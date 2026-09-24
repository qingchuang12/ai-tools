/**
 * 授权门面（main 进程**唯一**对外出口）
 *
 * 依赖方向（单向，无环）：
 *   index → {config, machine-code, vault, verifier, trial, redeem, errors}
 * 其余模块互不反向依赖；`src/main/index.ts` 只 import 本门面。
 *
 * 时间口径：所有到期判定都用 `trial.effectiveNow()`（`max(now, 水印, 后端时间下界, 付费态下界)`），
 * 不得直接 `Date.now()`，否则改系统时间就能让已过期的授权复活。
 */

import type {ActivationDegradedReason, ActivationState, RedeemResult} from '../../shared/activation-types';
import {getConfig} from './config';
import type {LicenseErrorCode} from './errors';
import {logLicenseEvent, PUBLIC_ERROR_KEY, redactLicenseKey} from './errors';
import {assertFeature as gateAssertFeature} from './feature-gate';
import {readFirstRunAt, writeFirstRun} from './first-run';
import {getHardwareFactors, getMachineCodePair, warmupMachineCode} from './machine-code';
import {probeMachineFirstSeen} from './machine-probe';
import {getPersistedAccessToken} from '../account';
import {
    buildCheckoutUrl,
    fetchRedeem,
    parseLicenseText,
    readLicenseFileViaDialog,
    redeemFailure,
    reportBinding,
    unbindPriorOnServer,
} from './redeem';
import type {TrialEvaluation} from './trial';
import {
    applyMachineFirstSeen,
    effectiveNow,
    enterHardwareGrace,
    evaluateTrial,
    grantTrial,
    licenseFloor,
    maxFloor,
    raiseLicenseServerFloor,
    raiseLicenseWatermark,
    raiseServerTimeFloor,
    touchTrial,
} from './trial';
import {raiseAnchorFloor, readAnchorFloor} from './anchor';
import {isDisabledByRecheck, setRecheckDisableHook, startRecheckLoop} from './recheck';
import type {VaultData} from './vault';
import {readVault, writeVault} from './vault';
import {expToMs, extractLicenseKeyFromToken, resolveFeatures, verifyToken} from './verifier';
import type {LicenseConfig, LicenseVault, TokenPayload, TrialVault} from './types';
import {FEATURE_PRO} from '../../shared/license-constants';

/** 当前会话已验签通过的载荷（供 `assertFeature` / UI 复用，避免重复验签） */
let payloadCache: TokenPayload | null = null;

/** D2：同进程内已触发过补报的 token 集合（配合持久化标记，避免一次会话内重复发请求） */
const reportedThisSession = new Set<string>();

/** 授权状态变化监听（运行中被复核停用时的 UI 反馈入口）；null = 未注册 */
let stateChangeListener: ((state: ActivationState) => void) | null = null;

/**
 * 注册状态变化监听（传 null 注销）。
 * P2 用途：主进程在复核停用后可据此向渲染层广播，让用户立刻看到「授权已失效」而不用重启。
 */
export function setStateChangeListener(fn: ((state: ActivationState) => void) | null): void {
    stateChangeListener = fn;
}

/** 重算一次状态并广播；广播是旁路能力，任何失败都不允许影响授权判定本身 */
function notifyStateChanged(): void {
    if (!stateChangeListener) return;
    void getState(null)
        .then((state) => {
            try {
                stateChangeListener?.(state);
            } catch (error) {
                logLicenseEvent('LIC_INTERNAL', {event: 'state_listener_failed', reason: (error as Error).name});
            }
        })
        .catch(() => {
            /* 广播失败不影响授权判定 */
        });
}

/** 空状态模板 */
function baseState(): ActivationState {
    return {
        status: 'inactive',
        trialStartsAt: null,
        trialExpiresAt: null,
        trialRunsLeft: null,
        activatedExpiresAt: null,
        activatedAt: null,
        machineCode: null,
        licenseKey: null,
        sku: null,
        features: [],
        source: 'none',
        degraded: null,
    };
}

