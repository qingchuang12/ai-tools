/**
 * 账号会话模块（main 进程）
 *
 * 职责：**持有登录态**（accessToken 持久化 + 登录 / 第二因子校验 / 登出 / 当前用户）。
 * 是 A9「客户端自动路径改造」中**新增账号登录能力**的落地，也是 R6 换绑解绑与
 * 「密钥激活分支要求登录」的共同前置——两者都依赖本模块产出的 Bearer 令牌。
 *
 * 设计要点：
 * - 令牌**明文永不明文落盘**：复用 `secret-store` 的通用密文接口（AES-256-GCM / safeStorage），
 *   id = `ACCOUNT_ACCESS_TOKEN_SECRET_ID`，与 API 令牌体系隔离（不参与撤销/过期逻辑）。
 * - 对外文案**统一收敛**，**绝不回传服务端的错误码**（与 license 域同口径：不把失败定位信息暴露给破解者）。
 * - 服务端所有端点经 `ApiResponseAdvice` 统一包壳（`{success,code,data,...}`），业务字段在 `$.data`；
 *   `parseAuth` 同时兼容扁平结构（无 `data` 段）。
 * - MFA 两形态：`mfaRequired=true` 时 `accessToken/user` 刻意 null，只回 `mfaTicket` + `mfaMethods`，
 *   调用方须再以票据调 `verifyMfa` 换真令牌。
 */

import {
    ACCOUNT_ACCESS_TOKEN_SECRET_ID,
    LOGIN_API_PATH,
    LOGIN_TIMEOUT_MS,
    LOGOUT_API_PATH,
    LOGOUT_TIMEOUT_MS,
    ME_API_PATH,
    ME_TIMEOUT_MS,
    MFA_VERIFY_API_PATH,
    MFA_VERIFY_TIMEOUT_MS,
} from './license/constants';
import {getConfig} from './license/config';
import {logLicenseEvent} from './license/errors';
import {getSecretStore} from './secret-store';

/**
 * 登录失败对外统一文案（i18n key）。
 * 刻意不复用 license 域的 `PUBLIC_*`：后者写的是「激活失败」，登录失败沿用会让用户困惑；
 * 安全口径不变——仍不回传服务端错误码，避免借此枚举账号。
 */
const ACCOUNT_PUBLIC_ERROR_KEY = 'account.errors.generic';
const ACCOUNT_PUBLIC_NETWORK_ERROR_KEY = 'account.errors.network';

/** 当前登录用户资料（A5 me 与登录/verify 响应中的 `user` 同结构） */
export interface AccountProfile {
    id: string;
    email: string;
    emailVerified: boolean;
    status: string;
    role: string;
}

/** 登录 / 第二因子校验的统一结果 */
export interface AccountAuthResult {
    ok: boolean;
    /** 失败分类：network=网络层（用户网坏不应误判为密码错）；auth=其余（不暴露原因） */
    category?: 'network' | 'auth';
    /** 统一对外文案（i18n key），UI 直接 `t(error)` 展示 */
    error?: string;
    /** 待第二因子：true 时须用 `mfaTicket` 调 `verifyMfa` 换真令牌 */
    mfaRequired?: boolean;
    mfaTicket?: string;
    mfaMethods?: string[];
    token?: string;
    profile?: AccountProfile | null;
}

/** 内存缓存的 profile（避免每次 getProfile 都打 /me）；登录/verify 成功后写入 */
let cachedProfile: AccountProfile | null = null;

/** 读取持久化的 accessToken（明文经 secret-store 解密，不存在/失败返回 null） */
export function getPersistedAccessToken(): string | null {
    try {
        return getSecretStore().getRawSecret(ACCOUNT_ACCESS_TOKEN_SECRET_ID);
    } catch (error) {
        logLicenseEvent('LIC_ACCOUNT_INTERNAL', {event: 'token_read_failed', reason: (error as Error).name});
        return null;
    }
}

/** 是否已登录（令牌是否存在；过期由服务端在请求时裁决，客户端不解析 JWT） */
export function isLoggedIn(): boolean {
    return !!getPersistedAccessToken();
}

