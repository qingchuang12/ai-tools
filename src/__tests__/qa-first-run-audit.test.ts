/**
 * QA 独立审计用例：首跑账本 / 试用防重置 / 首次使用即试用（BugFix 回归）
 *
 * 与 `license-trial.test.ts` 的区别：本文件是**验证方**独立构造的场景，
 * 重点在「防白嫖」与「首次使用即试用」两条主线的**反例**（删档 / 手改 / 时钟回拨 / 旧格式），
 * 以及错误路径（磁盘不可写）与两处账本不一致时的 fail-closed 取值。
 *
 * 隔离约定（**踩过的坑**）：`src/main/activation-store.ts` 的 `FILE` 在**模块加载时**就由
 * `os.homedir()` 算出来了，所以 `homedir` 的 spy 必须在该模块被 import **之前**装好，
 * 否则状态镜像会写到开发机真实的用户目录。tmpHome 因此全文件只建一次，用例间靠清空目录隔离。
 *
 * 所有文件写在临时目录下，不碰用户真实的 ~/.ai-tools。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;

const mocks = vi.hoisted(() => ({
    config: {
        version: 1 as const,
        enabled: true,
        killSwitch: false,
        sku: 'AI-TOOLS-PRO',
        acceptedSkus: ['pro-buyout'],
        skuFeatures: {'pro-buyout': ['cloud_sync']},
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
    getMachineCodePair: async (): Promise<{strong: string; soft: string}> => ({strong: mocks.strong, soft: mocks.soft}),
    getMachineCode: async (): Promise<string> => mocks.strong,
    getHardwareFactors: async (): Promise<{cpu: string; disk: string; board: string; osGuid: string}> => mocks.factors,
    warmupMachineCode: (): void => undefined,
}));

vi.mock('../main/license/keys', async () => {
    const {TEST_KEY_PAIR: pair} = await import('./helpers/license-test-keys');
    return {
        getPublicKey: (kid: string): unknown => (kid === 'default' ? pair.publicKey : null),
        clearKeyCache: (): void => undefined,
    };
});

// ── 隔离必须在任何被测模块被 import 之前生效 ────────────────────────────────
const ORIGINAL_APPDATA = process.env.APPDATA;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-qa-audit-'));
mocks.home = tmpHome;
process.env.APPDATA = path.join(tmpHome, 'AppData', 'Roaming');
const homedirSpy = vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);

const {readVault, writeVault} = await import('../main/license/vault');
const {grantTrial} = await import('../main/license/trial');
const {readFirstRunAt, writeFirstRun} = await import('../main/license/first-run');
const license = await import('../main/license');
const activationStore = await import('../main/activation-store');
const {FEATURE_PRO} = await import('../shared/license-constants');

const activationJson = (): string => path.join(tmpHome, '.ai-tools', 'activation.json');
const vaultFile = (): string => path.join(tmpHome, '.ai-tools', 'license-vault.json');

/** 与 `first-run.ts#ledgerPaths()` 同源的两处账本路径（测试侧独立实现，不复用被测代码） */
function ledgerPaths(): [string, string] {
    const home = tmpHome;
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        return [path.join(home, '.ai-tools-install'), path.join(appData, 'ai-tools', '.install-marker')];
    }
    if (process.platform === 'darwin') {
        return [
            path.join(home, 'Library', 'Application Support', 'ai-tools', '.install-marker'),
            path.join(home, 'Library', 'Caches', 'ai-tools', '.install-marker'),
        ];
    }
    return [
        path.join(home, '.config', 'ai-tools', '.install-marker'),
        path.join(home, '.local', 'share', 'ai-tools', '.install-marker'),
    ];
}

/** 用例间清空整个隔离目录（等价于全新机器） */
function wipeHome(): void {
    for (const entry of fs.readdirSync(tmpHome)) {
        fs.rmSync(path.join(tmpHome, entry), {recursive: true, force: true});
    }
}