/** 内部码 → 对外降级语义（只用于「是否展示重新激活引导」，UI 不展示原因本身） */
function degradedFrom(code: LicenseErrorCode): ActivationDegradedReason {
    switch (code) {
        case 'LIC_EXPIRED':
            return 'expired';
        case 'LIC_MACHINE_MISMATCH':
            return 'machine_mismatch';
        case 'LIC_CLOCK_ROLLBACK':
            return 'clock_rollback';
        case 'LIC_VAULT_TAMPERED':
            return 'vault_tampered';
        default:
            return 'token_invalid';
    }
}

function activatedState(
    payload: TokenPayload,
    cfg: LicenseConfig,
    license: LicenseVault | null,
    expiresAtOverride: number | null,
    machineCode: string,
    degraded: ActivationDegradedReason | null = null
): ActivationState {
    return {
        ...baseState(),
        status: 'activated',
        activatedExpiresAt: expiresAtOverride ?? expToMs(payload.exp),
        activatedAt: license?.activated_at ?? null,
        machineCode,
        licenseKey: redactLicenseKey(payload.lic ?? null),
        sku: payload.sku || cfg.sku,
        // 生效权益 = SKU 映射的 gate 键 ∪ token 原始 feat（见 resolveFeatures）；
        // 前置 `pro` 全量权益键：任意被接受的 SKU 即全量权益，与试用态口径一致（R5 权益模型统一）
        features: [FEATURE_PRO, ...resolveFeatures(payload, cfg)],
        source: 'license',
        degraded,
    };
}

/** 宽限态：验签已失败（机器码不匹配），但按策略仍维持「已激活」直到宽限到期 */
function graceState(
    cfg: LicenseConfig,
    license: LicenseVault | null,
    persisted: ActivationState | null,
    machineCode: string,
    graceUntil: number
): ActivationState {
    return {
        ...baseState(),
        status: 'activated',
        activatedExpiresAt: graceUntil,
        activatedAt: license?.activated_at ?? null,
        machineCode,
        // 宽限期内拿不到已验签的载荷，展示信息沿用上一次持久化的状态（非安全边界）
        licenseKey: persisted?.licenseKey ?? null,
        sku: persisted?.sku ?? cfg.sku,
        features: persisted?.features ? [...persisted.features] : [],
        source: 'license',
        degraded: 'hardware_changed',
    };
}

function trialState(ev: TrialEvaluation, machineCode: string): ActivationState {
    return {
        ...baseState(),
        status: 'trial',
        trialStartsAt: ev.trialStartsAt,
        trialExpiresAt: ev.trialExpiresAt,
        trialRunsLeft: ev.trialRunsLeft,
        machineCode,
        // 试用期视作全量权益（pro）：云同步等付费功能均开放；仅试用到期且未注册才关闭
        features: [FEATURE_PRO],
        source: 'trial',
        degraded: ev.degraded,
    };
}

/**
 * 硬件变更宽限判定（plan 5.4）：
 * 强码不等但弱码一致 + cpu/board/osGuid 三因子齐全 + 宽限次数未用尽 → 给 7 天缓冲。
 * **不做**「允许 N 个因子缺失」的宽松匹配：那会让机器码退化为低熵，破坏一机一码。
 */
async function resolveHardwareGrace(
    persisted: ActivationState | null,
    vault: VaultData,
    cfg: LicenseConfig,
    pair: {strong: string; soft: string},
    nowMs: number
): Promise<ActivationState> {
    const effNow = effectiveNow(vault.trial, nowMs, licenseFloor(vault.license));
    const trial = vault.trial;

    const graceUntil = trial?.hardware_grace_until ?? null;
    if (graceUntil && effNow <= graceUntil) {
        return graceState(cfg, vault.license, persisted, pair.strong, graceUntil);
    }

    const factors = await getHardwareFactors();
    const factorsComplete = !!factors.cpu && !!factors.board && !!factors.osGuid;
    const softMatched = !!vault.license?.mid_soft_at_activation && vault.license.mid_soft_at_activation === pair.soft;

    if (trial && softMatched && factorsComplete && trial.hardware_grace_used < cfg.grace.maxAutoGrace) {
        const granted = enterHardwareGrace(trial, cfg, effNow);
        await writeVault({trial: granted, license: vault.license});
        logLicenseEvent('LIC_OK', {event: 'hardware_grace_entered', days: cfg.grace.hardwareChangeDays});
        return graceState(cfg, vault.license, persisted, pair.strong, granted.hardware_grace_until ?? effNow);
    }

    logLicenseEvent('LIC_MACHINE_MISMATCH', {event: 'hardware_grace_denied'});
    return {...baseState(), machineCode: pair.strong, degraded: 'machine_mismatch'};
}

