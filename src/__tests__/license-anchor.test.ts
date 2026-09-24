/**
 * R2（plan-2.7）：vault 外高水位锚。
 *
 * 攻击场景：激活 → 订阅过期（期间锚被推高）→ 攻击者用**过期前的 vault 备份**覆盖回去 +
 * 把系统时间拨回。vault 内的水印/下界随之复位，但锚文件独立存在，
 * `effectiveNow` 取到锚里的高水位 → 依旧判过期。
 *
 * 覆盖：
 * 1. 端到端「还原旧 vault + 回拨」被锚拦下；删掉锚文件后同一状态复活（证明正是锚在起作用）；
 * 2. 锚文件语义：缺失/畸形 → null（不阻断）；只增不减；60s 步进节流。
 */

import {sign} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import type {LicenseConfig} from '../main/license/types';
import {TEST_KEY_PAIR} from './helpers/license-test-keys';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-20T00:00:00Z');

const mocks = vi.hoisted(() => ({
    config: {
        version: 1 as const,
        sku: 'AI-TOOLS-PRO',
        acceptedSkus: ['pro-subscription'],
        skuFeatures: {'pro-subscription': ['cloud_sync']},
        defaultKid: 'default',
        serviceBaseUrl: 'https://billing.example.test',
        redeemTimeoutMs: 15000,
        trial: {days: 60, maxRuns: null as number | null},
        clock: {skewToleranceMs: 2 * 60 * 60 * 1000, useServerTimeFloor: true},
        grace: {hardwareChangeDays: 7, maxAutoGrace: 1},
        features: {proFeature: 'pro', gated: ['cloud_sync']},
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
    getConfig: (): LicenseConfig => mocks.config,
}));

vi.mock('../main/license/machine-code', () => ({
    getMachineCodePair: async (): Promise<{strong: string; soft: string}> => ({strong: mocks.strong, soft: mocks.soft}),
    getMachineCode: async (): Promise<string> => mocks.strong,
    warmupMachineCode: (): void => undefined,
}));

vi.mock('../main/license/keys', async () => {
    const {TEST_KEY_PAIR: pair} = await import('./helpers/license-test-keys');
    return {
        getPublicKey: (kid: string): unknown => (kid === 'default' ? pair.publicKey : null),
        clearKeyCache: (): void => undefined,
    };
});

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-anchor-'));
mocks.home = tmpHome;
vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);

const ANCHOR_FILE = path.join(tmpHome, '.ai-tools', 'license-anchor.json');

const {readAnchorFloor, raiseAnchorFloor} = await import('../main/license/anchor');
const {writeVault} = await import('../main/license/vault');
const license = await import('../main/license');

beforeAll(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.setSystemTime(T0);
});

afterAll(() => {
    vi.useRealTimers();
    fs.rmSync(tmpHome, {recursive: true, force: true});
});

/** 签一张 30 天后过期的订阅令牌 */
function makeToken(expSec: number): string {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');
    const header = b64({alg: 'EdDSA', typ: 'JWT', kid: 'default'});
    const payload = b64({sku: 'pro-subscription', mid: mocks.strong, iat: expSec - 30 * 86400, exp: expSec, feat: ['OFFLINE']});
    const sig = sign(null, Buffer.from(`${header}.${payload}`, 'utf-8'), TEST_KEY_PAIR.privateKey);
    return `${header}.${payload}.${sig.toString('base64url')}`;
}

describe('R2 端到端：还原旧 vault + 回拨被 vault 外锚拦下', () => {
    it('过期后还原过期前的 vault 并回拨 → 仍判过期；删锚才复活', async () => {
        vi.setSystemTime(T0);
        // ① 激活（exp = T0 + 30d），锚随激活推到 T0
        const token = makeToken(Math.floor(T0 / 1000) + 30 * 86400);
        const applied = await license.importLicenseText(token);
        expect(applied.success).toBe(true);
        expect((await readAnchorFloor()) ?? 0).toBeGreaterThanOrEqual(T0 - 60_000);

        // ② 时间推到过期后（T0 + 40d），跑一次 getState：判过期，锚被推高到 T0 + 40d
        vi.setSystemTime(T0 + 40 * DAY_MS);
        const expired = await license.getState();
        expect(expired.status).toBe('inactive');
        expect(expired.degraded).toBe('expired');
        expect(await readAnchorFloor()).toBe(T0 + 40 * DAY_MS);

        // ③ 攻击：把系统时间拨回 T0，并用「过期前备份的 vault」覆盖回去（水印随之复位）
        vi.setSystemTime(T0);
        await writeVault({
            trial: null,
            license: {
                signed_token: token,
                activated_at: T0,
                mid_at_activation: mocks.strong,
                mid_soft_at_activation: mocks.soft,
                watermark: T0,
                server_time_floor: null,
            },
        });
        const revived = await license.getState();
        // 锚文件（T0 + 40d）不在备份里 → effectiveNow 仍高过 exp → 复活失败
        expect(revived.status).toBe('inactive');
        expect(revived.degraded).toBe('expired');

        // ④ 对照组：删掉锚文件后同一状态复活——证明 ③ 正是锚在拦截
        fs.rmSync(ANCHOR_FILE, {force: true});
        const rolledBack = await license.getState();
        expect(rolledBack.status).toBe('activated');
    });
});

describe('锚文件语义', () => {
    it('缺失 / 畸形 → null（视为没有锚，不阻断）', async () => {
        fs.rmSync(ANCHOR_FILE, {force: true});
        expect(await readAnchorFloor()).toBeNull();
        fs.mkdirSync(path.dirname(ANCHOR_FILE), {recursive: true});
        fs.writeFileSync(ANCHOR_FILE, '{not json', 'utf-8');
        expect(await readAnchorFloor()).toBeNull();
        fs.writeFileSync(ANCHOR_FILE, JSON.stringify({v: 1, floor: 'bogus'}), 'utf-8');
        expect(await readAnchorFloor()).toBeNull();
    });

    it('只增不减 + 60s 步进节流', async () => {
        fs.rmSync(ANCHOR_FILE, {force: true});
        expect(await raiseAnchorFloor(T0)).toBe(true);
        // 回拨目标：不倒退也不落盘
        expect(await raiseAnchorFloor(T0 - DAY_MS)).toBe(false);
        expect(await readAnchorFloor()).toBe(T0);
        // 步进内（< 60s）：跳过落盘
        expect(await raiseAnchorFloor(T0 + 30_000)).toBe(false);
        expect(await readAnchorFloor()).toBe(T0);
        // 超过步进：推进
        expect(await raiseAnchorFloor(T0 + 61_000)).toBe(true);
        expect(await readAnchorFloor()).toBe(T0 + 61_000);
    });
});
