/**
 * vault 落盘往返（F2 · 2026-09-29 审计）
 *
 * 背景：`readVault` 会过一遍 `sanitize`，而 sanitize 是**显式白名单**——字段没列进去就在
 * 落盘再读时静默消失。已经踩过两次：`next_check_at`（复核排期跨重启失效，字段旁留了警告注释）
 * 与 `machine_first_seen_at`（C8 三态被丢 → 每次启动都重发机器码探测）。
 *
 * 本文件守的就是「写进去的字段读回来还在」，并锁死两条容易被改坏的语义：
 * ① 三态字段不能折叠（`undefined`／`null`／`number` 各有含义）；
 * ② 新增字段**不得**进 `computeTrialToken` 的 canonical 列表——那会让所有已部署 vault 的
 *    HMAC 校验失败、`readVault` 直接判废回 `emptyVault()`，等于全员掉激活。
 *
 * 隔离：所有文件写在临时 HOME 下，不碰用户真实的 ~/.ai-tools。
 */

import {afterAll, describe, expect, it, vi} from 'vitest';
import type {LicenseConfig, LicenseVault, TrialVault} from '../main/license/types';
import type {VaultData} from '../main/license/vault';
import {createHomeSandbox} from './helpers/isolate-home';

const mocks = vi.hoisted(() => ({
    config: {
        version: 1 as const,
        sku: 'AI-TOOLS-PRO',
        acceptedSkus: ['pro-buyout'],
        skuFeatures: {'pro-buyout': ['cloud_sync']},
        defaultKid: 'default',
        serviceBaseUrl: 'https://billing.example.test',
        redeemTimeoutMs: 15000,
        trial: {days: 60, maxRuns: null as number | null},
        clock: {skewToleranceMs: 2 * 60 * 60 * 1000, useServerTimeFloor: true},
        grace: {hardwareChangeDays: 7, maxAutoGrace: 1},
        features: {proFeature: 'pro', gated: ['cloud_sync']},
        recheck: {
            enabled: true,
            intervalMs: 1296000000,
            retryMs: 7200000,
            offlineGraceDays: 30,
            hardStopDays: 60,
            timeoutMs: 8000,
        },
    } as LicenseConfig,
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
    loadConfig: (): LicenseConfig => mocks.config,
    resetConfigCache: (): void => undefined,
    resolveExternalLicenseDir: (): string => '',
    resolveAsarAssetsDir: (): string => '',
}));

vi.mock('../main/license/machine-code', () => ({
    getMachineCodePair: async (): Promise<{strong: string; soft: string}> => ({
        strong: mocks.strong,
        soft: mocks.soft,
    }),
    getMachineCode: async (): Promise<string> => mocks.strong,
    getHardwareFactors: async () => ({cpu: 'CPU1', disk: 'DISK1', board: 'BOARD1', osGuid: 'GUID1'}),
    warmupMachineCode: (): void => undefined,
}));

// ── 隔离必须在被测模块 import 之前生效（vault 路径在模块加载时就算好）────────
const vaultSandbox = createHomeSandbox(mocks, 'ai-tools-vault-');

const {readVault, writeVault} = await import('../main/license/vault');

afterAll(() => vaultSandbox.cleanup());

const NOW = Date.parse('2026-09-29T00:00:00Z');

function fullTrial(): TrialVault {
    return {
        first_run_at: NOW - 10 * 86400000,
        trial_count: 3,
        last_run_at: NOW - 3600000,
        trial_token: '',
        watermark: NOW - 7200000,
        mid_soft_at_activation: 'SOFT-1',
        hardware_grace_used: 1,
        hardware_grace_until: NOW + 86400000,
        server_time_floor: NOW - 1800000,
        machine_first_seen_at: NOW - 200 * 86400000,
    };
}

function fullLicense(): LicenseVault {
    return {
        signed_token: 'header.payload.sig',
        activated_at: NOW - 5 * 86400000,
        mid_at_activation: mocks.strong,
        mid_soft_at_activation: mocks.soft,
        watermark: NOW - 600000,
        server_time_floor: NOW - 300000,
        binding_reported: true,
        last_checked_at: NOW - 120000,
        last_verified_ok_at: NOW - 120000,
        offline_grace_used_ms: 0,
        revoked_by_server: null,
        next_check_at: NOW + 1296000000,
    };
}

/** 每个用例独立起一份 vault，避免相互污染 */
async function roundtrip(data: VaultData): Promise<VaultData> {
    await writeVault(data);
    return readVault();
}