/**
 * 确定试用起点（vault 里没有账本时调用）。
 *
 * - 首跑账本不存在 → 确属首次运行：落账本并以 `nowMs` 为起点发试用；
 * - 账本存在 → **沿用账本时间**：vault 被删/解密失败也只在原起点重建，剩余天数不会变多；
 * - 账本时间在未来（时钟回拨或人为前移）→ 返回 null，**不发试用**（fail-closed）。
 *
 * @returns 试用起点（ms）；null = 判定为篡改，调用方按未激活处理
 */
function resolveTrialStart(cfg: LicenseConfig, nowMs: number): number | null {
    const skew = Math.max(0, cfg.clock.skewToleranceMs);
    const ledgerAt = readFirstRunAt();
    if (ledgerAt === null) {
        writeFirstRun(nowMs);
        logLicenseEvent('LIC_OK', {event: 'trial_granted_first_run'});
        return nowMs;
    }
    if (ledgerAt > nowMs + skew) {
        // 账本起点在未来：只可能是时钟被回拨或账本被人手改。一律不发试用，
        // 且**可自愈**——时钟恢复正常后下一次判定会自动发放。
        logLicenseEvent('LIC_VAULT_TAMPERED', {event: 'first_run_ledger_in_future'});
        return null;
    }
    logLicenseEvent('LIC_OK', {event: 'trial_restored_from_ledger'});
    return Math.min(ledgerAt, nowMs);
}

/**
 * 保证 vault 里有试用账本（**自愈入口**）：缺失时按首跑账本发放或重建。
 *
 * 语义是「**从未激活过即可进入试用**」——不再依赖外部安装标记的存在与否，
 * 因此「标记在、vault 没了」「activation.json 在、vault 没了」这类真空地带都能自愈。
 *
 * @returns 试用账本与「本次是否新建」；null = 判定为篡改，调用方应返回未激活
 */
async function ensureTrialLedger(
    vault: VaultData,
    cfg: LicenseConfig,
    nowMs: number
): Promise<{trial: TrialVault; created: boolean} | null> {
    if (vault.trial) return {trial: vault.trial, created: false};
    const start = resolveTrialStart(cfg, nowMs);
    if (start === null) return null;
    const pair = await getMachineCodePair();
    // C8：vault 与首跑账本都能被删掉重装骗过，唯独服务端的「机器首次出现时间」删不掉。
    // 新建账本时联网问一次（离线拿不到就当没见过，绝不因此挡住用户）。
    const serverFirstSeen = await safeProbeMachineFirstSeen();
    const granted: TrialVault = {
        // grantTrial 已记 1 次运行（trial_count=1），本次运行不再重复累加
        ...grantTrial(start, pair.soft),
        // 起点可能来自外部账本（早于现在），水印仍要落在 nowMs 上留下单调下界
        watermark: Math.max(start, nowMs),
        last_run_at: nowMs,
    };
    const merged = applyMachineFirstSeen(granted, serverFirstSeen, nowMs) ?? granted;
    await writeVault({trial: merged, license: vault.license});
    return {trial: merged, created: true};
}

/**
 * C8 探测兜底：任何异常一律退化成「服务端没见过」。
 * 这是启动路径上的旁路网络请求，绝不能把它变成新的故障点——离线用户必须照常拿到试用。
 */
