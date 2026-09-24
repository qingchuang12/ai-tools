/**
 * 定期联网复核（main 进程，plan-7.0）
 *
 * 一句话职责：**问服务端一句「这张授权现在还认吗」**，把答案落到 vault 的 4 个复核字段上。
 * 本模块**不做任何停用动作**——停用判定统一由 `isDisabledByRecheck()` 表达，
 * 由 `index.ts#getState()` 与 `feature-gate.ts#assertFeature()` 各自在本地闸门里消费。
 *
 * 三条设计红线（改动前请读完）：
 * 1. **对外绝不抛**：全流程 try/catch，任何异常都退化成 `unknown`。复核是旁路逻辑，
 *    它崩了不能影响主进程，更不能影响用户既有权益。
 * 2. **宁可放过也不误杀**：只有服务端明确回答 `LICENSE_INVALID` / `LICENSE_EXPIRED` 才立即停用；
 *    `LICENSE_NOT_FOUND`（可能是服务端数据迁移/恢复）、429、5xx、网络失败、JSON 畸形一律 `unknown`。
 *    误判停用是资损级事故，漏判只是少收一天钱。
 * 3. **429 照常累加宽限**：绝不能因为「服务端在限流」就免扣——否则攻击者只要打满
 *    verify 限流（60/min/IP），客户端就永远只能拿到 429 → 永不停用，限流本身变成永久续命后门。
 *
 * 时间口径：入参 `nowMs` 由调用方给（单测可注入）；`last_checked_at` 单调只增，
 * 且 `elapsed` 取 `max(0, ...)` 并被 `min(elapsed, intervalMs)` 钳住，
 * 因此改系统时间既不能让宽限倒退，也不能一次暴涨把用户停掉。
 */

import {getConfig} from './config';
import {LICENSE_VERIFY_API_PATH} from './constants';
import {logLicenseEvent} from './errors';
import {raiseLicenseServerFloor} from './trial';
import type {LicenseConfig, LicenseVault, TrialVault} from './types';
import {readVault, writeVault} from './vault';
import {extractLicenseKeyFromToken} from './verifier';

/** 一天的毫秒数（宽限天数换算用） */
const DAY_MS = 86_400_000;

/** 429 退避的随机抖动上限（10 分钟）：避免同一 NAT 下所有客户端同时重试 */
const RATE_LIMIT_JITTER_MS = 10 * 60 * 1000;

/**
 * 唯一能「立即停用」的服务端业务码。
 * ⚠️ `LICENSE_NOT_FOUND` **绝不能**加进来：key 不存在可能是服务端数据迁移/恢复中的瞬时状态，
 *    把它当吊销会导致全体用户被误杀（资损级）。
 */
const REVOKED_CODES = new Set<string>(['LICENSE_INVALID', 'LICENSE_EXPIRED']);

/** 复核四态 */
export type RecheckVerdict =
    /** 200 且 data.status === 'ACTIVE' */
    | 'active'
    /** 400 且 code ∈ REVOKED_CODES —— 唯一能立即停用的态 */
    | 'revoked'
    /** 其它一切：网络失败/超时/5xx/429/JSON 畸形/非 200 非 400/LICENSE_NOT_FOUND */
    | 'unknown'
    /** 无本地 token / 取不到 licenseKey / 开关关闭 —— 状态零改动 */
    | 'skipped';

export interface RecheckOutcome {
    verdict: RecheckVerdict;
    /** HTTP 状态码；null = 网络层失败（fetch 抛异常 / 超时） */
    httpStatus: number | null;
    /** 服务端业务码（LICENSE_INVALID 等）；仅日志，绝不上屏 */
    serverCode: string | null;
    /** 本次是否触发停用 */
    disabled: boolean;
    /** 落盘后的累计已耗宽限（ms） */
    graceUsedMs: number;
}

/** 服务端统一壳：业务字段在 `$.data` 段；`data` 缺失时兼容扁平结构 */
interface VerifyData {
    status?: string;
}

interface VerifyEnvelope extends VerifyData {
    success?: boolean;
    code?: string;
    data?: VerifyData;
}

