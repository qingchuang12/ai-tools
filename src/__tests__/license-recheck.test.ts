/**
 * 定期联网复核（plan-7.0）验收单测 —— 按「方案 A（自然日）」语义。
 *
 * 覆盖范围（对应设计文档 12-14 条验收用例，全部用 `vi.stubGlobal('fetch')` 模拟服务端、
 * 注入 `nowMs` 获得确定性）：
 *   1. 200 + ACTIVE        → active，不禁用，刷新 last_verified_ok_at
 *   2. 400 + LICENSE_INVALID → revoked，立即禁用，revoked_by_server=true
 *   3. 400 + LICENSE_EXPIRED  → revoked，立即禁用
 *   4. 400 + LICENSE_NOT_FOUND → unknown，**永不**禁用（服务端数据迁移瞬时态）
 *   5. 429 空 body         → unknown，不禁用
 *   6. 网络/超时抛异常       → unknown，不禁用
 *   7. 响应体 JSON 畸形      → unknown，不禁用
 *   8. 方案 A 自然日：last_verified_ok_at 6 天前→false，8 天前→true
 *   9. last_verified_ok_at 为 null 回落 activated_at；两者皆无→不误杀
 *  10. revoked_by_server=true → 无论宽限，一律禁用
 *  11. getState：停用闸门压过验签（revoked 授权即使 token 合法也返回 token_invalid）
 *  12. deactivate 清空复核四字段，但保留 watermark / server_time_floor（川哥 2026-09-24 拍板）
 *  13. recheck.enabled=false → isDisabledByRecheck 恒 false；runRecheck 直接 skipped 且不发请求
 *  14. 429 连续多轮耗尽自然日 → 第 7 天 disabled（revoked_by_server 仍 false）
 *
 * 设计红线（务必在测试中守住）：
 * - 宁可放过不误杀：只有 LICENSE_INVALID / LICENSE_EXPIRED 立即停用，其余一律 unknown/grace。
 * - 429 照常累加宽限：方案 A 下停用判定现算（now - last_verified_ok_at >= 7 天），
 *   429 不刷新 last_verified_ok_at，但也不把它清零，故连续 429 终究会在第 7 天耗尽宽限。
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
/** 固定基准时间，避免依赖 Date.now() 造成抖动 */
const BASE = 1_700_000_000_000;

