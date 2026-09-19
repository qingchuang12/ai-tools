/**
 * 试用账本判定（main 进程）
 *
 * 时间口径（**全项目唯一**）：
 *   `effectiveNow() = max(Date.now(), vault.watermark, vault.server_time_floor, 付费态下界)`
 * 任何到期判定**必须**用它，**不得**直接 `Date.now()`——否则把系统时间改回过去就能让
 * 已过期的试用/授权复活（单调水印只增，回拨被抹平）。
 *
 * 双限口径（2026-09-17 客户拍板）：
 *   - 天数 **60 天是硬约束**；
 *   - 启动次数 `maxRuns = null` 表示**不限**：`trial_count` 只累加、不拦截
 *     （避免误伤重度用户），因此 `trialRunsLeft` 在不限时为 `null`。
 */

import type {ActivationDegradedReason} from '../../shared/activation-types';
import type {LicenseErrorCode} from './errors';
import {logLicenseEvent} from './errors';
import type {LicenseConfig, LicenseVault, TrialVault} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialEvaluation {
    status: 'trial' | 'inactive';
    degraded: ActivationDegradedReason | null;
    code: LicenseErrorCode;
    trialStartsAt: number | null;
    trialExpiresAt: number | null;
    /** 剩余启动次数；null = 不限 */
    trialRunsLeft: number | null;
}

/**
 * 授权时间的唯一出口：`max(now, 单调水印, 后端时间下界, 付费态下界)`。
 *
 * 水印只增不减，server_time_floor 由 redeem 响应给出（可选），两者共同封死「时间回拨」。
 * `extraFloorMs` 传付费账本的下界（见 `licenseFloor`）：**付费激活时不推进 trial 水印**，
 * 少了这一路，订阅过期后把系统时间改回过去就能复活（plan-2.4 的 C7，已修复）。
 */
export function effectiveNow(
    trial: TrialVault | null,
    nowMs: number = Date.now(),
    extraFloorMs: number | null = null
): number {
    let t = nowMs;
    if (trial) {
        if (typeof trial.watermark === 'number' && Number.isFinite(trial.watermark)) {
            t = Math.max(t, trial.watermark);
        }
        if (typeof trial.server_time_floor === 'number' && Number.isFinite(trial.server_time_floor)) {
            t = Math.max(t, trial.server_time_floor);
        }
    }
    if (typeof extraFloorMs === 'number' && Number.isFinite(extraFloorMs)) {
        t = Math.max(t, extraFloorMs);
    }
    return t;
}

/** 付费账本的时间下界 = `max(watermark, server_time_floor)`；无则为 null */
export function licenseFloor(license: LicenseVault | null): number | null {
    if (!license) return null;
    const floors = [license.watermark, license.server_time_floor].filter(
        (v): v is number => typeof v === 'number' && Number.isFinite(v)
    );
    return floors.length > 0 ? Math.max(...floors) : null;
}

/** 付费水印的落盘步进（ms）：避免每次 IPC 复算都重写 vault；回拨保护的精度到分钟级足够 */
export const LICENSE_WATERMARK_STEP_MS = 60_000;

/**
 * 推进付费态单调水印（只增不减）。
 *
 * @returns 更新后的账本；无需推进（已回拨、或距上次落盘不足一个步进）时返回 null，调用方应跳过落盘。
 */
export function raiseLicenseWatermark(license: LicenseVault | null, nowMs: number): LicenseVault | null {
    if (!license) return null;
    const current = typeof license.watermark === 'number' && Number.isFinite(license.watermark) ? license.watermark : 0;
    if (nowMs <= current + LICENSE_WATERMARK_STEP_MS) return null;
    return {...license, watermark: nowMs};
}

/** 抬高付费态后端时间下界（只增不减）；无需推进时返回 null */
export function raiseLicenseServerFloor(license: LicenseVault | null, serverTimeMs: number): LicenseVault | null {
    if (!license) return null;
    const current =
        typeof license.server_time_floor === 'number' && Number.isFinite(license.server_time_floor)
            ? license.server_time_floor
            : 0;
    if (serverTimeMs <= current) return null;
    return {...license, server_time_floor: serverTimeMs};
}