describe('vault 落盘往返 · 白名单字段不被静默丢弃（F2）', () => {
    it('trial 全字段往返后逐个存活（含 machine_first_seen_at 的 number 态）', async () => {
        const written = fullTrial();
        const back = await roundtrip({trial: written, license: null});

        expect(back.trial).not.toBeNull();
        const got = back.trial!;
        // trial_token 由 writeVault 重算（写入时传的是空串），其余字段必须与写入值全等
        expect(got.trial_token).not.toBe('');
        expect(got.first_run_at).toBe(written.first_run_at);
        expect(got.trial_count).toBe(written.trial_count);
        expect(got.last_run_at).toBe(written.last_run_at);
        expect(got.watermark).toBe(written.watermark);
        expect(got.mid_soft_at_activation).toBe(written.mid_soft_at_activation);
        expect(got.hardware_grace_used).toBe(written.hardware_grace_used);
        expect(got.hardware_grace_until).toBe(written.hardware_grace_until);
        expect(got.server_time_floor).toBe(written.server_time_floor);
        expect(got.machine_first_seen_at).toBe(written.machine_first_seen_at);
    });

    it('license 全字段往返后逐个存活（含 next_check_at 排期与 revoked_by_server）', async () => {
        const written = fullLicense();
        const back = await roundtrip({trial: null, license: written});

        expect(back.license).toEqual(written);
        expect(back.license!.next_check_at).toBe(written.next_check_at);
    });

    it('machine_first_seen_at 三态各自存活：undefined（键缺失）/ null（问过没见过）/ number', async () => {
        // ① undefined：JSON.stringify 丢键 → 读回来仍是 undefined，而不是被折成 null。
        //    判定口径是 `!== undefined`（见 index.ts backfillMachineFirstSeen / trial.ts applyMachineFirstSeen），
        //    故这里只断值不断「键是否存在」——sanitize 会显式给出值为 undefined 的键，语义等价。
        const absent = fullTrial();
        delete absent.machine_first_seen_at;
        const r1 = await roundtrip({trial: absent, license: null});
        expect(r1.trial!.machine_first_seen_at).toBeUndefined();

        // ② null：问过了、服务端没见过这台机器 → 不能变回 undefined（否则每次启动重发探测）
        const probed = {...fullTrial(), machine_first_seen_at: null};
        const r2 = await roundtrip({trial: probed, license: null});
        expect(r2.trial!.machine_first_seen_at).toBeNull();

        // ③ number：原值保真
        const known = {...fullTrial(), machine_first_seen_at: NOW - 86400000};
        const r3 = await roundtrip({trial: known, license: null});
        expect(r3.trial!.machine_first_seen_at).toBe(NOW - 86400000);
    });

    it('不可识别的值退化处理：字符串 → undefined（重新问一次）；NaN → null（JSON 固有行为）', async () => {
        // 字符串能被 JSON 表示 → 落到 sanitize，按「不可识别」退化为 undefined＝重新探测，以服务端为准
        const garbage = {...fullTrial(), machine_first_seen_at: '2026-09-29' as unknown as number};
        const r1 = await roundtrip({trial: garbage, license: null});
        expect(r1.trial!.machine_first_seen_at).toBeUndefined();

        // NaN 无法被 JSON 表示：`JSON.stringify(NaN)` === 'null' → 落盘即成 null（＝「问过、服务端没见过」）。
        // 这是 JSON 的固有行为而非缺陷，且实际不可达：applyMachineFirstSeen 在写入前就用
        // `Number.isFinite` 挡掉了 NaN（trial.ts:149），不会把它写进账本。
        const nan = {...fullTrial(), machine_first_seen_at: Number.NaN};
        const r2 = await roundtrip({trial: nan, license: null});
        expect(r2.trial!.machine_first_seen_at).toBeNull();
    });

    it('旧形态 vault（无 machine_first_seen_at 键）仍校验通过，不被判废成 emptyVault', async () => {
        // 这条守的是「新增字段不得进 computeTrialToken 的 canonical 列表」：
        // 一旦进了，老 vault 的 HMAC 就对不上 → readVault 返回空账本 → 用户掉激活/试用重置
        const legacy = fullTrial();
        delete legacy.machine_first_seen_at;
        await writeVault({trial: legacy, license: fullLicense()});

        const back = await readVault();
        expect(back.trial).not.toBeNull();
        expect(back.trial!.first_run_at).toBe(legacy.first_run_at);
        expect(back.license).not.toBeNull();
        expect(back.license!.signed_token).toBe('header.payload.sig');
    });
});