interface VerifyResponse {
    /** HTTP 状态码；null = 网络层失败 */
    httpStatus: number | null;
    /** 统一壳的 code（失败段）或 'SUCCESS' */
    code: string | null;
    /** data.status */
    status: string | null;
    /** HTTP `Date` 响应头解析值（GMT，无时区歧义）；本端点响应体没有 serverTime 字段 */
    serverTimeMs: number | null;
}

/**
 * 停用判定**唯一出口**：`getState()` 与 `assertFeature()` 必须共用它，避免两处判定漂移。
 *
 * 开关关闭时一律返回 false —— 这是资损事故的秒级回滚手段（改包外配置重启即恢复，不需发版），
 * 故开关判断放在**这里**而不是两个调用点，保证任何新增调用点都不会漏掉。
 */
export function isDisabledByRecheck(license: LicenseVault | null, cfg: LicenseConfig): boolean {
    if (!license || !cfg.recheck.enabled) return false;
    if (license.revoked_by_server === true) return true;
    const used = typeof license.offline_grace_used_ms === 'number' ? license.offline_grace_used_ms : 0;
    return used >= cfg.recheck.offlineGraceDays * DAY_MS;
}

/** 读 HTTP `Date` 响应头作为服务端时间基准（GMT，无时区歧义）；拿不到返回 null */
function parseServerDate(response: Response): number | null {
    try {
        const raw = response.headers?.get?.('date');
        if (!raw) return null;
        const ms = Date.parse(raw);
        return Number.isFinite(ms) ? ms : null;
    } catch {
        return null;
    }
}

/**
 * GET /api/licenses/verify/{licenseKey}
 *
 * ⚠️ 429 的响应**body 为空**，必须先判 `response.status` 再 `response.json()`；
 * 否则 `json()` 抛异常会被记成 BAD_RESPONSE，虽然最终也归 unknown，但日志会误导排查方向。
 */
async function fetchLicenseStatus(licenseKey: string): Promise<VerifyResponse> {
    const cfg = getConfig();
    let response: Response;
    try {
        response = await fetch(`${cfg.serviceBaseUrl}${LICENSE_VERIFY_API_PATH(licenseKey)}`, {
            method: 'GET',
            headers: {accept: 'application/json'},
            signal: AbortSignal.timeout(Math.max(1000, cfg.recheck.timeoutMs)),
        });
    } catch (error) {
        logLicenseEvent('LIC_RECHECK_NETWORK', {event: 'recheck_request_failed', reason: (error as Error).name});
        return {httpStatus: null, code: null, status: null, serverTimeMs: null};
    }

    const serverTimeMs = parseServerDate(response);

    if (response.status === 429) {
        logLicenseEvent('LIC_RECHECK_RATE_LIMITED', {event: 'recheck_rate_limited'});
        return {httpStatus: 429, code: null, status: null, serverTimeMs};
    }

    // 只解析 200（成功）与 400（业务失败）两种契约内状态；5xx / 3xx 等不解析（body 可能不是 JSON）
    if (response.status !== 200 && response.status !== 400) {
        logLicenseEvent('LIC_RECHECK_UNKNOWN', {event: 'recheck_unexpected_status', httpStatus: response.status});
        return {httpStatus: response.status, code: null, status: null, serverTimeMs};
    }

    let body: VerifyEnvelope | null = null;
    try {
        body = (await response.json()) as VerifyEnvelope;
    } catch {
        logLicenseEvent('LIC_RECHECK_BAD_RESPONSE', {event: 'recheck_json_invalid', httpStatus: response.status});
        return {httpStatus: response.status, code: null, status: null, serverTimeMs};
    }

    const data = body?.data ?? body ?? null;
    return {
        httpStatus: response.status,
        code: typeof body?.code === 'string' ? body.code : null,
        status: typeof data?.status === 'string' ? data.status : null,
        serverTimeMs,
    };
}

/** 响应 → 四态。判定从严：拿不到「明确 ACTIVE」就不算 active */
function classify(res: VerifyResponse): RecheckVerdict {
    if (res.httpStatus === 200 && res.status === 'ACTIVE') return 'active';
    if (res.httpStatus === 400 && res.code !== null && REVOKED_CODES.has(res.code)) return 'revoked';
    return 'unknown';
}