const mocks = vi.hoisted(() => ({
    config: {} as LicenseConfig,
    mid: {strong: 'RECHECK-STRONG', soft: 'RECHECK-SOFT'},
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

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-recheck-'));
mocks.home = tmpHome;
vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);

const {isDisabledByRecheck, runRecheck} = await import('../main/license/recheck');
const {getState, deactivate} = await import('../main/license');
const {readVault, writeVault} = await import('../main/license/vault');

/** 完整且自洽的默认配置（包外缺省值的镜像）；按用例覆盖 recheck 子段 */
function defaultConfig(): LicenseConfig {
    const d = DEFAULT_LICENSE_CONFIG;
    return {
        ...d,
        sku: 'pro-buyout',
        acceptedSkus: ['pro-buyout', 'pro-subscription'],
        skuFeatures: {'pro-buyout': ['cloud_sync'], 'pro-subscription': ['cloud_sync']},
        defaultKid: 'default',
        serviceBaseUrl: 'https://billing.example.test',
        features: {proFeature: 'pro', gated: ['cloud_sync']},
        recheck: {...d.recheck},
    };
}

/** 无签名的占位 token：仅用于 runRecheck 取 licenseKey（extractLicenseKeyFromToken 只解码 payload） */
function makeToken(lic = 'LIC-TEST-RECHECK-0001'): string {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');
    const header = b64({alg: 'EdDSA', typ: 'JWT', kid: 'default'});
    const payload = b64({sku: 'pro-subscription', mid: 'MID', iat: 1, exp: null, feat: ['OFFLINE'], lic});
    const sig = b64('dummy-signature');
    return `${header}.${payload}.${sig}`;
}

/** 用测试私钥签一张合法令牌（case 11 需要真验签通过） */
function makeSignedToken(expSec: number, mid: string, sku = 'pro-buyout'): string {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');
    const header = b64({alg: 'EdDSA', typ: 'JWT', kid: 'default'});
    const payload = b64({
        jti: 'jti-recheck-0001',
        sku,
        mid,
        iat: Math.floor(Date.now() / 1000) - 60,
        exp: expSec,
        feat: ['OFFLINE'],
        lic: 'LIC-TEST-RECHECK-11',
    });
    const sig = sign(null, Buffer.from(`${header}.${payload}`, 'utf-8'), TEST_KEY_PAIR.privateKey);
    return `${header}.${payload}.${sig.toString('base64url')}`;
}

/** 落一份完整 license 账本（含复核四字段），其余字段给默认值 */
function seedLicense(overrides: Partial<LicenseVault> = {}): LicenseVault {
    return {
        signed_token: makeToken(),
        activated_at: BASE,
        mid_at_activation: 'MID',
        mid_soft_at_activation: 'SOFT',
        watermark: BASE,
        server_time_floor: null,
        binding_reported: false,
        last_checked_at: null,
        last_verified_ok_at: null,
        offline_grace_used_ms: 0,
        revoked_by_server: false,
        ...overrides,
    };
}

function seedTrial(nowMs: number): TrialVault {
    return {
        first_run_at: nowMs - 1000,
        trial_count: 1,
        last_run_at: nowMs - 1000,
        trial_token: '',
        watermark: nowMs - 1000,
        mid_soft_at_activation: 'SOFT',
        hardware_grace_used: 0,
        hardware_grace_until: null,
        server_time_floor: null,
    };
}

interface FetchSpec {
    status: number;
    body?: unknown;
    date?: string | null;
    throws?: boolean;
    jsonThrows?: boolean;
}

/** 用固定响应桩住全局 fetch；url 由被调方拼装，这里忽略 */
function stubFetch(spec: FetchSpec): void {
    vi.stubGlobal('fetch', async (_url: string) => {
        if (spec.throws) throw new Error('ECONNREFUSED');
        return {
            status: spec.status,
            headers: {get: (name: string): string | null => (String(name).toLowerCase() === 'date' ? (spec.date ?? null) : null)},
            json: async () => {
                if (spec.jsonThrows) throw new SyntaxError('Unexpected token in JSON');
                return spec.body;
            },
        };
    });
}

function wipeHome(): void {
    for (const entry of fs.readdirSync(tmpHome)) {
        fs.rmSync(path.join(tmpHome, entry), {recursive: true, force: true});
    }
}

beforeEach(() => {
    mocks.config = defaultConfig();
    wipeHome();
    // 默认桩：任何内部探测（machine-probe 等）一律 404，避免真实网络；具体用例再覆盖
    vi.stubGlobal('fetch', async () => ({status: 404, headers: {get: (): null => null}, json: async () => ({})}));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    wipeHome();
});

describe('recheck：服务端响应 → 四态分类与禁用判定', () => {
    it('1) 200 + ACTIVE → verdict=active，不禁用，并刷新 last_verified_ok_at', async () => {
        const now = BASE + 1000;
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: null, activated_at: BASE})});
        stubFetch({status: 200, body: {success: true, code: 'SUCCESS', data: {status: 'ACTIVE'}}});

        const outcome = await runRecheck(now);

        expect(outcome.verdict).toBe('active');
        expect(outcome.disabled).toBe(false);
        expect(outcome.serverCode).toBe('SUCCESS');
        const stored = await readVault();
        expect(stored.license?.last_verified_ok_at).toBe(now);
        // 白名单只保留 true/null，落盘后非吊销态为 null
        expect(stored.license?.revoked_by_server).toBeNull();
        expect(stored.license?.offline_grace_used_ms).toBe(0);
    });

    it('2) 400 + LICENSE_INVALID → verdict=revoked，立即禁用，revoked_by_server=true', async () => {
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: BASE, activated_at: BASE})});
        stubFetch({status: 400, body: {success: false, code: 'LICENSE_INVALID', message: 'revoked'}});

        const outcome = await runRecheck(BASE + 1000);

        expect(outcome.verdict).toBe('revoked');
        expect(outcome.disabled).toBe(true);
        expect(outcome.serverCode).toBe('LICENSE_INVALID');
        const stored = await readVault();
        expect(stored.license?.revoked_by_server).toBe(true);
    });

    it('3) 400 + LICENSE_EXPIRED → verdict=revoked，立即禁用', async () => {
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: BASE, activated_at: BASE})});
        stubFetch({status: 400, body: {success: false, code: 'LICENSE_EXPIRED', message: 'expired'}});

        const outcome = await runRecheck(BASE + 1000);

        expect(outcome.verdict).toBe('revoked');
        expect(outcome.disabled).toBe(true);
        expect(outcome.serverCode).toBe('LICENSE_EXPIRED');
    });

    it('4) 400 + LICENSE_NOT_FOUND → verdict=unknown，且不强制停用（宽限内 disabled=false）', async () => {
        // 末次成功复核就在近期（宽限远未耗尽）：NOT_FOUND 归 unknown，不应强制停用。
        // 与用例 2/3（INVALID/EXPIRED 即便宽限内也立即 revoked）形成对照，证明 NOT_FOUND 永不立即禁用。
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: BASE, activated_at: BASE})});
        stubFetch({status: 400, body: {success: false, code: 'LICENSE_NOT_FOUND', message: 'not found'}});

        const outcome = await runRecheck(BASE + 1000);

        expect(outcome.verdict).toBe('unknown');
        expect(outcome.disabled).toBe(false);
        const stored = await readVault();
        // unknown 分支不刷新 last_verified_ok_at，也绝不改写为吊销
        expect(stored.license?.last_verified_ok_at).toBe(BASE);
        expect(stored.license?.revoked_by_server).toBeNull();
    });

    it('5) 429 空 body → verdict=unknown，不禁用（429 必须先判 status 再 json）', async () => {
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: BASE, activated_at: BASE})});
        stubFetch({status: 429, jsonThrows: true});

        const outcome = await runRecheck(BASE + 1000);

        expect(outcome.verdict).toBe('unknown');
        expect(outcome.httpStatus).toBe(429);
        expect(outcome.disabled).toBe(false);
    });

    it('6) 网络/超时抛异常 → verdict=unknown，不禁用', async () => {
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: BASE, activated_at: BASE})});
        stubFetch({throws: true});

        const outcome = await runRecheck(BASE + 1000);

        expect(outcome.verdict).toBe('unknown');
        expect(outcome.httpStatus).toBeNull();
        expect(outcome.disabled).toBe(false);
    });

    it('7) 响应体 JSON 畸形 → verdict=unknown，不禁用', async () => {
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: BASE, activated_at: BASE})});
        stubFetch({status: 200, jsonThrows: true});

        const outcome = await runRecheck(BASE + 1000);

        expect(outcome.verdict).toBe('unknown');
        expect(outcome.disabled).toBe(false);
    });
});

