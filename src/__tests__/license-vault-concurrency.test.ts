/**
 * vault 并发写入回归（F1 · 2026-09-29 审计）
 *
 * 缺陷形态：`writeVault` 单次写是原子的（tmp + rename），但调用点全是「读整个 vault → 改一个字段 →
 * 整对象写回」，跨调用无锁。复核定时器、渲染层 `activation:get-state` 轮询、支付到账轮询各自跑一遍，
 * 后落盘者用**旧对象整体覆盖**前者 —— 水印回退（破红线 1「只增」）、刚领取的 token 被旧 license 盖掉。
 *
 * 修法是把**读-改-写整体**搬进串行段（`updateVault(fn)`）：光串行化「写」没用，因为 `readVault()`
 * 发生在排队之前，读到的仍是旧值，lost update 照旧。本文件守的就是这条：
 *   1. 并发的 `updateVault` 累加**全部生效**（读发生在串行段内）；
 *   2. 并发的快照式 `writeVault` **确实会丢**一次更新（把 F1 要消灭的形态钉在测试里，防止有人
 *      「顺手改回快照写」而看不出行数变化背后的语义损失）；
 *   3. mutator 返回 `null` → 不落盘（目标记录已被并发改动时放弃覆盖）；
 *   4. `getState`（抬水印）与 `deactivate` 并发 → 授权仍被清干净，不被旧快照复活；
 *   5. 换发授权期间被并发抬高的水印会被新授权继承（红线 1）。
 *
 * 隔离：所有文件写在临时 HOME 下，不碰用户真实的 ~/.ai-tools。
 */

import {sign} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {LicenseConfig, LicenseVault, TrialVault} from '../main/license/types';
import {DEFAULT_LICENSE_CONFIG} from '../main/license/constants';
import {TEST_KEY_PAIR} from './helpers/license-test-keys';

const DAY_MS = 24 * 60 * 60 * 1000;

