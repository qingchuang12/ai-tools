/**
 * 支付后自动到账轮询单测（plan-1.0 / C4，`src/main/license/purchase-poll.ts`）。
 *
 * 覆盖：
 *  1. 到点即领：命中等档位授权 → 调 claim（落盘动作由门面注入）→ 轮询收场
 *  2. 档位过滤：公共服务下同机买过别的产品 → 不领取、继续轮询（productSku 缺失按可领处理）
 *  3. claim 返回 false（本地验签不过）→ 不算到账，继续轮询
 *  4. 窗口（30 分钟）耗尽 → 自动停止，不留后台定时器
 *  5. 单实例：重复打开收银台只重置窗口，不叠加循环（否则会把服务端限流打满）
 *  6. 未注册 claim（门面未初始化）→ 根本不启动
 *  7. 红线 1：网络异常 / 429 / 畸形响应一律静默，状态不变、下一轮再问
 *
 * 用 fake timers 驱动 60s 心跳；`fetchPendingLicenses` 走真实实现（桩全局 fetch），
 * 顺带锁住「pending → 轮询」这条链路的请求拼装口径。
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_LICENSE_CONFIG, PURCHASE_POLL_INTERVAL_MS, PURCHASE_POLL_WINDOW_MS} from '../main/license/constants';
import type {LicenseConfig} from '../main/license/types';

const mocks = vi.hoisted(() => ({
    config: {} as LicenseConfig,
    mid: 'POLL-AAAA-BBBB-CCCC',
}));

vi.mock('electron', () => ({
    safeStorage: {
        isEncryptionAvailable: (): boolean => true,
        encryptString: (s: string): Buffer => Buffer.from(`safe:${s}`, 'utf-8'),
        decryptString: (b: Buffer): string => b.toString('utf-8').replace(/^safe:/, ''),
    },
    dialog: {showOpenDialog: async () => ({canceled: true, filePaths: [] as string[]})},
}));

vi.mock('../main/license/config', () => ({
    getConfig: (): LicenseConfig => mocks.config,
}));

vi.mock('../main/license/machine-code', () => ({
    getMachineCode: async (): Promise<string> => mocks.mid,
    getMachineCodePair: async (): Promise<{strong: string; soft: string}> => ({strong: mocks.mid, soft: 'SOFT'}),
    warmupMachineCode: (): void => undefined,
}));

const {isPollingForPurchase, setPurchaseClaimHandler, startPurchasePolling, stopPurchasePolling} = await import(
    '../main/license/purchase-poll'
);

function defaultConfig(): LicenseConfig {
    const d = DEFAULT_LICENSE_CONFIG;
    return {
        ...d,
        sku: 'pro-buyout',
        acceptedSkus: ['pro-buyout', 'pro-subscription'],
        serviceBaseUrl: 'https://billing.example.test',
        recheck: {...d.recheck},
    };
}

let pendingCalls = 0;

/** 返回一批待领取授权；`opts` 控制条数/档位/异常形态 */
function stubPending(
    items: Array<{licenseKey: string; signedToken: string; productSku?: string | null}>,
    opts: {status?: number; throws?: boolean; jsonThrows?: boolean} = {},
): void {
    pendingCalls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
        if (String(url).includes('/api/licenses/pending')) pendingCalls += 1;
        if (opts.throws) throw new Error('ECONNREFUSED');
        return {
            ok: (opts.status ?? 200) < 400,
            status: opts.status ?? 200,
            headers: {get: (): null => null},
            json: async () => {
                if (opts.jsonThrows) throw new SyntaxError('not json');
                return {success: true, code: 'SUCCESS', data: {licenses: items}};
            },
        };
    });
}

