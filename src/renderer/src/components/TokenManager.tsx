/**
 * API 令牌管理卡片
 * 支持：生成、查看明文、复制、撤销/恢复、删除；配置权限范围与有效期。
 * 令牌明文仅加密落盘，查看/复制时短暂存在前端内存。
 */
import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {type TokenMeta, type TokenScope, useElectronAPI} from '../lib/electron';
import {useStore} from '../store/useStore';
import Modal from './Modal';
import {toast} from './Toast';

const EXPIRY_OPTIONS: { labelKey: string; value: number | null }[] = [
    {labelKey: 'tokenManager.expiryNone', value: null},
    {labelKey: 'tokenManager.expiry7', value: 7 * 86400_000},
    {labelKey: 'tokenManager.expiry30', value: 30 * 86400_000},
    {labelKey: 'tokenManager.expiry90', value: 90 * 86400_000},
];

function scopeColor(scope: TokenScope): string {
    if (scope === 'admin') return 'bg-[color-mix(in_srgb,var(--color-danger)_15%,transparent)] text-[var(--color-danger)]';
    if (scope.includes('download')) return 'bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]';
    return 'bg-[var(--color-surface-hover)] text-[var(--color-muted2)]';
}

export default function TokenManager() {
    const {t} = useTranslation();
    const api = useElectronAPI();
    const tokens = useStore(s => s.tokens);
    const setTokens = useStore(s => s.setTokens);
    const [loading, setLoading] = useState(true);
    const [revealed, setRevealed] = useState<Record<string, string>>({});

    const [showCreate, setShowCreate] = useState(false);
    const [name, setName] = useState('');
    const [rawKey, setRawKey] = useState('');
    const [expiry, setExpiry] = useState<number | null>(null);

    const load = async () => {
        try {
            setTokens(await api.apiTokens.list());
        } catch (e) {
            console.error('load tokens failed', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, [api]);

    const resetForm = () => {
        setName('');
        setRawKey('');
        setExpiry(null);
    };

    const handleImport = async () => {
        if (!name.trim()) {
            toast.error(t('tokenManager.toastNameRequired'));
            return;
        }
        if (!rawKey.trim()) {
            toast.error(t('tokenManager.toastKeyRequired'));
            return;
        }
        try {
            const created = await api.apiTokens.import(rawKey, name.trim(), undefined, expiry);
            toast.success(t('tokenManager.toastImported', {name: created.name}));
            setShowCreate(false);
            resetForm();
            await load();
        } catch (e: any) {
            toast.error(e?.message || t('tokenManager.toastImportFailed'));
        }
    };

    const handleReveal = async (id: string) => {
        if (revealed[id]) {
            setRevealed(p => {
                const n = {...p};
                delete n[id];
                return n;
            });
            return;
        }
        const secret = await api.apiTokens.reveal(id);
        if (secret) setRevealed(p => ({...p, [id]: secret}));
        else toast.error(t('tokenManager.toastRevealFailed'));
    };

    const handleCopy = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            toast.success(t('tokenManager.toastCopied'));
        } catch {
            toast.error(t('tokenManager.toastCopyFailed'));
        }
    };

    const handleRevoke = async (id: string, revoked: boolean) => {
        if (revoked) {
            await api.apiTokens.restore(id);
            toast.success(t('tokenManager.toastRestored'));
        } else {
            await api.apiTokens.revoke(id);
            toast.success(t('tokenManager.toastRevoked'));
        }
        await load();
    };

    const handleDelete = async (id: string) => {
        await api.apiTokens.delete(id);
        setRevealed(p => {
            const n = {...p};
            delete n[id];
            return n;
        });
        toast.success(t('tokenManager.toastDeleted'));
        await load();
    };

    const fmtExpire = (tk: TokenMeta) => {
        if (tk.expiresAt === null) return t('tokenManager.expiryNone');
        const d = new Date(tk.expiresAt);
        return d.toLocaleDateString();
    };

    return (
        <div className="card p-4">
            <div className="flex items-center justify-between mb-1">
                <h2 className="text-[13px] font-semibold text-[var(--color-text)]">{t('tokenManager.title')}</h2>
                <button
                    onClick={() => setShowCreate(true)}
                    className="px-2.5 py-1 rounded-md bg-[var(--color-accent)] text-white text-[12px] font-medium hover:bg-[color-mix(in_srgb,var(--color-accent)_90%,transparent)] transition-colors"
                >
                    + {t('tokenManager.import')}
                </button>
            </div>
            <p className="text-[12px] text-[var(--color-muted2)] mb-3">
                {t('tokenManager.desc')}
            </p>

            {loading ? (
                <div className="space-y-2">
                    {[0, 1].map(i => <div key={i} className="h-12 rounded-md bg-[var(--color-surface-hover)]/40 animate-pulse"/>)}
                </div>
            ) : tokens.length === 0 ? (
                <div className="text-[12px] text-[var(--color-muted)] py-3 text-center">{t('tokenManager.empty')}</div>
            ) : (
                <div className="space-y-2">
                    {tokens.map(tk => (
                        <div key={tk.id} className="p-3 rounded-md bg-[var(--color-surface-hover)]/40">
                            <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[12px] font-medium text-[var(--color-text)] truncate">{tk.name}</span>
                                        {tk.revoked && (
                                            <span
                                                className="text-[12px] px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--color-warning)_15%,transparent)] text-[var(--color-warning)]">{t('tokenManager.revoked')}</span>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap gap-1 mt-1">
                                        {tk.scopes.map(s => (
                                            <span key={s}
                                                  className={`text-[12px] px-1.5 py-0.5 rounded ${scopeColor(s)}`}>{s}</span>
                                        ))}
                                    </div>
                                    <p className="text-[12px] text-[var(--color-muted)] mt-1">
                                        {t('tokenManager.validity', {exp: fmtExpire(tk), preview: tk.preview})}
                                    </p>
                                </div>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                    <IconBtn title={t('tokenManager.viewHide')} onClick={() => handleReveal(tk.id)}>
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"
                                             stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                  d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                        </svg>
                                    </IconBtn>
                                    <IconBtn title={t('tokenManager.copy')} onClick={() => handleCopy(revealed[tk.id] || '')}>
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"
                                             stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                  d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.03 1.125-.03h3.448c.426 0 .801 0 1.175.03 1.13.094 1.976 1.057 1.976 2.192V16.5c0 1.135-.845 2.098-1.976 2.192a12.12 12.12 0 01-1.175.03H8.25m0-11.25v11.25"/>
                                        </svg>
                                    </IconBtn>
                                    <IconBtn title={tk.revoked ? t('tokenManager.restore') : t('tokenManager.revoke')}
                                             onClick={() => handleRevoke(tk.id, tk.revoked)}>
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"
                                             stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                  d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/>
                                        </svg>
                                    </IconBtn>
                                    <IconBtn title={t('tokenManager.delete')} danger onClick={() => handleDelete(tk.id)}>
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"
                                             stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                  d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>
                                        </svg>
                                    </IconBtn>
                                </div>
                            </div>
                            {revealed[tk.id] && (
                                <div className="mt-2 flex items-center gap-2">
                                    <code
                                        className="flex-1 px-2 py-1.5 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-[12px] text-[var(--color-info)] font-mono break-all">
                                        {revealed[tk.id]}
                                    </code>
                                    <button onClick={() => handleCopy(revealed[tk.id])}
                                            className="text-[12px] text-[var(--color-accent)] hover:underline">{t('tokenManager.copyText')}
                                    </button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* 生成令牌弹窗 */}
            <Modal isOpen={showCreate} onClose={() => setShowCreate(false)} title={t('tokenManager.modalTitle')}>
                <div className="space-y-4">
                    <div>
                        <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">{t('tokenManager.name')}</label>
                        <input
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder={t('tokenManager.namePlaceholder')}
                            className="w-full px-3 py-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] text-[12px] focus:border-[var(--color-accent)] transition-colors"
                        />
                    </div>
                    <div>
                        <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">{t('tokenManager.apiKey')}</label>
                        <textarea
                            value={rawKey}
                            onChange={e => setRawKey(e.target.value)}
                            placeholder={t('tokenManager.apiKeyPlaceholder')}
                            rows={3}
                            className="w-full px-3 py-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] text-[12px] font-mono focus:border-[var(--color-accent)] transition-colors resize-none"
                        />
                        <p className="text-[12px] text-[var(--color-muted)] mt-1">
                            {t('tokenManager.apiKeyHint')}
                        </p>
                    </div>
                    <div>
                        <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">{t('tokenManager.expiry')}</label>
                        <select
                            value={String(expiry)}
                            onChange={e => setExpiry(e.target.value === 'null' ? null : Number(e.target.value))}
                            className="w-full px-3 py-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] text-[12px] focus:border-[var(--color-accent)] transition-colors"
                        >
                            {EXPIRY_OPTIONS.map(o => (
                                <option key={String(o.value)} value={String(o.value)}>{t(o.labelKey)}</option>
                            ))}
                        </select>
                    </div>
                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => setShowCreate(false)}
                                className="px-3 py-1.5 rounded-md bg-[var(--color-surface-hover)] text-[var(--color-text)] text-[12px] hover:bg-[var(--color-surface-hover)]/80 transition-colors">{t('tokenManager.cancel')}
                        </button>
                        <button onClick={handleImport}
                                className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white text-[12px] font-medium hover:bg-[color-mix(in_srgb,var(--color-accent)_90%,transparent)] transition-colors">{t('tokenManager.importBtn')}
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}

function IconBtn({children, onClick, title, danger}: {
    children: React.ReactNode;
    onClick: () => void;
    title: string;
    danger?: boolean
}) {
    return (
        <button
            title={title}
            onClick={onClick}
            className={`p-1.5 rounded transition-colors ${danger ? 'text-[var(--color-muted2)] hover:text-[var(--color-danger)] hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)]' : 'text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]'}`}
        >
            {children}
        </button>
    );
}
