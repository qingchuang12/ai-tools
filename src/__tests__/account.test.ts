/**
 * 账号会话模块单测（`src/main/account.ts`）+ R6 unbind 修复（`redeem.unbindPriorOnServer`）。
 *
 * 覆盖：登录成功（无 MFA，落盘 token + 解析 profile）、MFA 待二因子、verifyMfa 换真令牌、
 * 登出清令牌、401/400 归 auth、网络异常归 network、未登录直接失败；
 * 以及 `verifier.extractLicenseKeyFromToken`（仅解码 payload、不验签）与 R6 改走账号侧 Bearer 端点。
 *
 * mock 套路对齐 `license-redeem.test.ts`：`electron` / `config` / `machine-code` / `secret-store`，
 * `fetch` 用 `vi.stubGlobal` 替换；`errors` 用真实模块（自包含，仅依赖 crypto）。
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

const hoisted = vi.hoisted(() => ({
    config: {
        serviceBaseUrl: 'https://billing.example.test',
        redeemTimeoutMs: 15000,
    },
    mid: 'AAAA-BBBB-CCCC-DDDD',
}));

const memStore = new Map<string, string>();

vi.mock('electron', () => ({
    dialog: {showOpenDialog: async () => ({canceled: true, filePaths: [] as string[]})},
}));

vi.mock('../main/license/config', () => ({
    getConfig: (): unknown => hoisted.config,
    loadConfig: (): unknown => hoisted.config,
    resetConfigCache: (): void => undefined,
}));

vi.mock('../main/license/machine-code', () => ({
    getMachineCode: async (): Promise<string> => hoisted.mid,
    getMachineCodePair: async (): Promise<{strong: string; soft: string}> => ({strong: hoisted.mid, soft: 'soft'}),
}));

vi.mock('../main/secret-store', () => ({
    getSecretStore: () => ({
        getRawSecret: (id: string): string | null => memStore.get(id) ?? null,
        putRawSecret: (id: string, plaintext: string): string => {
            memStore.set(id, plaintext);
            return id;
        },
        deleteRawSecret: (id: string): void => {
            memStore.delete(id);
        },
    }),
}));

const {
    login, verifyMfa, logout, getProfile, isLoggedIn, getPersistedAccessToken,
} = await import('../main/account');
const {unbindPriorOnServer} = await import('../main/license/redeem');
const {extractLicenseKeyFromToken} = await import('../main/license/verifier');

/** 服务端统一壳 */
function envelope(data: Record<string, unknown>): Record<string, unknown> {
    return {success: true, code: 'SUCCESS', data, traceId: 'abc123', timestamp: '2026-09-18T12:00:00.123'};
}

function user(): Record<string, unknown> {
    return {id: 'u-1', email: 'buyer@example.com', emailVerified: true, status: 'ACTIVE', role: 'USER'};
}

interface Captured {
    url?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    method?: string;
}

let captured: Captured = {};

function stubFetch(impl: (url: string) => { status?: number; json: unknown; throws?: boolean }): void {
    captured = {};
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        captured.url = String(url);
        captured.method = init?.method;
        captured.headers = init?.headers;
        captured.body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        const r = impl(String(url));
        if (r.throws) throw new Error('ECONNREFUSED');
        return {
            ok: (r.status ?? 200) < 400,
            status: r.status ?? 200,
            json: async () => r.json,
        };
    });
}

const TOKEN_ID = 'account-access-token';

beforeEach(() => {
    memStore.clear();
    captured = {};
    vi.unstubAllGlobals();
});

describe('login（无 MFA）', () => {
    it('成功：落盘 token + 解析 profile，返回 ok:true', async () => {
        stubFetch(() => ({json: envelope({accessToken: 'jwt.a.b', user: user()})}));
        const r = await login('buyer@example.com', 'pw');
        expect(r.ok).toBe(true);
        expect(r.token).toBe('jwt.a.b');
        expect(r.profile?.email).toBe('buyer@example.com');
        expect(memStore.get(TOKEN_ID)).toBe('jwt.a.b');
    });

    it('邮箱/密码为空：不发请求，直接归 auth 类', async () => {
        stubFetch(() => ({json: envelope({accessToken: 'x'})}));
        const r = await login('   ', 'pw');
        expect(r.ok).toBe(false);
        expect(r.category).toBe('auth');
        expect(captured.url).toBeUndefined();
        expect(memStore.get(TOKEN_ID)).toBeUndefined();
    });

    it('HTTP 400：归 auth 类（不暴露 INVALID_CREDENTIALS）', async () => {
        stubFetch(() => ({status: 400, json: {success: false, errorCode: 'INVALID_CREDENTIALS'}}));
        const r = await login('buyer@example.com', 'wrong');
        expect(r.ok).toBe(false);
        expect(r.category).toBe('auth');
        expect(r.error).toBe('account.errors.generic');
    });

    it('网络异常：单独归 network 类', async () => {
        stubFetch(() => ({json: {}, throws: true}));
        const r = await login('buyer@example.com', 'pw');
        expect(r.ok).toBe(false);
        expect(r.category).toBe('network');
        expect(r.error).toBe('account.errors.network');
    });
});

describe('login MFA 待二因子', () => {
    it('mfaRequired=true：返回票据、不落盘 token、不泄漏 user', async () => {
        stubFetch(() => ({json: envelope({mfaRequired: true, mfaTicket: 'tick-123', mfaMethods: ['TOTP', 'EMAIL']})}));
        const r = await login('buyer@example.com', 'pw');
        expect(r.ok).toBe(false);
        expect(r.mfaRequired).toBe(true);
        expect(r.mfaTicket).toBe('tick-123');
        expect(r.mfaMethods).toEqual(['TOTP', 'EMAIL']);
        expect(r.token).toBeUndefined();
        expect(memStore.get(TOKEN_ID)).toBeUndefined();
    });
});

