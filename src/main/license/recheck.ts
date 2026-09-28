/**
 * 定期联网复核（main 进程，plan-7.0 → plan-1.0 节奏改造）
 *
 * 一句话职责：**问服务端一句「这张授权现在还认吗」**，把答案落到 vault 的复核字段上。
 * 本模块**不做任何停用动作**——停用判定统一由 `isDisabledByRecheck()` 表达，
 * 由 `index.ts#getState()` 与 `feature-gate.ts#assertFeature()` 各自在本地闸门里消费。
 *
 * 节奏（plan-1.0 第 1~3 条）：正常 **15 天**一次；**拿不到明确结论**（网络/超时/5xx/畸形）时
 * **2 小时**后重试，直到拿到明确答案；429 走 `rateLimitedRetryMs` + 抖动退避。
 * 排期时刻落盘在 `LicenseVault.next_check_at`，跨重启存活。
 *
 * 停用分两段（plan-1.0 / U1）：距最近一次「服务端明确回答 ACTIVE」
 * `offlineGraceDays`（默认 30 天）之内无感 → 之上进入**提醒段**（`needsOnlineVerify`，功能不减）→
 * `hardStopDays`（默认 60 天）之上才自动失效。
 *
 * 四条设计红线（改动前请读完）：
 * 1. **对外绝不抛**：全流程 try/catch，任何异常都退化成 `unknown`。复核是旁路逻辑，
 *    它崩了不能影响主进程，更不能影响用户既有权益。
 * 2. **宁可放过也不误杀**：只有服务端明确回答 `LICENSE_INVALID` / `LICENSE_EXPIRED` 才立即停用；
 *    `LICENSE_NOT_FOUND`（可能是服务端数据迁移/恢复）、429、5xx、网络失败、JSON 畸形一律 `unknown`。
 *    误判停用是资损级事故，漏判只是少收一天钱。
 * 3. **429 照常累加宽限**：绝不能因为「服务端在限流」就免扣——否则攻击者只要打满
 *    verify 限流（60/min/IP），客户端就永远只能拿到 429 → 永不停用，限流本身变成永久续命后门。
 * 4. **本次进程尚未复核过时，不因「超阈值」停用**（plan-1.0 新增）：15 天间隔下「闲置 40 天回来
 *    第一次启动」会成为常态，此时距上次成功复核早已超阈值，但一次复核几秒就能翻案。
 *    若照停不误，用户一打开软件就是未激活、且断网时无法自救——属改造引入的**新误杀面**。
 *    故停用判定要求「本次进程已发起过至少一次复核尝试」。见 `hasPendingRecheckAttempt()`。
 *
 * 时间口径：入参 `nowMs` 由调用方给（单测可注入）；`last_checked_at` 单调只增（防改系统时间倒拨宽限）。
 * 阈值判定取真实经过时长（`now - last_verified_ok_at`，缺失回落 `activated_at`），
 * 改系统时间既不能让 `last_verified_ok_at` 倒退，也不影响既有的付费态水印/服务器时间下界。
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
 *
 * @param attemptPending 本次进程是否「还没发起过复核尝试」（默认读模块状态；单测显式传入以获得确定性）。
 *                       为 true 时**不因超阈值停用**（红线 4），但服务端已明确答过吊销（`revoked_by_server`）
 *                       不受此保护——那条是权威结论，不需要再问一次才生效。
 */
export function isDisabledByRecheck(
    license: LicenseVault | null,
    cfg: LicenseConfig,
    nowMs: number = Date.now(),
    attemptPending: boolean = hasPendingRecheckAttempt(),
): boolean {
    if (!license || !cfg.recheck.enabled) return false;
    if (license.revoked_by_server === true) return true;
    if (attemptPending) return false;
    const elapsed = elapsedSinceLastOkMs(license, nowMs);
    // 时间基准缺失（老 vault 连 activated_at 都没有）→ 不误杀（红线 2）
    if (elapsed === null) return false;
    return elapsed >= cfg.recheck.hardStopDays * DAY_MS;
}

/**
 * 是否处于「需联网验证」提醒段：超过 `offlineGraceDays` 但还没到 `hardStopDays`。
 * 只影响 UI 提示，**不减任何功能**（plan-1.0 / U1 的分段口径）。
 */
export function isRecheckAttentionNeeded(
    license: LicenseVault | null,
    cfg: LicenseConfig,
    nowMs: number = Date.now(),
): boolean {
    if (!license || !cfg.recheck.enabled) return false;
    const elapsed = elapsedSinceLastOkMs(license, nowMs);
    if (elapsed === null) return false;
    return elapsed >= cfg.recheck.offlineGraceDays * DAY_MS;
}

/**
 * 距「最近一次服务端明确回答 ACTIVE」的真实经过毫秒数。
 * `last_verified_ok_at` 为 null（从未成功复核）则回落 `activated_at`；两者皆无（理论不可能，
 * 新授权落盘即带 `activated_at`）返回 null，调用方按「不误杀」处理。
 */
function elapsedSinceLastOkMs(license: LicenseVault, nowMs: number): number | null {
    const since = license.last_verified_ok_at ?? license.activated_at;
    if (typeof since !== 'number') return null;
    // last_checked_at 单调只增，这里同样防「系统时间被倒拨」把已耗时长算少
    return Math.max(0, nowMs - since);
}

/**
 * 本次进程是否还没有发起过任何一次复核尝试（红线 4 的判据）。
 *
 * 初值为 `true`：进程刚起来、还没问过服务端，此时「距上次成功复核很久」只可能是「软件一直没运行」，
 * 而不是「网络一直连不上」——后者才是我们要停用授权的场景。
 */
