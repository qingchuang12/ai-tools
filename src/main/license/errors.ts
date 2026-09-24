/**
 * 授权模块错误码与日志出口（main 进程专用）
 *
 * 分层原则：
 * - **内部**：任何失败都对应一个 `LicenseErrorCode`，只经由 `logLicenseEvent()` 写日志；
 * - **对外**：UI 一律展示 `PUBLIC_ERROR_KEY` 对应的统一文案（网络类除外，见下），
 *   绝不回传错误码，避免给破解者提供「哪一步没过」的定位信息。
 */

import {createHash} from 'crypto';

/** 内部错误码：仅进日志，绝不出现在 UI 或 IPC 返回值里 */
export type LicenseErrorCode =
    | 'LIC_OK'
    | 'LIC_TRIAL_OK'            // 试用期内（未注册）视作全量权益，gate 放行
    | 'LIC_MALFORMED'           // 非 3 段 / base64url 或 JSON 解析失败
    | 'LIC_UNKNOWN_KID'         // header.kid 无对应公钥
    | 'LIC_BAD_SIGNATURE'       // Ed25519 验签失败
    | 'LIC_SKU_MISMATCH'
    | 'LIC_MACHINE_MISMATCH'    // mid != 当前机器码
    | 'LIC_EXPIRED'
    | 'LIC_NOT_YET_VALID'
    | 'LIC_FEATURE_MISSING'
    | 'LIC_CLOCK_ROLLBACK'
    | 'LIC_TRIAL_EXPIRED'
    | 'LIC_TRIAL_RUNS_EXCEEDED'
    | 'LIC_VAULT_TAMPERED'
    | 'LIC_REDEEM_NETWORK'
    | 'LIC_REDEEM_REJECTED'
    | 'LIC_REDEEM_BAD_RESPONSE'
    | 'LIC_UNBIND_NETWORK'
    | 'LIC_UNBIND_REJECTED'
    | 'LIC_UNBIND_FAILED'
    | 'LIC_REPORT_BINDING_NETWORK'
    | 'LIC_REPORT_BINDING_REJECTED'
    | 'LIC_REPORT_BINDING_BAD_RESPONSE'
    | 'LIC_ACCOUNT_NETWORK'        // 账号请求网络层失败（登录 / 二因子 / 登出 / me）
    | 'LIC_ACCOUNT_REJECTED'      // 账号请求被服务端拒绝（HTTP >=400，不暴露细分原因）
    | 'LIC_ACCOUNT_BAD_RESPONSE'  // 账号请求响应 JSON 畸形（解析失败）
    | 'LIC_ACCOUNT_INTERNAL'      // 本地令牌读取等内部异常
    | 'LIC_CLAIM_FAILED'          // A9：登录后自动到账激活失败（best-effort，不影响登录态）
    | 'LIC_UNBIND_SKIPPED'        // R6：未登录或取不到 licenseKey，跳过换绑解绑
    | 'LIC_RECHECK_NETWORK'       // 复核：网络层失败（fetch 抛异常 / 超时）
    | 'LIC_RECHECK_RATE_LIMITED'  // 复核：命中 429（照常累加宽限，免扣会让限流变成续命后门）
    | 'LIC_RECHECK_BAD_RESPONSE'  // 复核：响应 JSON 畸形或结构非法
    | 'LIC_RECHECK_REVOKED'       // 复核：服务端明确回答吊销 / 过期 → 停用
    | 'LIC_RECHECK_GRACE_EXHAUSTED' // 复核：离线宽限耗尽 → 停用
    | 'LIC_RECHECK_UNKNOWN'       // 复核：服务端答不上来（5xx / 未知码 / 非 200-400）→ 走宽限
    | 'LIC_INTERNAL';

/** UI 统一文案的 i18n key（激活/兑换类失败一律用它，不解释原因） */
export const PUBLIC_ERROR_KEY = 'license.errors.generic';

/** 网络类失败的 i18n key（唯一例外：否则用户会把断网误判为激活码错误） */
export const PUBLIC_NETWORK_ERROR_KEY = 'license.errors.network';

/** 功能被锁定的 i18n key（gate 拦截时用，属体验提示而非失败） */
export const PUBLIC_LOCKED_KEY = 'license.errors.locked';

/** 机器码脱敏：AB12-****-****-CD34，日志不得出现完整机器码 */
export function redactMid(mid: string | null | undefined): string {
    if (!mid) return '(none)';
    if (mid.length < 8) return '****';
    return `${mid.slice(0, 4)}-****-****-${mid.slice(-4)}`;
}

/** licenseKey 脱敏：AB12-****-****-CD34，日志不得出现原文 */
export function redactLicenseKey(key: string | null | undefined): string {
    if (!key) return '(none)';
    if (key.length < 8) return '****';
    return `${key.slice(0, 4)}-****-****-${key.slice(-4)}`;
}

/**
 * token 脱敏：只留 sha256 前 12 位作为「同一个 token」的关联标识。
 * 日志绝不出现 token 原文。
 */
export function redactToken(token: string | null | undefined): string {
    if (!token) return '(none)';
    // 延迟 require 不必要：crypto 是本模块唯一外部依赖且无环
    return `sha256:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

/**
 * 授权事件日志出口（唯一出口）。
 *
 * - 入参 `ctx` 必须**先脱敏再传入**（用 redactMid / redactToken / redactLicenseKey）；
 * - 本函数自身做二次兜底：任何键名含 token/secret/key 且值是长串的，一律替换为指纹；
 * - 日志写入失败绝不影响授权主流程（否则「记日志」会变成新的崩溃源）。
 */
export function logLicenseEvent(code: LicenseErrorCode, ctx: Record<string, unknown> = {}): void {
    try {
        const safe: Record<string, unknown> = { channel: 'license', code };
        for (const [k, v] of Object.entries(ctx)) {
            safe[k] = isSensitiveKey(k) && typeof v === 'string' && v.length > 16 ? redactToken(v) : v;
        }
        console.warn('[license]', JSON.stringify(safe));
    } catch {
        // 日志出口不允许抛出：授权判定不能因为日志失败而中断
    }
}

function isSensitiveKey(key: string): boolean {
    const k = key.toLowerCase();
    return k.includes('token') || k.includes('secret') || k.includes('licensekey') || k.includes('password');
}
