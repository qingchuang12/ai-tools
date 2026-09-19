/**
 * 兑换请求/响应契约单测（`fetchRedeem`）
 *
 * 覆盖：服务端统一壳（`$.data.signedToken`）与扁平结构的兼容、`serverTime` 透传、
 * 请求体字段（`customerEmail` 必填；不再发已废弃的 `customerId`/`sku`）、
 * 网络失败与拒绝路径的分类（network vs license）。
 *
 * 说明：服务端所有端点经 `ApiResponseAdvice` 包壳（`{success, code, data, traceId, timestamp}`），
 * 直读 `$.signedToken` 会取不到 token —— 这里用真实壳结构锁住该契约。
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

const hoisted = vi.hoisted(() => ({
    config: {
        serviceBaseUrl: 'https://billing.example.test',
        redeemTimeoutMs: 15000,
    },
    mid: 'AAAA-BBBB-CCCC-DDDD',
}));

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
}));

const {fetchRedeem} = await import('../main/license/redeem');

/** 服务端成功响应（统一壳） */
function envelope(data: Record<string, unknown>): Record<string, unknown> {
    return {success: true, code: 'SUCCESS', data, traceId: 'abc123', timestamp: '2026-09-18T12:00:00.123'};
}

interface Captured {
    url?: string;
    body?: Record<string, unknown>;
}

let captured: Captured = {};

function stubFetch(impl: (url: string) => {status?: number; json: unknown; throws?: boolean}): void {
    captured = {};
    vi.stubGlobal('fetch', async (url: string, init?: {body?: string}) => {
        captured.url = String(url);
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

beforeEach(() => {
    captured = {};
});

describe('fetchRedeem 请求体（与服务端 RedeemCodeRequest 对齐）', () => {
    it('上送 code / customerEmail / machineId，不再发 customerId 与 sku', async () => {
        stubFetch(() => ({json: envelope({success: true, signedToken: 'a.b.c'})}));
        const r = await fetchRedeem(' RC-1 ', ' Buyer@Example.com ');
        expect(r.ok).toBe(true);
        expect(captured.body).toEqual({
            code: 'RC-1',
            customerEmail: 'Buyer@Example.com',
            machineId: hoisted.mid,
        });
        expect(captured.body).not.toHaveProperty('customerId');
        expect(captured.body).not.toHaveProperty('sku');
    });

    it('邮箱为空：不发请求，返回统一文案的 license 类失败', async () => {
        stubFetch(() => ({json: envelope({signedToken: 'a.b.c'})}));
        const r = await fetchRedeem('RC-1', '   ');
        expect(r.ok).toBe(false);
        expect(r.category).toBe('license');
        expect(captured.url).toBeUndefined();
    });
});

describe('fetchRedeem 响应解析', () => {
    it('统一壳：从 $.data 取 signedToken 与 serverTime', async () => {
        stubFetch(() => ({
            json: envelope({
                success: true,
                licenseKey: '2F8A-7C31-9D04-B5E6',
                signedToken: 'h.p.s',
                expiresAt: '2027-09-18T12:00:00',
                serverTime: 1758000000000,
            }),
        }));
        const r = await fetchRedeem('RC-1', 'buyer@example.com');
        expect(r.ok).toBe(true);
        expect(r.token).toBe('h.p.s');
        expect(r.serverTimeMs).toBe(1758000000000);
    });

    it('兼容扁平结构（无 data 段）', async () => {
        stubFetch(() => ({json: {success: true, signedToken: 'flat.token.sig', serverTime: 1758000000001}}));
        const r = await fetchRedeem('RC-1', 'buyer@example.com');
        expect(r.ok).toBe(true);
        expect(r.token).toBe('flat.token.sig');
        expect(r.serverTimeMs).toBe(1758000000001);
    });

    it('壳内 success=true 但 data 无 signedToken → 拒绝', async () => {
        stubFetch(() => ({json: envelope({success: true, licenseKey: 'X'})}));
        const r = await fetchRedeem('RC-1', 'buyer@example.com');
        expect(r.ok).toBe(false);
        expect(r.category).toBe('license');
    });

    it('HTTP 400（统一错误体）→ 拒绝且归为 license 类', async () => {
        stubFetch(() => ({
            status: 400,
            json: {timestamp: '2026-09-18T12:00:00', errorCode: 'EMAIL_REQUIRED', message: '邮箱必填', success: false},
        }));
        const r = await fetchRedeem('RC-1', 'buyer@example.com');
        expect(r.ok).toBe(false);
        expect(r.category).toBe('license');
    });

    it('响应体非 JSON → 归为 license 类（不误报网络问题）', async () => {
        vi.stubGlobal('fetch', async () => ({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError('Unexpected token < in JSON');
            },
        }));
        const r = await fetchRedeem('RC-1', 'buyer@example.com');
        expect(r.ok).toBe(false);
        expect(r.category).toBe('license');
    });

    it('网络异常/超时 → 单独归为 network 类（避免用户把断网误判为激活码错误）', async () => {
        stubFetch(() => ({json: {}, throws: true}));
        const r = await fetchRedeem('RC-1', 'buyer@example.com');
        expect(r.ok).toBe(false);
        expect(r.category).toBe('network');
        expect(r.error).toBe('license.errors.network');
    });
});
