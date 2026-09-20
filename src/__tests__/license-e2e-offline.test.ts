/**
 * 授权链路离线端到端冒烟（plan-2.4 · 结转自 plan-2.1 的「端到端冒烟」）
 *
 * 与既有用例的分工：本文件走**完整生命周期**（全新环境 → 试用 → 导入激活 → gate 放行 →
 * 伪造/过期/换机 → 应急开关 → 去激活），一串动作连续打到同一份 vault，验证的是「串起来还对」
 * 而不是单点判定（单点已由 `license-verifier` / `license-trial` 覆盖）。
 *
 * 为什么叫「离线版」：凭证用**测试进程现生成的临时 Ed25519 私钥**签发（`helpers/license-test-keys`），
 * 不走 `fetchRedeem`。好处是不依赖后端与真实私钥，随时可跑；**没覆盖**的是与
 * billing-license-service 的真实兑换链路（含 `$.data.*` 响应壳与 `serverTime`），那部分仍需真实私钥。
 *
 * 所有文件写在临时 HOME 下，不碰用户真实的 ~/.ai-tools。
 */

import {sign} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {TEST_KEY_PAIR} from './helpers/license-test-keys';

const ORIGINAL_MID = {strong: 'AAAA-BBBB-CCCC-DDDD', soft: 'AAAA-BBBB-CCCC-EEEE'};
const OTHER_MID = {strong: 'ZZZZ-YYYY-XXXX-WWWW', soft: 'ZZZZ-YYYY-XXXX-VVVV'};

const mocks = vi.hoisted(() => ({
    config: {
        version: 1 as const,
        enabled: true,
        killSwitch: false,
        sku: 'pro-buyout',
        acceptedSkus: ['pro-buyout', 'pro-subscription'],
        skuFeatures: {'pro-buyout': ['cloud_sync'], 'pro-subscription': ['cloud_sync']} as Record<string, string[]>,
        defaultKid: 'default',
        serviceBaseUrl: 'https://billing.example.test',
        redeemTimeoutMs: 15000,
        trial: {days: 60, maxRuns: null as number | null},
        clock: {skewToleranceMs: 2 * 60 * 60 * 1000, useServerTimeFloor: true},
        grace: {hardwareChangeDays: 7, maxAutoGrace: 1},
        features: {proFeature: 'pro', gated: ['cloud_sync', 'remote_connect']},
    },
    // vi.hoisted 的工厂先于模块级常量求值，故这里写字面量而非引用
    mid: {strong: 'AAAA-BBBB-CCCC-DDDD', soft: 'AAAA-BBBB-CCCC-EEEE'},
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
    getMachineCodePair: async (): Promise<{strong: string; soft: string}> => ({...mocks.mid}),
    getMachineCode: async (): Promise<string> => mocks.mid.strong,
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

// ── 隔离必须在被测模块被 import 之前生效 ─────────────────────────────────────
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-e2e-'));
mocks.home = tmpHome;
vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);

const license = await import('../main/license');

function b64(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url');
}

interface TokenInput {
    expSec?: number | null;
    mid?: string;
    sku?: string;
}

/** 用测试私钥签一张合法令牌（默认：本机机器码 + 一年后到期） */
function makeToken({expSec = Math.floor(Date.now() / 1000) + 365 * 86400, mid = ORIGINAL_MID.strong, sku = 'pro-buyout'}: TokenInput = {}): string {
    const header = b64({alg: 'EdDSA', typ: 'JWT', kid: 'default'});
    const payload = b64({
        jti: 'jti-e2e-0001',
        sku,
        mid,
        iat: Math.floor(Date.now() / 1000) - 60,
        exp: expSec,
        feat: ['OFFLINE'],
        lic: 'LIC-TEST-1234-5678',
    });
    const sig = sign(null, Buffer.from(`${header}.${payload}`, 'utf-8'), TEST_KEY_PAIR.privateKey);
    return `${header}.${payload}.${sig.toString('base64url')}`;
}

/** 把签名段首字节取反：长度不变、格式合法，验签必失败 */
function tamperSignature(token: string): string {
    const parts = token.split('.');
    const sig = Buffer.from(parts[2], 'base64url');
    sig[0] = sig[0] ^ 0xff;
    return `${parts[0]}.${parts[1]}.${sig.toString('base64url')}`;
}

function wipeHome(): void {
    for (const entry of fs.readdirSync(tmpHome)) {
        fs.rmSync(path.join(tmpHome, entry), {recursive: true, force: true});
    }
}

describe('授权链路离线端到端', () => {
    beforeAll(() => wipeHome());
    afterAll(() => wipeHome());

    it('全新环境 → 试用 → 激活 → 付费功能放行 → 伪造/过期/换机被拦 → 应急开关 → 去激活回试用', async () => {
        // ① 全新环境：首次使用即进试用，且试用期内所有 gate 全量放行
        const fresh = await license.getState(null);
        expect(fresh.status).toBe('trial');
        expect(fresh.features).toContain('pro');
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(true);

        // ② 导入合法令牌：激活成功，付费权益解锁
        const activated = await license.importLicenseText(makeToken());
        expect(activated.success).toBe(true);
        expect(activated.state?.status).toBe('activated');
        expect(activated.state?.sku).toBe('pro-buyout');
        expect(activated.state?.features).toContain('cloud_sync');
        // 脱敏后才出 IPC：不得把完整 licenseKey 送出去
        expect(activated.state?.licenseKey).toContain('****');
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(true);

        // ③ 伪造签名：拒绝，对外只有统一文案，不泄漏任何内部码
        const forged = await license.importLicenseText(tamperSignature(makeToken()));
        expect(forged.success).toBe(false);
        expect(forged.category).toBe('license');
        expect(forged.error).toBe('license.errors.generic');
        expect(JSON.stringify(forged)).not.toContain('LIC_');

        // ④ 已过期的令牌同样进不来（要晚 3 小时：容差 2 小时内的过期不拦，见 verifier 的时钟容差）
        const expired = await license.importLicenseText(makeToken({expSec: Math.floor(Date.now() / 1000) - 3 * 3600}));
        expect(expired.success).toBe(false);
        expect(expired.error).toBe('license.errors.generic');

        // ③ ④ 都没污染已在位的授权：仍是激活态
        expect((await license.getState(null)).status).toBe('activated');

        // ⑤ 换机器（强码 + 弱码同时变，避免落到硬件变更宽限）：验签判机不符，gate 关闭
        mocks.mid = {...OTHER_MID};
        const moved = await license.getState(null);
        expect(moved.status).toBe('inactive');
        expect(moved.degraded).toBe('machine_mismatch');
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(false);

        // ⑥ 应急开关（killSwitch）：猛然放行，用于线上止血
        mocks.config.killSwitch = true;
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(true);
        expect((await license.getState(null)).status).toBe('activated');

        // ⑦ 开关复位 + 机器还原：授权自动回来
        mocks.config.killSwitch = false;
        mocks.mid = {...ORIGINAL_MID};
        expect((await license.getState(null)).status).toBe('activated');
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(true);

        // ⑧ 去激活：token 清空，回到试用，且试用起点不因这次折腾前移
        const released = await license.deactivate();
        expect(released.status).toBe('trial');
        expect(released.trialExpiresAt).toBe(fresh.trialExpiresAt);
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(true);
    });
});
