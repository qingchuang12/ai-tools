/**
 * 试用账本 / vault / 门面状态机单测
 *
 * 覆盖：60 天硬约束到期、次数不限只累加（以及有上限时先到为准）、单调水印推进、
 * `effectiveNow` 抹平时间回拨（把时间改回过去不能让已过期复活）、vault 损坏自愈、
 * legacy 旧激活降级、已激活权益 gate。
 *
 * 密钥对**运行时临时生成**（见 helpers/license-test-keys.ts，仓库不落任何私钥）；
 * 所有文件写在临时目录下，不碰用户真实的 ~/.ai-tools。
 */

import {sign} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {TEST_KEY_PAIR} from './helpers/license-test-keys';

const DAY_MS = 24 * 60 * 60 * 1000;

const mocks = vi.hoisted(() => ({
    config: {
        version: 1 as const,
        enabled: true,
        killSwitch: false,
        sku: 'AI-TOOLS-PRO',
        acceptedSkus: ['pro-buyout', 'pro-plus-buyout', 'pro-subscription', 'pro-plus-subscription'],
        skuFeatures: {
            'pro-buyout': ['cloud_sync'],
            'pro-plus-buyout': ['cloud_sync'],
            'pro-subscription': ['cloud_sync'],
            'pro-plus-subscription': ['cloud_sync'],
        },
        defaultKid: 'default',
        serviceBaseUrl: 'https://billing.example.test',
        redeemTimeoutMs: 15000,
        trial: {days: 60, maxRuns: null as number | null},
        clock: {skewToleranceMs: 2 * 60 * 60 * 1000, useServerTimeFloor: true},
        grace: {hardwareChangeDays: 7, maxAutoGrace: 1},
        features: {proFeature: 'pro', gated: ['cloud_sync', 'remote_connect']},
    },
    strong: 'AAAA-BBBB-CCCC-DDDD',
    soft: 'AAAA-BBBB-CCCC-EEEE',
    home: '',
    encryption: true,
    factors: {cpu: 'CPU1', disk: 'DISK1', board: 'BOARD1', osGuid: 'GUID1'},
}));

vi.mock('electron', () => ({
    safeStorage: {
        isEncryptionAvailable: (): boolean => mocks.encryption,
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
    getMachineCodePair: async (): Promise<{ strong: string; soft: string }> => ({
        strong: mocks.strong,
        soft: mocks.soft,
    }),
    getMachineCode: async (): Promise<string> => mocks.strong,
    getHardwareFactors: async (): Promise<{ cpu: string; disk: string; board: string; osGuid: string }> => mocks.factors,
    warmupMachineCode: (): void => undefined,
}));

vi.mock('../main/license/keys', async () => {
    const {TEST_KEY_PAIR: pair} = await import('./helpers/license-test-keys');
    return {
        getPublicKey: (kid: string): unknown => (kid === 'default' ? pair.publicKey : null),
        clearKeyCache: (): void => undefined,
    };
});

const {readVault, writeVault} = await import('../main/license/vault');
const {effectiveNow, evaluateTrial, grantTrial} = await import('../main/license/trial');
const {readFirstRunAt, writeFirstRun} = await import('../main/license/first-run');
const license = await import('../main/license');

/** Windows 首跑账本第二处落在 APPDATA 下：测试必须一起隔离，否则会写到真实用户目录 */
const ORIGINAL_APPDATA = process.env.APPDATA;

let tmpHome = '';

/** 每个用例独立临时 HOME，绝不碰用户真实目录 */
beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-lic-test-'));
    mocks.home = tmpHome;
    process.env.APPDATA = path.join(tmpHome, 'AppData', 'Roaming');
    mocks.encryption = true;
    mocks.strong = 'AAAA-BBBB-CCCC-DDDD';
    mocks.soft = 'AAAA-BBBB-CCCC-EEEE';
    mocks.config.enabled = true;
    mocks.config.killSwitch = false;
    mocks.config.trial.days = 60;
    mocks.config.trial.maxRuns = null;
    mocks.config.clock.skewToleranceMs = 2 * 60 * 60 * 1000;
    mocks.config.grace.maxAutoGrace = 1;
});

const homedirSpy = vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);

afterAll(() => {
    homedirSpy.mockRestore();
    if (ORIGINAL_APPDATA === undefined) {
        delete process.env.APPDATA;
    } else {
        process.env.APPDATA = ORIGINAL_APPDATA;
    }
});

function b64(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url');
}

