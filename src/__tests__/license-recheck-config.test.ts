/**
 * 复核节奏参数包外化单测（plan-1.0 / C7，`mergeConfig` 的 `recheck` 段）。
 *
 * 守两件事：
 * 1. **可调不发版**：六个键（enabled/intervalMs/retryMs/offlineGraceDays/hardStopDays/timeoutMs）
 *    都能从包外 `license.config.json` 覆盖；
 * 2. **误配不致命**：非法值回落默认、下限保护（1s）、两段时间阈值必须盖过一个完整复核周期——
 *    否则「用户只是隔了一个周期没开机」就会在下次启动被提醒甚至停用（结构性误杀）。
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_LICENSE_CONFIG} from '../main/license/constants';
import type {LicenseConfig} from '../main/license/types';

vi.mock('electron', () => ({
    app: {isPackaged: false, getAppPath: (): string => process.cwd(), getPath: (): string => process.cwd()},
    safeStorage: {isEncryptionAvailable: (): boolean => false},
    dialog: {showOpenDialog: async () => ({canceled: true, filePaths: [] as string[]})},
}));

const {mergeConfig} = (await import('../main/license/config')) as {mergeConfig: (raw: unknown) => LicenseConfig};

const DAY_MS = 86_400_000;

function recheckOf(raw: Record<string, unknown>): LicenseConfig['recheck'] {
    return mergeConfig({recheck: raw}).recheck;
}

beforeEach(() => {
    vi.stubGlobal('fetch', async () => ({status: 404, headers: {get: (): null => null}, json: async () => ({})}));
});

describe('mergeConfig：recheck 段包外化与兜底', () => {
    it('1) 缺省即 plan-1.0 节奏：15 天心跳 / 2 小时失败重试 / 30 天提醒 / 60 天失效', () => {
        const rc = mergeConfig({}).recheck;
        expect(rc.enabled).toBe(true);
        expect(rc.intervalMs).toBe(15 * DAY_MS);
        expect(rc.retryMs).toBe(2 * 60 * 60 * 1000);
        expect(rc.offlineGraceDays).toBe(30);
        expect(rc.hardStopDays).toBe(60);
        // 提醒段必须严格盖过一个复核周期（默认口径自洽，不依赖 clamp 才成立）
        expect(rc.offlineGraceDays).toBeGreaterThan(Math.ceil(rc.intervalMs / DAY_MS));
        expect(rc.hardStopDays).toBeGreaterThan(rc.offlineGraceDays);
    });

    it('2) 六键均可覆盖（调节奏不必发版）；已废弃的 rateLimitedRetryMs 残留键被忽略', () => {
        const rc = recheckOf({
            enabled: false,
            intervalMs: DAY_MS,
            retryMs: 600_000,
            offlineGraceDays: 45,
            hardStopDays: 90,
            timeoutMs: 12_000,
            // plan-1.0 审计 D3：429 与 unknown 同走 retryMs；老包外配置里残留的这键不再被读
            rateLimitedRetryMs: 900_000,
        });
        expect(rc).toEqual({
            enabled: false,
            intervalMs: DAY_MS,
            retryMs: 600_000,
            offlineGraceDays: 45,
            hardStopDays: 90,
            timeoutMs: 12_000,
        });
    });

    it('3) 提醒段小于「一个周期 + 缓冲」→ 抬到下限（防「隔周期没开机就被误杀」）', () => {
        const minDays = Math.ceil(DEFAULT_LICENSE_CONFIG.recheck.intervalMs / DAY_MS) + 5; // 15 + 5 = 20
        expect(recheckOf({offlineGraceDays: 1}).offlineGraceDays).toBe(minDays);
        // 停用段不得早于提醒段
        expect(recheckOf({offlineGraceDays: 40, hardStopDays: 7}).hardStopDays).toBe(40);
    });

    it('4) 心跳调大时下限同步抬升（配置组合永远盖过一个周期）', () => {
        const rc = recheckOf({intervalMs: 30 * DAY_MS, offlineGraceDays: 10, hardStopDays: 12});
        expect(rc.offlineGraceDays).toBe(35);
        expect(rc.hardStopDays).toBe(35);
    });

    it('5) 非法/越界值回落默认，且时间类下限 1s（配置笔误不会变成「狂打服务端」）', () => {
        const rc = recheckOf({intervalMs: 'NaN', timeoutMs: -5, retryMs: 0, offlineGraceDays: 'x'});
        expect(rc.intervalMs).toBe(DEFAULT_LICENSE_CONFIG.recheck.intervalMs);
        expect(rc.timeoutMs).toBe(1000);
        expect(rc.retryMs).toBe(1000);
        expect(rc.offlineGraceDays).toBe(DEFAULT_LICENSE_CONFIG.recheck.offlineGraceDays);
        // recheck 段整体写成非对象 → 全段沿用默认
        expect(mergeConfig({recheck: 'oops'}).recheck).toEqual(DEFAULT_LICENSE_CONFIG.recheck);
    });
});
