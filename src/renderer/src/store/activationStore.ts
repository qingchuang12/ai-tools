/**
 * 激活状态 store（渲染层）
 *
 * 全局单例：从主进程加载激活状态；当试用 / 激活到期时触发刷新，由主进程持久化降级为「未激活」。
 * 状态只在真实跃迁时更新（不再每秒 set），倒计时重渲染由显示它的组件各自用 useNow 驱动（F12）。
 * 弹窗开关也在此管理。状态本身以主进程 ~/.ai-tools/activation.json 为权威来源。
 */

import {create} from 'zustand';
import type {ActivationState} from '../lib/electron';
import {useElectronAPI} from '../lib/electron';
import {FEATURE_PRO, FEATURE_PROVIDERS} from '../../../shared/license-constants';

interface ActivationStore {
    state: ActivationState | null;
    modalOpen: boolean;
    init: () => void;
    refresh: () => Promise<void>;
    openModal: () => void;
    closeModal: () => void;
    /** 权益判定（渲染层 UI 态，安全边界在主进程 gate）。规则：含 `pro` 视为全量权益；provider 型权益随宿主 */
    hasFeature: (feature: string) => boolean;
}

let started = false;

export const useActivationStore = create<ActivationStore>((set, get) => ({
    state: null,
    modalOpen: false,

    init: () => {
        if (started) return;
        started = true;
        void get().refresh();
        // 主进程状态跃迁即时上屏（plan-1.0 / C5）：支付后自动到账、复核停用都发生在这里，
        // 下面的 ticker 只负责倒计时重渲染，不会主动拉取状态。
        try {
            useElectronAPI().activation.onStateChanged((st) => set({state: st}));
        } catch {
            /* 浏览器预览态无该通道：靠 ticker 兜底 */
        }
        // 单例 ticker：只负责「到期后拉一次主进程降级状态」，不再每秒 set state。
        // 倒计时重渲染已下沉到显示倒计时的组件（useNow），全局每秒 set({state:{...s}})
        // 会让所有 store 订阅者每秒重渲染（plan-1.0 / F12）。
        setInterval(() => {
            const s = get().state;
            if (!s) return;
            if (s.status === 'trial' || s.status === 'activated') {
                const exp = s.status === 'trial' ? s.trialExpiresAt : s.activatedExpiresAt;
                if (exp && Date.now() > exp) {
                    void get().refresh();
                }
            }
        }, 1000);
    },

    refresh: async () => {
        const api = useElectronAPI();
        try {
            const st = await api.activation.getState();
            set({ state: st });
        } catch {
            /* 主进程未就绪时忽略 */
        }
    },

    openModal: () => set({ modalOpen: true }),
    closeModal: () => set({ modalOpen: false }),

    hasFeature: (feature: string) => {
        const features = get().state?.features;
        if (!features || features.length === 0) return false;
        // `pro` 视为全量权益；provider 型权益（如 remote_connect）随宿主（cloud_sync）判定，
        // 与主进程 gate 的 FEATURE_PROVIDERS 归一同源，避免两端口径漂移（R5）
        if (features.includes(FEATURE_PRO)) return true;
        const host = FEATURE_PROVIDERS[feature];
        return features.includes(host ?? feature);
    },
}));
