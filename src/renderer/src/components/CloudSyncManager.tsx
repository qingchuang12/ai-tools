/**
 * 云同步设置卡片
 * 支持 Git（系统 git CLI）与 SFTP（ssh2-sftp-client）两种通道，云端自动创建 ai-tools 目录存放 mcp / skill。
 * 凭据以明文提交给主进程，落盘时换成 SecretStore 的 secretId；已保存的凭据在这里只显示占位符。
 */
import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
    type AllRuntimes,
    type CloudSyncConfig,
    type CloudSyncConfigInput,
    defaultCloudSyncConfig,
    useElectronAPI,
} from '../lib/electron';
import {CLOUD_ROOT_DIR} from '../../../shared/cloud-sync-constants';
import {useActivationStore} from '../store/activationStore';
import {toast} from './Toast';

interface Props {
    /** 运行时探测结果，用于在 Git 模式下提示未安装 git */
    runtimes?: AllRuntimes | null;
    /** 配置保存后通知外部（云客户端的可用性会变化） */
    onChanged?: () => void;
}

export default function CloudSyncManager({runtimes, onChanged}: Props) {
    const {t} = useTranslation();
    const api = useElectronAPI();
    // 云同步为付费权益：未授权时锁态提示（体验层，真实边界在主进程 gate）
    const licensed = useActivationStore((s) => s.hasFeature('cloud_sync'));
    const openModal = useActivationStore((s) => s.openModal);
    const [cfg, setCfg] = useState<CloudSyncConfig>(defaultCloudSyncConfig());
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    // 折叠态：保存后缩小，点击「编辑」展开
    const [expanded, setExpanded] = useState(false);

    // 明文凭据输入：undefined = 未改动（保留原值），'' = 清除，其他 = 覆盖
    const [gitToken, setGitToken] = useState<string | undefined>(undefined);
    const [gitPassphrase, setGitPassphrase] = useState<string | undefined>(undefined);
    const [sftpPassword, setSftpPassword] = useState<string | undefined>(undefined);
    const [sftpPassphrase, setSftpPassphrase] = useState<string | undefined>(undefined);

    const load = async () => {
        try {
            setCfg(await api.cloudSync.getConfig());
        } catch (e) {
            console.error('load cloud sync config failed', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, [api]);

    /** 把表单拼成补丁；明文字段未改动时不下发 */
    const buildPatch = (): CloudSyncConfigInput => ({
        enabled: cfg.enabled,
        provider: cfg.provider,
        git: {
            repoUrl: cfg.git.repoUrl.trim(),
            branch: cfg.git.branch.trim() || 'main',
            authType: cfg.git.authType,
            privateKeyPath: cfg.git.privateKeyPath,
            userName: cfg.git.userName,
            userEmail: cfg.git.userEmail,
            ...(gitToken !== undefined ? {tokenInput: gitToken} : {}),
            ...(gitPassphrase !== undefined ? {passphraseInput: gitPassphrase} : {}),
        },
        sftp: {
            host: cfg.sftp.host.trim(),
            port: cfg.sftp.port || 22,
            username: cfg.sftp.username.trim(),
            authType: cfg.sftp.authType,
            privateKeyPath: cfg.sftp.privateKeyPath,
            remoteDir: cfg.sftp.remoteDir.trim() || '/',
            ...(sftpPassword !== undefined ? {passwordInput: sftpPassword} : {}),
            ...(sftpPassphrase !== undefined ? {passphraseInput: sftpPassphrase} : {}),
        },
    });

    /** 保存前的必填校验，返回错误文案 */
    const validate = (): string | null => {
        if (!cfg.enabled) return null;
        if (cfg.provider === 'git') {
            if (!cfg.git.repoUrl.trim()) return t('cloudSync.repoRequired');
        } else {
            if (!cfg.sftp.host.trim()) return t('cloudSync.sftpHostRequired');
            if (!cfg.sftp.username.trim()) return t('cloudSync.sftpUserRequired');
        }
        return null;
    };

    const persist = async (): Promise<CloudSyncConfig | null> => {
        const err = validate();
        if (err) {
            toast.error(err);
            return null;
        }
        const next = await api.cloudSync.setConfig(buildPatch());
        setCfg(next);
        // 明文已落盘为 secretId，清掉本地输入态回到占位符显示
        setGitToken(undefined);
        setGitPassphrase(undefined);
        setSftpPassword(undefined);
        setSftpPassphrase(undefined);
        // 保存成功后折叠卡片，回到缩小态；点击「编辑」再展开
        setExpanded(false);
        onChanged?.();
        return next;
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            if (await persist()) toast.success(t('cloudSync.saved'));
        } catch (e: any) {
            toast.error(e?.message || t('cloudSync.saveFailed'));
        } finally {
            setSaving(false);
        }
    };

    /** 测试前先保存，避免测的是旧配置 */
    const handleTest = async () => {
        setTesting(true);
        try {
            if (!(await persist())) return;
            const res = await api.cloudSync.test();
            if (res.ok) toast.success(res.message || t('cloudSync.testSuccess'));
            else toast.error(res.message || t('cloudSync.testFailed'));
        } catch (e: any) {
            toast.error(e?.message || t('cloudSync.testError'));
        } finally {
            setTesting(false);
        }
    };

    const gitMissing = cfg.provider === 'git' && runtimes ? !runtimes.git.available : false;

    const summary = !loading && cfg.enabled
        ? (cfg.provider === 'git'
            ? `Git · ${cfg.git.repoUrl || t('cloudSync.notSet')}`
            : `SFTP · ${cfg.sftp.host || t('cloudSync.notSet')}`)
        : '';

    return (
        <div className="card p-4">
            <div className="flex items-center justify-between mb-1">
                <h2 className="text-[13px] font-semibold text-[var(--color-text)]">{t('cloudSync.title')}</h2>
                <div className="flex items-center gap-2">
                    {!expanded && cfg.enabled && (
                        <button
                            onClick={() => setExpanded(true)}
                            className="px-2.5 py-1 rounded-md text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
                            title={t('cloudSync.edit') || 'Edit'}
                        >
                            {t('cloudSync.edit') || 'Edit'}
                        </button>
                    )}
                    <button
                        onClick={() => setCfg({...cfg, enabled: !cfg.enabled})}
                        className={`relative w-9 h-5 rounded-full transition-colors ${cfg.enabled ? 'bg-[#34c759]' : 'bg-[var(--color-surface-hover)]'}`}
                        title={cfg.enabled ? t('cloudSync.disableTitle') : t('cloudSync.enableTitle')}
                    >
                        <span
                            className={`absolute top-[2px] w-4 h-4 rounded-full bg-[var(--color-surface)] transition-all ${cfg.enabled ? 'left-[18px]' : 'left-[2px]'}`}/>
                    </button>
                </div>
            </div>
            <p className="text-[12px] text-[var(--color-muted2)] mb-3">
                {t('cloudSync.desc', {dir: CLOUD_ROOT_DIR})}
            </p>

            {!licensed && (
                <div className="mb-3 px-3 py-3 rounded-md bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/30">
                    <p className="text-[12px] text-[var(--color-text)] mb-2">
                        {t('license.modal.needActivation')}
                    </p>
                    <button
                        onClick={openModal}
                        className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white text-[12px] font-medium hover:opacity-90 transition-colors"
                    >
                        {t('license.modal.upgrade')}
                    </button>
                </div>
            )}

            <div className={!licensed ? 'opacity-50 pointer-events-none' : ''}>
            {loading ? (
                <div className="h-24 rounded-md bg-[var(--color-surface-hover)]/40 animate-pulse"/>
            ) : !expanded ? (
                // 折叠态：仅显示状态摘要，节省空间
                <div className="flex items-center justify-between">
                    <p className="text-[12px] text-[var(--color-muted)]">
                        {cfg.enabled
                            ? summary
                            : t('cloudSync.disabled')}
                    </p>
                    {cfg.enabled && (
                        <p className="text-[12px] text-[var(--color-muted)]">
                            {cfg.lastSyncAt
                                ? t('cloudSync.lastSync', {
                                    time: new Date(cfg.lastSyncAt).toLocaleString(),
                                    msg: cfg.lastSyncMessage ? ` · ${cfg.lastSyncMessage}` : ''
                                })
                                : t('cloudSync.neverSynced')}
                        </p>
                    )}
                </div>
            ) : (
                <div className={cfg.enabled ? '' : 'opacity-50 pointer-events-none'}>
                    {/* 通道切换 */}
                    <div className="flex gap-2 mb-4">
                        {(['git', 'sftp'] as const).map(p => (
                            <button
                                key={p}
                                onClick={() => setCfg({...cfg, provider: p})}
                                className={`flex-1 px-3 py-2 rounded-md text-[12px] font-medium transition-colors ${
                                    cfg.provider === p ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-surface-hover)] text-[var(--color-muted2)] hover:text-[var(--color-text)]'
                                }`}
                            >
                                {p === 'git' ? t('cloudSync.gitChannel') : t('cloudSync.sftpChannel')}
                            </button>
                        ))}
                    </div>

                    {gitMissing && (
                        <div
                            className="mb-3 px-3 py-2 rounded-md bg-[#ff9f0a]/10 border border-[#ff9f0a]/30 text-[12px] text-[#ff9f0a]">
                            {t('cloudSync.gitMissing')}
                        </div>
                    )}

                    {cfg.provider === 'git' ? (
                        <div className="space-y-3">
                            <Field label={t('cloudSync.repoUrl')}>
                                <input
                                    value={cfg.git.repoUrl}
                                    onChange={e => setCfg({...cfg, git: {...cfg.git, repoUrl: e.target.value}})}
                                    placeholder={t('cloudSync.repoUrlPlaceholder')}
                                    className={inputCls + ' font-mono'}
                                />
                            </Field>
                            <div className="grid grid-cols-2 gap-3">
                                <Field label={t('cloudSync.branch')}>
                                    <input
                                        value={cfg.git.branch}
                                        onChange={e => setCfg({...cfg, git: {...cfg.git, branch: e.target.value}})}
                                        placeholder="main"
                                        className={inputCls}
                                    />
                                </Field>
                                <Field label={t('cloudSync.authType')}>
                                    <select
                                        value={cfg.git.authType}
                                        onChange={e => setCfg({
                                            ...cfg,
                                            git: {
                                                ...cfg.git,
                                                authType: e.target.value as CloudSyncConfig['git']['authType']
                                            }
                                        })}
                                        className={inputCls}
                                    >
                                        <option value="none">{t('cloudSync.authNone')}</option>
                                        <option value="ssh-key">{t('cloudSync.authSshKey')}</option>
                                        <option value="https-token">{t('cloudSync.authHttpsToken')}</option>
                                    </select>
                                </Field>
                            </div>

                            {cfg.git.authType === 'ssh-key' && (
                                <>
                                    <Field label={t('cloudSync.privateKeyPath')}>
                                        <input
                                            value={cfg.git.privateKeyPath || ''}
                                            onChange={e => setCfg({
                                                ...cfg,
                                                git: {...cfg.git, privateKeyPath: e.target.value}
                                            })}
                                            placeholder="~/.ssh/id_ed25519"
                                            className={inputCls + ' font-mono'}
                                        />
                                    </Field>
                                    <SecretField
                                        label={t('cloudSync.keyPassphrase')}
                                        value={gitPassphrase}
                                        saved={!!cfg.git.passphraseSecretId}
                                        onChange={setGitPassphrase}
                                    />
                                </>
                            )}

                            {cfg.git.authType === 'https-token' && (
                                <SecretField
                                    label={t('cloudSync.accessToken')}
                                    value={gitToken}
                                    saved={!!cfg.git.tokenSecretId}
                                    onChange={setGitToken}
                                    placeholder="Personal Access Token"
                                />
                            )}

                            <div className="grid grid-cols-2 gap-3">
                                <Field label={t('cloudSync.committerName')}>
                                    <input
                                        value={cfg.git.userName || ''}
                                        onChange={e => setCfg({...cfg, git: {...cfg.git, userName: e.target.value}})}
                                        placeholder="AI-Tools"
                                        className={inputCls}
                                    />
                                </Field>
                                <Field label={t('cloudSync.committerEmail')}>
                                    <input
                                        value={cfg.git.userEmail || ''}
                                        onChange={e => setCfg({...cfg, git: {...cfg.git, userEmail: e.target.value}})}
                                        placeholder="ai-tools@localhost"
                                        className={inputCls}
                                    />
                                </Field>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="grid grid-cols-[1fr_100px] gap-3">
                                <Field label={t('cloudSync.host')}>
                                    <input
                                        value={cfg.sftp.host}
                                        onChange={e => setCfg({...cfg, sftp: {...cfg.sftp, host: e.target.value}})}
                                        placeholder="sftp.example.com"
                                        className={inputCls + ' font-mono'}
                                    />
                                </Field>
                                <Field label={t('cloudSync.port')}>
                                    <input
                                        type="number"
                                        value={cfg.sftp.port}
                                        onChange={e => setCfg({
                                            ...cfg,
                                            sftp: {...cfg.sftp, port: Number(e.target.value) || 22}
                                        })}
                                        className={inputCls}
                                    />
                                </Field>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <Field label={t('cloudSync.username')}>
                                    <input
                                        value={cfg.sftp.username}
                                        onChange={e => setCfg({...cfg, sftp: {...cfg.sftp, username: e.target.value}})}
                                        className={inputCls}
                                    />
                                </Field>
                                <Field label={t('cloudSync.authType')}>
                                    <select
                                        value={cfg.sftp.authType}
                                        onChange={e => setCfg({
                                            ...cfg,
                                            sftp: {
                                                ...cfg.sftp,
                                                authType: e.target.value as CloudSyncConfig['sftp']['authType']
                                            }
                                        })}
                                        className={inputCls}
                                    >
                                        <option value="password">{t('cloudSync.password')}</option>
                                        <option value="key">{t('cloudSync.authSshKey')}</option>
                                    </select>
                                </Field>
                            </div>

                            {cfg.sftp.authType === 'password' ? (
                                <SecretField
                                    label={t('cloudSync.password')}
                                    value={sftpPassword}
                                    saved={!!cfg.sftp.passwordSecretId}
                                    onChange={setSftpPassword}
                                />
                            ) : (
                                <>
                                    <Field label={t('cloudSync.privateKeyPath')}>
                                        <input
                                            value={cfg.sftp.privateKeyPath || ''}
                                            onChange={e => setCfg({
                                                ...cfg,
                                                sftp: {...cfg.sftp, privateKeyPath: e.target.value}
                                            })}
                                            placeholder="~/.ssh/id_ed25519"
                                            className={inputCls + ' font-mono'}
                                        />
                                    </Field>
                                    <SecretField
                                        label={t('cloudSync.keyPassphrase')}
                                        value={sftpPassphrase}
                                        saved={!!cfg.sftp.passphraseSecretId}
                                        onChange={setSftpPassphrase}
                                    />
                                </>
                            )}

                            <Field label={t('cloudSync.remoteDir')}>
                                <input
                                    value={cfg.sftp.remoteDir}
                                    onChange={e => setCfg({...cfg, sftp: {...cfg.sftp, remoteDir: e.target.value}})}
                                    placeholder="/home/user/backup"
                                    className={inputCls + ' font-mono'}
                                />
                                <p className="text-[12px] text-[var(--color-muted)] mt-1">
                                    {t('cloudSync.storageLocation')}<span
                                    className="font-mono">{(cfg.sftp.remoteDir || '/').replace(/\/+$/, '')}/{CLOUD_ROOT_DIR}</span>
                                </p>
                            </Field>
                        </div>
                    )}

                    <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--color-border)]">
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => setExpanded(false)}
                                className="text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:underline transition-colors"
                            >
                                {t('cloudSync.collapse') || 'Collapse'}
                            </button>
                            <p className="text-[12px] text-[var(--color-muted)]">
                                {cfg.lastSyncAt
                                    ? t('cloudSync.lastSync', {
                                        time: new Date(cfg.lastSyncAt).toLocaleString(),
                                        msg: cfg.lastSyncMessage ? ` · ${cfg.lastSyncMessage}` : ''
                                    })
                                    : t('cloudSync.neverSynced')}
                            </p>
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={handleTest}
                                disabled={testing || saving}
                                className="px-3 py-1.5 rounded-md bg-[var(--color-surface-hover)] text-[var(--color-text)] text-[12px] hover:bg-[var(--color-surface-hover)]/80 transition-colors disabled:opacity-50"
                            >
                                {testing ? t('cloudSync.testing') : t('cloudSync.test')}
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={saving || testing}
                                className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white text-[12px] font-medium hover:bg-[var(--color-accent)]/90 transition-colors disabled:opacity-50"
                            >
                                {saving ? t('cloudSync.saving') : t('cloudSync.save')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            </div>
        </div>
    );
}

const inputCls = 'w-full px-3 py-2 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] text-[12px] focus:border-[var(--color-accent)] transition-colors';

function Field({label, children}: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">{label}</label>
            {children}
        </div>
    );
}

