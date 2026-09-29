/**
 * 兑换请求/响应契约单测（`fetchRedeem`）
 *
 * 覆盖：服务端统一壳（`$.data.signedToken`）与扁平结构的兼容、`serverTime` 透传、
 * 请求体字段（`credential` 必填、`customerEmail` 客户端仍必填；不再发已废弃的 `customerId`/`sku`）、
 * 网络失败与拒绝路径的分类（network vs license）。
 *
 * plan-1.0 追加：
 * - `fetchPendingLicenses`（C4）：按机器码领取待激活授权的请求拼装、壳解析、脏数据剔除与**全静默兜底**；
 * - `buildCheckoutUrl` / `buildAccountPageUrl`（C3）：收银台 URL 同时带 machineId 与 productId；
 * - `publicErrorFor`（C6）：服务端业务码 → 对外文案白名单，白名单外一律回落统一文案。
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

const {fetchRedeem, reportBinding, fetchPendingLicenses, buildCheckoutUrl, buildAccountPageUrl} = await import(
    '../main/license/redeem'
);
const {publicErrorFor, PUBLIC_ERROR_KEY} = await import('../main/license/errors');
const {PRODUCT_CODE} = await import('../shared/license-constants');
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

describe('fetchRedeem 请求体（与服务端 ActivateRequest 对齐）', () => {
    it('上送 code / customerEmail / machineId，不再发 customerId 与 sku', async () => {
        stubFetch(() => ({json: envelope({success: true, signedToken: 'a.b.c'})}));
        const r = await fetchRedeem(' RC-1 ', ' Buyer@Example.com ');
        expect(r.ok).toBe(true);
        expect(captured.body).toEqual({
            credential: 'RC-1',
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
            // 服务端真实错误体字段是 `code`（ApiResponse record），不是 errorCode
            json: {success: false, code: 'EMAIL_REQUIRED', message: '邮箱必填', timestamp: '2026-09-18T12:00:00'},
        }));
        const r = await fetchRedeem('RC-1', 'buyer@example.com');
        expect(r.ok).toBe(false);
        expect(r.category).toBe('license');
    });

    it('C6：换机冲突（MACHINE_MISMATCH）→ 专属文案 + 打开授权管理页动作', async () => {
        stubFetch(() => ({status: 400, json: {success: false, code: 'MACHINE_MISMATCH', message: 'bound'}}));
        const r = await fetchRedeem('LIC-BOUND-ELSEWHERE', 'buyer@example.com');
        expect(r.ok).toBe(false);
        expect(r.category).toBe('license');
        expect(r.error).toBe('license.errors.machineBound');
        expect(r.action).toBe('openAccount');
    });

    it('C6：白名单外的业务码仍回落统一文案（不给破解者定位信息）', async () => {
        stubFetch(() => ({status: 400, json: {success: false, code: 'LICENSE_NOT_FOUND', message: 'nope'}}));
        const r = await fetchRedeem('RC-1', 'buyer@example.com');
        expect(r.ok).toBe(false);
        expect(r.error).toBe('license.errors.generic');
        expect(r.action).toBeUndefined();
    });

    it('响应体非 JSON → 归为 license 类（不误报网络问题）', async () => {        vi.stubGlobal('fetch', async () => ({
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

describe('reportBinding（D2 启动旁路补绑）', () => {
    it('POST 到 /api/licenses/report-binding，上送 signedToken 与 machineId', async () => {
        stubFetch(() => ({
            json: envelope({success: true, licenseKey: '2F8A-7C31-9D04-B5E6', signedToken: 'h.p.s', serverTime: 1758000000000}),
        }));
        const r = await reportBinding('old.token.sig', hoisted.mid);
        expect(r.ok).toBe(true);
        expect(captured.url).toBe('https://billing.example.test/api/licenses/report-binding');
        expect(captured.body).toEqual({signedToken: 'old.token.sig', machineId: hoisted.mid});
        expect(r.token).toBe('h.p.s');
        expect(r.serverTimeMs).toBe(1758000000000);
    });

    it('signedToken 缺失：不发请求，归为 license 类', async () => {
        stubFetch(() => ({json: envelope({signedToken: 'x'})}));
        const r = await reportBinding('   ', hoisted.mid);
        expect(r.ok).toBe(false);
        expect(r.category).toBe('license');
        expect(captured.url).toBeUndefined();
    });

    it('HTTP 400 → 归为 license 类（不误报 network）', async () => {
        stubFetch(() => ({status: 400, json: {success: false, code: 'CREDENTIAL_NOT_FOUND'}}));
        const r = await reportBinding('old.token.sig', hoisted.mid);
        expect(r.ok).toBe(false);
        expect(r.category).toBe('license');
    });

    it('网络异常 → 归为 network 类', async () => {
        stubFetch(() => ({json: {}, throws: true}));
        const r = await reportBinding('old.token.sig', hoisted.mid);
        expect(r.ok).toBe(false);
        expect(r.category).toBe('network');
        expect(r.error).toBe('license.errors.network');
    });
});

describe('fetchPendingLicenses（plan-1.0 / C4：按机器码领取待激活授权）', () => {
    it('GET /api/licenses/pending?machineId=…，从统一壳取 data.licenses 并保留 signedToken', async () => {
        stubFetch(() => ({
            json: envelope({
                licenses: [
                    {
                        licenseKey: 'LIC-P-1',
                        signedToken: 'h.p.s',
                        productSku: 'pro-buyout',
                        expiresAt: '2027-01-01T00:00:00',
                        issuedAt: '2026-09-28T00:00:00',
                    },
                ],
                serverTime: '2026-09-28T12:00:00',
            }),
        }));

        const list = await fetchPendingLicenses('AAAA-BBBB-CCCC-DDDD');

        expect(captured.url).toBe(
            'https://billing.example.test/api/licenses/pending?machineId=AAAA-BBBB-CCCC-DDDD',
        );
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({licenseKey: 'LIC-P-1', signedToken: 'h.p.s', productSku: 'pro-buyout'});
    });

    it('机器码含特殊字符时按 URL 编码上送', async () => {
        stubFetch(() => ({json: envelope({licenses: []})}));
        await fetchPendingLicenses('a b/c');
        expect(captured.url).toContain('machineId=a%20b%2Fc');
    });

    it('剔除缺 licenseKey 或缺 signedToken 的半成品条目', async () => {
        stubFetch(() => ({
            json: envelope({
                licenses: [
                    {licenseKey: 'LIC-OK', signedToken: 'h.p.s'},
                    {licenseKey: 'LIC-NO-TOKEN', signedToken: '   '},
                    {licenseKey: '', signedToken: 'h.p.s'},
                    null,
                ],
            }),
        }));
        const list = await fetchPendingLicenses('MID');
        expect(list.map((l) => l.licenseKey)).toEqual(['LIC-OK']);
    });

    it('429 / 5xx / 畸形 JSON / 网络异常 / 空机器码 → 一律静默空数组（绝不影响授权状态）', async () => {
        for (const status of [429, 500, 404]) {
            stubFetch(() => ({status, json: {}}));
            expect(await fetchPendingLicenses('MID')).toEqual([]);
        }
        vi.stubGlobal('fetch', async () => ({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError('not json');
            },
        }));
        expect(await fetchPendingLicenses('MID')).toEqual([]);

        stubFetch(() => ({json: {}, throws: true}));
        expect(await fetchPendingLicenses('MID')).toEqual([]);

        captured = {};
        expect(await fetchPendingLicenses('   ')).toEqual([]);
        expect(captured.url).toBeUndefined();
    });
});

describe('收银台与账号页 URL（plan-1.0 / C3 + 审计 D2）', () => {
    it('收银台 URL 带 machineId 与产品码 product（档位由用户在收银台自选，不预置 productId）', async () => {
        const url = await buildCheckoutUrl();
        expect(url).toBe(
            `https://billing.example.test/checkout/index.html?machineId=${encodeURIComponent(
                hoisted.mid,
            )}&product=${encodeURIComponent(PRODUCT_CODE)}`,
        );
        expect(url).not.toContain('productId');
    });

    it('账号页 URL 指向 billing 的无密码授权管理入口', () => {
        expect(buildAccountPageUrl()).toBe('https://billing.example.test/account/');
    });
});

describe('publicErrorFor（plan-1.0 / C6：服务端业务码白名单）', () => {
    it('换机冲突 → 专属文案 + 打开授权管理页动作', () => {
        expect(publicErrorFor('MACHINE_MISMATCH')).toEqual({
            error: 'license.errors.machineBound',
            action: 'openAccount',
        });
    });

    it('已知的非冲突码 → 专属文案但无动作', () => {
        expect(publicErrorFor('LICENSE_NOT_ACTIVE')).toEqual({error: 'license.errors.notActive'});
        expect(publicErrorFor('LOGIN_REQUIRED')).toEqual({error: 'license.errors.loginRequired'});
    });

    it('未知码 / null / 空串 → 回落统一文案，不给破解者定位信息', () => {
        for (const code of ['LICENSE_NOT_FOUND', 'INTERNAL_ERROR', null, undefined, '']) {
            expect(publicErrorFor(code)).toEqual({error: PUBLIC_ERROR_KEY});
        }
    });
});
