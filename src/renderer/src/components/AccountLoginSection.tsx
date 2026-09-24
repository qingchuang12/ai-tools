/**
 * 账号登录区（激活弹窗内嵌，默认折叠）
 *
 * 三态：未登录（折叠入口 / 展开登录表单 / MFA 校验）→ 已登录（邮箱 + 登出）。
 *
 * 默认折叠的原因：账号登录是「后台可见 + 本人解绑」的增强能力，不该抢占激活主流程的注意力；
 * 展开后也只在弹窗底部追加，不打断现有激活路径。文案自成独立 `account.*` 段，
 * 不复用 `license.modal.*`，将来要拆到独立账号页时无需解耦。
 */

import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useAccountStore} from '../store/accountStore';

/** 与 ActivationModal 兑换表单同一口径，集中在此避免两处样式漂移 */
const INPUT_CLASS =
    'w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[13px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]';
const PRIMARY_BTN_CLASS =
    'flex-1 px-4 py-2.5 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity';
const GHOST_BTN_CLASS =
    'flex-1 px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] text-[13px] font-medium hover:bg-[var(--color-surface-hover)]/40 transition-colors disabled:opacity-50';

export default function AccountLoginSection() {
    const { t } = useTranslation();
    const { profile, loggedIn, loading, busy, error, mfaTicket, login, verifyMfa, logout, clearError } =
        useAccountStore();

    const [expanded, setExpanded] = useState(false);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');

    // 登录成功即收起并清空凭据：不让密码明文常驻组件 state
    useEffect(() => {
        if (!loggedIn) return;
        setExpanded(false);
        setEmail('');
        setPassword('');
        setCode('');
    }, [loggedIn]);

    // 首探登录态未完成前不渲染，避免闪一下「未登录」
    if (loading) return null;

    const submit = () => {
        clearError();
        void (mfaTicket ? verifyMfa(code.trim()) : login(email.trim(), password));
    };

    const collapse = () => {
        clearError();
        setExpanded(false);
    };

    return (
        <div className="pt-4 mt-1 border-t border-[var(--color-border)]">
            <p className="mb-2 text-[12px] font-medium text-[var(--color-text)]">{t('account.title')}</p>

            {loggedIn ? (
                <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-[var(--color-muted)] truncate">
                        {t('account.loggedInAs')}
                        <span className="text-[var(--color-text)] ms-1">{profile?.email}</span>
                    </span>
                    <button
                        onClick={() => void logout()}
                        disabled={busy}
                        className="shrink-0 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[12px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]/40 transition-colors disabled:opacity-50"
                    >
                        {t('account.logout')}
                    </button>
                </div>
            ) : !expanded ? (
                <>
                    <p className="mb-2 text-[12px] text-[var(--color-muted)]">{t('account.loginHint')}</p>
                    <button onClick={() => setExpanded(true)} className={`${GHOST_BTN_CLASS} w-full`}>
                        {t('account.login')}
                    </button>
                </>
            ) : (
                <div className="space-y-3">
                    <p className="text-[12px] text-[var(--color-muted)]">
                        {mfaTicket ? t('account.mfaHint') : t('account.loginHint')}
                    </p>

                    {mfaTicket ? (
                        <div>
                            <label className="block text-[12px] text-[var(--color-muted)] mb-1">
                                {t('account.codeLabel')}
                            </label>
                            <input
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                placeholder={t('account.codePlaceholder')}
                                autoComplete="one-time-code"
                                className={INPUT_CLASS}
                            />
                        </div>
                    ) : (
                        <>
                            <div>
                                <label className="block text-[12px] text-[var(--color-muted)] mb-1">
                                    {t('account.emailLabel')}
                                </label>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder={t('account.emailPlaceholder')}
                                    autoComplete="email"
                                    className={INPUT_CLASS}
                                />
                            </div>
                            <div>
                                <label className="block text-[12px] text-[var(--color-muted)] mb-1">
                                    {t('account.passwordLabel')}
                                </label>
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder={t('account.passwordPlaceholder')}
                                    autoComplete="current-password"
                                    className={INPUT_CLASS}
                                />
                            </div>
                        </>
                    )}

                    <div className="flex gap-2">
                        <button onClick={submit} disabled={busy} className={PRIMARY_BTN_CLASS}>
                            {busy ? t('account.working') : mfaTicket ? t('account.verify') : t('account.login')}
                        </button>
                        <button onClick={collapse} disabled={busy} className={GHOST_BTN_CLASS}>
                            {t('account.cancel')}
                        </button>
                    </div>
                </div>
            )}

            {error && <p className="mt-2 text-[12px] text-[var(--color-danger)]">{t(error)}</p>}
        </div>
    );
}
