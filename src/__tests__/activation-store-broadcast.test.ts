/**
 * 渲染层激活状态订阅单测（plan-1.0 / C5，`src/renderer/src/store/activationStore.ts`）。
 *
 * 覆盖 C5 的核心断言：主进程 `activation:state-changed` 推来的新状态**立即上屏**，
 * 不依赖 1 秒 ticker——支付后自动到账、复核停用这类跃迁必须即时可见。
 *
 * 同时守住旁路红线：浏览器预览态没有该通道（`onStateChanged` 缺失）时 `init()` 不得抛，
 * 首次 `refresh()` 照常拉到状态。
 *
 * store 是模块级单例且带 `started` 幂等标志，故每个用例前 `vi.resetModules()` 重新 import。
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

const ctl = vi.hoisted(() => ({
    getState: vi.fn(),
    subscribed: 0,
    listener: null as ((s: unknown) => void) | null,
    noChannel: false,
}));

vi.mock('../renderer/src/lib/electron', () => ({
    useElectronAPI: () => ({
        activation: {
            getState: ctl.getState,
            getMachineCode: vi.fn(async () => 'AAAA-BBBB-CCCC-DDDD'),
            onStateChanged:
                ctl.noChannel === true
                    ? undefined
                    : (cb: (s: unknown) => void) => {
                          ctl.subscribed += 1;
                          ctl.listener = cb;
                          return () => {
                              ctl.listener = null;
                          };
                      },
        },
    }),
}));

function state(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {status, features: ['pro', 'cloud_sync'], source: 'license', degraded: null, needsOnlineVerify: false, ...overrides};
}

async function nextTick(times = 3): Promise<void> {
    for (let i = 0; i < times; i++) {
        await new Promise((r) => setTimeout(r, 0));
    }
}

let useActivationStore: any;

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ctl.subscribed = 0;
    ctl.listener = null;
    ctl.noChannel = false;
    ctl.getState.mockResolvedValue(state('trial'));
    ({useActivationStore} = await import('../renderer/src/store/activationStore'));
});

describe('activationStore：主进程状态推送即时上屏', () => {
    it('1) init() 订阅通道，推来的状态立刻覆盖 store（不等 ticker）', async () => {
        useActivationStore.getState().init();
        await nextTick();
        expect(useActivationStore.getState().state?.status).toBe('trial');

        const paid = state('activated', {licenseExpiresAt: Date.now() + 30 * 86_400_000});
        ctl.listener?.(paid);
        expect(useActivationStore.getState().state?.status).toBe('activated');

        // 复核判定失效 → 主进程推送未激活，UI 立刻回落到激活引导
        ctl.listener?.(state('inactive', {features: [], degraded: 'token_invalid'}));
        expect(useActivationStore.getState().state?.status).toBe('inactive');
    });

    it('2) 提醒段（needsOnlineVerify）原样透传，供徽标变色', async () => {
        useActivationStore.getState().init();
        await nextTick();
        ctl.listener?.(state('activated', {needsOnlineVerify: true}));
        expect(useActivationStore.getState().state?.needsOnlineVerify).toBe(true);
        // 权益不因提醒段被削减
        expect(useActivationStore.getState().hasFeature('cloud_sync')).toBe(true);
    });

    it('3) 只订阅一次（init 幂等，重复挂载不叠加监听）', async () => {
        useActivationStore.getState().init();
        useActivationStore.getState().init();
        await nextTick();
        expect(ctl.subscribed).toBe(1);
    });

    it('4) 无该通道（浏览器预览态）→ init 不抛，refresh 照常拉到状态', async () => {
        ctl.noChannel = true;
        useActivationStore.getState().init();
        await nextTick();
        expect(useActivationStore.getState().state?.status).toBe('trial');
    });

    it('5) getState 失败（主进程未就绪）→ 静默保持 null，不抛', async () => {
        ctl.getState.mockRejectedValue(new Error('not ready'));
        useActivationStore.getState().init();
        await nextTick();
        expect(useActivationStore.getState().state).toBeNull();
    });
});