beforeEach(() => {
    wipeHome();
    mocks.encryption = true;
    mocks.strong = 'AAAA-BBBB-CCCC-DDDD';
    mocks.soft = 'AAAA-BBBB-CCCC-EEEE';
    mocks.config.enabled = true;
    mocks.config.killSwitch = false;
    mocks.config.trial.days = 60;
    mocks.config.trial.maxRuns = null;
    mocks.config.clock.skewToleranceMs = 2 * 60 * 60 * 1000;
});

afterAll(() => {
    homedirSpy.mockRestore();
    if (ORIGINAL_APPDATA === undefined) {
        delete process.env.APPDATA;
    } else {
        process.env.APPDATA = ORIGINAL_APPDATA;
    }
    fs.rmSync(tmpHome, {recursive: true, force: true});
});

function writeLedgerAt(idx: 0 | 1, at: number): void {
    const p = ledgerPaths()[idx];
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, JSON.stringify({v: 1, first_run_at: at}));
}

function writeLegacyLedger(idx: 0 | 1, iso: string): void {
    const p = ledgerPaths()[idx];
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, iso);
}

function removeVault(): void {
    fs.rmSync(vaultFile(), {force: true});
}

function removeActivationJson(): void {
    fs.rmSync(activationJson(), {force: true});
}

/** 让 vault 不可写：把 ~/.ai-tools 变成**普通文件**，mkdir/rename 必然失败 */
function breakVaultDisk(): void {
    fs.rmSync(path.join(tmpHome, '.ai-tools'), {recursive: true, force: true});
    fs.writeFileSync(path.join(tmpHome, '.ai-tools'), 'not-a-dir');
}

async function seedVaultTrial(firstRunAt: number, watermark: number): Promise<void> {
    const trial = grantTrial(firstRunAt, mocks.soft);
    await writeVault({trial: {...trial, watermark}, license: null});
}

describe('A. 首次使用即试用（修复确实生效）', () => {
    it('A1 全新环境（无 activation.json / 无 vault / 无账本）→ trial，且窗口恰好 = config.trial.days', async () => {
        expect(fs.existsSync(activationJson())).toBe(false);
        expect(fs.existsSync(vaultFile())).toBe(false);
        expect(readFirstRunAt()).toBeNull();

        const state = await license.getState(null);

        expect(state.status).toBe('trial');
        expect(state.source).toBe('trial');
        expect(state.trialStartsAt).not.toBeNull();
        expect(state.trialExpiresAt).not.toBeNull();
        // 关键：窗口长度严格等于配置的 60 天，而不是写死的常量
        expect((state.trialExpiresAt ?? 0) - (state.trialStartsAt ?? 0)).toBe(mocks.config.trial.days * DAY_MS);
        // 起点就是本次运行，误差 < 5s
        expect(Math.abs((state.trialStartsAt ?? 0) - Date.now())).toBeLessThan(5000);
        // 账本已落盘，后续不会再发第二轮
        expect(readFirstRunAt()).not.toBeNull();
        for (const p of ledgerPaths()) expect(fs.existsSync(p)).toBe(true);
    });

    it('A2 升级用户：手工造 status=inactive 的 activation.json + 空 vault → 走完整链路仍是 trial', async () => {
        fs.mkdirSync(path.dirname(activationJson()), {recursive: true});
        fs.writeFileSync(
            activationJson(),
            JSON.stringify({
                status: 'inactive',
                trialStartsAt: null,
                trialExpiresAt: null,
                trialRunsLeft: null,
                activatedExpiresAt: null,
                activatedAt: null,
                machineCode: 'LEGACY-CODE',
                licenseKey: null,
                sku: null,
                features: [],
                source: 'none',
                degraded: null,
            })
        );
        // 旧版还会留下安装标记，这里以旧格式（纯 ISO 时间戳）复现
        writeLegacyLedger(0, new Date(Date.now() - 5 * DAY_MS).toISOString());

        // 走真实调用链：activation-store.getActivationState()
        const state = await activationStore.getActivationState();

        expect(state.status).toBe('trial');
        // 起点沿用 5 天前的旧标记，而不是「现在」——升级用户不该白拿一轮
        expect(Math.abs((state.trialStartsAt ?? 0) - (Date.now() - 5 * DAY_MS))).toBeLessThan(5000);
        // 明文镜像已被回写为 trial
        expect(JSON.parse(fs.readFileSync(activationJson(), 'utf-8')).status).toBe('trial');
    });

    it('A3 试用态必须含 FEATURE_PRO，且 gate 全量放行', async () => {
        const state = await license.getState(null);
        expect(state.status).toBe('trial');
        expect(state.features).toContain(FEATURE_PRO);
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(true);
        expect((await license.assertFeature('remote_connect')).allowed).toBe(true);
    });

    it('A4 无 activation.json 也不影响：删掉镜像后状态仍是 trial 且不重发', async () => {
        const first = await activationStore.getActivationState();
        const start0 = first.trialStartsAt;
        removeActivationJson();
        const second = await activationStore.getActivationState();
        expect(second.status).toBe('trial');
        expect(second.trialStartsAt).toBe(start0);
    });
});