describe('verifyMfa', () => {
    it('成功：POST /api/account/mfa/verify，上送 ticket+code，落盘真令牌', async () => {
        stubFetch(() => ({json: envelope({accessToken: 'real.jwt.x', user: user()})}));
        const r = await verifyMfa('tick-123', '123456');
        expect(r.ok).toBe(true);
        expect(r.token).toBe('real.jwt.x');
        expect(captured.url).toBe('https://billing.example.test/api/account/mfa/verify');
        expect(captured.body).toEqual({ticket: 'tick-123', code: '123456'});
        expect(memStore.get(TOKEN_ID)).toBe('real.jwt.x');
    });

    it('票据/码为空：不发请求，归 auth 类', async () => {
        stubFetch(() => ({json: envelope({accessToken: 'x'})}));
        const r = await verifyMfa('', '123456');
        expect(r.ok).toBe(false);
        expect(captured.url).toBeUndefined();
    });

    it('HTTP 400：归 auth 类', async () => {
        stubFetch(() => ({status: 400, json: {success: false, errorCode: 'MFA_CODE_INVALID'}}));
        const r = await verifyMfa('tick-123', '000000');
        expect(r.ok).toBe(false);
        expect(r.category).toBe('auth');
    });
});

describe('logout', () => {
    it('已登录：通知服务端（带 Bearer）并清本地令牌', async () => {
        stubFetch(() => ({json: envelope({accessToken: 'jwt.a.b', user: user()})}));
        await login('buyer@example.com', 'pw');
        expect(memStore.get(TOKEN_ID)).toBe('jwt.a.b');

        stubFetch(() => ({json: {success: true}}));
        await logout();
        expect(memStore.get(TOKEN_ID)).toBeUndefined();
        expect(captured.url).toBe('https://billing.example.test/api/account/logout');
        expect(captured.headers?.Authorization).toBe('Bearer jwt.a.b');
        expect(await isLoggedIn()).toBe(false);
    });

    it('未登录：直接清本地态，不调服务端', async () => {
        await logout();
        expect(captured.url).toBeUndefined();
        expect(memStore.get(TOKEN_ID)).toBeUndefined();
    });
});

describe('isLoggedIn / getProfile', () => {
    it('登录后 isLoggedIn=true 且 getProfile 命中缓存', async () => {
        stubFetch(() => ({json: envelope({accessToken: 'jwt.a.b', user: user()})}));
        await login('buyer@example.com', 'pw');
        expect(await isLoggedIn()).toBe(true);
        captured = {};
        const p = await getProfile();
        expect(p?.email).toBe('buyer@example.com');
        // 命中缓存：不应触发 /me
        expect(captured.url).toBeUndefined();
    });

    it('未登录 getProfile 返回 null', async () => {
        // 清掉跨测试残留的内存 profile 缓存（logout 在 memStore 为空时不会发起网络请求）
        await logout();
        const p = await getProfile();
        expect(p).toBeNull();
    });
});

describe('extractLicenseKeyFromToken（仅解码 payload、不验签）', () => {
    it('从合法 3 段 token 解出 lic', () => {
        const payload = Buffer.from(JSON.stringify({lic: 'LIC-2F8A-7C31', sku: 'PRO', mid: 'm', exp: 9999999999})).toString('base64url');
        const token = `h.${payload}.s`;
        expect(extractLicenseKeyFromToken(token)).toBe('LIC-2F8A-7C31');
    });

    it('非 3 段 / 无 lic：返回 null', () => {
        expect(extractLicenseKeyFromToken('only.two')).toBeNull();
        const payload = Buffer.from(JSON.stringify({sku: 'PRO'})).toString('base64url');
        expect(extractLicenseKeyFromToken(`h.${payload}.s`)).toBeNull();
        expect(extractLicenseKeyFromToken('')).toBeNull();
    });
});

describe('R6 unbindPriorOnServer（修复后走账号侧 Bearer 端点）', () => {
    it('带 Bearer 调 /api/account/licenses/{key}/unbind，空 body，返回 true', async () => {
        stubFetch(() => ({json: {success: true}}));
        const ok = await unbindPriorOnServer('tok-xyz', 'LIC-2F8A-7C31');
        expect(ok).toBe(true);
        expect(captured.url).toBe('https://billing.example.test/api/account/licenses/LIC-2F8A-7C31/unbind');
        expect(captured.headers?.Authorization).toBe('Bearer tok-xyz');
        expect(captured.body).toEqual({});
    });

    it('accessToken 或 licenseKey 为空：不发请求，返回 false', async () => {
        stubFetch(() => ({json: {success: true}}));
        expect(await unbindPriorOnServer('', 'LIC-1')).toBe(false);
        expect(await unbindPriorOnServer('tok', '  ')).toBe(false);
        expect(captured.url).toBeUndefined();
    });

    it('HTTP 403（未授权/非本人）：归 false（best-effort 不抛）', async () => {
        stubFetch(() => ({status: 403, json: {success: false}}));
        expect(await unbindPriorOnServer('tok', 'LIC-1')).toBe(false);
    });

    it('网络异常：归 false', async () => {
        stubFetch(() => ({json: {}, throws: true}));
        expect(await unbindPriorOnServer('tok', 'LIC-1')).toBe(false);
    });
});