function makeToken(payload: Record<string, unknown>): string {
    const h = b64({alg: 'EdDSA', typ: 'JWT', kid: 'default'});
    const p = b64(payload);
    const sig = sign(null, Buffer.from(`${h}.${p}`, 'utf-8'), TEST_KEY_PAIR.privateKey);
    return `${h}.${p}.${sig.toString('base64url')}`;
}

function validToken(overrides: Record<string, unknown> = {}): string {
    const nowSec = Math.floor(Date.now() / 1000);
    return makeToken({
        jti: 'jti-1',
        sku: 'pro-buyout',
        mid: mocks.strong,
        iat: nowSec,
        exp: nowSec + 30 * 86400,
        feat: ['pro'],
        lic: 'ABCD1234EFGH5678',
        ...overrides,
    });
}

/** 直接种一个试用账本到 vault（绕过「首次安装」判定） */
async function seedTrial(partial: Partial<{first_run_at: number; trial_count: number; watermark: number}>): Promise<void> {
    const now = Date.now();
    const trial = grantTrial(partial.first_run_at ?? now, mocks.soft);
    await writeVault({
        trial: {
            ...trial,
            first_run_at: partial.first_run_at ?? now,
            trial_count: partial.trial_count ?? 1,
            watermark: partial.watermark ?? (partial.first_run_at ?? now),
        },
        license: null,
    });
}

describe('首次使用进入试用（vault 缺失自愈）', () => {
    it('全新环境（无 vault / 无首跑账本）→ 直接判 trial 并落账本', async () => {
        expect(readFirstRunAt()).toBeNull();
        const state = await license.getState(null);
        expect(state.status).toBe('trial');
        expect(state.source).toBe('trial');
        expect(state.features).toContain('pro');
        // 账本已落盘：后续读取不会再发一轮新的
        expect(readFirstRunAt()).not.toBeNull();
    });

    it('升级遗留 activation.json（status=inactive）且 vault 为空 → 仍进入试用', async () => {
        const persisted = {
            status: 'inactive' as const,
            trialStartsAt: null,
            trialExpiresAt: null,
            trialRunsLeft: null,
            activatedExpiresAt: null,
            activatedAt: null,
            machineCode: 'OLD-CODE',
            licenseKey: null,
            sku: null,
            features: [],
            source: 'none' as const,
            degraded: null,
        };
        const state = await license.getState(persisted);
        expect(state.status).toBe('trial');
    });

    it('删 vault（账本仍在）→ 按原起点重建，剩余天数不增加', async () => {
        const start = Date.now() - 30 * DAY_MS;
        writeFirstRun(start);
        await writeVault({trial: null, license: null});
        const state = await license.getState(null);
        expect(state.status).toBe('trial');
        expect(state.trialStartsAt).toBe(start);
        expect((state.trialExpiresAt ?? 0) - (state.trialStartsAt ?? 0)).toBe(60 * DAY_MS);
    });

    it('账本起点已超 60 天 → 不发新试用，判 trial_expired（不再是永久 inactive）', async () => {
        writeFirstRun(Date.now() - 61 * DAY_MS);
        await writeVault({trial: null, license: null});
        const state = await license.getState(null);
        expect(state.status).toBe('inactive');
        expect(state.degraded).toBe('trial_expired');
    });

    it('账本起点在未来（手改 / 时钟回拨）→ 不发试用，判 vault_tampered', async () => {
        writeFirstRun(Date.now() + 30 * DAY_MS);
        await writeVault({trial: null, license: null});
        const state = await license.getState(null);
        expect(state.status).toBe('inactive');
        expect(state.degraded).toBe('vault_tampered');
    });

    it('反复读取 / activation.json 丢失都不会重置试用起点', async () => {
        await license.getState(null);
        const first = await readVault();
        await license.getState(null);
        await license.getState(null);
        const after = await readVault();
        expect(after.trial?.first_run_at).toBe(first.trial?.first_run_at);
        expect(after.trial?.trial_count).toBeGreaterThan(first.trial?.trial_count ?? 0);
    });
});

