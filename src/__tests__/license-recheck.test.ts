/**
 * 定期联网复核（plan-7.0 → plan-1.0 节奏改造）验收单测 —— 按「方案 A（自然日）+ 分段宽限」语义。
 *
 * 覆盖范围（注入 `nowMs` 获得确定性；停用判定一律显式传 `attemptPending`，不依赖模块状态顺序）：
 *   1. 200 + ACTIVE        → active，不禁用，刷新 last_verified_ok_at
 *   2. 400 + LICENSE_INVALID → revoked，立即禁用，revoked_by_server=true
 *   3. 400 + LICENSE_EXPIRED  → revoked，立即禁用
 *   4. 400 + LICENSE_NOT_FOUND → unknown，**永不**禁用（服务端数据迁移瞬时态）
 *   5. 429 空 body         → unknown，不禁用
 *   6. 网络/超时抛异常       → unknown，不禁用
 *   7. 响应体 JSON 畸形      → unknown，不禁用
 *   8. 停用阈值 = hardStopDays（默认 60 天）：阈值内 false / 阈值上 true
 *   9. last_verified_ok_at 为 null 回落 activated_at；两者皆无→不误杀
 *  10. revoked_by_server=true → 无论宽限，一律禁用
 *  11. getState：停用闸门压过验签（revoked 授权即使 token 合法也返回 token_invalid）
 *  12. deactivate 清空复核字段（含 next_check_at），但保留 watermark / server_time_floor（川哥 2026-09-24 拍板）
 *  13. recheck.enabled=false → isDisabledByRecheck 恒 false；runRecheck 直接 skipped 且不发请求
 *  14. 429 连续多轮 → 跨过 hardStopDays 当天 disabled（revoked_by_server 仍 false）
 *  —— plan-1.0 新增（15~22）——
 *  15. 排期：unknown → now + retryMs（2 小时）；active → now + intervalMs（15 天）；429 → ≥ now + rateLimitedRetryMs
 *  16. 红线 4：闲置超硬停但**本次进程尚未复核** → 不停用（新误杀面已被堵住）
 *  17. 红线 4 解除：闲置 70 天后启动 + 复核拿不到结论 → 本次即停用
 *  18. 提醒段：超过 offlineGraceDays 未到 hardStopDays → needsOnlineVerify=true 且**不停用**
 *  19. getState：提醒段用户功能照常（status=activated、features 不减）
 *  20. 排期跨重启：startRecheckLoop 读 next_check_at，未到点不发起请求
 *  21. 红线 4：getState 停用判定优先于验签，但受 attemptPending 保护
 *  22. 阈值兜底：hardStopDays 小于 offlineGraceDays 时按配置原样判定（clamp 属 config 层，见 license-recheck-config 用例）
 *
 * 设计红线（务必在测试中守住）：
 * - 宁可放过不误杀：只有 LICENSE_INVALID / LICENSE_EXPIRED 立即停用，其余一律 unknown/grace。
 * - 429 照常累加宽限：方案 A 下停用判定现算（now - last_verified_ok_at >= hardStopDays），
 *   429 既不刷新也不清零 last_verified_ok_at，故连续 429 终究会在阈值当天耗尽宽限。
 * - 15 天心跳必须配 30/60 天分段：宽限若小于「一个心跳周期」，用户只是隔周期没开机就会被误杀。
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

/**
 * `os.homedir()` 必须**每个用例前**重新 spy：`afterEach` 的 `restoreAllMocks()` 会把它还原成真实家目录，
 * 于是第 2 个用例起 `vault.ts` / `anchor.ts` 就往开发者自己的 `~/.ai-tools/` 里写——
 * 覆写的是真实的 license-vault.json / license-anchor.json（真激活数据，且 mock 密文让本机授权直接失效）。
 */
vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);

const {isDisabledByRecheck, isRecheckAttentionNeeded, runRecheck, startRecheckLoop, stopRecheckLoop} = await import(
    '../main/license/recheck'
);
const {getState, deactivate} = await import('../main/license');
const {readVault, writeVault} = await import('../main/license/vault');

/** 节奏常量从配置取（勿在用例里写死 15 天 / 2 小时，改默认值时用例要跟着改） */
const RECHECK = DEFAULT_LICENSE_CONFIG.recheck;

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

