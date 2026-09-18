/**
 * 激活状态指示器（调试器页左下角状态栏）
 * 点击打开激活管理弹窗。颜色随状态变化：未激活=灰、试用中=橙、已激活=绿。
 * 试用/已激活态追加紧凑剩余时间（如「30天」「2年」）；文案与单位走 i18n（license.status.* / license.badge.*）。
 */

import {useTranslation} from 'react-i18next';
import {useActivationStore} from '../store/activationStore';
import type {ActivationStatus} from '../lib/electron';
import {formatCompactDuration} from '../lib/format';

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

    const expiresAt =
        status === 'trial' ? (state?.trialExpiresAt ?? null)
            : status === 'activated' ? (state?.activatedExpiresAt ?? null)
                : null;
    const time = formatCompactDuration(t, expiresAt);

    return (
        <button
            onClick={openModal}
            title={t('license.badge.tooltip')}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium no-drag whitespace-nowrap shrink-0 transition-colors"
            style={{ background: st.bg, color: st.color }}
        >
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.dot }} />
            <span>{label}</span>
            {time && <span className="opacity-80">· {time}</span>}
        </button>
    );
}