/**
 * 按 verdict 计算新的 license 账本（**纯函数，不落盘**）。
 *
 * 宽限累加用方案 B（按真实使用时长钳制）：每次 unknown 只累加 `min(经过时长, intervalMs)`。
 * 这样「出差 10 天不开机、回来当天离线打开」只消耗 1 天宽限，不会被误停；
 * 同时天然免疫系统休眠导致的定时器漂移（唤醒后单次 elapsed 很大，但仍被钳到 24h）。
 *
 * ⚠️ 若产品改选方案 A（自然日），只需替换本函数 unknown 分支的累加逻辑，其余代码不动。
 */
function applyVerdict(
    license: LicenseVault,
    verdict: RecheckVerdict,
    nowMs: number,
    serverTimeMs: number | null,
): {license: LicenseVault; disabled: boolean} {
    const cfg = getConfig();
    // 单调：任何分支都不允许 last_checked_at 回退，防改系统时间倒拨宽限
    const checkedAt = Math.max(license.last_checked_at ?? 0, nowMs);

    if (verdict === 'active') {
        let next: LicenseVault = {
            ...license,
            last_checked_at: checkedAt,
            last_verified_ok_at: checkedAt,
            offline_grace_used_ms: 0,
            // 只有服务端明确回答 ACTIVE 才清掉停用标记 —— 本地改时间无法复活
            revoked_by_server: false,
        };
        // 本端点响应体无 serverTime，时间基准只能取 HTTP Date 头；拿不到就跳过，不影响主流程
        if (typeof serverTimeMs === 'number' && Number.isFinite(serverTimeMs)) {
            next = raiseLicenseServerFloor(next, serverTimeMs) ?? next;
        }
        return {license: next, disabled: false};
    }

    if (verdict === 'revoked') {
        return {
            license: {...license, last_checked_at: checkedAt, revoked_by_server: true},
            disabled: true,
        };
    }

    // unknown：按真实使用时长钳制累加
    const prevChecked = license.last_checked_at ?? null;
    const elapsed = prevChecked === null ? 0 : Math.max(0, nowMs - prevChecked);
    const used = (license.offline_grace_used_ms ?? 0) + Math.min(elapsed, cfg.recheck.intervalMs);
    return {
        license: {...license, last_checked_at: checkedAt, offline_grace_used_ms: used},
        disabled: used >= cfg.recheck.offlineGraceDays * DAY_MS,
    };
}

let loopTimer: ReturnType<typeof setTimeout> | null = null;
let loopStopped = false;

/** 停用时的通知钩子（由门面 `index.ts` 注册，避免 recheck → index 的循环依赖） */
type DisableHook = () => void;
let disableHook: DisableHook | null = null;

/**
 * 注册「被停用」钩子。门面在此回调里重新算一次状态并广播给渲染层。
 * 采用「recheck 暴露钩子、index 注册」而不是反向 import，是为了避免 index ↔ recheck 循环依赖。
 */
export function setRecheckDisableHook(fn: DisableHook | null): void {
    disableHook = fn;
}

/** 按上次结果决定下次间隔：429 走 1h + 抖动退避，其余一律 24h */
function nextDelay(outcome: RecheckOutcome): number {
    const cfg = getConfig();
    if (outcome.httpStatus === 429) {
        return cfg.recheck.rateLimitedRetryMs + Math.floor(Math.random() * RATE_LIMIT_JITTER_MS);
    }
    return cfg.recheck.intervalMs;
}

/**
 * 递归 setTimeout 调度（不用 setInterval：不同 verdict 的下次间隔不同）。
 * timer 一律 unref()，后台任务不阻止进程退出（与 `machine-code.ts#warmupMachineCode` 同口径）。
 */
function scheduleNext(delayMs: number): void {
    if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
    }
    if (loopStopped) return;
    const timer = setTimeout(() => {
        void runRecheck().then((outcome) => {
            scheduleNext(nextDelay(outcome));
        });
    }, Math.max(0, delayMs));
    if (typeof timer.unref === 'function') timer.unref();
    loopTimer = timer;
}