describe('recheck：方案 A（自然日）停用判定 —— isDisabledByRecheck 纯函数', () => {
    const cfg = defaultConfig();

    it('8) last_verified_ok_at 6 天前→false，8 天前→true（offlineGraceDays=7）', () => {
        const recent = seedLicense({last_verified_ok_at: BASE - 6 * DAY_MS, activated_at: BASE});
        const old = seedLicense({last_verified_ok_at: BASE - 8 * DAY_MS, activated_at: BASE});

        expect(isDisabledByRecheck(recent, cfg, BASE)).toBe(false);
        expect(isDisabledByRecheck(old, cfg, BASE)).toBe(true);
    });

    it('9) last_verified_ok_at 为 null 回落 activated_at；两者皆无→不误杀', () => {
        const fallback = seedLicense({last_verified_ok_at: null, activated_at: BASE - 8 * DAY_MS});
        expect(isDisabledByRecheck(fallback, cfg, BASE)).toBe(true);

        const noAnchor = seedLicense({last_verified_ok_at: null, activated_at: null});
        expect(isDisabledByRecheck(noAnchor, cfg, BASE)).toBe(false);
    });

    it('10) revoked_by_server=true → 无论宽限是否耗尽，一律禁用', () => {
        const fresh = seedLicense({revoked_by_server: true, last_verified_ok_at: BASE, activated_at: BASE});
        expect(isDisabledByRecheck(fresh, cfg, BASE)).toBe(true);
    });
});

