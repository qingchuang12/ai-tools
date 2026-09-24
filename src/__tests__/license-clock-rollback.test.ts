/**
 * 付费态时钟回拨回归（plan-2.4 · C7）
 *
 * 背景：付费激活时 `getState()` 走早期返回，**不推进 trial 水印**，
 * 而 redeem 的 `serverTime` 此前只抬高试用下界 —— 于是「订阅物理过期后把系统时间调回过去」
 * 就能让已失效的授权复活，且云同步等 gate 一并放行。
 *
 * 防护（本文件守的行为）：付费账本自带单调时钟 + `serverTime` 下界，两者并入 `effectiveNow()`，
 * 与试用共用同一个时间出口；`licenseFloor()` 负责从付费账本取出下界。
 *
 * 隔离：所有文件写在临时 HOME 下，不碰用户真实的 ~/.ai-tools。
 */

import {sign} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {TEST_KEY_PAIR} from './helpers/license-test-keys';

const mocks = vi.hoisted(() => ({
    config: {
        version: 1 as const,
        sku: 'pro-subscription',
        acceptedSkus: ['pro-buyout', 'pro-subscription'],
        skuFeatures: {'pro-buyout': ['cloud_sync'], 'pro-subscription': ['cloud_sync']} as Record<string, string[]>,
        defaultKid: 'default',
        serviceBaseUrl: 'https://billing.example.test',
        redeemTimeoutMs: 15000,
        trial: {days: 60, maxRuns: null as number | null},
        clock: {skewToleranceMs: 2 * 60 * 60 * 1000, useServerTimeFloor: true},
        grace: {hardwareChangeDays: 7, maxAutoGrace: 1},
        features: {proFeature: 'pro', gated: ['cloud_sync', 'remote_connect']},
        // 本文件早于 plan-7.0 复核特性编写，不覆盖停用闸门：关掉开关使 isDisabledByRecheck 恒 false，
        // 精确还原复核接入前的判定行为（与用例 13 的开关测试正交，避免误伤既有断言）。
        recheck: {enabled: false, intervalMs: 86400000, offlineGraceDays: 7, timeoutMs: 8000, rateLimitedRetryMs: 3600000},
    },
    strong: 'AAAA-BBBB-CCCC-DDDD',
    soft: 'AAAA-BBBB-CCCC-EEEE',
    home: '',
}));

vi.mock('electron', () => ({
    safeStorage: {
        isEncryptionAvailable: (): boolean => true,
        encryptString: (s: string): Buffer => Buffer.from(`safe:${s}`, 'utf-8'),
        decryptString: (b: Buffer): string => {
            const text = b.toString('utf-8');
            if (!text.startsWith('safe:')) throw new Error('BAD_CIPHERTEXT');
            return text.slice(5);
        },
    },
    dialog: {showOpenDialog: async () => ({canceled: true, filePaths: [] as string[]})},
}));

vi.mock('../main/license/config', () => ({
    getConfig: (): unknown => mocks.config,
    loadConfig: (): unknown => mocks.config,
    resetConfigCache: (): void => undefined,
    resolveExternalLicenseDir: (): string => '',
    resolveAsarAssetsDir: (): string => '',
}));

vi.mock('../main/license/machine-code', () => ({
    getMachineCodePair: async (): Promise<{strong: string; soft: string}> => ({strong: mocks.strong, soft: mocks.soft}),
    getMachineCode: async (): Promise<string> => mocks.strong,
    getHardwareFactors: async () => ({cpu: 'CPU1', disk: 'DISK1', board: 'BOARD1', osGuid: 'GUID1'}),
    warmupMachineCode: (): void => undefined,
}));

vi.mock('../main/license/keys', async () => {
    const {TEST_KEY_PAIR: pair} = await import('./helpers/license-test-keys');
    return {
        getPublicKey: (kid: string): unknown => (kid === 'default' ? pair.publicKey : null),
        clearKeyCache: (): void => undefined,
    };
});

// ── 隔离必须在被测模块被 import 之前生效（vault 路径在模块加载时就算好）────────
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-clock-'));
mocks.home = tmpHome;
vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);

const {readVault, writeVault} = await import('../main/license/vault');
const {licenseFloor, raiseLicenseServerFloor, raiseLicenseWatermark, LICENSE_WATERMARK_STEP_MS} = await import(
    '../main/license/trial'
);
const license = await import('../main/license');

/** 签一张「当时有效」的订阅令牌 */
function makeToken(expSec: number): string {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');
    const header = b64({alg: 'EdDSA', typ: 'JWT', kid: 'default'});
    const payload = b64({
        jti: 'jti-clock-rollback',
        sku: 'pro-subscription',
        mid: mocks.strong,
        iat: expSec - 30 * 86400,
        exp: expSec,
        feat: ['OFFLINE'],
    });
    const sig = sign(null, Buffer.from(`${header}.${payload}`, 'utf-8'), TEST_KEY_PAIR.privateKey);
    return `${header}.${payload}.${sig.toString('base64url')}`;
}

