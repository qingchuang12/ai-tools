/**
 * 授权门面（main 进程**唯一**对外出口）
 *
 * 依赖方向（单向，无环）：
 *   index → {config, machine-code, vault, verifier, trial, redeem, errors}
 * 其余模块互不反向依赖；`src/main/index.ts` 只 import 本门面。
 *
 * 时间口径：所有到期判定都用 `trial.effectiveNow()`（`max(now, 水印, 后端时间下界)`），
 * 不得直接 `Date.now()`，否则改系统时间就能让已过期的授权复活。
 */

import type {ActivationDegradedReason, ActivationState, RedeemResult} from '../../shared/activation-types';
import {getConfig} from './config';
import type {LicenseErrorCode} from './errors';
import {logLicenseEvent, PUBLIC_ERROR_KEY, redactLicenseKey} from './errors';
import {assertFeature as gateAssertFeature} from './feature-gate';
import {getHardwareFactors, getMachineCodePair, warmupMachineCode} from './machine-code';
import {buildCheckoutUrl, fetchRedeem, parseLicenseText, readLicenseFileViaDialog, redeemFailure,} from './redeem';
import type {TrialEvaluation} from './trial';
import {effectiveNow, enterHardwareGrace, evaluateTrial, grantTrial, raiseServerTimeFloor, touchTrial} from './trial';
import type {VaultData} from './vault';
import {readVault, writeVault} from './vault';
import {expToMs, verifyToken} from './verifier';
import type {LicenseConfig, LicenseVault, TokenPayload} from './types';
import {FEATURE_PRO} from '../../shared/license-constants';

/** 当前会话已验签通过的载荷（供 `assertFeature` / UI 复用，避免重复验签） */
let payloadCache: TokenPayload | null = null;

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
        features: Array.isArray(payload.feat) ? [...payload.feat] : [],
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
    const effNow = effectiveNow(vault.trial, nowMs);
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
        // 到期判定必须用 effectiveNow：水印只增，改系统时间救不了已过期的授权
        const outcome = await verifyToken(token, {nowMs: effectiveNow(vault.trial, now)});
        if (outcome.ok && outcome.payload) {
            payloadCache = outcome.payload;
            return activatedState(outcome.payload, cfg, vault.license, null, pair.strong);
        }
        payloadCache = null;
        if (outcome.code === 'LIC_MACHINE_MISMATCH') {
            return resolveHardwareGrace(persisted, vault, cfg, pair, now);
        }
        return {...baseState(), machineCode: pair.strong, degraded: degradedFrom(outcome.code)};
    }

    // legacy：旧版本「本地 HMAC 激活码」留下的 activated 状态无法绑定 sku/feat/exp（且该算法是后门），
    // 一律降级为未激活并引导重新激活。
    if (persisted && persisted.status === 'activated') {
        logLicenseEvent('LIC_MALFORMED', {event: 'legacy_activation_downgraded'});
        return {...baseState(), machineCode: pair.strong, degraded: 'token_invalid'};
    }

    if (!vault.trial) {
        return {...baseState(), machineCode: pair.strong};
    }

    const ev = evaluateTrial(vault.trial, cfg, now);
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

    const updated = touchTrial(vault.trial, now);
    await writeVault({trial: updated, license: vault.license});
    return trialState(ev, pair.strong);
}

/**
 * 首次安装发试用（由 activation-store 在「两处安装标记均缺失」时调用）。
 * 已有账本则不重置——删 activation.json 不会重置试用（还有两处标记 + vault 双保护）。
 */
export async function grantTrialOnFirstInstall(): Promise<void> {
    const vault = await readVault();
    if (vault.trial) return;
    const pair = await getMachineCodePair();
    await writeVault({trial: grantTrial(Date.now(), pair.soft), license: vault.license});
}

/** 门面初始化：必须在 `app.whenReady()` 之后调用（safeStorage 在 ready 前会抛） */
export async function init(): Promise<ActivationState> {
    warmupMachineCode();
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
        license: {signed_token: null, activated_at: null, mid_at_activation: null, mid_soft_at_activation: null},
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
    const outcome = await verifyToken(token, {nowMs: Date.now()});
    if (!outcome.ok || !outcome.payload) {
        logLicenseEvent(outcome.code, {event: 'apply_signed_token_rejected'});
        return redeemFailure('license');
    }
    const vault = await readVault();
    const pair = await getMachineCodePair();
    const now = Date.now();
    let trial = vault.trial;
    if (trial && cfg.clock.useServerTimeFloor && typeof serverTimeMs === 'number') {
        trial = raiseServerTimeFloor(trial, serverTimeMs);
    }
    const license: LicenseVault = {
        signed_token: token,
        activated_at: now,
        mid_at_activation: pair.strong,
        mid_soft_at_activation: pair.soft,
    };
    await writeVault({trial, license});
    payloadCache = outcome.payload;
    return {success: true, state: activatedState(outcome.payload, cfg, license, null, pair.strong)};
}

/** 兑换码 → 后端 redeem → 本地验签 → 落盘 */
export async function redeem(code: string): Promise<RedeemResult> {
    const result = await fetchRedeem(code);
    if (!result.ok || !result.token) {
        return redeemFailure(result.category ?? 'license');
    }
    return applySignedToken(result.token, result.serverTimeMs ?? null);
}

/** 导入 `.lic` 文本（裸 token 或 JSON 包装） */
export async function importLicenseText(text: string): Promise<RedeemResult> {
    const token = parseLicenseText(text);
    if (!token) {
        logLicenseEvent('LIC_MALFORMED', {event: 'import_license_text_unparsable'});
        return {success: false, category: 'license', error: PUBLIC_ERROR_KEY};
    }
    return applySignedToken(token, null);
}

/** 导入 `license.lic` 文件（主进程弹选择器）。用户取消时 `error` 为空，UI 不应提示失败 */
export async function importLicenseFile(): Promise<RedeemResult> {
    const text = await readLicenseFileViaDialog();
    if (text === null) return {success: false};
    return importLicenseText(text);
}

/**
 * 权益 gate 判定（**主进程兜底的唯一入口**）：实现在 `feature-gate.ts`，
 * 门面只做转发并顺带刷新会话内的载荷缓存。
 */
export async function assertFeature(feature: string): Promise<{allowed: boolean; code: LicenseErrorCode}> {
    const result = await gateAssertFeature(feature);
    if (result.payload) payloadCache = result.payload;
    return {allowed: result.allowed, code: result.code};
}
