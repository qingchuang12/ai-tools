/**
 * 激活状态 store（渲染层）
 *
 * 全局单例：从主进程加载激活状态，每秒 ticker 用于倒计时显示；
 * 当试用 / 激活到期时触发刷新，由主进程持久化降级为「未激活」。
 * 弹窗开关也在此管理。状态本身以主进程 ~/.ai-tools/activation.json 为权威来源。
 */

import {create} from 'zustand';
import type {ActivationState} from '../lib/electron';
import {useElectronAPI} from '../lib/electron';

interface ActivationStore {
    state: ActivationState | null;
    modalOpen: boolean;
    init: () => void;
    refresh: () => Promise<void>;
    openModal: () => void;
    closeModal: () => void;
    /** 权益判定（渲染层 UI 态，安全边界在主进程 gate）。规则：含 `pro` 视为全量权益 */
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
        // 单例 ticker：每秒刷新倒计时；到期则触发主进程降级并落盘
        setInterval(() => {
            const s = get().state;
            if (!s) return;
            if (s.status === 'trial' || s.status === 'activated') {
                const exp = s.status === 'trial' ? s.trialExpiresAt : s.activatedExpiresAt;
                if (exp && Date.now() > exp) {
                    void get().refresh();
                } else {
                    // 触发重渲染以更新剩余时间显示
                    set({ state: { ...s } });
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
        // `pro` 视为全量权益；其余按名称匹配
        return features.includes('pro') || features.includes(feature);
    },
}));