/**
 * 启动后台复核循环（进程内单例，重复调用先清旧 timer）。
 * **会立即发起首次复核**（delay 0）——退款时效优先，启动即查，不加抖动；
 * 抖动只用在 429 退避上。故门面 `init()` 只需调本函数，不要再额外 `void runRecheck()`，否则启动会并发两请求。
 */
export function startRecheckLoop(): void {
    loopStopped = false;
    scheduleNext(0);
}

/** 停止循环（测试/退出用） */
export function stopRecheckLoop(): void {
    loopStopped = true;
    if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
    }
}

/** 空结果构造：保持 verdict / disabled 语义一致，避免各处手写字面量 */
function outcome(
    verdict: RecheckVerdict,
    httpStatus: number | null,
    serverCode: string | null,
    disabled: boolean,
    graceUsedMs: number,
): RecheckOutcome {
    return {verdict, httpStatus, serverCode, disabled, graceUsedMs};
}

/**
 * 执行一次复核（纯逻辑，单测可直接调并注入 nowMs）。
 *
 * @param nowMs 时间基准（默认 `Date.now()`）；单测注入以获得确定性
 * @returns 复核结果；**绝不抛**，任何异常都退化成 `unknown`
 */
export async function runRecheck(nowMs: number = Date.now()): Promise<RecheckOutcome> {
    try {
        const cfg = getConfig();
        if (!cfg.recheck.enabled) {
            return outcome('skipped', null, null, false, 0);
        }

        const vault = await readVault();
        const license = vault.license;
        const token = license?.signed_token;
        if (!license || !token) {
            return outcome('skipped', null, null, false, license?.offline_grace_used_ms ?? 0);
        }

        // licenseKey 从 token 的 `lic` 声明直解（服务端签发时无条件写入），无需新增获取方式
        const licenseKey = extractLicenseKeyFromToken(token);
        if (!licenseKey) {
            logLicenseEvent('LIC_RECHECK_UNKNOWN', {event: 'recheck_no_license_key'});
            return outcome('skipped', null, null, false, license.offline_grace_used_ms ?? 0);
        }

        const res = await fetchLicenseStatus(licenseKey);
        const verdict = classify(res);

        if (verdict === 'skipped') {
            return outcome('skipped', res.httpStatus, res.code, false, license.offline_grace_used_ms ?? 0);
        }

        if (verdict === 'revoked') {
            logLicenseEvent('LIC_RECHECK_REVOKED', {event: 'recheck_revoked', code: res.code});
        } else if (verdict === 'unknown') {
            logLicenseEvent('LIC_RECHECK_UNKNOWN', {event: 'recheck_unknown', httpStatus: res.httpStatus});
        }

        const applied = applyVerdict(license, verdict, nowMs, res.serverTimeMs);
        const trial: TrialVault | null = vault.trial;
        await writeVault({trial, license: applied.license});

        if (applied.disabled) {
            if (verdict === 'revoked') {
                logLicenseEvent('LIC_RECHECK_REVOKED', {event: 'recheck_disabled', cause: 'server_revoked'});
            } else {
                logLicenseEvent('LIC_RECHECK_GRACE_EXHAUSTED', {
                    event: 'recheck_disabled',
                    cause: 'grace_exhausted',
                    usedMs: applied.license.offline_grace_used_ms ?? 0,
                });
            }
            // 通知门面（广播给渲染层）；钩子本身异常不能影响复核结果
            try {
                disableHook?.();
            } catch (error) {
                logLicenseEvent('LIC_INTERNAL', {event: 'recheck_hook_failed', reason: (error as Error).name});
            }
        }

        return outcome(
            verdict,
            res.httpStatus,
            res.code,
            applied.disabled,
            applied.license.offline_grace_used_ms ?? 0,
        );
    } catch (error) {
        // 兜底：复核的任何异常都不允许影响主进程与既有判定
        logLicenseEvent('LIC_INTERNAL', {event: 'recheck_unexpected', reason: (error as Error).name});
        return outcome('unknown', null, null, false, 0);
    }
}