afterEach(() => {
    stopPurchasePolling();
    setPurchaseClaimHandler(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

beforeEach(() => {
    mocks.config = defaultConfig();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
});

describe('purchase-poll：支付后自动到账', () => {
    it('1) 到点领到等档位授权 → 调 claim 并收场', async () => {
        stubPending([{licenseKey: 'LIC-1', signedToken: 'h.p.s', productSku: 'pro-buyout'}]);
        const claim = vi.fn(async (): Promise<boolean> => true);
        setPurchaseClaimHandler(claim);

        startPurchasePolling();
        expect(isPollingForPurchase()).toBe(true);

        await vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS);

        expect(claim).toHaveBeenCalledTimes(1);
        expect(claim).toHaveBeenCalledWith('h.p.s');
        expect(isPollingForPurchase()).toBe(false);
    });

    it('2) 档位不匹配不领取（productSku 缺失按可领处理），轮询继续', async () => {
        stubPending([{licenseKey: 'LIC-X', signedToken: 'x.x.x', productSku: 'other-app-sku'}]);
        const claim = vi.fn(async (): Promise<boolean> => true);
        setPurchaseClaimHandler(claim);

        startPurchasePolling();
        await vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS);
        expect(claim).not.toHaveBeenCalled();
        expect(isPollingForPurchase()).toBe(true);

        // 无 productSku 的条目：无法证伪，按可领交给 claim（claim 内部还有本地验签兜底）
        stubPending([{licenseKey: 'LIC-N', signedToken: 'n.n.n', productSku: null}]);
        await vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS);
        expect(claim).toHaveBeenCalledTimes(1);
    });

    it('3) claim 返回 false（本地验签不过）→ 不算到账，下一轮再问', async () => {
        stubPending([{licenseKey: 'LIC-BAD', signedToken: 'bad', productSku: 'pro-buyout'}]);
        const claim = vi.fn(async (): Promise<boolean> => false);
        setPurchaseClaimHandler(claim);

        startPurchasePolling();
        await vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS);
        expect(claim).toHaveBeenCalledTimes(1);
        expect(isPollingForPurchase()).toBe(true);

        await vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS);
        expect(claim).toHaveBeenCalledTimes(2);
    });

    it('4) 窗口耗尽自动停止，不留后台定时器', async () => {
        stubPending([]);
        const claim = vi.fn(async (): Promise<boolean> => true);
        setPurchaseClaimHandler(claim);

        startPurchasePolling();
        await vi.advanceTimersByTimeAsync(PURCHASE_POLL_WINDOW_MS + PURCHASE_POLL_INTERVAL_MS);

        expect(isPollingForPurchase()).toBe(false);
        expect(claim).not.toHaveBeenCalled();
        const callsAtStop = pendingCalls;
        await vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS * 3);
        expect(pendingCalls).toBe(callsAtStop);
    });

    it('5) 重复打开收银台只重置窗口，不叠加循环', async () => {
        stubPending([]);
        setPurchaseClaimHandler(async (): Promise<boolean> => false);

        startPurchasePolling();
        startPurchasePolling();
        startPurchasePolling();

        await vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS);
        // 单实例：一个心跳周期只问一次
        expect(pendingCalls).toBe(1);
        stopPurchasePolling();
        expect(isPollingForPurchase()).toBe(false);
    });

    it('6) 门面未注册 claim（未初始化）→ 不启动轮询', () => {
        stubPending([{licenseKey: 'LIC-1', signedToken: 'h.p.s'}]);
        setPurchaseClaimHandler(null);
        startPurchasePolling();
        expect(isPollingForPurchase()).toBe(false);
    });

    it('7) 红线 1：429 / 畸形 JSON / 网络异常一律静默，轮询照常继续', async () => {
        setPurchaseClaimHandler(vi.fn(async (): Promise<boolean> => true));

        for (const opts of [{status: 429}, {jsonThrows: true}, {throws: true}, {status: 500}]) {
            stubPending([], opts);
            startPurchasePolling();
            await vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS);
            // 不抛异常、不停轮询、也没东西可领
            expect(isPollingForPurchase()).toBe(true);
            stopPurchasePolling();
        }
    });
});