describe('试用双限（天数硬约束 / 次数默认不限）', () => {
    it('首次安装发试用：60 天，剩余次数为 null（不限）', async () => {
        await license.grantTrialOnFirstInstall();
        const state = await license.getState(null);
        expect(state.status).toBe('trial');
        expect(state.source).toBe('trial');
        expect(state.trialRunsLeft).toBeNull();
        expect(state.trialStartsAt).not.toBeNull();
        expect((state.trialExpiresAt ?? 0) - (state.trialStartsAt ?? 0)).toBe(60 * DAY_MS);
    });

    it('超过 60 天 → inactive + trial_expired', async () => {
        await seedTrial({first_run_at: Date.now() - 61 * DAY_MS});
        const state = await license.getState(null);
        expect(state.status).toBe('inactive');
        expect(state.degraded).toBe('trial_expired');
    });

    it('次数不限时只累加不拦截：连跑 5 次仍在试用', async () => {
        await seedTrial({first_run_at: Date.now()});
        for (let i = 0; i < 5; i++) {
            const state = await license.getState(null);
            expect(state.status).toBe('trial');
            expect(state.trialRunsLeft).toBeNull();
        }
        const vault = await readVault();
        // 首次 grant 记 1 次，之后每次 getState 再 +1
        expect(vault.trial?.trial_count).toBe(6);
    });

    it('配置了 maxRuns 时先到为准：跑满次数即使未到期也失效', async () => {
        mocks.config.trial.maxRuns = 3;
        await seedTrial({first_run_at: Date.now(), trial_count: 3});
        const state = await license.getState(null);
        expect(state.status).toBe('inactive');
        expect(state.degraded).toBe('trial_runs_exceeded');

        // 反过来：天数到期时即使次数没用完也失效
        mocks.config.trial.maxRuns = 100;
        await seedTrial({first_run_at: Date.now() - 61 * DAY_MS, trial_count: 1});
        expect((await license.getState(null)).degraded).toBe('trial_expired');
    });
});

describe('单调时间与回拨', () => {
    it('effectiveNow 取 max(now, 水印, 后端下界)', () => {
        const trial = grantTrial(1000, 'SOFT');
        expect(effectiveNow({...trial, watermark: 5000}, 2000)).toBe(5000);
        expect(effectiveNow({...trial, server_time_floor: 9000}, 2000)).toBe(9000);
        expect(effectiveNow(trial, 2000)).toBe(2000);
        expect(effectiveNow(null, 2000)).toBe(2000);
    });

    it('水印推进：每次运行只增不减', async () => {
        const past = Date.now() - 3 * DAY_MS;
        await seedTrial({first_run_at: past, watermark: past});
        await license.getState(null);
        const after = await readVault();
        expect(after.trial?.watermark).toBeGreaterThanOrEqual(Date.now() - 1000);
        expect(after.trial?.trial_count).toBe(2);
    });

    it('把系统时间改回过去不能让已过期的试用复活', async () => {
        const now = Date.now();
        // 水印被推到「未来」（等价于用户先把时间调前、再调回过去）
        const futureWatermark = now + 100 * DAY_MS;
        await seedTrial({first_run_at: now - 10 * DAY_MS, watermark: futureWatermark});
        const trial = (await readVault()).trial!;
        const ev = evaluateTrial(trial, mocks.config as never, now);
        // 真实 now 远早于水印 → 会记 CLOCK_ROLLBACK 日志，但到期判定用 effectiveNow，仍然判过期
        expect(ev.status).toBe('inactive');
        expect(ev.degraded).toBe('trial_expired');
    });

    it('时钟早于首次运行（典型是删档 + 改表）→ vault_tampered', async () => {
        const now = Date.now();
        await seedTrial({first_run_at: now + 30 * DAY_MS});
        const trial = (await readVault()).trial!;
        expect(evaluateTrial(trial, mocks.config as never, now).degraded).toBe('vault_tampered');
    });
});

