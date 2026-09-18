/**
 * 权益 gate（主进程**唯一**判定入口）
 *
 * 判定链路：配置名单 → 取 vault 里的 signed token → **全量验签**（Ed25519 verify <1ms，机器码走缓存）
 * → 校验所需权益（`pro` 视为全量权益）。**不做结果缓存**：刚过期 / 刚去激活必须立刻生效。
 *
 * 为什么每层都要验签而不缓存结论：缓存会让「去激活后仍能同步」成为现实，
 * 而验签成本（亚毫秒）相对一次云同步（网络秒级）可以忽略。
 *
 * 应急开关（改包外 `license.config.json` 即可，**不需要重新发版**）：
 * - `enabled: false` → 模块整体不介入，gate 全放行；
 * - `killSwitch: true` → 跳过验签，gate 全放行（止血用，事后必须复位）。
 */

import {getConfig} from './config';
import type {LicenseErrorCode} from './errors';
import {logLicenseEvent, PUBLIC_LOCKED_KEY} from './errors';
import {effectiveNow, evaluateTrial} from './trial';
import {readVault} from './vault';
import {verifyToken} from './verifier';
import type {TokenPayload} from './types';

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
 * 不在 `config.features.gated` 名单里的功能一律放行——gate 名单是配置而非代码，
 * 便于上线后按售卖策略调整而不发版。
 */
export async function assertFeature(feature: string): Promise<GateResult> {
    const cfg = getConfig();
    if (!cfg.enabled) return {allowed: true, code: 'LIC_DISABLED', payload: null};
    if (cfg.killSwitch) return {allowed: true, code: 'LIC_OK', payload: null};
    if (!cfg.features.gated.includes(feature)) return {allowed: true, code: 'LIC_OK', payload: null};

    const vault = await readVault();
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
        nowMs: effectiveNow(vault.trial, Date.now()),
        requiredFeature: feature,
    });
    if (!outcome.ok) {
        logLicenseEvent(outcome.code, {event: 'gate_denied', feature});
    }
    return {allowed: outcome.ok, code: outcome.code, payload: outcome.payload};
}