async function safeProbeMachineFirstSeen(): Promise<number | null> {
    try {
        return await probeMachineFirstSeen();
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {event: 'machine_probe_unexpected', reason: (error as Error).name});
        return null;
    }
}

/**
 * C8：为**已存在但从未联网问过**的账本补一次探测（老 vault 升级上来的场景）。
 * 问过就把结果写进账本，之后不再重复问——探测在启动路径上，不能每次启动都发一次请求。
 */
async function backfillMachineFirstSeen(vault: VaultData): Promise<TrialVault | null> {
    const trial = vault.trial;
    if (!trial || trial.machine_first_seen_at !== undefined) return null;
    const firstSeenAt = await safeProbeMachineFirstSeen();
    const merged = applyMachineFirstSeen(trial, firstSeenAt);
    if (!merged) return null;
    await writeVault({trial: merged, license: vault.license});
    return merged;
}

/**
 * 计算当前授权状态（**状态权威源是 vault**，activation.json 只是它的明文镜像）。
 *
 * @param persisted 上次落盘的明文状态，仅用于两件事：legacy 判定（旧 HMAC 激活 → 降级）
 *                  与宽限期内的展示信息。一致性与安全性一律以 vault + 验签结果为准。
 */
export async function getState(persisted: ActivationState | null = null): Promise<ActivationState> {
    const cfg = getConfig();
    const pair = await getMachineCodePair();
    const vault = await readVault();
    const now = Date.now();

    const token = vault.license?.signed_token;
    if (token) {
        // 到期判定必须用 effectiveNow：水印只增，改系统时间救不了已过期的授权。
        // 付费态的单调下界自带一路（trial 在已激活分支不推进），再加 vault 外锚（R2），一起取 max。
        const floor = maxFloor(licenseFloor(vault.license), await readAnchorFloor());
        // ① 先推进付费水印与 vault 外锚：防回拨不受停用影响，这两步必须照常发生
        const raised = raiseLicenseWatermark(vault.license, now);
        if (raised) await writeVault({trial: vault.trial, license: raised});
        await raiseAnchorFloor(now);
        const license = raised ?? vault.license;
        // ② 再判停用：优先级**高于**验签与硬件变更宽限。
        //    若只挂在「验签成功」分支，退款用户换一块硬盘 → mid 不匹配 → 命中 resolveHardwareGrace
        //    → 又白得 7 天可用期（真实绕过）。故必须放在验签之前。
        if (isDisabledByRecheck(license, cfg, now)) {
            payloadCache = null;
            return {...baseState(), machineCode: pair.strong, degraded: 'token_invalid'};
        }
        // ③ 才走原有验签流程（含 LIC_MACHINE_MISMATCH → 硬件宽限）
        const outcome = await verifyToken(token, {
            nowMs: effectiveNow(vault.trial, now, floor),
        });
        if (outcome.ok && outcome.payload) {
            payloadCache = outcome.payload;
            // D2（plan-7.0 / A9）：已验签的授权若尚未补报过本机机器码，启动期旁路上报一次（不阻塞启动）
            if (!license?.binding_reported) {
                void reportBindingOnStartup(token, pair.strong);
            }
            return activatedState(outcome.payload, cfg, license, null, pair.strong);
        }
        payloadCache = null;
        if (outcome.code === 'LIC_MACHINE_MISMATCH') {
            return resolveHardwareGrace(persisted, {...vault, license}, cfg, pair, now);
        }
        return {...baseState(), machineCode: pair.strong, degraded: degradedFrom(outcome.code)};
    }

    // legacy：旧版本「本地 HMAC 激活码」留下的 activated 状态无法绑定 sku/feat/exp（且该算法是后门），
    // 一律降级为未激活并引导重新激活。
    if (persisted && persisted.status === 'activated') {
        logLicenseEvent('LIC_MALFORMED', {event: 'legacy_activation_downgraded'});
        return {...baseState(), machineCode: pair.strong, degraded: 'token_invalid'};
    }

    // 无 token 且无试用账本：按「首跑账本」发放/重建试用（首次使用即进入试用，且删档不延长）
    const ensured = await ensureTrialLedger(vault, cfg, now);
    if (!ensured) {
        return {...baseState(), machineCode: pair.strong, degraded: 'vault_tampered'};
    }

    // C8：老账本（从未联网问过）补一次服务端探测，命中则把试用起点回溯到「这台机器最早来过」的时间
    const backfilled = ensured.created ? null : await backfillMachineFirstSeen(vault);
    const trial = backfilled ?? ensured.trial;

    const ev = evaluateTrial(trial, cfg, now);
    if (ev.status === 'inactive') {
        return {
            ...baseState(),
            machineCode: pair.strong,
            trialStartsAt: ev.trialStartsAt,
            trialExpiresAt: ev.trialExpiresAt,
            trialRunsLeft: ev.trialRunsLeft,
            degraded: ev.degraded,
        };
    }

    // 新建时已在 ensureTrialLedger 里落盘（含本次运行计数），避免首跑被重复计数
    if (!ensured.created) {
        const updated = touchTrial(trial, now);
        await writeVault({trial: updated, license: vault.license});
    }
    return trialState(ev, pair.strong);
}