const mocks = vi.hoisted(() => ({
    config: {} as LicenseConfig,
    strong: 'CONCUR-STRONG',
    soft: 'CONCUR-SOFT',
    home: '',
    /**
     * 一次性闸门：拦住**arm 之后的第一个** `getMachineCodePair` 调用者，把某个流程精确地停在
     * 「已读过入口快照、还没落盘」的窗口里，好让另一个流程插进去写。拦住后自动解除（不连坐）。
     */
    gate: {armed: false, onEnter: null as (() => void) | null, waitRelease: null as Promise<void> | null},
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
    getMachineCodePair: async (): Promise<{strong: string; soft: string}> => {
        if (mocks.gate.armed) {
            mocks.gate.armed = false;
            mocks.gate.onEnter?.();
            await mocks.gate.waitRelease;
        }
        return {strong: mocks.strong, soft: mocks.soft};
    },
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

// ── 隔离必须在被测模块 import 之前生效 ────────────────────────────────────────
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-concur-'));
mocks.home = tmpHome;

/**
 * 首跑账本（`first-run.ts`）在 win32 下有**两处**落点，其中一处走 `process.env.APPDATA`
 * 而不是 `os.homedir()`——只 spy homedir 拦不住它，用例会读到开发者真实的
 * `%APPDATA%\ai-tools\.install-marker`，判定结果随机上真实机器状态漂移
 * （本文件用例 4 就会因真实账本时间落在假时钟之后而被判「首跑账本在未来」）。
 */
const realAppData = process.env.APPDATA;
const tmpAppData = path.join(tmpHome, 'AppData-Roaming');

/**
 * 与 license-recheck.test.ts 同理：`afterEach` 的 `restoreAllMocks()` 会把 `os.homedir` 还原成真实家目录，
 * 于是下一个用例就往开发者自己的 `~/.ai-tools/` 里写真实授权文件。必须每个用例前重新 spy。
 */
vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);

const {readVault, writeVault, updateVault, resetVaultWriteChain} = await import('../main/license/vault');
const license = await import('../main/license');

/** 完整自洽的配置（包外缺省值镜像）。复核开关关掉：本文件只验并发落盘语义，不掺停用判定 */
function testConfig(): LicenseConfig {
    const d = DEFAULT_LICENSE_CONFIG;
    return {
        ...d,
        sku: 'pro-buyout',
        acceptedSkus: ['pro-buyout', 'pro-subscription'],
        skuFeatures: {'pro-buyout': ['cloud_sync'], 'pro-subscription': ['cloud_sync']},
        defaultKid: 'default',
        serviceBaseUrl: 'https://billing.example.test',
        features: {proFeature: 'pro', gated: ['cloud_sync']},
        recheck: {...d.recheck, enabled: false},
    };
}

/** 用测试私钥签一张合法令牌（`lic` 让每张 token 可区分，便于断言「落盘的是哪一张」） */
function makeSignedToken(expSec: number, lic: string): string {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');
    const header = b64({alg: 'EdDSA', typ: 'JWT', kid: 'default'});
    const payload = b64({
        jti: `jti-${lic}`,
        sku: 'pro-buyout',
        mid: mocks.strong,
        iat: Math.floor(Date.now() / 1000) - 60,
        exp: expSec,
        feat: ['OFFLINE'],
        lic,
    });
    const sig = sign(null, Buffer.from(`${header}.${payload}`, 'utf-8'), TEST_KEY_PAIR.privateKey);
    return `${header}.${payload}.${sig.toString('base64url')}`;
}

function seedLicense(overrides: Partial<LicenseVault> = {}): LicenseVault {
    return {
        signed_token: null,
        activated_at: null,
        mid_at_activation: null,
        mid_soft_at_activation: null,
        watermark: null,
        server_time_floor: null,
        // 已补报过：避免 getState 走 fire-and-forget 的 reportBindingOnStartup 发真实网络请求
        binding_reported: true,
        last_checked_at: null,
        last_verified_ok_at: null,
        offline_grace_used_ms: 0,
        revoked_by_server: false,
        next_check_at: null,
        ...overrides,
    };
}

function seedTrial(nowMs: number): TrialVault {
    return {
        first_run_at: nowMs - 1000,
        trial_count: 0,
        last_run_at: nowMs - 1000,
        trial_token: '',
        watermark: nowMs - 1000,
        mid_soft_at_activation: mocks.soft,
        hardware_grace_used: 0,
        hardware_grace_until: null,
        server_time_floor: null,
    };
}

function wipeHome(): void {
    for (const entry of fs.readdirSync(tmpHome)) {
        fs.rmSync(path.join(tmpHome, entry), {recursive: true, force: true});
    }
}

/** arm 一次性闸门；返回「已进入窗口」的信号与放行手柄 */
function armGate(): {entered: Promise<void>; release: () => void} {
    let onEnter!: () => void;
    let onRelease!: () => void;
    const entered = new Promise<void>((resolve) => {
        onEnter = resolve;
    });
    mocks.gate.armed = true;
    mocks.gate.onEnter = onEnter;
    mocks.gate.waitRelease = new Promise<void>((resolve) => {
        onRelease = resolve;
    });
    return {entered, release: onRelease};
}

beforeEach(() => {
    mocks.config = testConfig();
    mocks.gate.armed = false;
    mocks.gate.onEnter = null;
    mocks.gate.waitRelease = null;
    vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);
    process.env.APPDATA = tmpAppData;
    // 兜底桩：本文件不该发任何真实网络请求，一旦发了就 404 而不是挂住
    vi.stubGlobal('fetch', async () => ({status: 404, headers: {get: (): null => null}, json: async () => ({})}));
    wipeHome();
    resetVaultWriteChain();
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 1));
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (realAppData === undefined) {
        delete process.env.APPDATA;
    } else {
        process.env.APPDATA = realAppData;
    }
    wipeHome();
});

describe('updateVault：读-改写在同一串行段内（F1）', () => {
    it('1) 8 个并发 +1 全部生效（读发生在串行段内，不是各自读同一份旧值）', async () => {
        await writeVault({trial: seedTrial(Date.now()), license: null});

        await Promise.all(
            Array.from({length: 8}, () =>
                updateVault((cur) =>
                    cur.trial ? {trial: {...cur.trial, trial_count: cur.trial.trial_count + 1}, license: cur.license} : null,
                ),
            ),
        );

        const stored = await readVault();
        expect(stored.trial?.trial_count).toBe(8);
    });

    it('2) 快照式 writeVault 并发会丢更新，updateVault 并发取到较大值', async () => {
        const W = Date.UTC(2026, 8, 1);
        await writeVault({trial: null, license: seedLicense({watermark: W})});

        // ① 复现 F1 的缺陷形态：两个调用方都先读快照，再各自整对象写回。
        //    写入本身是串行的（FIFO），所以后落盘的 50ms 稳定覆盖掉先落盘的 100ms —— 大值丢失。
        const snapshot = await readVault();
        await Promise.all([
            writeVault({trial: null, license: {...snapshot.license!, watermark: W + 100}}),
            writeVault({trial: null, license: {...snapshot.license!, watermark: W + 50}}),
        ]);
        expect((await readVault()).license?.watermark).toBe(W + 50);

        // ② 同一组并发换成 updateVault：mutator 拿到的是磁盘最新值，取 max 后两次抬高都在
        await Promise.all([
            updateVault((cur) => ({
                trial: cur.trial,
                license: {...cur.license!, watermark: Math.max(cur.license!.watermark ?? 0, W + 100)},
            })),
            updateVault((cur) => ({
                trial: cur.trial,
                license: {...cur.license!, watermark: Math.max(cur.license!.watermark ?? 0, W + 50)},
            })),
        ]);
        expect((await readVault()).license?.watermark).toBe(W + 100);
    });

    it('3) mutator 返回 null → 放弃落盘（并发换授权后，守卫住的写入不会盖回去）', async () => {
        const OLD = makeSignedToken(Math.floor(Date.UTC(2027, 0, 1) / 1000), 'LIC-CONCUR-OLD');
        const NEW = makeSignedToken(Math.floor(Date.UTC(2027, 0, 1) / 1000), 'LIC-CONCUR-NEW');
        await writeVault({trial: null, license: seedLicense({signed_token: OLD})});

        // 先入队：换掉授权（模拟并发到账／原子换绑）
        const swap = updateVault((cur) => ({trial: cur.trial, license: {...cur.license!, signed_token: NEW}}));
        // 后入队：只认 OLD 这张（模拟 runRecheck / reportBindingOnStartup 的 token 守卫）
        const guarded = updateVault((cur) =>
            cur.license && cur.license.signed_token === OLD
                ? {trial: cur.trial, license: {...cur.license, last_checked_at: 12345}}
                : null,
        );
        await swap;

        expect(await guarded).toBeNull();
        const stored = await readVault();
        expect(stored.license?.signed_token).toBe(NEW);
        expect(stored.license?.last_checked_at).toBeNull();
    });
});

