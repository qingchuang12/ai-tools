/**
 * 账号会话 store（渲染层）
 *
 * 全局单例：管理登录态与用户资料。令牌明文由主进程持久化在 secret-store（
 * 渲染层**不接触明文**），这里只持有登录成功后的 profile。
 *
 * 失败文案一律走 i18n key 且不做原因细分（不回传服务端错误码），避免账号枚举——
 * 这一点与主进程 `account.ts` 的口径一致，渲染层不再二次放大错误信息。
 */

import {create} from 'zustand';
import {useElectronAPI} from '../lib/electron';
import type {AccountProfile} from '../../../shared/activation-types';

interface AccountStore {
    profile: AccountProfile | null;
    loggedIn: boolean;
    /** 首次探测登录态中（避免尚未探测完就闪出「未登录」） */
    loading: boolean;
    /** 提交中：login / verifyMfa / logout */
    busy: boolean;
    /** 对外统一文案（i18n key），UI 直接 `t(error)` 渲染 */
    error: string | null;
    /** 待第二因子票据；非空表示处于 MFA 输入态 */
    mfaTicket: string | null;

    init: () => void;
    login: (email: string, password: string) => Promise<boolean>;
    verifyMfa: (code: string) => Promise<boolean>;
    logout: () => Promise<void>;
    clearError: () => void;
}

let started = false;

export const useAccountStore = create<AccountStore>((set, get) => ({
    profile: null,
    loggedIn: false,
    loading: true,
    busy: false,
    error: null,
    mfaTicket: null,

    init: () => {
        if (started) return;
        started = true;
        void (async () => {
            try {
                const api = useElectronAPI();
                const ok = await api.account.isLoggedIn();
                if (!ok) {
                    set({ loggedIn: false, profile: null, loading: false });
                    return;
                }
                const p = await api.account.getProfile();
                set({ loggedIn: Boolean(p), profile: p, loading: false });
            } catch {
                // 主进程未就绪或浏览器 mock：保持未登录，不阻塞 UI
                set({ loggedIn: false, profile: null, loading: false });
            }
        })();
    },

    login: async (email, password) => {
        set({ busy: true, error: null });
        try {
            const api = useElectronAPI();
            const r = await api.account.login(email, password);
            if (r.ok) {
                set({ busy: false, loggedIn: true, profile: r.profile ?? null, mfaTicket: null, error: null });
                return true;
            }
            // 待第二因子不是失败：存票据并切 MFA 输入态，文案不落 error
            if (r.mfaRequired && r.mfaTicket) {
                set({ busy: false, mfaTicket: r.mfaTicket, error: null });
                return false;
            }
            set({ busy: false, error: r.error ?? 'account.errors.generic' });
            return false;
        } catch {
            set({ busy: false, error: 'account.errors.network' });
            return false;
        }
    },

    verifyMfa: async (code) => {
        const ticket = get().mfaTicket;
        if (!ticket) {
            // 无票据属异常路径（例如 store 被重置），退回登录态而不是硬失败
            set({ mfaTicket: null, error: 'account.errors.generic' });
            return false;
        }
        set({ busy: true, error: null });
        try {
            const api = useElectronAPI();
            const r = await api.account.verifyMfa(ticket, code);
            if (r.ok) {
                set({ busy: false, loggedIn: true, profile: r.profile ?? null, mfaTicket: null, error: null });
                return true;
            }
            set({ busy: false, error: r.error ?? 'account.errors.generic' });
            return false;
        } catch {
            set({ busy: false, error: 'account.errors.network' });
            return false;
        }
    },

    logout: async () => {
        set({ busy: true, error: null });
        try {
            const api = useElectronAPI();
            await api.account.logout();
        } catch {
            // best-effort：服务端不可达也要清本地态（令牌已在主进程失效）
        }
        set({ busy: false, loggedIn: false, profile: null, mfaTicket: null, error: null });
    },

    clearError: () => set({ error: null }),
}));