/** 发试用：首次安装时调用（install 标记由 activation-store 维护，此处只管账本） */
export function grantTrial(nowMs: number, midSoft: string): TrialVault {
    return {
        first_run_at: nowMs,
        trial_count: 1,
        last_run_at: nowMs,
        // 自检串由 vault 在落盘前计算，这里先留空
        trial_token: '',
        watermark: nowMs,
        mid_soft_at_activation: midSoft,
        hardware_grace_used: 0,
        hardware_grace_until: null,
        server_time_floor: null,
    };
}

/** 推进一次运行：次数单调 +1，水印只增，last_run_at 更新 */
export function touchTrial(trial: TrialVault, nowMs: number): TrialVault {
    return {
        ...trial,
        trial_count: trial.trial_count + 1,
        last_run_at: nowMs,
        watermark: Math.max(trial.watermark, nowMs),
    };
}

/** 抬高后端时间下界（redeem 响应带 serverTime 时使用，只增不减） */
export function raiseServerTimeFloor(trial: TrialVault, serverTimeMs: number): TrialVault {
    return {
        ...trial,
        server_time_floor: Math.max(trial.server_time_floor ?? 0, serverTimeMs),
    };
}

/**
 * 试用判定（天数 / 次数，先到为准）。
 *
 * 处置策略：
 * - `now < first_run_at - 容差`：时钟被改到首次运行之前（典型是删档 + 改表）→ 判 `LIC_VAULT_TAMPERED`；
 * - `now < watermark - 容差`：仅**记脱敏 warn 日志、不阻断**（避免误伤 NTP 校正 / 用户误改时区），
 *   且到期判定用的是 `effectiveNow`，回拨本身拿不到任何好处。
 */
export function evaluateTrial(trial: TrialVault, cfg: LicenseConfig, nowMs: number): TrialEvaluation {
    const skew = Math.max(0, cfg.clock.skewToleranceMs);
    const effNow = effectiveNow(trial, nowMs);
    const expiresAt = trial.first_run_at + Math.max(0, cfg.trial.days) * DAY_MS;

    if (nowMs < trial.first_run_at - skew) {
        logLicenseEvent('LIC_VAULT_TAMPERED', {event: 'trial_clock_before_first_run'});
        return {
            status: 'inactive',
            degraded: 'vault_tampered',
            code: 'LIC_VAULT_TAMPERED',
            trialStartsAt: trial.first_run_at,
            trialExpiresAt: expiresAt,
            trialRunsLeft: 0,
        };
    }

    if (effNow > expiresAt) {
        return {
            status: 'inactive',
            degraded: 'trial_expired',
            code: 'LIC_TRIAL_EXPIRED',
            trialStartsAt: trial.first_run_at,
            trialExpiresAt: expiresAt,
            trialRunsLeft: 0,
        };
    }

    // maxRuns 为 null = 不限：trialRunsLeft 返回 null，UI 不展示次数
    const runsLeft = cfg.trial.maxRuns === null ? null : Math.max(0, cfg.trial.maxRuns - trial.trial_count);
    if (runsLeft !== null && runsLeft <= 0) {
        return {
            status: 'inactive',
            degraded: 'trial_runs_exceeded',
            code: 'LIC_TRIAL_RUNS_EXCEEDED',
            trialStartsAt: trial.first_run_at,
            trialExpiresAt: expiresAt,
            trialRunsLeft: 0,
        };
    }

    if (nowMs < trial.watermark - skew) {
        // 只记日志：日志里不出现具体时间值，避免泄露判定细节
        logLicenseEvent('LIC_CLOCK_ROLLBACK', {event: 'trial_clock_rollback'});
    }

    return {
        status: 'trial',
        degraded: null,
        code: 'LIC_OK',
        trialStartsAt: trial.first_run_at,
        trialExpiresAt: expiresAt,
        trialRunsLeft: runsLeft,
    };
}

/**
 * 进入硬件变更宽限（换硬盘场景）：强码变了但弱码一致 → 给 7 天缓冲，状态维持已激活。
 * 用完 `maxAutoGrace` 次后不再自动宽限，需联系支持重新签发。
 */
export function enterHardwareGrace(trial: TrialVault, cfg: LicenseConfig, effNow: number): TrialVault {
    return {
        ...trial,
        hardware_grace_used: trial.hardware_grace_used + 1,
        hardware_grace_until: effNow + Math.max(0, cfg.grace.hardwareChangeDays) * DAY_MS,
    };
}
