/**
 * 激活状态指示器（调试器页左上角）
 * 点击打开激活管理弹窗。颜色随状态变化：未激活=灰、试用中=橙、已激活=绿。
 */

import {useActivationStore} from '../store/activationStore';
import type {ActivationStatus} from '../lib/electron';

const STYLE: Record<ActivationStatus, { bg: string; color: string; dot: string; label: string }> = {
    inactive: { bg: 'rgba(99,99,102,0.15)', color: '#a1a1a6', dot: '#636366', label: '未激活' },
    trial: { bg: 'rgba(255,159,10,0.15)', color: '#ff9f0a', dot: '#ff9f0a', label: '试用中' },
    activated: { bg: 'rgba(52,199,89,0.15)', color: '#34c759', dot: '#34c759', label: '已激活' },
};

export default function ActivationBadge() {
    const state = useActivationStore((s) => s.state);
    const openModal = useActivationStore((s) => s.openModal);
    const status: ActivationStatus = state?.status ?? 'inactive';
    const st = STYLE[status];

    return (
        <button
            onClick={openModal}
            title="点击管理激活"
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium no-drag transition-colors"
            style={{ background: st.bg, color: st.color }}
        >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: st.dot }} />
            {st.label}
        </button>
    );
}
