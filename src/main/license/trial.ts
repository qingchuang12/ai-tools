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

/**
 * R4：服务端首见时间的合理回溯窗口（2 年）。
 *
 * 比 plan-2.6 建议的「试用窗（60 天）」宽得多：60 天窗会把「200 天前来过」的合法回溯一并拒收，
 * 令 C8 的防重置失效；2 年窗只挡 epoch/0/负值这类只可能来自篡改响应的荒谬值，
 * 又能覆盖真实的长跨度部署。合法值被误拒的代价也有限：按「探测无效」处理，下次启动重试。
 */
export const MACHINE_FIRST_SEEN_MAX_AGE_MS = 2 * 365 * DAY_MS;

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

/** 取多路时间下界的最大值；全部缺失/非法时为 null（R2：vault 内下界与 vault 外锚并链用） */
export function maxFloor(...floors: (number | null | undefined)[]): number | null {
    const valid = floors.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return valid.length > 0 ? Math.max(...valid) : null;
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

/**
 * C8：把服务端给出的「机器首次出现时间」并进试用账本。
 *
 * 只做一件事——**把试用起点往回拨**（`first_run_at` 取更早的那个），从不往前挪：
 * 服务端说这台机器 200 天前就来过，那今天的「首跑」其实是第 N 次安装，
 * 试用早就过期了；反过来若服务端时间晚于本地起点（不该发生），一律以本地为准，避免误伤。
 *
 * R4（plan-2.7）：`first_seen_at` 早于合理窗口（`MACHINE_FIRST_SEEN_MAX_AGE_MS`）视为**异常值**
 * （epoch/0/负值只可能来自被篡改的响应）——按「探测无效」处理：不改账本、保持「从未问过」，
 * 下次启动会重试自愈。绝不把起点回拨到窗口之外，否则一次恶意响应就能把全新试用瞬间判死。
 *
 * 三态语义见 `TrialVault.machine_first_seen_at`：`undefined` 表示从未联网问过。
 *
 * @returns 更新后的账本；无需变更（服务端没见过 / 时间不更早 / 已问过且一致 / 值异常）时返回 null，
 *          调用方应跳过落盘——本函数在启动路径上被调用，不能每次都写 vault。
 */
export function applyMachineFirstSeen(trial: TrialVault, firstSeenAt: number | null, nowMs: number = Date.now()): TrialVault | null {
    const alreadyProbed = trial.machine_first_seen_at !== undefined;
    const known = typeof trial.machine_first_seen_at === 'number' ? trial.machine_first_seen_at : null;

    if (firstSeenAt === null) {
        // 服务端没见过这台机器：记下"问过了"，起点不动
        return alreadyProbed && known === null ? null : {...trial, machine_first_seen_at: null};
    }
    if (!Number.isFinite(firstSeenAt)) return null;
    if (firstSeenAt < nowMs - MACHINE_FIRST_SEEN_MAX_AGE_MS) {
        logLicenseEvent('LIC_MALFORMED', {event: 'machine_first_seen_implausible'});
        return null;
    }

    const backdated = Math.min(trial.first_run_at, firstSeenAt);
    if (alreadyProbed && known === firstSeenAt && backdated === trial.first_run_at) return null;

    return {
        ...trial,
        first_run_at: backdated,
        machine_first_seen_at: firstSeenAt,
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