/**
 * D2（plan-7.0 / A9）：启动旁路补报本机机器码。
 *
 * 场景：授权落地时未携带机器码（落成「未绑定」态），或需把服务端已绑定的事实同步回本地。
 * 设计约束：
 * - **不阻塞启动**：`getState` 已直接返回已激活态，本函数 fire-and-forget；
 * - **去重**：同进程（`reportedThisSession`）+ 跨重启（`LicenseVault.binding_reported`）双重防重复；
 * - **落盘重签 token**：补绑成功后服务端会**重签** `signedToken`（含本次机器码），必须把新 token 写回
 *   vault——否则本地旧 token（无 `mid`）下次启动会被 `verifier` 判 `LIC_MACHINE_MISMATCH`；
 * - **失败不抛**：网络 / 拒绝一律留待下次启动重试。
 */
async function reportBindingOnStartup(signedToken: string, machineId: string): Promise<void> {
    if (reportedThisSession.has(signedToken)) return;
    reportedThisSession.add(signedToken);
    try {
        const r = await reportBinding(signedToken, machineId);
        if (!r.ok || !r.token) return;
        // 服务端重签的 token 才是「已绑本机」的权威件，先本地验签再落盘（与 applySignedToken 同口径）
        const applied = await applySignedToken(r.token, r.serverTimeMs ?? null);
        if (!applied.success) return;
        const vault = await readVault();
        if (!vault.license) return;
        await writeVault({trial: vault.trial, license: {...vault.license, binding_reported: true}});
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {event: 'report_binding_unexpected', reason: (error as Error).name});
    }
}

/**
 * 确保试用账本存在（原「首次安装发试用」入口，保留导出以兼容既有调用点与测试）。
 *
 * 真正的发试用已经内化为 `getState()` 的自愈逻辑：不再依赖 activation-store 的调用时机，
 * 也不依赖外部安装标记是否缺失。已有账本则不动（幂等）。
 */
export async function grantTrialOnFirstInstall(): Promise<void> {
    const cfg = getConfig();
    const vault = await readVault();
    await ensureTrialLedger(vault, cfg, Date.now());
}

/** 门面初始化：必须在 `app.whenReady()` 之后调用（safeStorage 在 ready 前会抛） */
export async function init(): Promise<ActivationState> {
    warmupMachineCode();
    // 复核循环内部会**立即**发起首次复核（退款时效优先，启动即查），
    // 故此处只调 startRecheckLoop()，不再额外 runRecheck()——否则启动会并发两个请求，白白消耗限流额度。
    // 循环 timer 已 unref()，不阻塞窗口显示也不阻止进程退出。
    setRecheckDisableHook(notifyStateChanged);
    startRecheckLoop();
    return getState(null);
}

