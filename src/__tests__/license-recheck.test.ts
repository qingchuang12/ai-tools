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
 *  15. 排期：unknown → now + retryMs（2 小时）；active → now + intervalMs（15 天）；429 → 同 retryMs + 抖动
 *  16. 红线 4：闲置超硬停但**本次进程尚未复核** → 不停用（新误杀面已被堵住）
 *  17. 红线 4 解除：闲置 70 天后启动 + 复核拿不到结论 → 本次即停用
 *  18. 提醒段：超过 offlineGraceDays 未到 hardStopDays → needsOnlineVerify=true 且**不停用**
 *  19. getState：提醒段用户功能照常（status=activated、features 不减）
 *  20. 排期跨重启：startRecheckLoop 读 next_check_at，未到点不发起请求
 *  21. 红线 4：getState 停用判定优先于验签，但受 attemptPending 保护
 *  22. 阈值兜底：hardStopDays 小于 offlineGraceDays 时按配置原样判定（clamp 属 config 层，见 license-recheck-config 用例）
 *  —— plan-1.0 审计 D1（23~26）——
 *  23. 启动排期：进提醒段强制「启动即查」；`next_check_at` 被时钟回拨放大时夹到 intervalMs，
 *      且不会因 `setTimeout` 32 位截断变成启动即查
 *  24. 停用/提醒基准 = `max(now, server_time_floor)`：回拨时钟不能凭空续命
 *  25. 基准**不含** `watermark`：本地时钟前调抬高的 watermark 不得误杀付费用户
 *  26. unknown/429 也抬 `server_time_floor`（HTTP Date），本次停用即用新基准
 *  —— plan-1.0 审计 D8（27）——
 *  27. 服务端下发 `nextCheckAfterMs` 参与排期：正常态采用并夹 `[1h, 30d]`；畸形值回落本地 `intervalMs`；
 *      失败态（unknown/429）**不吃**下发值，「失败后 2 小时重试」不受服务端影响
 *  —— plan-1.0 审计 F5 / F1（28~30）——
 *  28. F5 丙：全程离线时把时钟回拨，进程内锚挡住「已耗宽限凭空缩水」
 *  29. F5 丙：时钟误调向前只在本次进程内生效（不落盘），重启即恢复 → 红线 2 不永久误杀
 *  30. F1：复核请求在途时用户去激活 → 复核放弃落盘，不复活已清空的授权
 *
 * 设计红线（务必在测试中守住）：
 * - 宁可放过不误杀：只有 LICENSE_INVALID / LICENSE_EXPIRED 立即停用，其余一律 unknown/grace。
 * - 429 照常消耗宽限：方案 A 下停用判定现算（基准 - last_verified_ok_at >= hardStopDays），
 *   429 既不刷新也不清零 last_verified_ok_at，故连续 429 终究会在阈值当天耗尽宽限。
 * - 15 天心跳必须配 30/60 天分段：宽限若小于「一个心跳周期」，用户只是隔周期没开机就会被误杀。
 */

import {sign} from 'node:crypto';
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHomeSandbox} from './helpers/isolate-home';
import type {LicenseConfig, LicenseVault, TrialVault} from '../main/license/types';
import {DEFAULT_LICENSE_CONFIG} from '../main/license/constants';
import {TEST_KEY_PAIR} from './helpers/license-test-keys';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
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

/**
 * `os.homedir()`（及 win32 的 `%APPDATA%`，first-run 第二处 marker 落点）必须**每个用例前**重新接管：
 * `afterEach` 的 `restoreAllMocks()` 会把 homedir 还原成真实家目录，于是第 2 个用例起
 * `vault.ts` / `anchor.ts` 就往开发者自己的 `~/.ai-tools/` 里写——覆写的是真实的
 * license-vault.json / license-anchor.json（真激活数据，且 mock 密文让本机授权直接失效）。
 * 故 beforeEach 调 `recheckSandbox.arm()` 重新接管，见下方钩子。
 */
const recheckSandbox = createHomeSandbox(mocks, 'ai-tools-recheck-');

const {isDisabledByRecheck, isRecheckAttentionNeeded, runRecheck, startRecheckLoop, stopRecheckLoop,
    resetProcessTimeAnchor} = await import(
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
    /** throws 为真时 fetch 先抛、用不到 status，故可选；正常响应桩必须显式传 */
    status?: number;
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
    recheckSandbox.wipe();
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
    recheckSandbox.arm();
    wipeHome();
    // F5 丙：进程内时间锚是模块级状态，必须每个用例前清空（等价于「重启应用」）。
    // 不清空会跨用例串味——本文件有用例走真 Date.now()（≈2026 年）调 getState()，
    // 锚被抬到真实时间后，后续用 BASE（≈2023 年）判定的用例会被算成「已离线一千多天」而全部误判停用。
    resetProcessTimeAnchor();
    // 默认桩：任何内部探测（machine-probe 等）一律 404，避免真实网络；具体用例再覆盖
    vi.stubGlobal('fetch', async () => ({status: 404, headers: {get: (): null => null}, json: async () => ({})}));
});

