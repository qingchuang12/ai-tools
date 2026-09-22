/**
 * 离线验签器（Ed25519）
 *
 * 目标形态（客户 16.3）：
 *   `parts.length === 3` → `Ed25519Verify(公钥[按 header.kid 选], header + "." + payload, sig)`
 *   → 依次校验 `sku`（命中 `config.acceptedSkus`）/ `mid` / `exp` / `nbf` / `feat`
 *     （生效权益 = SKU 映射 ∪ 原始 feat，见 `resolveFeatures`）。**必须真验签，不能只查格式。**
 *
 * **秒 ↔ 毫秒的转换只允许在本文件发生**：token 的 `iat`/`exp`/`nbf` 是秒（JWT 惯例），
 * 而 `ActivationState` 与 vault 一律用毫秒。其它模块禁止自行 `*1000`，一律走 `expToMs()`。
 */

import {verify} from 'crypto';
import {getConfig} from './config';
import type {LicenseErrorCode} from './errors';
import {logLicenseEvent, redactMid} from './errors';
import {getPublicKey} from './keys';
import {getMachineCodePair} from './machine-code';
import type {LicenseConfig, TokenHeader, TokenPayload, VerifyOutcome} from './types';
import {DEFAULT_KID} from '../../shared/license-constants';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface VerifyOptions {
    /** 基准时间（ms）。省略时用 `Date.now()`；T03 接入 `effectiveNow()` 后由调用方传入 */
    nowMs?: number;
    /** 需要的权益；null / 省略表示只验令牌本身，不做权益判定 */
    requiredFeature?: string | null;
}

/** 严格 base64url 解码：非法字符集或不可回环的编码一律视为格式错误 */
function decodeSegment(seg: string): Buffer | null {
    if (!BASE64URL_RE.test(seg)) return null;
    const buf = Buffer.from(seg, 'base64url');
    // 回环校验：防止非规范编码造成「验签用的字节」与「签名时的字节」不一致而被绕过
    if (buf.length > 0 && buf.toString('base64url') !== seg) return null;
    return buf;
}

function fail(code: LicenseErrorCode, ctx: Record<string, unknown> = {}): VerifyOutcome {
    logLicenseEvent(code, ctx);
    return {ok: false, code, payload: null, kid: null};
}

function isStringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** 秒 → 毫秒（全项目唯一的转换出口，token 到期时间一律经它落到状态里） */
export function expToMs(exp: number | null | undefined): number | null {
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

/**
 * 生效权益 = 「SKU 授予的 gate 键」∪「token 原始 feat」。
 *
 * 前者由包外配置按 SKU 映射（功能开关，见 `SKU_FEATURES` 注释）；后者是服务端的营销权益文案。
 * 取并集：服务端将来若直接下发 gate 键（如 `cloud_sync`）也能立即生效，无需升级客户端。
 */
export function resolveFeatures(payload: Partial<TokenPayload>, cfg: LicenseConfig): string[] {
    const bySku = (typeof payload.sku === 'string' ? cfg.skuFeatures?.[payload.sku] : undefined) ?? [];
    const raw = isStringArray(payload.feat) ? payload.feat : [];
    return [...new Set([...bySku, ...raw])];
}

/** 权益判定：命中 `proFeature` 视为全量权益，否则需显式包含所需权益 */
export function payloadHasFeature(payload: TokenPayload, feature: string, cfg: LicenseConfig): boolean {
    const features = resolveFeatures(payload, cfg);
    return features.includes(cfg.features.proFeature) || features.includes(feature);
}

/**
 * 校验签名令牌。
 *
 * 返回 `VerifyOutcome`：
 * - `ok === true`：令牌有效（或被应急开关放行），`payload` 可用；
 * - `ok === false`：`code` 是内部错误码，**只进日志**，对外一律用统一文案。
 */
export async function verifyToken(token: string, options: VerifyOptions = {}): Promise<VerifyOutcome> {
    const raw = (token || '').trim();
    if (!raw) return fail('LIC_MALFORMED', {event: 'verify_empty_token'});

    const parts = raw.split('.');
    if (parts.length !== 3) return fail('LIC_MALFORMED', {event: 'verify_segment_count', segments: parts.length});

    const headerBuf = decodeSegment(parts[0]);
    const payloadBuf = decodeSegment(parts[1]);
    const sigBuf = decodeSegment(parts[2]);
    if (!headerBuf || !payloadBuf || !sigBuf) return fail('LIC_MALFORMED', {event: 'verify_base64url'});

    let header: Partial<TokenHeader>;
    let payload: Partial<TokenPayload>;
    try {
        header = JSON.parse(headerBuf.toString('utf-8')) as Partial<TokenHeader>;
        payload = JSON.parse(payloadBuf.toString('utf-8')) as Partial<TokenPayload>;
    } catch {
        return fail('LIC_MALFORMED', {event: 'verify_json'});
    }

    const cfg = getConfig();
    const kid = typeof header.kid === 'string' && header.kid.trim() ? header.kid.trim() : cfg.defaultKid || DEFAULT_KID;

    // alg 若声明则必须是 EdDSA，避免被降级到其它算法
    if (header.alg !== undefined && header.alg !== 'EdDSA') {
        return fail('LIC_MALFORMED', {event: 'verify_alg', alg: String(header.alg)});
    }

    const publicKey = getPublicKey(kid);
    if (!publicKey) return fail('LIC_UNKNOWN_KID', {event: 'verify_kid', kid});

    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf-8');
    let signatureOk = false;
    try {
        signatureOk = verify(null, signingInput, publicKey, sigBuf);
    } catch (error) {
        // 签名长度/算法不匹配时 Node 会抛异常，这里等同于验签失败（绝不能让异常变成「通过」）
        logLicenseEvent('LIC_INTERNAL', {event: 'verify_threw', reason: (error as Error).name});
        signatureOk = false;
    }
    if (!signatureOk) return fail('LIC_BAD_SIGNATURE', {event: 'verify_signature', kid});

    // 接受的 SKU 列表（配置驱动：服务端按档位使用不同 SKU）；列表异常时回退单值 sku，绝不因此放行
    const acceptedSkus = Array.isArray(cfg.acceptedSkus) && cfg.acceptedSkus.length > 0 ? cfg.acceptedSkus : [cfg.sku];
    if (typeof payload.sku !== 'string' || !payload.sku || !acceptedSkus.includes(payload.sku)) {
        return fail('LIC_SKU_MISMATCH', {event: 'verify_sku', kid});
    }
    if (typeof payload.mid !== 'string' || !payload.mid) {
        return fail('LIC_MACHINE_MISMATCH', {event: 'verify_mid_missing', kid});
    }

    const pair = await getMachineCodePair();
    if (payload.mid !== pair.strong) {
        return fail('LIC_MACHINE_MISMATCH', {event: 'verify_mid', kid, mid: redactMid(payload.mid)});
    }

    const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const skewSec = Math.floor(Math.max(0, cfg.clock.skewToleranceMs) / 1000);

    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
        if (nowSec > payload.exp + skewSec) return fail('LIC_EXPIRED', {event: 'verify_exp', kid});
    }
    if (typeof payload.nbf === 'number' && Number.isFinite(payload.nbf)) {
        if (nowSec < payload.nbf - skewSec) return fail('LIC_NOT_YET_VALID', {event: 'verify_nbf', kid});
    }

    const required = options.requiredFeature;
    if (required && !payloadHasFeature(payload as TokenPayload, required, cfg)) {
        // 带上 sku 与它的授予集：SKU 未配 skuFeatures 时 `grant` 为 'unmapped'，可直接定位漏配
        return fail('LIC_FEATURE_MISSING', {
            event: 'verify_feat',
            kid,
            required,
            sku: typeof payload.sku === 'string' ? payload.sku : '(none)',
            grant: cfg.skuFeatures?.[payload.sku as string] ?? 'unmapped',
        });
    }

    return {ok: true, code: 'LIC_OK', payload: payload as TokenPayload, kid};
}