describe('B. 防白嫖（删档 / 手改 / 时钟回拨）', () => {
    it('B1 删 activation.json → 试用起点不变', async () => {
        await activationStore.getActivationState();
        const before = (await readVault()).trial?.first_run_at;
        removeActivationJson();
        const state = await activationStore.getActivationState();
        expect(state.status).toBe('trial');
        expect((await readVault()).trial?.first_run_at).toBe(before);
        expect(state.trialStartsAt).toBe(before);
    });

    it('B2 删 vault（账本仍在）→ 按原 first_run_at 重建，剩余天数只减不增', async () => {
        const start = Date.now() - 30 * DAY_MS;
        writeLedgerAt(0, start);
        writeLedgerAt(1, start);
        await seedVaultTrial(start, start);

        const before = await license.getState(null);
        const remainingBefore = (before.trialExpiresAt ?? 0) - Date.now();

        removeVault();
        expect((await readVault()).trial).toBeNull();

        const after = await license.getState(null);
        expect(after.status).toBe('trial');
        expect(after.trialStartsAt).toBe(start);
        const remainingAfter = (after.trialExpiresAt ?? 0) - Date.now();
        expect(remainingAfter).toBeLessThanOrEqual(remainingBefore + 1000);
        // 重建后 vault 里的起点就是账本起点
        expect((await readVault()).trial?.first_run_at).toBe(start);
    });

    it('B3 只删单处账本不重置；两处都删才重置（重置需跨两个系统根目录的刻意操作）', async () => {
        const start = Date.now() - 20 * DAY_MS;
        writeLedgerAt(0, start);
        writeLedgerAt(1, start);
        await seedVaultTrial(start, start);

        // (a) 只删第一处 → 起点不动
        fs.rmSync(ledgerPaths()[0], {force: true});
        removeVault();
        let st = await license.getState(null);
        expect(st.trialStartsAt).toBe(start);

        // (b) 只删第二处 → 起点不动
        writeLedgerAt(0, start);
        writeLedgerAt(1, start);
        fs.rmSync(ledgerPaths()[1], {force: true});
        removeVault();
        st = await license.getState(null);
        expect(st.trialStartsAt).toBe(start);

        // (c) 两处都删 → 才会重置（本地无 TEE 的既有下限）
        fs.rmSync(ledgerPaths()[0], {force: true});
        fs.rmSync(ledgerPaths()[1], {force: true});
        removeVault();
        st = await license.getState(null);
        expect(st.status).toBe('trial');
        expect(st.trialStartsAt ?? 0).toBeGreaterThan(start);
        expect(Math.abs((st.trialStartsAt ?? 0) - Date.now())).toBeLessThan(5000);

        // 证据：两处账本不在同一父目录下（win32：USERPROFILE vs APPDATA）
        const [a, b] = ledgerPaths();
        expect(a).not.toBe(b);
        expect(path.dirname(path.dirname(a))).not.toBe(path.dirname(path.dirname(b)));
    });

    it('B4 手改账本到过去 → 零收益（剩余天数只减不增）', async () => {
        const realStart = Date.now() - 10 * DAY_MS;
        writeLedgerAt(0, realStart);
        writeLedgerAt(1, realStart);
        await seedVaultTrial(realStart, realStart);

        const baseline = await license.getState(null);

        // 把账本往前改 40 天（妄想「提前开始 → 更晚到期」）
        const earlier = realStart - 40 * DAY_MS;
        writeLedgerAt(0, earlier);
        writeLedgerAt(1, earlier);
        removeVault();

        const after = await license.getState(null);
        expect(after.status).toBe('trial');
        expect(after.trialStartsAt).toBe(earlier);
        expect(after.trialExpiresAt ?? 0).toBeLessThan(baseline.trialExpiresAt ?? 0);
        // 剩余天数严格变少
        expect((after.trialExpiresAt ?? 0) - Date.now()).toBeLessThan((baseline.trialExpiresAt ?? 0) - Date.now());
    });

    it('B5 手改账本到未来 → 拒发试用并判 vault_tampered（fail-closed），且可自愈', async () => {
        writeLedgerAt(0, Date.now() + 30 * DAY_MS);
        writeLedgerAt(1, Date.now() + 30 * DAY_MS);
        removeVault();

        const tampered = await license.getState(null);
        expect(tampered.status).toBe('inactive');
        expect(tampered.degraded).toBe('vault_tampered');
        expect((await readVault()).trial).toBeNull();
        expect((await license.assertFeature('cloud_sync')).allowed).toBe(false);

        // 时钟/账本恢复正常后，下一次判定自动发放（不再永久 inactive）
        writeLedgerAt(0, Date.now() - 1 * DAY_MS);
        writeLedgerAt(1, Date.now() - 1 * DAY_MS);
        const healed = await license.getState(null);
        expect(healed.status).toBe('trial');
    });

    it('B6 时钟回拨（删 vault + 回拨）→ 判 vault_tampered，拿不到新试用', async () => {
        const realNow = Date.now();
        const start = realNow - 61 * DAY_MS;
        writeLedgerAt(0, start);
        writeLedgerAt(1, start);
        removeVault();

        vi.useFakeTimers({toFake: ['Date']});
        try {
            vi.setSystemTime(realNow - 100 * DAY_MS);
            const st = await license.getState(null);
            expect(st.status).toBe('inactive');
            expect(st.degraded).toBe('vault_tampered');
        } finally {
            vi.useRealTimers();
        }
    });

    it('B7 时钟回拨 + 已过期试用 → 不能复活，且恢复时钟后仍是过期', async () => {
        const realNow = Date.now();
        const start = realNow - 61 * DAY_MS;
        // 水印被推到未来（等价于用户先把时间调前、再调回过去）
        await seedVaultTrial(start, realNow + 10 * DAY_MS);

        vi.useFakeTimers({toFake: ['Date']});
        try {
            vi.setSystemTime(realNow - 100 * DAY_MS);
            const st = await license.getState(null);
            expect(st.status).toBe('inactive');
            expect(st.degraded).toBe('vault_tampered');
            expect((await license.assertFeature('cloud_sync')).allowed).toBe(false);
        } finally {
            vi.useRealTimers();
        }

        // 时钟恢复正常后仍是过期（水印只增）
        const back = await license.getState(null);
        expect(back.status).toBe('inactive');
        expect(back.degraded).toBe('trial_expired');
    });

    it('B8 旧格式账本（纯 ISO 时间戳）被正确兼容，不把老用户误判成新装', async () => {
        const oldIso = new Date(Date.now() - 45 * DAY_MS).toISOString();
        writeLegacyLedger(0, oldIso);
        writeLegacyLedger(1, oldIso);
        removeVault();

        expect(readFirstRunAt()).toBe(Date.parse(oldIso));

        const st = await license.getState(null);
        expect(st.status).toBe('trial');
        expect(st.trialStartsAt).toBe(Date.parse(oldIso));
        // 剩余 ~15 天，而不是新的 60 天
        expect((st.trialExpiresAt ?? 0) - Date.now()).toBeLessThan(16 * DAY_MS);

        // 起点不会被「读一次就刷新」：再读一次仍然同一个起点
        const again = await license.getState(null);
        expect(again.trialStartsAt).toBe(Date.parse(oldIso));
    });

    it('B9 旧格式账本已超 60 天 → 判 trial_expired，不重发', async () => {
        const oldIso = new Date(Date.now() - 90 * DAY_MS).toISOString();
        writeLegacyLedger(0, oldIso);
        writeLegacyLedger(1, oldIso);
        removeVault();

        const st = await license.getState(null);
        expect(st.status).toBe('inactive');
        expect(st.degraded).toBe('trial_expired');
    });
});