describe('recheck：闸门消费点', () => {
    it('11) getState：停用闸门压过验签（revoked 授权即使 token 合法也返回 token_invalid）', async () => {
        mocks.mid = {strong: 'RECHECK-STRONG', soft: 'RECHECK-SOFT'};
        const validToken = makeSignedToken(Math.floor(Date.now() / 1000) + 365 * 86400, 'RECHECK-STRONG');
        const recent = Date.now();

        // 11a：同一张合法 token + 近期 last_verified_ok_at，但服务端已吊销 → 闸门立刻生效
        await writeVault({
            trial: null,
            license: {
                ...seedLicense({
                    signed_token: validToken,
                    mid_at_activation: 'RECHECK-STRONG',
                    mid_soft_at_activation: 'RECHECK-SOFT',
                    last_verified_ok_at: recent,
                    activated_at: recent,
                    revoked_by_server: true,
                }),
            },
        });
        const disabled = await getState(null);
        expect(disabled.status).toBe('inactive');
        expect(disabled.degraded).toBe('token_invalid');

        // 11b：同一张 token、同样的近期状态，仅把 revoked 标记清掉 → 闸门让位验签，返回 activated。
        // 反证：11a 的 token_invalid 完全是停用闸门所致，而非 token 本身不合法。
        await writeVault({
            trial: null,
            license: {
                ...seedLicense({
                    signed_token: validToken,
                    mid_at_activation: 'RECHECK-STRONG',
                    mid_soft_at_activation: 'RECHECK-SOFT',
                    last_verified_ok_at: recent,
                    activated_at: recent,
                    revoked_by_server: false,
                }),
            },
        });
        const enabled = await getState(null);
        expect(enabled.status).toBe('activated');
    });

    it('12) deactivate 清空复核四字段，但保留 watermark / server_time_floor（川哥拍板）', async () => {
        const W = 1_600_000_000_000;
        const F = 1_650_000_000_000;
        await writeVault({
            trial: seedTrial(BASE),
            license: seedLicense({
                signed_token: makeToken('LIC-DEACTIVATE-KEEP'),
                watermark: W,
                server_time_floor: F,
                revoked_by_server: true,
                last_checked_at: BASE - 1000,
                last_verified_ok_at: BASE - 2000,
                offline_grace_used_ms: 1234,
                binding_reported: true,
            }),
        });

        await deactivate();
        const stored = await readVault();

        // 必须保留的反回拨单调水位
        expect(stored.license?.watermark).toBe(W);
        expect(stored.license?.server_time_floor).toBe(F);
        // 必须清空的敏感/激活字段
        expect(stored.license?.signed_token).toBeNull();
        expect(stored.license?.activated_at).toBeNull();
        expect(stored.license?.mid_at_activation).toBeNull();
        expect(stored.license?.mid_soft_at_activation).toBeNull();
        // 必须清空的复核四字段（白名单只保留 true/null，故落盘为 null）
        expect(stored.license?.revoked_by_server).toBeNull();
        expect(stored.license?.offline_grace_used_ms).toBe(0);
        expect(stored.license?.last_checked_at).toBeNull();
        expect(stored.license?.last_verified_ok_at).toBeNull();
        expect(stored.license?.binding_reported).toBeNull();
    });
});

describe('recheck：开关与宽限耗尽', () => {
    it('13) recheck.enabled=false → isDisabledByRecheck 恒 false；runRecheck 直接 skipped 且不发请求', async () => {
        mocks.config = {...defaultConfig(), recheck: {...defaultConfig().recheck, enabled: false}};

        // 即便宽限早已耗尽，关掉开关也绝不误杀
        const exhausted = seedLicense({last_verified_ok_at: BASE - 30 * DAY_MS, activated_at: BASE});
        expect(isDisabledByRecheck(exhausted, mocks.config, BASE)).toBe(false);

        const fetchSpy = vi.fn(async () => ({status: 200, headers: {get: () => null}, json: async () => ({})}));
        vi.stubGlobal('fetch', fetchSpy);
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: BASE - 30 * DAY_MS})});

        const outcome = await runRecheck(BASE + 1000);
        expect(outcome.verdict).toBe('skipped');
        expect(outcome.disabled).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('14) 429 连续多轮耗尽自然日 → 第 7 天 disabled（revoked_by_server 仍 false）', async () => {
        // 末次成功复核在 T0；之后服务端一直 429 答不上来，宽限（7 天）按真实经过天数现算。
        const T0 = BASE;
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: T0, activated_at: T0})});
        stubFetch({status: 429});

        const flags: boolean[] = [];
        for (let day = 0; day <= 7; day++) {
            const outcome = await runRecheck(T0 + day * DAY_MS);
            flags.push(outcome.disabled);
        }
        // 第 0~6 天仍在宽限内：不禁用；跨过第 7 天（真实经过 >= 7×DAY）：禁用
        expect(flags.slice(0, 7)).toEqual([false, false, false, false, false, false, false]);
        expect(flags[7]).toBe(true);

        const stored = await readVault();
        // 429 是 unknown，不会把授权标成吊销（白名单只保留 true/null，故落盘为 null），也不会改写末次成功复核时间
        expect(stored.license?.revoked_by_server).toBeNull();
        expect(stored.license?.last_verified_ok_at).toBe(T0);
    });
});