/** 写/清令牌密文 */
function persistToken(token: string | null): void {
    const store = getSecretStore();
    if (token) store.putRawSecret(ACCOUNT_ACCESS_TOKEN_SECRET_ID, token);
    else store.deleteRawSecret(ACCOUNT_ACCESS_TOKEN_SECRET_ID);
}

/** 归一化 UserProfileResponse → AccountProfile（字段缺省安全兜底） */
function mapProfile(user: unknown): AccountProfile | null {
    if (!user || typeof user !== 'object') return null;
    const u = user as Record<string, unknown>;
    if (typeof u.email !== 'string' || !u.email) return null;
    return {
        id: typeof u.id === 'string' ? u.id : '',
        email: u.email,
        emailVerified: u.emailVerified === true,
        status: typeof u.status === 'string' ? u.status : 'ACTIVE',
        role: typeof u.role === 'string' ? u.role : 'USER',
    };
}

/**
 * 解析 `AuthResponse`：优先取 `$.data` 段（服务端统一壳），无 `data` 时兼容扁平结构。
 * 仅返回本模块关心的字段；HTTP >=400 一律返回 null（由调用方归为 auth 类）。
 */
function parseAuth(body: unknown, status: number): {
    token?: string;
    user?: unknown;
    mfaRequired?: boolean;
    mfaTicket?: string;
    mfaMethods?: string[];
} | null {
    if (!body || typeof body !== 'object' || status >= 400) return null;
    const b = body as Record<string, unknown>;
    const data = (b.data && typeof b.data === 'object' ? b.data : b) as Record<string, unknown>;
    return {
        token: typeof data.accessToken === 'string' && data.accessToken ? data.accessToken : undefined,
        user: data.user,
        mfaRequired: data.mfaRequired === true,
        mfaTicket: typeof data.mfaTicket === 'string' && data.mfaTicket ? data.mfaTicket : undefined,
        mfaMethods: Array.isArray(data.mfaMethods) ? (data.mfaMethods as string[]) : undefined,
    };
}

/** 通用 POST JSON + 容错（网络异常归 network 类，返回 null 体） */
async function postJson(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    headers: Record<string, string> = {},
): Promise<{status: number; body: unknown} | null> {
    const cfg = getConfig();
    let response: Response;
    try {
        response = await fetch(`${cfg.serviceBaseUrl}${path}`, {
            method: 'POST',
            headers: {'content-type': 'application/json', ...headers},
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
        });
    } catch (error) {
        logLicenseEvent('LIC_ACCOUNT_NETWORK', {event: 'request_failed', path, reason: (error as Error).name});
        return null;
    }
    let parsed: unknown = null;
    try {
        parsed = await response.json();
    } catch {
        parsed = null;
    }
    return {status: response.status, body: parsed};
}

/**
 * 邮箱 + 密码登录。
 * - 成功（无 MFA）：持久化令牌、缓存 profile，返回 `ok:true`；
 * - 待二因子：返回 `mfaRequired:true` + 票据（不持久化令牌）；
 * - 失败/网络：分别归 `auth` / `network` 类，统一文案，不暴露原因。
 */
export async function login(email: string, password: string): Promise<AccountAuthResult> {
    const e = (email || '').trim();
    const p = password || '';
    if (!e || !p) {
        return {ok: false, category: 'auth', error: ACCOUNT_PUBLIC_ERROR_KEY};
    }
    const res = await postJson(
        LOGIN_API_PATH,
        {email: e, password: p},
        LOGIN_TIMEOUT_MS,
    );
    if (!res) return {ok: false, category: 'network', error: ACCOUNT_PUBLIC_NETWORK_ERROR_KEY};
    const parsed = parseAuth(res.body, res.status);
    if (!parsed) {
        logLicenseEvent('LIC_ACCOUNT_REJECTED', {event: 'login_rejected', status: res.status});
        return {ok: false, category: 'auth', error: ACCOUNT_PUBLIC_ERROR_KEY};
    }
    if (parsed.mfaRequired) {
        return {
            ok: false,
            mfaRequired: true,
            mfaTicket: parsed.mfaTicket,
            mfaMethods: parsed.mfaMethods,
        };
    }
    if (!parsed.token) {
        logLicenseEvent('LIC_ACCOUNT_REJECTED', {event: 'login_no_token'});
        return {ok: false, category: 'auth', error: ACCOUNT_PUBLIC_ERROR_KEY};
    }
    persistToken(parsed.token);
    cachedProfile = mapProfile(parsed.user);
    return {ok: true, token: parsed.token, profile: cachedProfile};
}

