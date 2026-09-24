/**
 * 渲染层账号 store 单测（`src/renderer/src/store/accountStore.ts`）。
 *
 * 回归目标（本次改动）：
 *  - A9：`init()` 已登录分支新增 `if (p) void claimLicensesAfterLogin();`
 *    → 已登录用户启动即触发「登录后自动到账」；未登录则不触发。
 *  - 幂等守卫：`claimLicensesAfterLogin()` 顶部
 *    `if (useActivationStore.getState().state?.status === 'activated') return;`
 *    → 已激活时跳过，避免重复激活。
 *  - 回归：`login()` / `verifyMfa()` 成功分支仍调用 `claimLicensesAfterLogin()`。
 *
 * 注意：其它 account 相关用例（account.test.ts 等）测的是主进程 `src/main/account.ts`，
 * 并不覆盖本渲染层 store，因此这里单独补一层针对渲染 store 的测试。
 *
 * mock 套路：用 `vi.mock` 替换 `useElectronAPI`（仅暴露 `account`）与 `useActivationStore`
 * （用可变 `ctl.activationStatus` 控制激活态），每次 `beforeEach` 重新 `import` 以重置
 * 模块级 `started` 标志与 store 单例。
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

const ctl = vi.hoisted(() => ({
    accountApi: {
        isLoggedIn: vi.fn(),
        getProfile: vi.fn(),
        login: vi.fn(),
        verifyMfa: vi.fn(),
        logout: vi.fn(),
        claimLicenses: vi.fn(),
    },
    /** undefined → activation `state` 为 null；否则作为 status */
    activationStatus: 'trial' as string | undefined,
    refresh: vi.fn(),
}));

vi.mock('../renderer/src/lib/electron', () => ({
    useElectronAPI: () => ({account: ctl.accountApi}),
}));

vi.mock('../renderer/src/store/activationStore', () => ({
    useActivationStore: {
        getState: () => ({
            state: ctl.activationStatus === undefined ? null : {status: ctl.activationStatus, features: []},
            refresh: ctl.refresh,
        }),
    },
}));

const profile = {id: 'u1', email: 'a@b.com', emailVerified: true, status: 'ACTIVE', role: 'USER'};

async function nextTick(times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
        await new Promise((r) => setTimeout(r, 0));
    }
}

/** 轮询直到断言通过（用于等待 fire-and-forget 的异步副作用落地） */
async function flush(fn: () => void, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    for (;;) {
        try {
            fn();
            return;
        } catch (e) {
            if (Date.now() - start > timeoutMs) throw e;
            await nextTick();
        }
    }
}

describe('accountStore（渲染层）A9 自动到账 + 幂等守卫', () => {
    let useAccountStore: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        ctl.accountApi.isLoggedIn.mockResolvedValue(false);
        ctl.accountApi.getProfile.mockResolvedValue(null);
        ctl.accountApi.login.mockResolvedValue({ok: true, profile});
        ctl.accountApi.verifyMfa.mockResolvedValue({ok: true, profile});
        ctl.accountApi.logout.mockResolvedValue(undefined);
        ctl.accountApi.claimLicenses.mockResolvedValue({claimed: false});
        ctl.activationStatus = 'trial';
        ctl.refresh.mockResolvedValue(undefined);
        const mod = await import('../renderer/src/store/accountStore');
        useAccountStore = mod.useAccountStore;
    });

    it('init：已登录且未激活 → 触发 claimLicenses（A9）', async () => {
        ctl.accountApi.isLoggedIn.mockResolvedValue(true);
        ctl.accountApi.getProfile.mockResolvedValue(profile);
        useAccountStore.getState().init();
        await flush(() => expect(useAccountStore.getState().loading).toBe(false));
        await flush(() => expect(ctl.accountApi.claimLicenses).toHaveBeenCalledTimes(1));
    });

    it('init：已激活 → 跳过 claimLicenses（幂等守卫）', async () => {
        ctl.activationStatus = 'activated';
        ctl.accountApi.isLoggedIn.mockResolvedValue(true);
        ctl.accountApi.getProfile.mockResolvedValue(profile);
        useAccountStore.getState().init();
        await flush(() => expect(useAccountStore.getState().loading).toBe(false));
        await nextTick(2);
        expect(ctl.accountApi.claimLicenses).not.toHaveBeenCalled();
    });

    it('init：未登录 → 不触发 claimLicenses', async () => {
        ctl.accountApi.isLoggedIn.mockResolvedValue(false);
        useAccountStore.getState().init();
        await flush(() => expect(useAccountStore.getState().loading).toBe(false));
        await nextTick(2);
        expect(ctl.accountApi.claimLicenses).not.toHaveBeenCalled();
    });

    it('login 成功且未激活 → 触发 claimLicenses（回归：行为保留）', async () => {
        await useAccountStore.getState().login('a@b.com', 'pw');
        await flush(() => expect(ctl.accountApi.claimLicenses).toHaveBeenCalledTimes(1));
    });

    it('login 成功且已激活 → 跳过 claimLicenses（幂等守卫）', async () => {
        ctl.activationStatus = 'activated';
        await useAccountStore.getState().login('a@b.com', 'pw');
        await nextTick(3);
        expect(ctl.accountApi.claimLicenses).not.toHaveBeenCalled();
    });

    it('verifyMfa 成功且未激活 → 触发 claimLicenses（回归）', async () => {
        useAccountStore.setState({mfaTicket: 'tick'});
        await useAccountStore.getState().verifyMfa('123456');
        await flush(() => expect(ctl.accountApi.claimLicenses).toHaveBeenCalledTimes(1));
    });

    it('verifyMfa 成功且已激活 → 跳过 claimLicenses（幂等守卫）', async () => {
        ctl.activationStatus = 'activated';
        useAccountStore.setState({mfaTicket: 'tick'});
        await useAccountStore.getState().verifyMfa('123456');
        await nextTick(3);
        expect(ctl.accountApi.claimLicenses).not.toHaveBeenCalled();
    });

    it('claimLicenses 返回 claimed:true → 触发激活态刷新', async () => {
        ctl.accountApi.claimLicenses.mockResolvedValue({claimed: true});
        await useAccountStore.getState().login('a@b.com', 'pw');
        await flush(() => expect(ctl.accountApi.claimLicenses).toHaveBeenCalledTimes(1));
        await flush(() => expect(ctl.refresh).toHaveBeenCalledTimes(1));
    });
});