describe('并发落盘的真实业务组合（F1）', () => {
    it('4) getState（抬水印）与 deactivate 并发 → 授权被清干净，不被旧快照复活', async () => {
        const T = Date.UTC(2026, 8, 1);
        // 水印落后于 now：getState 这一轮**确实会抬水印、确实会写盘**，才有机会把已清空的授权盖回去
        const W = T - 5 * DAY_MS;
        const token = makeSignedToken(Math.floor((T + 30 * DAY_MS) / 1000), 'LIC-CONCUR-DEACT');
        await writeVault({trial: null, license: seedLicense({signed_token: token, activated_at: T, watermark: W})});

        // 两条同时发起（deactivate 的写入先入队：它的函数体第一句就是 updateVault，
        // 而 getState 要先 await 取机器码 + 读账本）。于是 getState 的抬水印发生在**清空之后**——
        // 只有 token 守卫能挡住它把旧 license 整体写回去（＝把用户刚去激活的授权复活）。
        const [, afterDeactivate] = await Promise.all([license.getState(null), license.deactivate()]);

        const stored = await readVault();
        expect(stored.license?.signed_token).toBeNull();
        expect(stored.license?.activated_at).toBeNull();
        // 并发那次 getState 的**返回值**不作断言：它读到的是清理前的快照，返回 activated 是正确行为
        // （UI 下一轮轮询自然会翻）。这里要守的是**落盘**：去激活必须真的生效、不被旧快照盖回去。
        expect(afterDeactivate.status).not.toBe('activated');
        // 川哥 2026-09-24 拍板：去激活保留反回拨水位，只清 token 与复核状态
        expect(stored.license?.watermark).toBe(W);
    });

    it('5) 换发授权期间被并发抬高的水印会被新授权继承（红线 1：水印只增）', async () => {
        const T1 = Date.UTC(2026, 8, 1);
        const T2 = T1 + 10 * DAY_MS; // 并发 getState 把水印抬到的时刻
        const T3 = T1 + DAY_MS; // 换发落盘时的「现在」，故意低于 T2（本地时钟回拨过）
        const EXPIRE = Math.floor((T2 + 30 * DAY_MS) / 1000);
        vi.setSystemTime(T1);

        const oldToken = makeSignedToken(EXPIRE, 'LIC-CONCUR-INHERIT-OLD');
        const newToken = makeSignedToken(EXPIRE, 'LIC-CONCUR-INHERIT-NEW');
        await writeVault({
            trial: null,
            license: seedLicense({signed_token: oldToken, activated_at: T1, watermark: T1}),
        });

        // 把换发停在「入口已读过快照、尚未落盘」的窗口里（verifier 取机器码时被拦）
        const gate = armGate();
        const applying = license.importLicenseText(newToken);
        await gate.entered;

        // 窗口内并发：渲染层轮询 getState 把水印抬到 T2
        vi.setSystemTime(T2);
        await license.getState(null);
        expect((await readVault()).license?.watermark).toBe(T2);

        // 时钟回拨到 T3 后才放行落盘：新授权必须继承 T2，而不是入口快照的 T1 或落盘时刻的 T3
        vi.setSystemTime(T3);
        gate.release();
        const result = await applying;

        expect(result.success).toBe(true);
        const stored = await readVault();
        expect(stored.license?.signed_token).toBe(newToken);
        expect(stored.license?.watermark).toBe(T2);
    });
});