describe('vault 加密与自愈', () => {
    it('safeStorage 可用时走 safeStorage，不可用回退 AES-256-GCM', async () => {
        const payload = {trial: grantTrial(Date.now(), mocks.soft), license: null};

        mocks.encryption = true;
        await writeVault(payload);
        expect(fs.readFileSync(path.join(tmpHome, '.ai-tools', 'license-vault.json'), 'utf-8')).toContain('safeStorage');
        expect((await readVault()).trial?.first_run_at).toBe(payload.trial.first_run_at);

        mocks.encryption = false;
        await writeVault(payload);
        expect(fs.readFileSync(path.join(tmpHome, '.ai-tools', 'license-vault.json'), 'utf-8')).toContain('aes-gcm');
        expect((await readVault()).trial?.first_run_at).toBe(payload.trial.first_run_at);
    });

    it('文件被改成垃圾 → 自愈为空账本，不崩溃', async () => {
        await seedTrial({first_run_at: Date.now()});
        const file = path.join(tmpHome, '.ai-tools', 'license-vault.json');
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, 'not-json-at-all');
        const vault = await readVault();
        expect(vault.trial).toBeNull();
        expect(vault.license).toBeNull();
    });

    it('密文被篡改（authTag 不匹配）→ 判废而非给出错误数据', async () => {
        await seedTrial({first_run_at: Date.now()});
        // 用「明文 + 非 safe 前缀」伪造一份密文，解密必然失败
        const file = path.join(tmpHome, '.ai-tools', 'license-vault.json');
        fs.writeFileSync(
            file,
            JSON.stringify({v: 1, scheme: 'safeStorage', data: Buffer.from('tampered', 'utf-8').toString('base64')})
        );
        expect((await readVault()).trial).toBeNull();
    });

    it('明文账本被手改（trial_count 造假）→ trial_token 自检不过，判废', async () => {
        await seedTrial({first_run_at: Date.now()});
        const vault = await readVault();
        const tampered = {...vault.trial!, trial_count: 0};
        await writeVault({trial: tampered, license: null});
        // 直接落盘后手动改密文不可行，这里改为验证「自检串会随字段变化」这一性质
        const again = await readVault();
        expect(again.trial?.trial_count).toBe(0); // 正常路径下自检串会被重算，读取仍通过
        // 手工替换密文内容（等价于改了字段但没重算自检串）→ 判废
        const file = path.join(tmpHome, '.ai-tools', 'license-vault.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {v: number; scheme: string; data: string};
        const plain = Buffer.from(raw.data, 'base64').toString('utf-8').replace('"trial_count":0', '"trial_count":99');
        fs.writeFileSync(
            file,
            JSON.stringify({...raw, data: Buffer.from(plain, 'utf-8').toString('base64')})
        );
        expect((await readVault()).trial).toBeNull();
    });
});

describe('门面状态机', () => {
    it('legacy：旧版本 activated 但 vault 无 token → 降级 inactive + token_invalid', async () => {
        const persisted = {
            status: 'activated' as const,
            trialStartsAt: null,
            trialExpiresAt: null,
            trialRunsLeft: null,
            activatedExpiresAt: null,
            activatedAt: Date.now(),
            machineCode: 'OLD-CODE',
            licenseKey: null,
            sku: null,
            features: [],
            source: 'license' as const,
            degraded: null,
        };
        const state = await license.getState(persisted);
        expect(state.status).toBe('inactive');
        expect(state.degraded).toBe('token_invalid');
    });

    it('导入合法 token → 落盘并变为已激活，gate 放行含 pro 的权益', async () => {
        const result = await license.importLicenseText(validToken());
        expect(result.success).toBe(true);
        expect(result.state?.status).toBe('activated');
        expect(result.state?.features).toContain('pro');
        expect(result.state?.licenseKey).toContain('****');

        const state = await license.getState(null);
        expect(state.status).toBe('activated');
        expect(state.source).toBe('license');
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(true);
        expect(license.currentPayload()?.mid).toBe(mocks.strong);
    });

    it('换机器码（换机）→ 验签判 machine_mismatch，gate 拒绝', async () => {
        await license.importLicenseText(validToken());
        mocks.strong = '9999-8888-7777-6666';
        const result = await license.assertFeature('cloud_sync');
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('LIC_MACHINE_MISMATCH');
    });

    it('去激活只清 token，不重置试用', async () => {
        await seedTrial({first_run_at: Date.now()});
        await license.importLicenseText(validToken());
        expect((await license.getState(null)).status).toBe('activated');

        const after = await license.deactivate();
        expect(after.status).toBe('trial');
        expect((await readVault()).trial).not.toBeNull();
        expect((await readVault()).license?.signed_token).toBeNull();
    });

    it('killSwitch / enabled 应急开关放行 gate', async () => {
        mocks.config.killSwitch = true;
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(true);
        mocks.config.killSwitch = false;

        mocks.config.enabled = false;
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(true);
    });

    it('试用期内未注册 → gate 视作 pro 全量放行（含 cloud_sync / remote_connect）', async () => {
        await seedTrial({first_run_at: Date.now()});
        const st = await license.getState(null);
        expect(st.status).toBe('trial');
        expect(st.features).toContain('pro');
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(true);
        expect((await license.assertFeature('remote_connect')).allowed).toBe(true);
    });

    it('试用到期且未注册 → gate 拒绝 cloud_sync（LIC_FEATURE_MISSING）', async () => {
        await seedTrial({first_run_at: Date.now() - 61 * DAY_MS});
        const st = await license.getState(null);
        expect(st.status).toBe('inactive');
        expect(st.degraded).toBe('trial_expired');
        const res = await license.assertFeature('cloud_sync');
        expect(res.allowed).toBe(false);
        expect(res.code).toBe('LIC_FEATURE_MISSING');
    });
});