export function hasPendingRecheckAttempt(): boolean {
    return attemptPending;
}

/** 标记「本次进程已完成一次复核尝试」；`startRecheckLoop()` 会重新置回 pending。 */
function markAttemptDone(): void {
    attemptPending = false;
}

let attemptPending = true;

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
 * 宽限判定用方案 A（自然日，川哥 2026-09-24 拍板）：停用与否由 `isDisabledByRecheck()` 按
 * 「真实经过天数 = now - 最近一次服务端明确回答 ACTIVE 的时间」在每次 getState/assertFeature 时现算。
 * 这里 unknown 分支只推进 `last_checked_at`（单调），并由同一函数判定本次是否触发停用钩子；
 * 不再累加 `offline_grace_used_ms`（该字段在方案 A 下退化为仅保留兼容，不再参与判定）。
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

    // unknown：方案 A —— 不累加 offline_grace_used_ms，停用判定交由 isDisabledByRecheck 现算
    return {
        license: {...license, last_checked_at: checkedAt},
        disabled: isDisabledByRecheck(license, cfg, nowMs),
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

/**
 * 下一次排期间隔（plan-1.0 / C1）：
 * - 429 → `rateLimitedRetryMs` + 抖动（服务端明确说「别再来这么密」，退避要更长）；
 * - `unknown`（网络/超时/5xx/畸形=**没拿到结论**）→ `retryMs`（默认 2 小时），持续到拿到明确答案；
 * - 其余（active / revoked / skipped 终态）→ `intervalMs`（默认 15 天）。
 *
 * 注意 unknown 分支不能合并进「终态」用 15 天：那等于把「失败后 2 小时重试」这条需求丢掉。
 */
function nextDelay(outcome: RecheckOutcome): number {
    const cfg = getConfig();
    if (outcome.httpStatus === 429) {
        return cfg.recheck.rateLimitedRetryMs + Math.floor(Math.random() * RATE_LIMIT_JITTER_MS);
    }
    if (outcome.verdict === 'unknown') return cfg.recheck.retryMs;
    return cfg.recheck.intervalMs;
}

/**
 * 递归 setTimeout 调度（不用 setInterval：不同 verdict 的下次间隔不同）。
 * timer 一律 unref()，后台任务不阻止进程退出（与 `machine-code.ts#warmupMachineCode` 同口径）。
 *
 * ⚠️ 超过 2^31-1 ms（≈24.8 天）的 delay 会被 Node/浏览器**静默截断成 1ms**（并抛 TimeoutOverflowWarning），
 * 于是「下一次在 30 天后」变成「立刻再问一次」→ 打满服务端 verify 限流。15 天节奏本身在限内，
 * 但 `next_check_at` 会被系统时间倒拨或服务端下发的较大值放大，故这里按 24 天分段挂定时器。
 */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

function scheduleNext(delayMs: number): void {
    if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
    }
    if (loopStopped) return;
    const target = Math.max(0, delayMs);
    const wait = Math.min(target, MAX_TIMER_MS);
    const timer = setTimeout(() => {
        // 只是分段挂载、还没到点：继续等剩余量，不发请求
        if (wait < target) {
            scheduleNext(target - wait);
            return;
        }
        void runRecheck().then((outcome) => {
            scheduleNext(nextDelay(outcome));
        });
    }, wait);
    if (typeof timer.unref === 'function') timer.unref();
    loopTimer = timer;
}

/**
 * 启动后台复核循环（进程内单例，重复调用先清旧 timer）。
 *
 * 首次延迟取 vault 里的 `next_check_at`（plan-1.0 / C1：节奏要**跨重启存活**，
 * 否则「失败后 2 小时重试」只在进程活着时成立，用户重启一次就重置回 15 天）；
 * 缺失或已过期 → delay 0，即「启动即查」（退款时效优先，与既有行为一致）。
 */
export function startRecheckLoop(): void {
    loopStopped = false;
    // 新一轮循环 = 新的「本次进程复核尝试」，红线 4 的启动保护重新生效
    attemptPending = true;
    void initialDelay().then(scheduleNext);
}

/** 启动延迟：读持久化排期，拿不到就当「立即查」——旁路逻辑，异常绝不影响启动 */
async function initialDelay(): Promise<number> {
    try {
        const vault = await readVault();
        const scheduled = vault.license?.next_check_at;
        if (typeof scheduled !== 'number' || !Number.isFinite(scheduled)) return 0;
        return Math.max(0, scheduled - Date.now());
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {event: 'recheck_initial_delay_failed', reason: (error as Error).name});
        return 0;
    }
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
        // 本次进程已实际问过服务端：解除红线 4 的启动保护，此后超阈值停用判定才生效。
        // 必须在 applyVerdict 之前——否则本次 unknown 永远不会触发停用判定。
        markAttemptDone();
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
        const result = outcome(
            verdict,
            res.httpStatus,
            res.code,
            applied.disabled,
            applied.license.offline_grace_used_ms ?? 0,
        );
        // C1：排期与本次结论**同一次落盘**——`next_check_at` 是跨重启的下次发起时刻
        const scheduled: LicenseVault = {
            ...applied.license,
            next_check_at: nowMs + nextDelay(result),
        };
        await writeVault({trial, license: scheduled});

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

        return result;
    } catch (error) {
        // 兜底：复核的任何异常都不允许影响主进程与既有判定
        logLicenseEvent('LIC_INTERNAL', {event: 'recheck_unexpected', reason: (error as Error).name});
        return outcome('unknown', null, null, false, 0);
    }
}
