/**
 * 激活管理弹窗（三态）
 *
 * - 未激活：购买（打开收银台，自动带入 machineId）→ 兑换码输入 / 导入 license.lic / 粘贴文本；
 * - 试用中：剩余时间 + 去激活；
 * - 已激活：剩余时间 + 脱敏 licenseKey + 去激活（硬件变更宽限期内额外提示）。
 *
 * 全部文案走 i18n（license.*）；不再硬编码购买链接，收银台 URL 由主进程按配置拼装。
 */

import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import Modal from './Modal';
import {useActivationStore} from '../store/activationStore';
import {useElectronAPI} from '../lib/electron';

type Mode = 'choose' | 'redeem';

function formatRemaining(ms: number | null, t: (k: string, opts?: Record<string, unknown>) => string): string {
    if (ms === null) return t('license.modal.permanent');
    const diff = ms - Date.now();
    if (diff <= 0) return t('license.modal.expired');
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return t('license.modal.remaining', { d, h, m });
}

export default function ActivationModal() {
    const { t } = useTranslation();
    const { state, modalOpen, closeModal, refresh } = useActivationStore();
    const api = useElectronAPI();
    const [mode, setMode] = useState<Mode>('choose');
    const [code, setCode] = useState('');
    const [showText, setShowText] = useState(false);
    const [text, setText] = useState('');
    const [msg, setMsg] = useState<{ type: 'err' | 'ok'; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (modalOpen) {
            setMode('choose');
            setCode('');
            setText('');
            setShowText(false);
            setMsg(null);
        }
    }, [modalOpen]);

    const doPurchase = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const url = await api.activation.getPurchaseUrl();
            if (url) {
                await api.system.openExternal(url);
                // 收银台会在支付成功后给兑换码，引导用户回到此处输入
                setMode('redeem');
            } else {
                setMsg({ type: 'err', text: t('license.errors.locked') });
            }
        } catch {
            setMsg({ type: 'err', text: t('license.errors.generic') });
        } finally {
            setBusy(false);
        }
    };

    const doRedeem = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api.activation.redeem(code.trim());
            if (r.success && r.state) {
                setMsg({ type: 'ok', text: t('license.status.activated') });
                await refresh();
                setTimeout(() => closeModal(), 800);
            } else if (r.error) {
                setMsg({ type: 'err', text: t(r.error) });
            } else {
                setMsg({ type: 'err', text: t('license.errors.generic') });
            }
        } finally {
            setBusy(false);
        }
    };

    const doImportFile = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api.activation.importLicenseFile();
            // 用户取消选择：success=false 且无 error，不应提示失败
            if (r.success && r.state) {
                setMsg({ type: 'ok', text: t('license.status.activated') });
                await refresh();
                setTimeout(() => closeModal(), 800);
            } else if (r.error) {
                setMsg({ type: 'err', text: t(r.error) });
            }
        } finally {
            setBusy(false);
        }
    };

    const doImportText = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api.activation.importLicenseText(text.trim());
            if (r.success && r.state) {
                setMsg({ type: 'ok', text: t('license.status.activated') });
                await refresh();
                setTimeout(() => closeModal(), 800);
            } else if (r.error) {
                setMsg({ type: 'err', text: t(r.error) });
            } else if (text.trim()) {
                setMsg({ type: 'err', text: t('license.errors.generic') });
            }
        } finally {
            setBusy(false);
        }
    };

    const doDeactivate = async () => {
        setBusy(true);
        try {
            await api.activation.deactivate();
            await refresh();
            setMode('choose');
            setMsg(null);
        } finally {
            setBusy(false);
        }
    };

    if (!state) return null;

    const title =
        state.status === 'inactive' ? t('license.status.inactive')
            : state.status === 'trial' ? t('license.status.trial')
                : t('license.status.activated');

    return (
        <Modal isOpen={modalOpen} onClose={closeModal} title={title}>
            {state.status === 'inactive' && mode === 'choose' && (
                <div className="space-y-3">
                    <p className="text-[13px] text-[var(--color-muted)]">{t('license.modal.chooseHint')}</p>
                    <button
                        onClick={doPurchase}
                        disabled={busy}
                        className="w-full px-4 py-2.5 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity"
                    >
                        {t('license.modal.purchase')}
                    </button>
                    <button
                        onClick={() => { setMode('redeem'); setMsg(null); }}
                        className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] text-[13px] font-medium hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                    >
                        {t('license.modal.redeem')}
                    </button>
                </div>
            )}

            {state.status === 'inactive' && mode === 'redeem' && (
                <div className="space-y-3">
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

                    {msg && (
                        <p className={`text-[12px] ${msg.type === 'ok' ? 'text-[#34c759]' : 'text-[#ff3b30]'}`}>
                            {msg.text}
                        </p>
                    )}

                    <button
                        onClick={doRedeem}
                        disabled={busy || !code.trim()}
                        className="w-full px-4 py-2.5 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity"
                    >
                        {t('license.modal.activate')}
                    </button>

                    <div className="flex gap-2">
                        <button
                            onClick={doImportFile}
                            disabled={busy}
                            className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)]/40 transition-colors disabled:opacity-50"
                        >
                            {t('license.modal.importFile')}
                        </button>
                        <button
                            onClick={() => setShowText((v) => !v)}
                            disabled={busy}
                            className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] text-[12px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                        >
                            {t('license.modal.importText')}
                        </button>
                    </div>

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
                                className="w-full px-3 py-2 rounded-lg bg-[var(--color-accent)] text-white text-[12px] font-medium hover:opacity-80 disabled:opacity-50 transition-opacity"
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

            {state.status === 'trial' && (
                <div className="space-y-4">
                    <p className="text-[13px] text-[var(--color-text)]">
                        {t('license.modal.trialRemaining')}
                        <span className="font-semibold text-[#ff9f0a] ml-1">
                            {formatRemaining(state.trialExpiresAt, t)}
                        </span>
                    </p>
                    <button
                        onClick={doDeactivate}
                        disabled={busy}
                        className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[#ff3b30] text-[13px] font-medium hover:bg-[#ff3b30]/10 transition-colors disabled:opacity-50"
                    >
                        {t('license.modal.deactivate')}
                    </button>
                </div>
            )}

            {state.status === 'activated' && (
                <div className="space-y-4">
                    {state.degraded === 'hardware_changed' && state.licenseKey && (
                        <div className="px-3 py-2 rounded-md bg-[#ff9f0a]/10 border border-[#ff9f0a]/30 text-[12px] text-[#ff9f0a]">
                            {t('license.modal.hardwareChanged', { days: 7 })}
                        </div>
                    )}
                    <p className="text-[13px] text-[var(--color-text)]">
                        {t('license.modal.activatedRemaining')}
                        <span className="font-semibold text-[#34c759] ml-1">
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
                    <button
                        onClick={doDeactivate}
                        disabled={busy}
                        className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-[#ff3b30] text-[13px] font-medium hover:bg-[#ff3b30]/10 transition-colors disabled:opacity-50"
                    >
                        {t('license.modal.deactivate')}
                    </button>
                </div>
            )}
        </Modal>
    );
}
