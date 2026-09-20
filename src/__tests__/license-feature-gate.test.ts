/**
 * R1+R5（plan-2.7）：gate fail-closed 与权益模型统一。
 *
 * 覆盖：
 * 1. 完整性：`shared/license-constants` 的每个 `FEATURE_*` 权益键必须「= proFeature / 在 gated /
 *    有 provider 派生且宿主在 gated」——新增付费功能漏配会在测试期暴露，而不是线上静默放行；
 * 2. fail-closed：未登记 feature 一律拒绝（含持有效 token、试用期内两种场景）；
 * 3. `pro` 全量权益键只验令牌本身（token feat 不携带 `pro` 也能通过）；
 * 4. provider 派生：`remote_connect` 归一到宿主 `cloud_sync` 判定（R5）。
 */

import {sign} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterAll, describe, expect, it, vi} from 'vitest';
import type {LicenseConfig, TrialVault} from '../main/license/types';
import {TEST_KEY_PAIR} from './helpers/license-test-keys';

const DAY_MS = 24 * 60 * 60 * 1000;

const mocks = vi.hoisted(() => ({
    config: {
        version: 1 as const,
        enabled: true,
        killSwitch: false,
        sku: 'AI-TOOLS-PRO',
        acceptedSkus: ['pro-subscription'],
        skuFeatures: {'pro-subscription': ['cloud_sync']},
        defaultKid: 'default',
        serviceBaseUrl: 'https://billing.example.test',
        redeemTimeoutMs: 15000,
        trial: {days: 60, maxRuns: null as number | null},
        clock: {skewToleranceMs: 2 * 60 * 60 * 1000, useServerTimeFloor: true},
        grace: {hardwareChangeDays: 7, maxAutoGrace: 1},
        features: {proFeature: 'pro', gated: ['cloud_sync', 'premium_new']},
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

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-gate-'));
mocks.home = tmpHome;
vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);

const {writeVault} = await import('../main/license/vault');
const {assertFeature} = await import('../main/license/feature-gate');
const sharedConsts = await import('../shared/license-constants');
const {DEFAULT_LICENSE_CONFIG} = await import('../main/license/constants');

afterAll(() => {
    fs.rmSync(tmpHome, {recursive: true, force: true});
});

/** 签一张测试令牌；expSec / feat 可定制 */
function makeToken(expSec: number, feat: string[] = ['OFFLINE']): string {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');
    const header = b64({alg: 'EdDSA', typ: 'JWT', kid: 'default'});
    const payload = b64({
        sku: 'pro-subscription',
        mid: mocks.strong,
        iat: expSec - 30 * 86400,
        exp: expSec,
        feat,
    });
    const sig = sign(null, Buffer.from(`${header}.${payload}`, 'utf-8'), TEST_KEY_PAIR.privateKey);
    return `${header}.${payload}.${sig.toString('base64url')}`;
}

function trialAt(nowMs: number): TrialVault {
    return {
        first_run_at: nowMs,
        trial_count: 1,
        last_run_at: nowMs,
        trial_token: '',
        watermark: nowMs,
        mid_soft_at_activation: mocks.soft,
        hardware_grace_used: 0,
        hardware_grace_until: null,
        server_time_floor: null,
    };
}

describe('R1 完整性：每个 FEATURE_* 权益键都被登记（pro / gated / provider 派生）', () => {
    it('遍历 shared/license-constants 的全部权益键常量', () => {
        const entries = Object.entries(sharedConsts).filter(
            ([k, v]) => k.startsWith('FEATURE_') && typeof v === 'string'
        );
        // 至少应覆盖 pro / cloud_sync / remote_connect 三个已知键，防止遍历条件失效
        expect(entries.length).toBeGreaterThanOrEqual(3);

        for (const [exportName, feature] of entries) {
            const registered =
                feature === DEFAULT_LICENSE_CONFIG.features.proFeature ||
                DEFAULT_LICENSE_CONFIG.features.gated.includes(feature as string) ||
                (sharedConsts.FEATURE_PROVIDERS[feature as string] !== undefined &&
                    DEFAULT_LICENSE_CONFIG.features.gated.includes(
                        sharedConsts.FEATURE_PROVIDERS[feature as string]
                    ));
            expect(registered, `${exportName}=${feature} 未登记：fail-closed 下会误锁付费用户`).toBe(true);
        }
    });
});

describe('R1 fail-closed：未登记权益键一律拒绝', () => {
    it('试用期内查未登记 feature → 拒绝（旧实现会放行）', async () => {
        await writeVault({trial: trialAt(Date.now()), license: null});
        const r = await assertFeature('not_a_registered_feature');
        expect(r.allowed).toBe(false);
        expect(r.code).toBe('LIC_FEATURE_MISSING');
    });

    it('持有效 token 查未登记 feature → 仍拒绝', async () => {
        await writeVault({trial: null, license: null});
        const token = makeToken(Math.floor(Date.now() / 1000) + 30 * 86400);
        await writeVault({
            trial: null,
            license: {signed_token: token, activated_at: Date.now(), mid_at_activation: mocks.strong, mid_soft_at_activation: mocks.soft},
        });
        const r = await assertFeature('not_a_registered_feature');
        expect(r.allowed).toBe(false);
    });
});

describe('gate 判定链路（trial / token / pro / provider）', () => {
    it('试用期内（无 token）：登记的权益放行', async () => {
        await writeVault({trial: trialAt(Date.now()), license: null});
        const r = await assertFeature('cloud_sync');
        expect(r.allowed).toBe(true);
        expect(r.code).toBe('LIC_TRIAL_OK');
    });

    it('试用已到期（无 token）：登记的权益拒绝', async () => {
        await writeVault({trial: trialAt(Date.now() - 70 * DAY_MS), license: null});
        const r = await assertFeature('cloud_sync');
        expect(r.allowed).toBe(false);
    });

    it('有效 token：gated 权益按 skuFeatures/token feat 判定；token 未授予的 gated 权益拒绝', async () => {
        const token = makeToken(Math.floor(Date.now() / 1000) + 30 * 86400);
        await writeVault({
            trial: null,
            license: {signed_token: token, activated_at: Date.now(), mid_at_activation: mocks.strong, mid_soft_at_activation: mocks.soft},
        });
        expect((await assertFeature('cloud_sync')).allowed).toBe(true);
        // gated 名单里的 premium_new 未被任何 SKU 授予 → 拒绝（真验签路径仍在）
        expect((await assertFeature('premium_new')).allowed).toBe(false);
    });

    it('R5：remote_connect 按 provider 归一到 cloud_sync 判定', async () => {
        const token = makeToken(Math.floor(Date.now() / 1000) + 30 * 86400);
        await writeVault({
            trial: null,
            license: {signed_token: token, activated_at: Date.now(), mid_at_activation: mocks.strong, mid_soft_at_activation: mocks.soft},
        });
        expect((await assertFeature('remote_connect')).allowed).toBe(true);
    });

    it('pro 全量权益键：只验令牌本身有效（token feat 不需要携带 pro）', async () => {
        const token = makeToken(Math.floor(Date.now() / 1000) + 30 * 86400);
        await writeVault({
            trial: null,
            license: {signed_token: token, activated_at: Date.now(), mid_at_activation: mocks.strong, mid_soft_at_activation: mocks.soft},
        });
        expect((await assertFeature('pro')).allowed).toBe(true);
    });

    it('过期 token：pro 与 gated 权益都拒绝', async () => {
        const token = makeToken(Math.floor(Date.now() / 1000) - 86400);
        await writeVault({
            trial: null,
            license: {signed_token: token, activated_at: Date.now(), mid_at_activation: mocks.strong, mid_soft_at_activation: mocks.soft},
        });
        expect((await assertFeature('pro')).allowed).toBe(false);
        expect((await assertFeature('cloud_sync')).allowed).toBe(false);
    });
});