/** 当前会话已验签的载荷；没有则为 null */
export function currentPayload(): TokenPayload | null {
    return payloadCache;
}

/** 去激活：只清 token，不重置试用（plan 待明确 #17：不允许去激活后重新试用） */
export async function deactivate(): Promise<ActivationState> {
    const vault = await readVault();
    await writeVault({
        trial: vault.trial,
        // 显式列出而非依赖「字面量未列出即被丢弃」：去激活必须清干净复核状态，
        // 否则「停用 → 去激活 → 重新激活」可能继承旧的 revoked_by_server 标记。
        // 川哥拍板（2026-09-24）：watermark / server_time_floor 两个防改系统时间的单调水位必须保留——
        // 它们是反回拨下界，去激活后保留才能防止「改系统时间 + 重新激活」回拨续命；
        // 只把该清的（token / 激活时间 / mid / 复核四字段）置空，binding_reported 也清（换 token 需重新上报）。
        license: {
            ...vault.license,
            signed_token: null,
            activated_at: null,
            mid_at_activation: null,
            mid_soft_at_activation: null,
            revoked_by_server: false,
            offline_grace_used_ms: 0,
            last_checked_at: null,
            last_verified_ok_at: null,
            binding_reported: null,
        },
    });
    payloadCache = null;
    return getState(null);
}

/** 按配置模板拼出带 machineId 的收银台 URL */
export async function getPurchaseUrl(): Promise<string> {
    return buildCheckoutUrl();
}

/** 验签通过后才落盘（**落盘前必须本地验签**，不无条件信任后端返回） */
async function applySignedToken(token: string, serverTimeMs: number | null): Promise<RedeemResult> {
    const cfg = getConfig();
    const vault = await readVault();
    // 同样走 effectiveNow：落盘前就按「见过的最新时间」判定，回拨换不来一张新令牌
    const outcome = await verifyToken(token, {
        nowMs: effectiveNow(vault.trial, Date.now(), licenseFloor(vault.license)),
    });
    if (!outcome.ok || !outcome.payload) {
        logLicenseEvent(outcome.code, {event: 'apply_signed_token_rejected'});
        return redeemFailure('license');
    }
    const pair = await getMachineCodePair();
    const now = Date.now();
    let trial = vault.trial;
    if (trial && cfg.clock.useServerTimeFloor && typeof serverTimeMs === 'number') {
        trial = raiseServerTimeFloor(trial, serverTimeMs);
    }
    // 付费态自己的单调时钟：沿用上一张授权已攒下的时间下界，再按本次时序抬高，只增不减
    let license: LicenseVault = {
        signed_token: token,
        activated_at: now,
        mid_at_activation: pair.strong,
        mid_soft_at_activation: pair.soft,
        watermark: Math.max(now, licenseFloor(vault.license) ?? 0),
        server_time_floor: vault.license?.server_time_floor ?? null,
        // 新授权不继承旧授权的复核状态：否则「被停用 → 重新激活」会立刻又被判停用，用户无法自救。
        // 复核从零开始（下次启动即首查），由服务端重新给出权威答案。
        last_checked_at: null,
        last_verified_ok_at: null,
        offline_grace_used_ms: 0,
        revoked_by_server: false,
        // 新 token 尚未补报本机机器码（与既有「新激活需补绑」语义一致）
        binding_reported: null,
    };
    if (cfg.clock.useServerTimeFloor && typeof serverTimeMs === 'number' && Number.isFinite(serverTimeMs)) {
        license = raiseLicenseServerFloor(license, serverTimeMs) ?? license;
    }
    // R2：激活/换发即推进 vault 外锚（服务端时间比本地更可信时用它抬下界）
    await raiseAnchorFloor(maxFloor(now, serverTimeMs) ?? now);
    await writeVault({trial, license});
    payloadCache = outcome.payload;
    return {success: true, state: activatedState(outcome.payload, cfg, license, null, pair.strong)};
}

