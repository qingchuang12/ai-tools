/**
 * C8 试用防重置（2026-09-20）
 *
 * 背景：试用账本（vault）+ 首跑账本（first-run）都在本地，删掉这两个文件重装就能再领一次
 * 60 天试用。服务端现在为每台机器记一份「首次出现时间」，客户端拿到后把试用起点**回溯**，
 * 于是删档重来只能拿到**已经过期**的试用。
 *
 * 覆盖：
 * 1. `applyMachineFirstSeen`：起点只回拨不前挪、三态语义（undefined/时间/null）、幂等不重复落盘；
 * 2. 端到端判定：服务端说 200 天前见过 → 今天首发也判过期；
 * 3. `probeMachineFirstSeen`：统一壳解析、未见过 / 网络失败 / 非 200 一律退化成 null（离线优先）。
 *
 * 不覆盖真实 `index.ts` 门面串联（那部分由 `license-e2e-offline` 负责，且它走的是离线路径）。
 */

import {describe, expect, it, vi} from 'vitest';
import type {LicenseConfig, TrialVault} from '../main/license/types';

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
        features: {proFeature: 'pro', gated: ['cloud_sync']},
    },
    mid: 'AAAA-BBBB-CCCC-DDDD',
}));

vi.mock('../main/license/config', () => ({
    getConfig: (): LicenseConfig => mocks.config,
}));

vi.mock('../main/license/machine-code', () => ({
    getMachineCode: async (): Promise<string> => mocks.mid,
}));

const {applyMachineFirstSeen, evaluateTrial} = await import('../main/license/trial');
const {probeMachineFirstSeen} = await import('../main/license/machine-probe');

function trialAt(nowMs: number): TrialVault {
    return {
        first_run_at: nowMs,
        trial_count: 1,
        last_run_at: nowMs,
        trial_token: '',
        watermark: nowMs,
        mid_soft_at_activation: 'SOFT-1',
        hardware_grace_used: 0,
        hardware_grace_until: null,
        server_time_floor: null,
    };
}

const NOW = Date.parse('2026-09-20T00:00:00Z');

describe('C8 · applyMachineFirstSeen（服务端首次时间并进试用账本）', () => {
    it('服务端说 200 天前见过这台机器 → 试用起点回溯，今天首发也判过期', () => {
        const firstSeen = NOW - 200 * DAY_MS;

        const merged = applyMachineFirstSeen(trialAt(NOW), firstSeen);
        expect(merged).not.toBeNull();
        expect(merged!.first_run_at).toBe(firstSeen);
        expect(merged!.machine_first_seen_at).toBe(firstSeen);

        const ev = evaluateTrial(merged!, mocks.config, NOW);
        expect(ev.status).toBe('inactive');
        expect(ev.code).toBe('LIC_TRIAL_EXPIRED');
    });

    it('删档重装场景：本地起点是今天、服务端 200 天前 → 拿不到新的 60 天', () => {
        const fresh = applyMachineFirstSeen(trialAt(NOW), NOW - 200 * DAY_MS)!;
        // 不回溯时是全新 60 天
        expect(evaluateTrial(trialAt(NOW), mocks.config, NOW).status).toBe('trial');
        // 回溯后立刻过期
        expect(evaluateTrial(fresh, mocks.config, NOW).status).toBe('inactive');
    });

    it('服务端没见过（null）→ 只记「问过了」，起点不动', () => {
        const merged = applyMachineFirstSeen(trialAt(NOW), null);
        expect(merged!.first_run_at).toBe(NOW);
        expect(merged!.machine_first_seen_at).toBeNull();
        expect(evaluateTrial(merged!, mocks.config, NOW).status).toBe('trial');
    });

    it('服务端时间晚于本地起点 → 一律不往前挪（避免误伤）', () => {
        const merged = applyMachineFirstSeen(trialAt(NOW), NOW + 10 * DAY_MS);
        expect(merged!.first_run_at).toBe(NOW);
        expect(merged!.machine_first_seen_at).toBe(NOW + 10 * DAY_MS);
    });

    it('已问过且结果一致 → 返回 null（启动路径上不重复落盘）', () => {
        const once: TrialVault = {...trialAt(NOW), machine_first_seen_at: null};
        expect(applyMachineFirstSeen(once, null)).toBeNull();
    });

    it('非法时间（NaN）→ 不动账本', () => {
        expect(applyMachineFirstSeen(trialAt(NOW), Number.NaN)).toBeNull();
    });
});

describe('C8 · probeMachineFirstSeen（服务端探测，失败一律退化）', () => {
    it('统一壳：取 $.data.firstSeenAt 并转成毫秒', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                success: true,
                code: 'SUCCESS',
                data: {machineCode: mocks.mid, firstSeenAt: '2026-03-04T00:00:00', seen: true},
            }),
        })));

        const got = await probeMachineFirstSeen();
        expect(got).toBe(Date.parse('2026-03-04T00:00:00'));
    });

    it('未见过：firstSeenAt 为 null → 返回 null（按全新机器处理）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({success: true, data: {machineCode: mocks.mid, firstSeenAt: null, seen: false}}),
        })));
        expect(await probeMachineFirstSeen()).toBeNull();
    });

    it('断网/超时 → null，绝不因此挡住离线用户', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('ENOTFOUND');
        }));
        expect(await probeMachineFirstSeen()).toBeNull();
    });

    it('非 200（端点不存在）→ null', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, status: 404, json: async () => ({})})));
        expect(await probeMachineFirstSeen()).toBeNull();
    });

    it('响应畸形（非法时间串）→ null', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({success: true, data: {firstSeenAt: 'not-a-date'}}),
        })));
        expect(await probeMachineFirstSeen()).toBeNull();
    });

    it('请求带上了机器码且路径正确', async () => {
        const spy = vi.fn(async () => ({
            ok: true,
            json: async () => ({success: true, data: {firstSeenAt: null, seen: false}}),
        }));
        vi.stubGlobal('fetch', spy);

        await probeMachineFirstSeen();

        const [url] = spy.mock.calls[0] as unknown as [string];
        expect(url).toContain('/api/licenses/machine/');
        expect(url).toContain(encodeURIComponent(mocks.mid));
    });
});