afterEach(() => {
    stopRecheckLoop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    wipeHome();
});

afterAll(() => recheckSandbox.cleanup());

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

    it('15) 排期落盘：unknown→+retryMs(2h)；active→+intervalMs(15d)；429→+retryMs(+抖动)', async () => {
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

        // 15c：429 与 unknown **同节奏**（审计 D3 定案），只在退避之上再加 0~10min 抖动
        // （同 NAT 群体不同时重试）；宽限照常在 `hardStopDays` 后触发停用（见用例 14），
        // 所以「429 退避更短」并不会给限流留续命后门。
        stubFetch({status: 429});
        const t429 = BASE + 2 * cfg.recheck.retryMs;
        await runRecheck(t429);
        const scheduled = (await readVault()).license?.next_check_at ?? 0;
        expect(scheduled).toBeGreaterThanOrEqual(t429 + cfg.recheck.retryMs);
        expect(scheduled).toBeLessThan(t429 + cfg.recheck.retryMs + 10 * 60 * 1000);
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
                // 排期放远（30 天）+ 立刻 stopRecheckLoop：本用例只要「新进程尚未复核」这个起始态，
                // 不希望后台循环抢先问过服务端（提醒段现在会「启动即查」，见用例 20c）。
                // stop 在 initialDelay 的异步读盘之前发生 → 一次请求都不发；红线 4 的置回仍生效。
                next_check_at: now + 30 * DAY_MS,
            }),
        });

        await writeVault(seed());
        startRecheckLoop(); // 模拟新进程启动：本次尚未复核过
        stopRecheckLoop();

        const protectedState = await getState(null);
        expect(protectedState.status).toBe('activated');
        expect(protectedState.needsOnlineVerify).toBe(true);

        // 本次进程问过服务端（且拿不到结论）→ 保护解除，超阈值判定生效
        stubFetch({throws: true});
        await runRecheck(now);

        const stoppedState = await getState(null);
        expect(stoppedState.status).toBe('inactive');
        expect(stoppedState.needsOnlineVerify).toBe(false);
    });

    // ==================== plan-1.0 审计 D1：排期夹逼 + 停用基准防回拨 ====================

    it('23) 启动排期：处于提醒段强制即查；排期被时钟回拨放大时夹到 intervalMs 且绝不当「立刻再查」', async () => {
        const fetchSpy = vi.fn(async (_url: string) => ({
            status: 200,
            headers: {get: (): null => null},
            json: async () => ({success: true, code: 'SUCCESS', data: {status: 'ACTIVE'}}),
        }));
        vi.stubGlobal('fetch', fetchSpy);
        const now = Date.now();

        // 23a：排期还有 10 天，但已进提醒段（40 天没成功复核）→ 强制启动即查，
        //      否则「提醒了却只能干等排期」，用户点「立即联网验证」之前界面会一直挂着提醒。
        await writeVault({
            trial: null,
            license: seedLicense({
                last_verified_ok_at: now - 40 * DAY_MS,
                activated_at: now - 40 * DAY_MS,
                next_check_at: now + 10 * DAY_MS,
            }),
        });
        startRecheckLoop();
        expect(await until(() => fetchSpy.mock.calls.length > 0)).toBe(true);
        stopRecheckLoop();

        // 23b：排期被回拨的时钟放大成 400 天 → 夹到 intervalMs 后仍远超用例观察窗口，
        //      而且**不能**因为「delay > 2^31-1 ms 被 Node 静默截成 1ms」变成启动即查（打满限流）。
        fetchSpy.mockClear();
        await writeVault({
            trial: null,
            license: seedLicense({last_verified_ok_at: now, activated_at: now, next_check_at: now + 400 * DAY_MS}),
        });
        startRecheckLoop();
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(fetchSpy).not.toHaveBeenCalled();
        stopRecheckLoop();
    });

    it('24) 停用/提醒基准含服务端时间下界：把时钟往回调不能凭空续命', () => {
        const cfg = defaultConfig();
        // 末次成功复核在 60 天前；时钟被回拨到 30 天前
        const rolledBack = BASE - 30 * DAY_MS;
        const seed = (floor: number | null) =>
            seedLicense({last_verified_ok_at: BASE - 60 * DAY_MS, activated_at: BASE - 60 * DAY_MS, server_time_floor: floor});

        // 无下界可参照时按本地时间算（30 天前）→ 宽限未耗尽，不误杀
        expect(isDisabledByRecheck(seed(null), cfg, rolledBack, false)).toBe(false);
        // 有服务端下界（= BASE）时以它为基准 → 真实经过 60 天，硬停生效
        expect(isDisabledByRecheck(seed(BASE), cfg, rolledBack, false)).toBe(true);
        // 提醒段同理
        expect(isRecheckAttentionNeeded(seed(BASE), cfg, BASE - 45 * DAY_MS)).toBe(true);
    });

    it('25) 基准只认服务端下界：本地 watermark 被时钟前调抬高，不得反过来误杀付费用户', () => {
        const cfg = defaultConfig();
        // watermark 由本地时间推进：用户偶然把时钟调快 80 天，watermark 就永久抬高了 80 天。
        // 若拿它当宽限基准，回来后立刻被判「60 天没复核」——属误杀（红线 2），故基准不含 watermark。
        const license = seedLicense({
            last_verified_ok_at: BASE,
            activated_at: BASE,
            watermark: BASE + 80 * DAY_MS,
            server_time_floor: null,
        });
        expect(isDisabledByRecheck(license, cfg, BASE, false)).toBe(false);
        expect(isRecheckAttentionNeeded(license, cfg, BASE)).toBe(false);
    });

    it('26) 复核失败（unknown/429）也抬服务端时间下界，本次停用判定即用新基准', async () => {
        const cfg = defaultConfig();
        const since = BASE - cfg.recheck.hardStopDays * DAY_MS;
        await writeVault({
            trial: null,
            license: seedLicense({last_verified_ok_at: since, activated_at: since, server_time_floor: null}),
        });
        // 服务端 429 答不上来，但 HTTP Date 头仍给出真实时间 = BASE
        stubFetch({status: 429, date: new Date(BASE).toUTCString()});

        // 本地时钟被回拨到 90 天前（elapsed 会算成负数 → 旧实现等于无限续命）
        const outcome = await runRecheck(BASE - 90 * DAY_MS);
        expect(outcome.verdict).toBe('unknown');
        expect(outcome.disabled).toBe(true);
        expect((await readVault()).license?.server_time_floor).toBe(BASE);
    });

    it('27) 服务端下发 nextCheckAfterMs 参与排期（审计 D8）：正常态采用并夹安全区间，失败态与畸形值不吃', async () => {
        const cfg = defaultConfig();
        const seed = () => seedLicense({last_verified_ok_at: BASE, activated_at: BASE});

        // 27a：明确 ACTIVE + 下发 3 天 → 排期用下发值，不再走本地 intervalMs
        await writeVault({trial: null, license: seed()});
        stubFetch({status: 200, body: {success: true, code: 'SUCCESS', data: {status: 'ACTIVE', nextCheckAfterMs: 3 * DAY_MS}}});
        await runRecheck(BASE);
        expect((await readVault()).license?.next_check_at).toBe(BASE + 3 * DAY_MS);

        // 27b：下发 1 分钟（异常小）→ 夹到下限 1 小时，防被打满 verify 限流后 429 狂耗宽限
        await writeVault({trial: null, license: seed()});
        stubFetch({status: 200, body: {data: {status: 'ACTIVE', nextCheckAfterMs: 60_000}}});
        await runRecheck(BASE);
        expect((await readVault()).license?.next_check_at).toBe(BASE + HOUR_MS);

        // 27c：下发 400 天（异常大）→ 夹到上限 30 天，防复核被推到有生之年
        await writeVault({trial: null, license: seed()});
        stubFetch({status: 200, body: {data: {status: 'ACTIVE', nextCheckAfterMs: 400 * DAY_MS}}});
        await runRecheck(BASE);
        expect((await readVault()).license?.next_check_at).toBe(BASE + 30 * DAY_MS);

        // 27d：畸形下发值（字符串 / null）→ 视为未下发，回落本地 intervalMs
        for (const bad of ['3d', null]) {
            await writeVault({trial: null, license: seed()});
            stubFetch({status: 200, body: {data: {status: 'ACTIVE', nextCheckAfterMs: bad}}});
            await runRecheck(BASE);
            expect((await readVault()).license?.next_check_at).toBe(BASE + cfg.recheck.intervalMs);
        }

        // 27e：**200 但状态不是 ACTIVE = 没拿到明确结论** → 仍按 retryMs 重试，下发值不得延长重试
        // （否则服务端一句异常就能把「失败后 2 小时重试」这条需求废掉）
        await writeVault({trial: null, license: seed()});
        stubFetch({status: 200, body: {data: {status: 'SUSPENDED', nextCheckAfterMs: 10 * DAY_MS}}});
        const outcome = await runRecheck(BASE);
        expect(outcome.verdict).toBe('unknown');
        expect((await readVault()).license?.next_check_at).toBe(BASE + cfg.recheck.retryMs);
    });

    it('28) F5 丙：全程离线时把时钟回拨，进程内锚挡住「已耗宽限凭空缩水」', () => {
        const cfg = defaultConfig();
        // 末次成功复核在 55 天前，且 server_time_floor 为 null —— 模拟「激活后一直没连上过服务端」
        const seed = () => seedLicense({
            last_verified_ok_at: BASE - 55 * DAY_MS,
            activated_at: BASE - 55 * DAY_MS,
            server_time_floor: null,
        });
        const stopped = (license: LicenseVault, nowMs: number): boolean =>
            isDisabledByRecheck(license, cfg, nowMs, false);

        // 应用正常运行：先见到 BASE（55 天，未超 60 天阈值），再见到 6 天后（真到 61 天 → 停用）
        expect(stopped(seed(), BASE)).toBe(false);
        expect(stopped(seed(), BASE + 6 * DAY_MS)).toBe(true);

        // 离线回拨到 BASE：旧实现 elapsed 缩回 55 天 → 停用被解除（回拨续命）；
        // 丙方案下锚仍停在本进程见过的 BASE+6 天 → elapsed 仍是 61 天，停用照旧生效。
        expect(stopped(seed(), BASE)).toBe(true);
        // 提醒段同理，不因回拨而消失
        expect(isRecheckAttentionNeeded(seed(), cfg, BASE)).toBe(true);
    });

    it('29) F5 丙：时钟被误调向前只在本次进程内生效，重启即恢复且不落盘（红线 2 不永久误杀）', async () => {
        const cfg = defaultConfig();
        // CMOS 电池没电 / VM 挂起恢复等都会让时钟一次性跳到未来，这属误伤而非作弊
        const license = seedLicense({
            last_verified_ok_at: BASE,
            activated_at: BASE,
            server_time_floor: null,
        });
        await writeVault({trial: null, license});

        // 本次进程内：跳到 80 天后 → 被判停用（丙方案接受的代价，代价上界＝重启一次）
        expect(isDisabledByRecheck(license, cfg, BASE + 80 * DAY_MS, false)).toBe(true);

        // 关键区别：这次前调**没有**写进任何跨重启的下界（对照用例 25 的 watermark 路线是永久抬高）
        const stored = await readVault();
        expect(stored.license?.server_time_floor).toBeNull();

        // 重启（锚归零）后同一张授权立刻恢复，不构成永久误杀
        resetProcessTimeAnchor();
        expect(isDisabledByRecheck(stored.license!, cfg, BASE, false)).toBe(false);
        expect(isRecheckAttentionNeeded(stored.license!, cfg, BASE)).toBe(false);
    });

    it('30) F1：复核请求在途时用户去激活 → 复核放弃落盘，绝不把已清空的授权复活', async () => {
        const now = BASE + 1000;
        await writeVault({trial: null, license: seedLicense({last_verified_ok_at: BASE, activated_at: BASE})});

        // 只把 verify 那一发停在网络往返上（其余请求照常 404），精确制造「结论已拿到、还没落盘」的窗口
        let arrived!: () => void;
        let release!: () => void;
        const requestArrived = new Promise<void>((resolve) => {
            arrived = resolve;
        });
        const mayReturn = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.stubGlobal('fetch', async (url: string) => {
            if (!String(url).includes('LIC-TEST-RECHECK-0001')) {
                return {status: 404, headers: {get: (): null => null}, json: async () => ({})};
            }
            arrived();
            await mayReturn;
            return {
                status: 200,
                headers: {get: (): string | null => null},
                json: async () => ({success: true, code: 'SUCCESS', data: {status: 'ACTIVE'}}),
            };
        });

        const pending = runRecheck(now);
        await requestArrived; // 复核已发出请求，正卡在网络往返上

        await deactivate(); // 用户此刻点了「去激活」
        release();
        const outcome = await pending;

        // 复核本身仍然成功（verdict 如实反映服务端答案），但结论**不落盘**、也不因未落盘而误判停用
        expect(outcome.verdict).toBe('active');
        expect(outcome.disabled).toBe(false);

        const stored = await readVault();
        expect(stored.license?.signed_token).toBeNull(); // 没有被复核结果整体盖回去
        expect(stored.license?.last_checked_at).toBeNull();
        expect(stored.license?.last_verified_ok_at).toBeNull();
        expect(stored.license?.next_check_at).toBeNull(); // 排期也没写：去激活清掉的字段一个都没回来
    });
});