/**
 * 密文输入框：未改动时显示「已保存」占位符，聚焦编辑后才提交明文。
 * 清空输入框并保存 = 删除该凭据。
 */
function SecretField({
                         label,
                         value,
                         saved,
                         onChange,
                         placeholder,
                     }: {
    label: string;
    value: string | undefined;
    saved: boolean;
    onChange: (v: string | undefined) => void;
    placeholder?: string;
}) {
    const {t} = useTranslation();
    const editing = value !== undefined;
    return (
        <div>
            <div className="flex items-center justify-between mb-1.5">
                <label className="text-[12px] text-[var(--color-muted2)]">{label}</label>
                {saved && !editing && (
                    <button onClick={() => onChange('')}
                            className="text-[12px] text-[#ff3b30] hover:underline">{t('cloudSync.clear')}</button>
                )}
                {editing && (
                    <button onClick={() => onChange(undefined)}
                            className="text-[12px] text-[var(--color-muted2)] hover:underline">{t('cloudSync.cancelEdit')}</button>
                )}
            </div>
            <input
                type="password"
                value={editing ? value : ''}
                onChange={e => onChange(e.target.value)}
                placeholder={saved && !editing ? t('cloudSync.savedPlaceholder') : (placeholder || '')}
                className={inputCls + ' font-mono'}
            />
        </div>
    );
}
