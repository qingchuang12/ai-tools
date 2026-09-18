/**
 * 激活状态指示器（调试器页左上角）
 * 点击打开激活管理弹窗。颜色随状态变化：未激活=灰、试用中=橙、已激活=绿。
 * 文案走 i18n（license.status.* / license.badge.tooltip）。
 */

import {useTranslation} from 'react-i18next';
import {useActivationStore} from '../store/activationStore';
import type {ActivationStatus} from '../lib/electron';

const STYLE: Record<ActivationStatus, { bg: string; color: string; dot: string }> = {
    inactive: { bg: 'rgba(99,99,102,0.15)', color: '#a1a1a6', dot: '#636366' },
    trial: { bg: 'rgba(255,159,10,0.15)', color: '#ff9f0a', dot: '#ff9f0a' },
    activated: { bg: 'rgba(52,199,89,0.15)', color: '#34c759', dot: '#34c759' },
};

export default function ActivationBadge() {
    const { t } = useTranslation();
    const state = useActivationStore((s) => s.state);
    const openModal = useActivationStore((s) => s.openModal);
    const status: ActivationStatus = state?.status ?? 'inactive';
    const st = STYLE[status];
    const label =
        status === 'inactive' ? t('license.status.inactive')
            : status === 'trial' ? t('license.status.trial')
                : t('license.status.activated');

    return (
        <button
            onClick={openModal}
            title={t('license.badge.tooltip')}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium no-drag transition-colors"
            style={{ background: st.bg, color: st.color }}
        >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: st.dot }} />
            {label}
        </button>
    );
}
