/**
 * 本账号授权列表契约单测（`fetchMyLicenses`）
 *
 * 覆盖：Bearer 头、服务端统一壳（`$.data` 为数组）与扁平数组兼容、字段归一、
 * 空/失败路径。契约见 `billing-license-service` 的 `AccountAssetController.myLicenses()`
 * 与 `LicenseResponse`（`/api/account/licenses`，Bearer）。
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

const hoisted = vi.hoisted(() => ({
    config: {serviceBaseUrl: 'https://billing.example.test', redeemTimeoutMs: 15000},
}));

vi.mock('electron', () => ({
    dialog: {showOpenDialog: async () => ({canceled: true, filePaths: [] as string[]})},
}));

vi.mock('../main/license/config', () => ({
    getConfig: (): unknown => hoisted.config,
    loadConfig: (): unknown => hoisted.config,
    resetConfigCache: (): void => undefined,
}));

const {fetchMyLicenses} = await import('../main/license/redeem');

function envelope(data: unknown): Record<string, unknown> {
    return {success: true, code: 'SUCCESS', data, traceId: 'abc123', timestamp: '2026-09-18T12:00:00.123'};
}

interface Captured {
    url?: string;
    headers?: Record<string, string>;
}

let captured: Captured = {};

function stubFetch(impl: (url: string) => {status?: number; json: unknown; throws?: boolean}): void {
    captured = {};
    vi.stubGlobal('fetch', async (url: string, init?: {headers?: Record<string, string>}) => {
        captured.url = String(url);
        captured.headers = init?.headers as Record<string, string> | undefined;
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

describe('fetchMyLicenses 请求', () => {
    it('GET 到 /api/account/licenses 并带 Bearer 头', async () => {
        stubFetch(() => ({json: envelope([])}));
        await fetchMyLicenses('tok-123');
        expect(captured.url).toBe('https://billing.example.test/api/account/licenses');
        expect(captured.headers?.Authorization).toBe('Bearer tok-123');
    });

    it('未登录（无 token）：直接返回 null，不发请求', async () => {
        stubFetch(() => ({json: envelope([])}));
        const r = await fetchMyLicenses('');
        expect(r).toBeNull();
        expect(captured.url).toBeUndefined();
    });
});

describe('fetchMyLicenses 响应解析', () => {
    it('统一壳：从 $.data 取数组并归一字段', async () => {
        stubFetch(() => ({
            json: envelope([
                {licenseKey: 'LIC-A', status: 'ACTIVE', machineCode: null, customerEmail: 'a@b.com'},
                {licenseKey: 'LIC-B', status: 'EXPIRED', machineCode: 'ZZZZ', customerEmail: 'c@d.com'},
            ]),
        }));
        const r = await fetchMyLicenses('tok');
        expect(r).toEqual([
            {licenseKey: 'LIC-A', status: 'ACTIVE', machineCode: null, customerEmail: 'a@b.com'},
            {licenseKey: 'LIC-B', status: 'EXPIRED', machineCode: 'ZZZZ', customerEmail: 'c@d.com'},
        ]);
    });

    it('兼容扁平数组（无 data 段）', async () => {
        stubFetch(() => ({
            json: [{licenseKey: 'LIC-C', status: 'ACTIVE', machineCode: null, customerEmail: null}],
        }));
        const r = await fetchMyLicenses('tok');
        expect(r).toEqual([
            {licenseKey: 'LIC-C', status: 'ACTIVE', machineCode: null, customerEmail: null},
        ]);
    });

    it('空数组：返回 [] 而非 null', async () => {
        stubFetch(() => ({json: envelope([])}));
        const r = await fetchMyLicenses('tok');
        expect(r).toEqual([]);
    });

    it('无 data 段且非数组 → 返回 []', async () => {
        stubFetch(() => ({json: {success: true, code: 'SUCCESS'}}));
        const r = await fetchMyLicenses('tok');
        expect(r).toEqual([]);
    });

    it('HTTP 401/非 2xx → 返回 null（调用方按重试处理）', async () => {
        stubFetch(() => ({status: 401, json: {success: false}}));
        const r = await fetchMyLicenses('tok');
        expect(r).toBeNull();
    });

    it('网络异常 → 返回 null', async () => {
        stubFetch(() => ({json: {}, throws: true}));
        const r = await fetchMyLicenses('tok');
        expect(r).toBeNull();
    });

    it('条目缺 licenseKey → 被过滤掉', async () => {
        stubFetch(() => ({
            json: envelope([
                {status: 'ACTIVE'},
                {licenseKey: 'OK', status: 'ACTIVE', machineCode: null, customerEmail: null},
            ]),
        }));
        const r = await fetchMyLicenses('tok');
        expect(r).toEqual([
            {licenseKey: 'OK', status: 'ACTIVE', machineCode: null, customerEmail: null},
        ]);
    });
});
