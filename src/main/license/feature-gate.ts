/**
 * 权益 gate（主进程**唯一**判定入口）
 *
 * 判定链路：fail-closed 名单校验 → 取 vault 里的 signed token → **全量验签**（Ed25519 verify <1ms，
 * 机器码走缓存）→ 校验所需权益（`pro` 视为全量权益）。**不做结果缓存**：刚过期 / 刚去激活必须立刻生效。
 *
 * 为什么每层都要验签而不缓存结论：缓存会让「去激活后仍能同步」成为现实，
 * 而验签成本（亚毫秒）相对一次云同步（网络秒级）可以忽略。
 *
 * fail-closed（plan-2.7 的 R1）：只有登记过的权益键（`proFeature` 与 `features.gated`，provider
 * 权益按 `FEATURE_PROVIDERS` 归一到宿主）才允许进入验签链路；未登记的 feature 一律拒绝。
 * 名单是配置而非代码（包外 `license.config.json` 可改），但漏配的方向现在是「误锁」而不是
 * 「误放」——新增付费功能忘了登记会立刻被用户/测试发现，而不是静默放行。
 */

import {getConfig} from './config';
import type {LicenseErrorCode} from './errors';
import {logLicenseEvent, PUBLIC_LOCKED_KEY} from './errors';
import {readAnchorFloor} from './anchor';
import {effectiveNow, evaluateTrial, licenseFloor, maxFloor} from './trial';
import {isDisabledByRecheck} from './recheck';
import {readVault} from './vault';
import {verifyToken} from './verifier';
import type {TokenPayload} from './types';
import {FEATURE_PROVIDERS} from '../../shared/license-constants';

export interface GateResult {
    allowed: boolean;
    /** 内部码，只进日志；对外一律用统一文案 */
    code: LicenseErrorCode;
    /** 验签通过时的载荷；被拦截时为 null */
    payload: TokenPayload | null;
}

/** 被拦截时对外展示的 i18n key（渲染层 `t()` 翻译） */
export const GATE_LOCKED_MESSAGE = PUBLIC_LOCKED_KEY;

/**
 * 判定某个权益是否可用。
 *
 * fail-closed：未登记的权益键直接拒绝（R1）；`pro` 是全量权益键，只验令牌本身有效
 * （任意被接受的 SKU 即视为全量权益，不要求 token 显式携带 `pro`）。
 */
export async function assertFeature(feature: string): Promise<GateResult> {
    const cfg = getConfig();

    // R5：provider 型权益归一到宿主（remote_connect → cloud_sync），两端口径一致
    const required = FEATURE_PROVIDERS[feature] ?? feature;
    const isPro = required === cfg.features.proFeature;
    if (!isPro && !cfg.features.gated.includes(required)) {
        logLicenseEvent('LIC_FEATURE_MISSING', {event: 'gate_unregistered', feature});
        return {allowed: false, code: 'LIC_FEATURE_MISSING', payload: null};
    }

    const vault = await readVault();
    // R2：vault 外锚文件并入时间下界——「备份还原旧 vault + 回拨」拿不到锚里的高水位
    const floor = maxFloor(licenseFloor(vault.license), await readAnchorFloor());
    const nowMs = effectiveNow(vault.trial, Date.now(), floor);

    const token = vault.license?.signed_token;
    if (!token) {
        // 试用期内（未注册）视作全量权益（pro）：所有被 gate 的功能均开放；
        // 仅当「试用已到期且未注册」才拦截。注册用户（持有合法 token）走下方验签路径。
        if (vault.trial && evaluateTrial(vault.trial, cfg, Date.now()).status === 'trial') {
            return {allowed: true, code: 'LIC_TRIAL_OK', payload: null};
        }
        logLicenseEvent('LIC_FEATURE_MISSING', {event: 'gate_no_token', feature});
        return {allowed: false, code: 'LIC_FEATURE_MISSING', payload: null};
    }

    const outcome = await verifyToken(token, {
        nowMs,
        // `pro` 只验令牌本身；其余权益按归一后的名字校验
        requiredFeature: isPro ? null : required,
    });
    if (!outcome.ok) {
        logLicenseEvent(outcome.code, {event: 'gate_denied', feature});
    }
    // 定期复核停用闸门：与 getState() 共用 isDisabledByRecheck()，避免两处判定漂移。
    // 这是云同步等付费功能的真实闸门——服务端明确吊销 / 离线宽限耗尽后，即便本地 token 仍验签通过也要拒绝。
    if (outcome.ok && isDisabledByRecheck(vault.license, cfg)) {
        logLicenseEvent('LIC_RECHECK_REVOKED', {event: 'gate_recheck_disabled', feature});
        return {allowed: false, code: 'LIC_RECHECK_REVOKED', payload: null};
    }
    return {allowed: outcome.ok, code: outcome.code, payload: outcome.payload};
}