function wipeHome(): void {
    for (const entry of fs.readdirSync(tmpHome)) {
        fs.rmSync(path.join(tmpHome, entry), {recursive: true, force: true});
    }
}

describe('licenseFloor（付费账本时间下界）', () => {
    it('取 watermark 与 server_time_floor 的较大值；两者都缺失时为 null', () => {
        const base = {signed_token: null, activated_at: null, mid_at_activation: null, mid_soft_at_activation: null};
        expect(licenseFloor(null)).toBeNull();
        expect(licenseFloor(base)).toBeNull();
        expect(licenseFloor({...base, watermark: 1000})).toBe(1000);
        expect(licenseFloor({...base, server_time_floor: 3000})).toBe(3000);
        expect(licenseFloor({...base, watermark: 5000, server_time_floor: 3000})).toBe(5000);
    });

    it('付费水印只增不减，且步进内不落盘', () => {
        const base = {signed_token: null, activated_at: null, mid_at_activation: null, mid_soft_at_activation: null};
        const T0 = 1_000_000_000;
        expect(raiseLicenseWatermark(base, T0)).toEqual({...base, watermark: T0});
        // 步进内：避免每次 IPC 复算都重写 vault
        expect(raiseLicenseWatermark({...base, watermark: T0}, T0 + LICENSE_WATERMARK_STEP_MS - 1)).toBeNull();
        // 回拨：不倒退
        expect(raiseLicenseWatermark({...base, watermark: T0}, T0 - 10 * 86400_000)).toBeNull();
        expect(raiseLicenseServerFloor({...base, server_time_floor: T0}, T0 - 1)).toBeNull();
        expect(raiseLicenseServerFloor(base, T0)).toEqual({...base, server_time_floor: T0});
    });
});

describe('付费态时钟回拨', () => {
    beforeEach(() => {
        wipeHome();
        vi.useFakeTimers();
    });

    afterAll(() => {
        vi.useRealTimers();
    });

    it('订阅过期后再把系统时间调回过去：状态仍是未激活（expired），且 gate 关闭', async () => {
        const T0 = Date.UTC(2026, 8, 1);
        const EXPIRE = T0 + 30 * 86400_000;
        vi.setSystemTime(T0);
        const token = makeToken(Math.floor(EXPIRE / 1000));
        await writeVault({
            trial: null,
            license: {
                signed_token: token,
                activated_at: T0,
                mid_at_activation: mocks.strong,
                mid_soft_at_activation: mocks.soft,
            },
        });

        // 有效期内：正常激活
        vi.setSystemTime(T0 + 10 * 86400_000);
        const active = await license.getState(null);
        expect(active.status).toBe('activated');

        // 物理过期
        vi.setSystemTime(EXPIRE + 2 * 86400_000);
        const expired = await license.getState(null);
        expect(expired.status).toBe('inactive');
        expect(expired.degraded).toBe('expired');

        // 把系统时间调回有效期内 —— 修补贴的前提场景，必须仍然拦住
        vi.setSystemTime(T0 + 20 * 86400_000);
        const rolledBack = await license.getState(null);
        expect(rolledBack.status).toBe('inactive');
        expect(rolledBack.degraded).toBe('expired');
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(false);

        // 付费水印已落到 vault 里（「见过的最新时间」不丢）
        const stored = await readVault();
        expect(stored.license?.watermark).toBeGreaterThan(EXPIRE);
    });

    it('服务端的 serverTime 下界同样生效：本地时钟落后于服务器也拦得住', async () => {
        const EXPIRE = Date.UTC(2026, 8, 20);
        const SERVER_NOW = EXPIRE + 5 * 86400_000;
        const token = makeToken(Math.floor(EXPIRE / 1000));
        await writeVault({
            trial: null,
            license: {
                signed_token: token,
                activated_at: Date.UTC(2026, 7, 20),
                mid_at_activation: mocks.strong,
                mid_soft_at_activation: mocks.soft,
                server_time_floor: SERVER_NOW,
            },
        });

        // 本地时钟被调到过期之前，但服务端下界已经越过到期时间
        vi.setSystemTime(EXPIRE - 3 * 86400_000);
        const state = await license.getState(null);
        expect(state.status).toBe('inactive');
        expect(state.degraded).toBe('expired');
    });

    it('有效期内不受影响：没过期就是没过期', async () => {
        const T0 = Date.UTC(2026, 8, 1);
        const EXPIRE = T0 + 30 * 86400_000;
        vi.setSystemTime(T0);
        const token = makeToken(Math.floor(EXPIRE / 1000));
        await writeVault({
            trial: null,
            license: {
                signed_token: token,
                activated_at: T0,
                mid_at_activation: mocks.strong,
                mid_soft_at_activation: mocks.soft,
            },
        });

        vi.setSystemTime(T0 + 5 * 86400_000);
        const state = await license.getState(null);
        expect(state.status).toBe('activated');
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(true);
    });
});
