/**
 * 激活状态指示器（调试器页左下角状态栏）
 * 点击打开激活管理弹窗。颜色随状态变化：未激活=灰、试用中=橙、已激活=绿、需联网验证=蓝（info）。
 * 徽标只放**状态词**（提醒态放短词），剩余时间挂 `title`；文案与单位走 i18n（license.status.* / license.badge.*）。
 *
 * 溢出治理（plan-1.0 审计 D4 → D7 收紧）：侧栏可拖到 160px，欧语系文案比中文长 2~3 倍，
 * 旧版 `whitespace-nowrap` + `shrink-0` 会让徽标顶出侧栏、盖住 `<main>` 首列；改成「图标 + truncate 文本」后
 * 溢出没了，但 D6 实测在**默认 200px** 下「已激活 · 2年」这类拼接文案仍有 7~8 种语言出省略号
 * （常态就读不出来）→ 现只显状态词，完整信息（含剩余时间）由 `title` 与弹窗兜底。
 */

import {useTranslation} from 'react-i18next';
import {useActivationStore} from '../store/activationStore';
import type {ActivationStatus} from '../lib/electron';
import {formatCompactDuration} from '../lib/format';
import {useNow} from '../hooks/useNow';
import {ErrorIcon} from './Icons';

// 三态配色全部引用主题令牌（style 内联支持 CSS 变量与 color-mix，Electron 130+ 生效），
// 跟随浅色/暗色主题自动切换，不再写死暗色值。
const STYLE: Record<ActivationStatus, { bg: string; color: string; dot: string }> = {
    inactive: {
        bg: 'color-mix(in srgb, var(--color-muted) 15%, transparent)',
        color: 'var(--color-muted2)',
        dot: 'var(--color-muted)',
    },
    trial: {
        bg: 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
        color: 'var(--color-warning)',
        dot: 'var(--color-warning)',
    },
    activated: {
        bg: 'color-mix(in srgb, var(--color-success) 15%, transparent)',
        color: 'var(--color-success)',
        dot: 'var(--color-success)',
    },
};

// 「需联网验证」是**提醒**不是告警（功能不减），也不该与「试用中」共用橙色——
// 同色会让用户以为试用要到期了。用 info 蓝 + 感叹号图标做独立语义位。
const NEEDS_VERIFY_STYLE = {
    bg: 'color-mix(in srgb, var(--color-info) 15%, transparent)',
    color: 'var(--color-info)',
    dot: 'var(--color-info)',
};

export default function ActivationBadge() {
    const { t } = useTranslation();
    const state = useActivationStore((s) => s.state);
    const openModal = useActivationStore((s) => s.openModal);
    const status: ActivationStatus = state?.status ?? 'inactive';
    const label =
        status === 'inactive' ? t('license.status.inactive')
            : status === 'trial' ? t('license.status.trial')
                : t('license.status.activated');

    const expiresAt =
        status === 'trial' ? (state?.trialExpiresAt ?? null)
            : status === 'activated' ? (state?.activatedExpiresAt ?? null)
                : null;
    // 倒计时只在「有到期时间」时按秒推进（挂 title 上），无到期 / 未激活即停表——
    // store 不再每秒 set，重渲染范围收敛到本徽标（plan-1.0 / F12）。
    const now = useNow(1000, expiresAt !== null);
    const time = formatCompactDuration(t, expiresAt, now);
    // C2（plan-1.0 / U1 分段）：已激活但长时间没联上服务端 → 蓝色提醒「需联网验证」。
    // 只改配色与文案，**不减任何功能**；到失效阈值才由主进程降级为未激活。
    const needsOnline = status === 'activated' && state?.needsOnlineVerify === true;
    const shown = needsOnline ? NEEDS_VERIFY_STYLE : STYLE[status];
    // 徽标**只放状态词**（提醒态放短词）：审计 D7 实测——状态行里版本号固定占 57.5px 且 shrink-0，
    // 侧栏 200px 时文字槽仅 74px、160px 时仅 34px，旧版拼「已激活 · 2年」(zh 72 / de 105 / ru 116 /
    // ja 143) 在**默认宽度**下就有 7~8 种语言出省略号，等于常态读不出来。
    // 剩余时间改为完整挂在 title 上（弹窗内另有精确到分的文案），info 蓝 + 感叹号仍表达提醒态。
    const text = needsOnline ? t('license.badge.verifyShort') : label;
    const title = needsOnline
        ? t('license.badge.needsOnlineVerify')
        : time
            ? `${t('license.badge.tooltip')} · ${t('license.badge.remainShort', {time})}`
            : t('license.badge.tooltip');

    return (
        <button
            onClick={openModal}
            title={title}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium no-drag min-w-0 max-w-full transition-colors"
            style={{ background: shown.bg, color: shown.color }}
        >
            {needsOnline
                ? <ErrorIcon className="w-3.5 h-3.5 shrink-0" />
                : <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: shown.dot }} />}
            <span className="truncate">{text}</span>
        </button>
    );
}