describe('D. 边缘与错误路径', () => {
    it('D1 vault 不可写（~/.ai-tools 被占为文件）→ 不抛异常、仍返回 trial，且不会每跑一次重置起点', async () => {
        breakVaultDisk();

        await expect(license.getState(null)).resolves.toMatchObject({status: 'trial'});
        const first = await license.getState(null);
        const start0 = first.trialStartsAt;

        // 磁盘依旧不可写
        breakVaultDisk();
        const second = await license.getState(null);
        expect(second.status).toBe('trial');
        // 起点被首跑账本钉住，不因 vault 写失败而刷新
        expect(second.trialStartsAt).toBe(start0);
    });

    it('D2 两处账本不一致 → 取「最早且合法」的值（fail-closed）', async () => {
        // (a) 一处合法、一处是垃圾
        const t0 = Date.now() - 12 * DAY_MS;
        writeLedgerAt(0, t0);
        const p1 = ledgerPaths()[1];
        fs.mkdirSync(path.dirname(p1), {recursive: true});
        fs.writeFileSync(p1, 'GARBAGE-NOT-JSON');
        expect(readFirstRunAt()).toBe(t0);

        // (b) 两处都合法但不同 → 取更早的那个（剩余更少）
        const earlier = Date.now() - 40 * DAY_MS;
        const later = Date.now() - 5 * DAY_MS;
        writeLedgerAt(0, earlier);
        writeLedgerAt(1, later);
        expect(readFirstRunAt()).toBe(earlier);

        removeVault();
        const st = await license.getState(null);
        expect(st.trialStartsAt).toBe(earlier);

        // (c) 一处过去、一处被改到未来 → 取过去那个，判 trial 而非 tampered
        writeLedgerAt(0, earlier);
        writeLedgerAt(1, Date.now() + 30 * DAY_MS);
        removeVault();
        const st2 = await license.getState(null);
        expect(st2.status).toBe('trial');
        expect(st2.trialStartsAt).toBe(earlier);
    });

    it('D3 账本内容非数字 / 空串 / 非法 JSON → 视为无账本', async () => {
        for (const bad of ['', '   ', '{"v":1}', '{"v":1,"first_run_at":"x"}', 'not-a-date']) {
            for (const p of ledgerPaths()) {
                fs.mkdirSync(path.dirname(p), {recursive: true});
                fs.writeFileSync(p, bad);
            }
            expect(readFirstRunAt()).toBeNull();
        }
    });

    it('D4 writeFirstRun 幂等：已有合法值时沿用原值，不会被 nowMs 顶掉', async () => {
        const t0 = Date.now() - 25 * DAY_MS;
        writeFirstRun(t0);
        writeFirstRun(Date.now());
        writeFirstRun(Date.now() + 10 * DAY_MS);
        expect(readFirstRunAt()).toBe(t0);
    });

    it('D5 导出签名稳定：getState / grantTrialOnFirstInstall / init / deactivate', () => {
        expect(typeof license.getState).toBe('function');
        expect(typeof license.grantTrialOnFirstInstall).toBe('function');
        expect(typeof license.init).toBe('function');
        expect(typeof license.deactivate).toBe('function');
        expect(typeof license.assertFeature).toBe('function');
        expect(typeof license.redeem).toBe('function');
    });

    it('D6 deactivate 后仍是 trial（起点不变），且不会新发一轮', async () => {
        const start = Date.now() - 8 * DAY_MS;
        writeLedgerAt(0, start);
        writeLedgerAt(1, start);
        removeVault();
        const before = await license.getState(null);
        expect(before.status).toBe('trial');

        const after = await license.deactivate();
        expect(after.status).toBe('trial');
        expect(after.trialStartsAt).toBe(start);
        expect((await readVault()).license?.signed_token).toBeNull();
    });
});
