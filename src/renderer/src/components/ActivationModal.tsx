/**
 * 激活管理弹窗（三态）
 *
 * - 未激活：在线激活（打开授权页，自动带入 machineId）→ 离线激活（导入 license.lic / 粘贴令牌）→ 兑换码输入；
 * - 试用中：剩余时间 + 立即激活（进入激活方式选择页）；
 * - 已激活：剩余时间 + 脱敏 licenseKey + 去激活（**二次确认**：确认才执行，取消保持已激活不变；硬件变更宽限期内额外提示）。
 *
 * 全部文案走 i18n（license.*）；授权页 URL 与兑换 API 由主进程按配置拼装
 * （默认指向本地 billing-license-service，可经包外 license.config.json 覆盖）。
 */

import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import Modal from './Modal';
import {useActivationStore} from '../store/activationStore';
import {useElectronAPI} from '../lib/electron';
import {FEATURE_CLOUD_SYNC} from '../../../shared/license-constants';
import type {RedeemResult} from '../../../shared/activation-types';

type Mode = 'choose' | 'redeem' | 'offline';

function formatRemaining(ms: number | null, t: (k: string, opts?: Record<string, unknown>) => string): string {
    if (ms === null) return t('license.modal.permanent');
    const diff = ms - Date.now();
    if (diff <= 0) return t('license.modal.expired');
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return t('license.modal.remaining', { d, h, m });
}

function FeatureList({
    t,
    hasFeature,
}: {
    t: (k: string, opts?: Record<string, unknown>) => string;
    hasFeature: (feature: string) => boolean;
}) {
    const cloudOpen = hasFeature(FEATURE_CLOUD_SYNC);
    return (
        <div className="pt-4 mt-1 border-t border-[var(--color-border)]">
            <p className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-text)]">
                {/* 钥匙图标：锚定「需试用/激活方可开放」的语义。刻意不用锁——列表项已用勾/锁表达单项状态，
                    区块级再用锁会与之混淆。 */}
                <svg
                    className="shrink-0 text-[var(--color-accent)]"
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <circle cx="5" cy="5" r="2.5" />
                    <path d="M6.8 6.8 13 13" />
                    <path d="M10.5 10.5 12 9" />
                </svg>
                {t('license.modal.openFeatures')}
            </p>
            <ul className="space-y-1.5">
                <li className="flex items-center gap-2 text-[13px]">
                    {cloudOpen ? (
                        <svg
                            className="text-[#34c759]"
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M3.5 8.5l3 3 6-7" />
                        </svg>
                    ) : (
                        <svg
                            className="text-[var(--color-muted2)]"
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <rect x="4" y="7" width="8" height="6" rx="1.5" />
                            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
                        </svg>
                    )}
                    <span className={cloudOpen ? 'text-[var(--color-text)]' : 'text-[var(--color-muted)]'}>
                        {t('license.feature.cloudSync')}
                    </span>
                </li>
                <li className="flex items-center gap-2 text-[13px]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-muted2)]/70" />
                    <span className="text-[var(--color-muted2)]">{t('license.feature.moreComing')}</span>
                </li>
            </ul>
            {!cloudOpen && (
                <p className="mt-2 text-[11px] text-[var(--color-muted2)]">{t('license.modal.featureLocked')}</p>
            )}
        </div>
    );
}