/** 轮询等待后台链路的副作用（fs 写入 + fetch 都是真异步，固定 sleep 在 CI 上不稳） */
async function until(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return cond();
}

beforeEach(() => {
    mocks.config = defaultConfig();
    mocks.mid = {strong: 'RECHECK-STRONG', soft: 'RECHECK-SOFT'};
    vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);
    wipeHome();
    // 默认桩：任何内部探测（machine-probe 等）一律 404，避免真实网络；具体用例再覆盖
    vi.stubGlobal('fetch', async () => ({status: 404, headers: {get: (): null => null}, json: async () => ({})}));
});

afterEach(() => {
    stopRecheckLoop();
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

describe('recheck：停用判定阈值（hardStopDays 分段）—— isDisabledByRecheck 纯函数', () => {
    const cfg = defaultConfig();
    /** 已解除红线 4 保护（本次进程问过服务端）时的判定 */
    const stopped = (license: LicenseVault, nowMs: number): boolean => isDisabledByRecheck(license, cfg, nowMs, false);

    it('8) 停用阈值 = hardStopDays：阈值前一天 false，阈值当天 true', () => {
        const days = cfg.recheck.hardStopDays;
        expect(stopped(seedLicense({last_verified_ok_at: BASE - (days - 1) * DAY_MS, activated_at: BASE}), BASE)).toBe(
            false,
        );
        expect(stopped(seedLicense({last_verified_ok_at: BASE - days * DAY_MS, activated_at: BASE}), BASE)).toBe(true);
    });

    it('9) last_verified_ok_at 为 null 回落 activated_at；两者皆无→不误杀', () => {
        const fallback = seedLicense({
            last_verified_ok_at: null,
            activated_at: BASE - (cfg.recheck.hardStopDays + 8) * DAY_MS,
        });
        expect(stopped(fallback, BASE)).toBe(true);

        const noAnchor = seedLicense({last_verified_ok_at: null, activated_at: null});
        expect(stopped(noAnchor, BASE)).toBe(false);
    });

    it('10) revoked_by_server=true → 无论宽限与红线 4，一律禁用', () => {
        const fresh = seedLicense({revoked_by_server: true, last_verified_ok_at: BASE, activated_at: BASE});
        // 权威结论不依赖「本次是否问过服务端」：attemptPending=true 也照样停用
        expect(isDisabledByRecheck(fresh, cfg, BASE, true)).toBe(true);
    });

    it('22) 纯函数不跨段兜底：阈值关系由 config 层 clamp 保证，这里只验按配置原样判定', () => {
        const crossed = {...cfg, recheck: {...cfg.recheck, offlineGraceDays: 60, hardStopDays: 30}};
        const idle45 = seedLicense({last_verified_ok_at: BASE - 45 * DAY_MS, activated_at: BASE});
        // 提醒段按 60 天算 → 未触发；停用段按 30 天算 → 已触发。两层 clamp 逻辑不在此函数内。
        expect(isRecheckAttentionNeeded(idle45, crossed, BASE)).toBe(false);
        expect(isDisabledByRecheck(idle45, crossed, BASE, false)).toBe(true);
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

    it('12) deactivate 清空复核字段（含排期 next_check_at），但保留 watermark / server_time_floor（川哥拍板）', async () => {
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
                next_check_at: BASE + RECHECK.intervalMs,
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
        // 排期同样清零：去激活后不该让下一次启动沿用「上一张授权的 15 天节奏」
        expect(stored.license?.next_check_at).toBeNull();
    });
});

describe('recheck：开关、排期与宽限耗尽', () => {
    it('13) recheck.enabled=false → isDisabledByRecheck 恒 false；runRecheck 直接 skipped 且不发请求', async () => {
        mocks.config = {...defaultConfig(), recheck: {...defaultConfig().recheck, enabled: false}};

        // 即便宽限早已耗尽，关掉开关也绝不误杀
        const exhausted = seedLicense({last_verified_ok_at: BASE - 90 * DAY_MS, activated_at: BASE});
        expect(isDisabledByRecheck(exhausted, mocks.config, BASE, false)).toBe(false);

        const fetchSpy = vi.fn(async () => ({status: 200, headers: {get: () => null}, json: async () => ({})}));
        vi.stubGlobal('fetch', fetchSpy);
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: BASE - 90 * DAY_MS})});

        const outcome = await runRecheck(BASE + 1000);
        expect(outcome.verdict).toBe('skipped');
        expect(outcome.disabled).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('14) 429 连续多轮 → 跨过 hardStopDays 当天 disabled（revoked_by_server 仍 false）', async () => {
        // 末次成功复核在 T0；之后服务端一直 429 答不上来，宽限按真实经过天数现算（红线 3：429 照常累加）。
        const T0 = BASE;
        const limit = defaultConfig().recheck.hardStopDays;
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: T0, activated_at: T0})});
        stubFetch({status: 429});

        const flags: boolean[] = [];
        for (let day = 0; day <= limit; day++) {
            const outcome = await runRecheck(T0 + day * DAY_MS);
            flags.push(outcome.disabled);
        }
        // 阈值之前全部放行；跨过阈值当天（真实经过 >= hardStopDays×DAY）才禁用
        expect(flags.slice(0, limit)).toEqual(new Array(limit).fill(false));
        expect(flags[limit]).toBe(true);

        const stored = await readVault();
        // 429 是 unknown，不会把授权标成吊销（白名单只保留 true/null，故落盘为 null），也不会改写末次成功复核时间
        expect(stored.license?.revoked_by_server).toBeNull();
        expect(stored.license?.last_verified_ok_at).toBe(T0);
    });

    it('15) 排期落盘：unknown→+retryMs(2h)；active→+intervalMs(15d)；429→+rateLimitedRetryMs(+抖动)', async () => {
        const cfg = defaultConfig();

        // 15a：拿不到结论 → 按 retryMs 重试，而不是傻等 15 天
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: BASE, activated_at: BASE})});
        stubFetch({throws: true});
        await runRecheck(BASE);
        expect((await readVault()).license?.next_check_at).toBe(BASE + cfg.recheck.retryMs);

        // 15b：明确 ACTIVE → 回归 15 天节奏
        stubFetch({status: 200, body: {success: true, code: 'SUCCESS', data: {status: 'ACTIVE'}}});
        await runRecheck(BASE + cfg.recheck.retryMs);
        expect((await readVault()).license?.next_check_at).toBe(BASE + cfg.recheck.retryMs + cfg.recheck.intervalMs);

        // 15c：429 → 退避 base 之上再加 0~10min 抖动（同 NAT 群体不同时重试）
        stubFetch({status: 429});
        const t429 = BASE + 2 * cfg.recheck.retryMs;
        await runRecheck(t429);
        const scheduled = (await readVault()).license?.next_check_at ?? 0;
        expect(scheduled).toBeGreaterThanOrEqual(t429 + cfg.recheck.rateLimitedRetryMs);
        expect(scheduled).toBeLessThan(t429 + cfg.recheck.rateLimitedRetryMs + 10 * 60 * 1000);
    });

    it('16) 红线 4：闲置超阈值但本次进程尚未复核 → 不停用；服务端权威吊销不受此保护', () => {
        const cfg = defaultConfig();
        const idle90 = seedLicense({last_verified_ok_at: BASE - 90 * DAY_MS, activated_at: BASE});
        // attemptPending=true（还没问过服务端）→ 放行，等本次复核翻案
        expect(isDisabledByRecheck(idle90, cfg, BASE, true)).toBe(false);
        // 但 revoked_by_server 是服务端明确结论，不需要再问一次才生效
        const revoked = seedLicense({revoked_by_server: true, last_verified_ok_at: BASE, activated_at: BASE});
        expect(isDisabledByRecheck(revoked, cfg, BASE, true)).toBe(true);
    });

    it('17) 红线 4 解除：闲置 90 天后启动 + 本次复核拿不到结论 → 本次即停用', async () => {
        // runRecheck 在 fetch 之后、判定之前解除保护，故「问过但问不出答案」不再受红线 4 庇护。
        const T0 = BASE;
        await writeVault({
            trial: null,
            license: seedLicense({last_verified_ok_at: T0 - 90 * DAY_MS, activated_at: T0 - 90 * DAY_MS}),
        });
        stubFetch({throws: true});

        const outcome = await runRecheck(T0);
        expect(outcome.verdict).toBe('unknown');
        expect(outcome.disabled).toBe(true);
    });

    it('18) 提醒段：超过 offlineGraceDays 未到 hardStopDays → 需联网验证且不停用', () => {
        const cfg = defaultConfig();
        const inGrace = seedLicense({last_verified_ok_at: BASE - 10 * DAY_MS, activated_at: BASE});
        const inWarn = seedLicense({last_verified_ok_at: BASE - 45 * DAY_MS, activated_at: BASE});

        expect(isRecheckAttentionNeeded(inGrace, cfg, BASE)).toBe(false);
        expect(isRecheckAttentionNeeded(inWarn, cfg, BASE)).toBe(true);
        // 提醒段绝不减功能、也不停用（U1 分段口径）
        expect(isDisabledByRecheck(inWarn, cfg, BASE, false)).toBe(false);
    });

    it('19) getState：提醒段仍是 activated，功能不减，只置 needsOnlineVerify', async () => {
        mocks.mid = {strong: 'RECHECK-STRONG', soft: 'RECHECK-SOFT'};
        const validToken = makeSignedToken(Math.floor(Date.now() / 1000) + 365 * 86400, 'RECHECK-STRONG');
        const now = Date.now();

        await writeVault({
            trial: null,
            license: seedLicense({
                signed_token: validToken,
                mid_at_activation: 'RECHECK-STRONG',
                mid_soft_at_activation: 'RECHECK-SOFT',
                last_verified_ok_at: now - 45 * DAY_MS,
                activated_at: now - 45 * DAY_MS,
            }),
        });

        const state = await getState(null);
        expect(state.status).toBe('activated');
        expect(state.needsOnlineVerify).toBe(true);
        expect(state.features).toContain('cloud_sync');
        expect(state.degraded).toBeNull();
    });

    it('20) 排期跨重启：未到 next_check_at 不发起请求；已过点则启动即查', async () => {
        const fetchSpy = vi.fn(async (_url: string) => ({
            status: 200,
            headers: {get: (): null => null},
            json: async () => ({success: true, code: 'SUCCESS', data: {status: 'ACTIVE'}}),
        }));
        vi.stubGlobal('fetch', fetchSpy);
        const now = Date.now();

        // 20a：排期在 5 天后 → 循环只挂长定时器，启动阶段一次请求都不发
        await writeVault({
            trial: null,
            license: seedLicense({last_verified_ok_at: now, activated_at: now, next_check_at: now + 5 * DAY_MS}),
        });
        startRecheckLoop();
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(fetchSpy).not.toHaveBeenCalled();
        stopRecheckLoop();

        // 20b：排期已过 → 启动即查，保住退款/吊销的本地生效时效
        await writeVault({
            trial: null,
            license: seedLicense({last_verified_ok_at: now, activated_at: now, next_check_at: now - 1000}),
        });
        startRecheckLoop();
        expect(await until(() => fetchSpy.mock.calls.length > 0)).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        stopRecheckLoop();
    });

    it('21) getState 消费红线 4：新进程未复核前不误杀，问过之后按结论停用', async () => {
        mocks.mid = {strong: 'RECHECK-STRONG', soft: 'RECHECK-SOFT'};
        const validToken = makeSignedToken(Math.floor(Date.now() / 1000) + 365 * 86400, 'RECHECK-STRONG');
        const now = Date.now();
        const seed = () => ({
            trial: null,
            license: seedLicense({
                signed_token: validToken,
                mid_at_activation: 'RECHECK-STRONG',
                mid_soft_at_activation: 'RECHECK-SOFT',
                last_verified_ok_at: now - 90 * DAY_MS,
                activated_at: now - 90 * DAY_MS,
                // 排期放远（30 天，故意跨过 setTimeout 的 2^31-1 ms 截断线）：
                // startRecheckLoop 只用于重新 arm 红线 4 的启动保护，本用例不让它真的发请求。
                // 若长延迟被截断成 1ms，这里会出现「未复核却已复核」的假象，本用例即回归门禁。
                next_check_at: now + 30 * DAY_MS,
            }),
        });

        await writeVault(seed());
        startRecheckLoop(); // 模拟新进程启动：本次尚未复核过

        const protectedState = await getState(null);
        expect(protectedState.status).toBe('activated');
        expect(protectedState.needsOnlineVerify).toBe(true);

        // 本次进程问过服务端（且拿不到结论）→ 保护解除，超阈值判定生效
        stubFetch({throws: true});
        await runRecheck(now);

        const stoppedState = await getState(null);
        expect(stoppedState.status).toBe('inactive');
        expect(stoppedState.needsOnlineVerify).toBe(false);
        stopRecheckLoop();
    });
});