/**
 * R6 原子换绑内核：新授权**先本地生效**（覆盖旧 token），生效成功后才去释放旧授权的本机绑定。
 *
 * - `switchMode=false`：纯激活，行为与 `applySignedToken` 一致；
 * - `switchMode=true`：先抓当前 vault 的旧 `signed_token`，跑激活（整对象覆盖＝新生效）；
 *   成功后若旧 token 存在，则 best-effort 调后端解绑旧码。解绑失败**只标 `unbindWarning`**，
 *   不回滚新激活、不阻挡（用户拍板：新生效优先、解绑尽力而为）。
 */
async function applyWithSwitch(
    token: string,
    serverTimeMs: number | null,
    switchMode: boolean,
): Promise<RedeemResult> {
    const priorToken = switchMode ? (await readVault()).license?.signed_token ?? null : null;
    const result = await applySignedToken(token, serverTimeMs);
    if (!result.success || !priorToken) return result;

    // 新授权已本地生效，尽力释放旧授权的本机绑定（不阻挡、不回滚）。
    // R6 修复：旧端点已删除，改走账号侧出口——从旧 token 解出 licenseKey，配合登录态 Bearer 调用。
    const priorLicenseKey = extractLicenseKeyFromToken(priorToken);
    const accessToken = getPersistedAccessToken();
    if (priorLicenseKey && accessToken) {
        const ok = await unbindPriorOnServer(accessToken, priorLicenseKey);
        if (!ok) {
            logLicenseEvent('LIC_UNBIND_FAILED', {event: 'switch_unbind_best_effort_failed'});
            result.unbindWarning = true;
        }
    } else {
        // 未登录或旧 token 取不到 licenseKey：无法调用账号侧解绑，仅记日志（best-effort）
        logLicenseEvent('LIC_UNBIND_SKIPPED', {
            event: 'switch_unbind_no_session',
            hasToken: !!accessToken,
            hasLicenseKey: !!priorLicenseKey,
        });
    }
    return result;
}

/** 兑换码 + 购买邮箱 → 后端 redeem → 本地验签 → 落盘（邮箱为服务端必填的客户标识） */
export async function redeem(code: string, email: string, switchMode = false): Promise<RedeemResult> {
    const result = await fetchRedeem(code, email);
    if (!result.ok || !result.token) {
        return redeemFailure(result.category ?? 'license');
    }
    return applyWithSwitch(result.token, result.serverTimeMs ?? null, switchMode);
}

/** 导入 `.lic` 文本（裸 token 或 JSON 包装） */
export async function importLicenseText(text: string, switchMode = false): Promise<RedeemResult> {
    const token = parseLicenseText(text);
    if (!token) {
        logLicenseEvent('LIC_MALFORMED', {event: 'import_license_text_unparsable'});
        return {success: false, category: 'license', error: PUBLIC_ERROR_KEY};
    }
    return applyWithSwitch(token, null, switchMode);
}

/** 导入 `license.lic` 文件（主进程弹选择器）。用户取消时 `error` 为空，UI 不应提示失败 */
export async function importLicenseFile(switchMode = false): Promise<RedeemResult> {
    const text = await readLicenseFileViaDialog();
    if (text === null) return {success: false};
    return importLicenseText(text, switchMode);
}

/**
 * 权益 gate 判定（**主进程兜底的唯一入口**）：实现在 `feature-gate.ts`，
 * 门面只做转发并顺带刷新会话内的载荷缓存。
 */
export async function assertFeature(feature: string): Promise<{allowed: boolean; code: LicenseErrorCode}> {
    const result = await gateAssertFeature(feature);
    if (result.code === 'LIC_RECHECK_REVOKED') {
        // 停用后旧载荷不能留在会话缓存里：currentPayload() 会被 updater.ts 消费，
        // 而 update-gate 是「payload 为 null 即放行」口径，陈旧的 update_until / max_major_version
        // 会让已停用用户被「按旧权益」误拦更新。清空后与「未激活放行」的既有设计自洽。
        payloadCache = null;
    } else if (result.payload) {
        payloadCache = result.payload;
    }
    return {allowed: result.allowed, code: result.code};
}