export default function ActivationModal() {
    const { t } = useTranslation();
    const { state, modalOpen, closeModal, refresh, hasFeature } = useActivationStore();
    const api = useElectronAPI();
    const [mode, setMode] = useState<Mode>('choose');
    const [code, setCode] = useState('');
    const [email, setEmail] = useState('');
    const [showText, setShowText] = useState(false);
    const [text, setText] = useState('');
    const [msg, setMsg] = useState<{ type: 'err' | 'ok'; text: string } | null>(null);
    const [busy, setBusy] = useState(false);
    // 试用用户点「立即激活」后进入激活流程（复用未激活的选择页/子页；返回时退回试用视图）
    const [activating, setActivating] = useState(false);
    // 去激活需二次确认：确认前不调任何接口，取消/关闭弹窗都保持已激活状态不变
    const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
    // R6：换绑态——复用激活流程但走 switchMode（新生效→旧解绑），不先去激活
    const [switching, setSwitching] = useState(false);
    // R6：换绑后旧授权解绑失败的轻提示标记（新授权已生效，不阻挡）
    const [unbindWarn, setUnbindWarn] = useState(false);

    useEffect(() => {
        if (modalOpen) {
            setMode('choose');
            setCode('');
            setEmail('');
            setText('');
            setShowText(false);
            setMsg(null);
            setActivating(false);
            setConfirmingDeactivate(false);
            setSwitching(false);
            setUnbindWarn(false);
        }
    }, [modalOpen]);

    const doOnlineActivation = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const url = await api.activation.getPurchaseUrl();
            if (url) {
                await api.system.openExternal(url);
                // 授权页（带 machineId）支付完成后直接发放令牌：引导用户回到此处粘贴令牌或输入兑换码
                setMsg({ type: 'ok', text: t('license.modal.openedOnlineHint') });
            } else {
                setMsg({ type: 'err', text: t('license.errors.locked') });
            }
        } catch {
            setMsg({ type: 'err', text: t('license.errors.generic') });
        } finally {
            setBusy(false);
        }
    };

    const goOffline = () => {
        setMode('offline');
        setMsg(null);
    };

    const goRedeem = () => {
        setMode('redeem');
        setMsg(null);
    };

    const doRedeem = async () => {
        // 邮箱是服务端的客户标识（必填）。此处先做本地必填校验，让用户知道缺什么；
        // 邮箱格式与归属判定仍由服务端负责（INVALID_EMAIL），失败一律回落统一文案。
        if (!email.trim()) {
            setMsg({ type: 'err', text: t('license.modal.emailRequired') });
            return;
        }
        setBusy(true);
        setMsg(null);
        setUnbindWarn(false);
        try {
            const r = await api.activation.redeem(code.trim(), email.trim(), switching);
            await finalizeResult(r);
        } finally {
            setBusy(false);
        }
    };

    const doImportFile = async () => {
        setBusy(true);
        setMsg(null);
        setUnbindWarn(false);
        try {
            const r = await api.activation.importLicenseFile(switching);
            // 用户取消选择：success=false 且无 error，不应提示失败
            if (!r.success && !r.error) return;
            await finalizeResult(r);
        } finally {
            setBusy(false);
        }
    };

    const doImportText = async () => {
        setBusy(true);
        setMsg(null);
        setUnbindWarn(false);
        try {
            const r = await api.activation.importLicenseText(text.trim(), switching);
            if (r.success && r.state) {
                await finalizeResult(r);
            } else if (r.error) {
                setMsg({ type: 'err', text: t(r.error) });
            } else if (text.trim()) {
                setMsg({ type: 'err', text: t('license.errors.generic') });
            }
        } finally {
            setBusy(false);
        }
    };

    /**
     * 激活/换绑结果统一收尾：成功→刷新状态并提示（换绑用专门文案）；
     * 换绑时旧授权解绑失败仅标 `unbindWarn` 轻提示，不回滚新授权、不阻挡（新生效优先）。
     */
    const finalizeResult = async (r: RedeemResult) => {
        if (r.success && r.state) {
            setMsg({
                type: 'ok',
                text: switching ? t('license.modal.switchSuccess') : t('license.status.activated'),
            });
            setUnbindWarn(!!r.unbindWarning);
            await refresh();
            // 解绑失败时给用户留出阅读轻提示的时间，不自动关弹窗
            if (!r.unbindWarning) setTimeout(() => closeModal(), 800);
        } else if (r.error) {
            setUnbindWarn(false);
            setMsg({ type: 'err', text: t(r.error) });
        } else {
            setUnbindWarn(false);
            setMsg({ type: 'err', text: t('license.errors.generic') });
        }
    };

    /** R6：进入换绑态——复用激活流程，但走 switchMode（新生效→旧解绑），不先去激活 */
    const startSwitch = () => {
        setSwitching(true);
        setMode('choose');
        setMsg(null);
        setUnbindWarn(false);
    };

    /** R6：取消换绑——退回已激活视图，旧授权保持不动 */
    const cancelSwitch = () => {
        setSwitching(false);
        setMode('choose');
        setMsg(null);
        setUnbindWarn(false);
    };

    const doDeactivate = async () => {
        setBusy(true);
        try {
            await api.activation.deactivate();
            await refresh();
            setMode('choose');
            setMsg(null);
            setConfirmingDeactivate(false);
        } finally {
            setBusy(false);
        }
    };

    if (!state) return null;

    const title =
        state.status === 'inactive' ? t('license.status.inactive')
            : state.status === 'trial' ? t('license.status.trial')
                : t('license.status.activated');

    // 激活流程页面对「未激活」「试用中且点了立即激活」「已激活且换绑中」共用
    const showActivationFlow =
        state.status === 'inactive' || (state.status === 'trial' && activating) || (state.status === 'activated' && switching);

    return (
        <Modal isOpen={modalOpen} onClose={closeModal} title={title}>
            {showActivationFlow && mode === 'choose' && (
                <div className="space-y-3">
                    <p className="text-[13px] text-[var(--color-muted)]">{t('license.modal.chooseHint')}</p>
                    <button
                        onClick={doOnlineActivation}
                        disabled={busy}
                        className="w-full px-4 py-2.5 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity"
                    >
                        {t('license.modal.onlineActivation')}
                    </button>
                    <button
                        onClick={goOffline}
                        disabled={busy}
                        className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] text-[13px] font-medium hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                    >
                        {t('license.modal.offlineActivation')}
                    </button>
                    <button
                        onClick={goRedeem}
                        disabled={busy}
                        className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] text-[13px] font-medium hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                    >
                        {t('license.modal.redeem')}
                    </button>

                    {state.status === 'activated' && switching && (
                        <button
                            onClick={cancelSwitch}
                            disabled={busy}
                            className="w-full px-4 py-2 rounded-lg text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:underline transition-colors"
                        >
                            {t('license.modal.cancelSwitch')}
                        </button>
                    )}

                    {state.status === 'trial' && (
                        <button
                            onClick={() => { setActivating(false); setMsg(null); }}
                            className="w-full px-4 py-2 rounded-lg text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:underline transition-colors"
                        >
                            {t('license.modal.back')}
                        </button>
                    )}
                </div>
            )}

            {showActivationFlow && mode === 'redeem' && (
                <div className="space-y-3">
                    <div>
                        <label className="block text-[12px] text-[var(--color-muted)] mb-1">
                            {t('license.modal.emailLabel')}
                        </label>
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder={t('license.modal.emailLabel')}
                            autoComplete="email"
                            className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[13px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
                        />
                    </div>
                    <div>
                        <label className="block text-[12px] text-[var(--color-muted)] mb-1">
                            {t('license.modal.codePlaceholder')}
                        </label>
                        <input
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            placeholder={t('license.modal.codePlaceholder')}
                            className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[13px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
                        />
                    </div>
                    <p className="text-[12px] text-[var(--color-muted)]">{t('license.modal.redeemHint')}</p>

                    <button
                        onClick={doRedeem}
                        disabled={busy || !code.trim()}
                        className="w-full px-4 py-2.5 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity"
                    >
                        {t('license.modal.activate')}
                    </button>

                    <button
                        onClick={() => { setMode('choose'); setMsg(null); }}
                        className="w-full px-4 py-2 rounded-lg text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:underline transition-colors"
                    >
                        {t('license.modal.back')}
                    </button>
                </div>
            )}

            {showActivationFlow && mode === 'offline' && (
                <div className="space-y-3">
                    <button
                        onClick={doImportFile}
                        disabled={busy}
                        className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] text-[13px] font-medium hover:bg-[var(--color-surface-hover)]/40 transition-colors disabled:opacity-50"
                    >
                        {t('license.modal.importFile')}
                    </button>
                    <button
                        onClick={() => setShowText((v) => !v)}
                        disabled={busy}
                        className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] text-[13px] font-medium hover:bg-[var(--color-surface-hover)]/40 transition-colors disabled:opacity-50"
                    >
                        {t('license.modal.importText')}
                    </button>

                    {showText && (
                        <div className="space-y-2">
                            <textarea
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                rows={3}
                                placeholder={t('license.modal.importText')}
                                className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[12px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
                            />
                            <button
                                onClick={doImportText}
                                disabled={busy || !text.trim()}
                                className="w-full px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-[12px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity"
                            >
                                {t('license.modal.activate')}
                            </button>
                        </div>
                    )}

                    <button
                        onClick={() => { setMode('choose'); setMsg(null); }}
                        className="w-full px-4 py-2 rounded-lg text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:underline transition-colors"
                    >
                        {t('license.modal.back')}
                    </button>
                </div>
            )}

            {state.status === 'trial' && !activating && (
                <div className="space-y-4">
                    <p className="text-[13px] text-[var(--color-text)]">
                        {t('license.modal.trialRemaining')}
                        <span className="font-semibold text-[#ff9f0a] ms-1">
                            {formatRemaining(state.trialExpiresAt, t)}
                        </span>
                    </p>
                    <button
                        onClick={() => { setActivating(true); setMode('choose'); setMsg(null); }}
                        disabled={busy}
                        className="w-full px-4 py-2.5 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity"
                    >
                        {t('license.modal.activateNow')}
                    </button>
                </div>
            )}

            {state.status === 'activated' && !switching && (
                <div className="space-y-4">
                    {state.degraded === 'hardware_changed' && state.licenseKey && (
                        <div className="px-3 py-2 rounded-md bg-[#ff9f0a]/10 border border-[#ff9f0a]/30 text-[12px] text-[#ff9f0a]">
                            {t('license.modal.hardwareChanged', { days: 7 })}
                        </div>
                    )}
                    <p className="text-[13px] text-[var(--color-text)]">
                        {t('license.modal.activatedRemaining')}
                        <span className="font-semibold text-[#34c759] ms-1">
                            {formatRemaining(state.activatedExpiresAt, t)}
                        </span>
                    </p>
                    {state.licenseKey && (
                        <div className="flex items-center justify-between">
                            <span className="text-[12px] text-[var(--color-muted)]">
                                {t('license.modal.licenseKey')}
                            </span>
                            <span className="text-[12px] font-mono text-[var(--color-text)]">
                                {state.licenseKey}
                            </span>
                        </div>
                    )}
                    {!confirmingDeactivate && (
                        <button
                            onClick={startSwitch}
                            disabled={busy}
                            className="w-full px-4 py-2.5 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity"
                        >
                            {t('license.modal.switch')}
                        </button>
                    )}
                    {!confirmingDeactivate ? (
                        <button
                            onClick={() => { setConfirmingDeactivate(true); setMsg(null); }}
                            disabled={busy}
                            className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[#ff3b30] text-[13px] font-medium hover:bg-[#ff3b30]/10 transition-colors disabled:opacity-50"
                        >
                            {t('license.modal.deactivate')}
                        </button>
                    ) : (
                        <div className="space-y-3">
                            <div className="px-3 py-2 rounded-md bg-[#ff3b30]/10 border border-[#ff3b30]/30 text-[12px] text-[#ff3b30]">
                                {t('license.modal.deactivateConfirm')}
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={doDeactivate}
                                    disabled={busy}
                                    className="flex-1 px-4 py-2.5 rounded-lg bg-[#ff3b30] text-white text-[13px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity"
                                >
                                    {t('license.modal.confirmDeactivate')}
                                </button>
                                <button
                                    onClick={() => setConfirmingDeactivate(false)}
                                    disabled={busy}
                                    className="flex-1 px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] text-[13px] font-medium hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                                >
                                    {t('license.modal.cancel')}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}
            {msg && (
                <p className={`text-[12px] ${msg.type === 'ok' ? 'text-[#34c759]' : 'text-[#ff3b30]'}`}>
                    {msg.text}
                </p>
            )}
            {unbindWarn && (
                <p className="text-[12px] text-[#ff9f0a]">{t('license.modal.unbindFailed')}</p>
            )}
            <FeatureList t={t} hasFeature={hasFeature} />
        </Modal>
    );
}