/**
 * 第二因子校验：用登录票据 + 动态码/邮箱码换取真令牌。
 * 成功后持久化令牌、缓存 profile；任何失败归 `auth` 类（不暴露「票据无效 / 码错」等细分）。
 */
export async function verifyMfa(ticket: string, code: string): Promise<AccountAuthResult> {
    const t = (ticket || '').trim();
    const c = (code || '').trim();
    if (!t || !c) {
        return {ok: false, category: 'auth', error: ACCOUNT_PUBLIC_ERROR_KEY};
    }
    const res = await postJson(
        MFA_VERIFY_API_PATH,
        {ticket: t, code: c},
        MFA_VERIFY_TIMEOUT_MS,
    );
    if (!res) return {ok: false, category: 'network', error: ACCOUNT_PUBLIC_NETWORK_ERROR_KEY};
    const parsed = parseAuth(res.body, res.status);
    if (!parsed || !parsed.token) {
        logLicenseEvent('LIC_ACCOUNT_REJECTED', {event: 'mfa_verify_rejected', status: res?.status ?? -1});
        return {ok: false, category: 'auth', error: ACCOUNT_PUBLIC_ERROR_KEY};
    }
    persistToken(parsed.token);
    cachedProfile = mapProfile(parsed.user);
    return {ok: true, token: parsed.token, profile: cachedProfile};
}

/**
 * 登出：best-effort 通知服务端（令所有令牌失效），无论成败都清本地令牌与缓存。
 * 不抛：登出是本地为主的操作，网络失败也应立即清本地态。
 */
export async function logout(): Promise<void> {
    const token = getPersistedAccessToken();
    if (token) {
        const cfg = getConfig();
        try {
            await fetch(`${cfg.serviceBaseUrl}${LOGOUT_API_PATH}`, {
                method: 'POST',
                headers: {Authorization: `Bearer ${token.trim()}`},
                signal: AbortSignal.timeout(Math.max(1000, LOGOUT_TIMEOUT_MS)),
            });
        } catch (error) {
            logLicenseEvent('LIC_ACCOUNT_NETWORK', {event: 'logout_request_failed', reason: (error as Error).name});
        }
    }
    persistToken(null);
    cachedProfile = null;
}

/**
 * 当前用户资料：优先命中内存缓存；未命中且持令牌时兜底 `/me`（best-effort，失败返回 null）。
 * 渲染层据此展示「已登录为 xxx@email」与登录态，安全边界（权益）仍由主进程 gate 兜底。
 */
export async function getProfile(): Promise<AccountProfile | null> {
    if (cachedProfile) return cachedProfile;
    const token = getPersistedAccessToken();
    if (!token) return null;
    const cfg = getConfig();
    try {
        const response = await fetch(`${cfg.serviceBaseUrl}${ME_API_PATH}`, {
            method: 'GET',
            headers: {Authorization: `Bearer ${token.trim()}`},
            signal: AbortSignal.timeout(Math.max(1000, ME_TIMEOUT_MS)),
        });
        if (!response.ok) return null;
        const body = await response.json();
        const data = (body && typeof body === 'object' && (body as Record<string, unknown>).data
            ? (body as Record<string, unknown>).data
            : body) as unknown;
        cachedProfile = mapProfile(data);
        return cachedProfile;
    } catch (error) {
        logLicenseEvent('LIC_ACCOUNT_NETWORK', {event: 'me_request_failed', reason: (error as Error).name});
        return null;
    }
}
