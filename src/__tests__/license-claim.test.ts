/**
 * 登录后自动到账单测（`claimLicenses`）
 *
 * 覆盖：未登录/空列表/无候选静默返回、A9 优先级选择（未绑定有效授权 > 已绑本机）、
 * 复用 `redeem` 走统一激活端点、激活成功/失败语义、邮箱兜底（授权归属邮箱 → 登录态账号邮箱）。
 *
 * `claimLicenses` 位于轻量的 `./claim`，仅依赖可 mock 的轻模块；其中 `redeem` 定义在门面 `./index`，
 * 故测试对 `../main/license/index` 仅 mock `redeem`，避免加载 gate 重模块。
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

const hoisted = vi.hoisted(() => ({
    token: 'access-token-123',
    mid: 'AAAA-BBBB-CCCC-DDDD',
    email: 'owner@example.com',
}));

vi.mock('electron', () => ({
    dialog: {showOpenDialog: async () => ({canceled: true, filePaths: [] as string[]})},
}));

vi.mock('../main/license/config', () => ({
    getConfig: (): unknown => ({serviceBaseUrl: 'https://billing.example.test', redeemTimeoutMs: 15000}),
    loadConfig: (): unknown => ({}),
    resetConfigCache: (): void => undefined,
}));

vi.mock('../main/license/machine-code', () => ({
    getMachineCode: async (): Promise<string> => hoisted.mid,
}));

vi.mock('../main/account', () => ({
    getPersistedAccessToken: vi.fn((): string => hoisted.token),
    getProfile: vi.fn(async (): Promise<{id: string; email: string; emailVerified: boolean; status: string; role: string} | null> => ({
        id: 'u1',
        email: hoisted.email,
        emailVerified: true,
        status: 'ACTIVE',
        role: 'USER',
    })),
}));

vi.mock('../main/license/redeem', () => ({
    fetchMyLicenses: vi.fn(),
}));

// `redeem` 定义在门面 `./index`；仅 mock 这一出口，避免加载 gate 重模块
vi.mock('../main/license/index', () => ({
    redeem: vi.fn(),
}));

const {claimLicenses} = await import('../main/license/claim');
const indexMod = await import('../main/license/index');
const redeemMod = await import('../main/license/redeem');
const accountMod = await import('../main/account');

const redeemMock = vi.mocked(indexMod.redeem);
const fetchMock = vi.mocked(redeemMod.fetchMyLicenses);
const getToken = vi.mocked(accountMod.getPersistedAccessToken);
const getProfile = vi.mocked(accountMod.getProfile);

beforeEach(() => {
    vi.clearAllMocks();
});

const ACTIVE_UNBOUND = {licenseKey: 'LIC-A', status: 'ACTIVE', machineCode: null, customerEmail: 'a@b.com'};
const ACTIVE_BOUND_LOCAL = {licenseKey: 'LIC-B', status: 'ACTIVE', machineCode: hoisted.mid, customerEmail: 'b@b.com'};
const ACTIVE_BOUND_OTHER = {licenseKey: 'LIC-C', status: 'ACTIVE', machineCode: 'WWWW-XXXX-YYYY-ZZZZ', customerEmail: 'c@b.com'};
const EXPIRED_UNBOUND = {licenseKey: 'LIC-D', status: 'EXPIRED', machineCode: null, customerEmail: 'd@b.com'};

describe('claimLicenses 前置与候选选择', () => {
    it('未登录（无 token）：静默返回 claimed:false，不拉列表/不激活', async () => {
        getToken.mockReturnValueOnce('');
        const r = await claimLicenses();
        expect(r).toEqual({claimed: false});
        expect(fetchMock).not.toHaveBeenCalled();
        expect(redeemMock).not.toHaveBeenCalled();
    });

    it('列表为空：返回 claimed:false', async () => {
        fetchMock.mockResolvedValueOnce([]);
        const r = await claimLicenses();
        expect(r).toEqual({claimed: false});
        expect(redeemMock).not.toHaveBeenCalled();
    });

    it('列表只有「已绑他机 + 已过期」：无候选 → claimed:false', async () => {
        fetchMock.mockResolvedValueOnce([ACTIVE_BOUND_OTHER, EXPIRED_UNBOUND]);
        const r = await claimLicenses();
        expect(r).toEqual({claimed: false});
        expect(redeemMock).not.toHaveBeenCalled();
    });

    it('优先级：未绑定有效授权优先于已绑本机', async () => {
        fetchMock.mockResolvedValueOnce([ACTIVE_BOUND_LOCAL, ACTIVE_UNBOUND]);
        redeemMock.mockResolvedValueOnce({success: true});
        const r = await claimLicenses();
        expect(r).toEqual({claimed: true});
        expect(redeemMock).toHaveBeenCalledWith('LIC-A', 'a@b.com', false);
    });

    it('无未绑定项时，回退到已绑本机的授权', async () => {
        fetchMock.mockResolvedValueOnce([ACTIVE_BOUND_OTHER, ACTIVE_BOUND_LOCAL]);
        redeemMock.mockResolvedValueOnce({success: true});
        const r = await claimLicenses();
        expect(r).toEqual({claimed: true});
        expect(redeemMock).toHaveBeenCalledWith('LIC-B', 'b@b.com', false);
    });

    it('激活成功返回 claimed:true', async () => {
        fetchMock.mockResolvedValueOnce([ACTIVE_UNBOUND]);
        redeemMock.mockResolvedValueOnce({success: true});
        const r = await claimLicenses();
        expect(r).toEqual({claimed: true});
    });

    it('激活失败：静默返回 claimed:false（不弹窗）', async () => {
        fetchMock.mockResolvedValueOnce([ACTIVE_UNBOUND]);
        redeemMock.mockResolvedValueOnce({success: false, category: 'license', error: 'license.errors.generic'});
        const r = await claimLicenses();
        expect(r).toEqual({claimed: false});
    });

    it('授权归属邮箱缺失：回退到登录态账号邮箱', async () => {
        fetchMock.mockResolvedValueOnce([{licenseKey: 'LIC-A', status: 'ACTIVE', machineCode: null, customerEmail: null}]);
        redeemMock.mockResolvedValueOnce({success: true});
        await claimLicenses();
        expect(redeemMock).toHaveBeenCalledWith('LIC-A', hoisted.email, false);
    });

    it('授权与账号邮箱均缺失：以空串调用激活（交由服务端裁决），返回 claimed:false', async () => {
        getProfile.mockResolvedValueOnce(null);
        fetchMock.mockResolvedValueOnce([{licenseKey: 'LIC-A', status: 'ACTIVE', machineCode: null, customerEmail: null}]);
        redeemMock.mockResolvedValueOnce({success: false, category: 'license', error: 'license.errors.generic'});
        const r = await claimLicenses();
        expect(redeemMock).toHaveBeenCalledWith('LIC-A', '', false);
        expect(r).toEqual({claimed: false});
    });
});
