/**
 * 平台 MCP Server 详情页（如 ModelScope MCP 广场）
 * 复用设置下的连接令牌获取详情，支持一键安装 / 卸载。
 * 安装配置直接来自平台返回的 server_config（command / args / env）。
 */

import {useEffect, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {
    type AnyClientId,
    type ClientInfo,
    type McpServerConfig,
    type PlatformServerDetail as PlatformServerDetailType,
    type RuntimeInfo,
    useElectronAPI,
} from '../lib/electron';
import type {ServerListItem} from '../api/registry';
import {useIsMac} from '../lib/useIsMac';
import {localizeCategoryList} from '../lib/categoryAlias';
import {useStore} from '../store/useStore';
import Modal from '../components/Modal';
import ClientIcon from '../components/ClientIcon';
import ClientMultiSelect from '../components/ClientMultiSelect';
import {BackIcon, ExternalLinkIcon, EyeIcon, GitHubIcon, VerifiedIcon} from '../components/Icons';
import {toast} from '../components/Toast';
import WindowControls from '../components/WindowControls';

// 根据命令推断所需运行时
function commandToRuntime(cmd: string): 'node' | 'python' | 'docker' {
    const c = cmd.toLowerCase();
    if (c === 'docker') return 'docker';
    if (c === 'uvx' || c === 'python' || c === 'python3' || c === 'pip' || c === 'uv') return 'python';
    return 'node'; // npx / node / bun / deno 等
}

// 将平台命令映射为本地可执行文件路径
async function resolveCommand(
    cmd: string,
    getNpxPath: () => Promise<string>,
    getUvxPath: () => Promise<string>
): Promise<string> {
    if (cmd === 'npx') return getNpxPath();
    if (cmd === 'uvx') return getUvxPath();
    return cmd;
}

function formatNumber(count: number): string {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
}

function PlatformIcon({name, iconUrl}: { name: string; iconUrl?: string }) {
    const [imgError, setImgError] = useState(false);
    if (iconUrl && !imgError) {
        return (
            <img
                src={iconUrl}
                alt={name}
                className="w-12 h-12 rounded-xl object-cover"
                onError={() => setImgError(true)}
            />
        );
    }
    const initial = name.charAt(0).toUpperCase();
    const colors = ['bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500', 'bg-pink-500'];
    const colorIndex = name.charCodeAt(0) % colors.length;
    return (
        <div
            className={`w-12 h-12 rounded-xl ${colors[colorIndex]} flex items-center justify-center text-white font-bold text-lg`}>
            {initial}
        </div>
    );
}

interface Props {
    connId: string;
    serverId: string;
    /** 列表项种子数据（来自卡片跳转时通过路由 state 透传），用于在平台详情接口不包含分类/浏览量时补全展示 */
    seedItem?: ServerListItem | null;
}

export default function PlatformServerDetail({connId, serverId, seedItem}: Props) {
    const {t, i18n} = useTranslation();
    const navigate = useNavigate();
    const api = useElectronAPI();
    const isMac = useIsMac();
    const {addInstalledServerId, removeInstalledServerId} = useStore();

    const [clients, setClients] = useState<ClientInfo[]>([]);
    const [selectedClients, setSelectedClients] = useState<AnyClientId[]>([]);
    const [installedClients, setInstalledClients] = useState<AnyClientId[]>([]);
    const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
    const [isInstalling, setIsInstalling] = useState(false);
    const [isUninstalling, setIsUninstalling] = useState(false);
    const [installError, setInstallError] = useState<string | null>(null);
    const [showInstallModal, setShowInstallModal] = useState(false);
    const [iconError] = useState(false);
    // 环境变量表单（envSchema 有必填项时让用户填写）
    const [envInputs, setEnvInputs] = useState<Record<string, string>>({});
    // 远程托管型的接入地址（可在安装模态中编辑；打开时由 detail 初始化）
    const [remoteUrl, setRemoteUrl] = useState('');

    const {data: detail, isLoading, error} = useQuery({
        queryKey: ['platformServerDetail', connId, serverId],
        queryFn: () => api.apiConnections.getServerDetail(connId, serverId) as Promise<PlatformServerDetailType>,
        retry: 1,
    });

    // 加载已安装客户端
    const refreshInstalledClients = async () => {
        try {
            const {servers} = await api.config.getAllServers();
            const info = servers[serverId];
            setInstalledClients(info ? info.clients : []);
        } catch (e) {
            console.error('Failed to get installed clients:', e);
        }
    };

    useEffect(() => {
        api.clients.getAll().then(setClients);
        refreshInstalledClients();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, serverId, connId]);

    // 运行时检测 + 初始化环境变量表单
    useEffect(() => {
        if (!detail?.install) {
            setRuntimeInfo(null);
            setRemoteUrl('');
            return;
        }
        // 远程托管型（如百炼）：无本地命令，跳过运行时检测，连接由客户端直连 URL 完成
        if ('url' in detail.install) {
            setRuntimeInfo({available: true, version: null, path: 'remote'});
            setRemoteUrl(detail.install.url);
            setEnvInputs({});
            return;
        }
        const runtime = commandToRuntime(detail.install.command);
        if (runtime === 'docker') {
            setRuntimeInfo({available: true, version: null, path: 'docker'});
        } else {
            api.env.checkRuntime(runtime).then(setRuntimeInfo);
        }
        const initEnv: Record<string, string> = Object.fromEntries(
            Object.entries(detail.install.env ?? {}).map(([k, v]) => [k, String(v)])
        );
        setEnvInputs(initEnv);
    }, [detail, api]);

    // 默认选中已安装客户端
    useEffect(() => {
        // 仅限支持 MCP 配置写入的客户端：cloud（云同步暂存区）/ agent-skills（.agents 统一标准）
        // 没有 MCP 配置文件，不能作为 MCP 安装目标
        const installed = clients.filter(c => c.installed && c.supportsMcp).map(c => c.id);
        if (installed.length > 0 && selectedClients.length === 0) {
            if (installed.includes('cursor')) setSelectedClients(['cursor']);
            else if (installed.includes('claude-code')) setSelectedClients(['claude-code']);
            else setSelectedClients([installed[0]]);
        }
    }, [clients]);

    const toggleClient = (id: AnyClientId) => {
        setSelectedClients(prev => (prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]));
    };

    const envSchemaObj = (detail?.envSchema ?? {}) as {properties?: Record<string, unknown>; required?: string[]};
    const license = typeof detail?.extra?.license === 'string' ? detail.extra.license : null;
    const envProps = (envSchemaObj.properties ?? {}) as Record<string, {
        description?: string;
        [k: string]: unknown
    }>;
    const requiredEnv = envSchemaObj.required ?? [];
    const hasEnvForm = Object.keys(envProps).length > 0;

    // 远程型鉴权头按 headersTemplate 生成：${KEY} 占位符由用户输入的环境变量填充，
    // 不硬编码具体键名（各远程源在 install 里自行声明模板）；替换后为空的键值对剔除，
    // 全空则不写 headers（与「key 未输入时不带鉴权头」的既有行为一致）。
    const buildRemoteHeaders = (template?: Record<string, string>): Record<string, string> | undefined => {
        if (!template) return undefined;
        const headers = Object.fromEntries(
            Object.entries(template)
                .map(([k, v]) => [k, v.replace(/\$\{(\w+)\}/g, (_, name: string) => (envInputs[name] ?? '').trim())])
                .filter(([, v]) => v !== '')
        );
        return Object.keys(headers).length > 0 ? headers : undefined;
    };

    const handleInstall = async () => {
        if (!detail?.install) return;
        const targets = selectedClients.filter(c => !installedClients.includes(c));
        if (targets.length === 0) {
            setInstallError(t('detail.selectAtLeastOne') || '请至少选择一个客户端');
            return;
        }
        // 校验必填环境变量
        for (const key of requiredEnv) {
            if (!envInputs[key]) {
                setInstallError(`${t('detail.envRequired') || '请填写必填环境变量'}：${key}`);
                return;
            }
        }
        // 产品决策：codex-cli（TOML 适配器）只序列化 command/args/env/cwd，远程 URL 型配置
        // 写入时 url 会被静默丢弃产生坏条目——主进程不设防线，UI 层在安装前明示拦截
        if ('url' in detail.install && targets.includes('codex-cli')) {
            setInstallError(t('detail.remoteCodexUnsupported'));
            return;
        }

        setIsInstalling(true);
        setInstallError(null);
        try {
            let config: McpServerConfig;
            if ('url' in detail.install) {
                // 远程托管型：写入 URL 接入点 + 按模板生成的鉴权头，无需本地命令/运行时
                // （必填 key 已在上面 requiredEnv 校验兜底；占位符未填时对应头被剔除）
                const headers = buildRemoteHeaders(detail.install.headersTemplate);
                config = {
                    url: remoteUrl.trim() || detail.install.url,
                    type: detail.install.type,
                    ...(headers ? {headers} : {}),
                    ...(detail.source ? {source: detail.source} : {}),
                    ...(detail.sourceUrl ? {homepage: detail.sourceUrl} : {}),
                };
            } else {
                const command = await resolveCommand(
                    detail.install.command,
                    api.env.getNpxPath,
                    api.env.getUvxPath
                );
                const env: Record<string, string> = Object.fromEntries(
                    Object.entries(detail.install.env ?? {}).map(([k, v]) => [k, String(v)])
                );
                for (const k of Object.keys(envProps)) {
                    if (envInputs[k]) env[k] = envInputs[k];
                }
                config = {
                    command,
                    args: detail.install.args,
                    ...(Object.keys(env).length > 0 ? {env} : {}),
                    // Phase 6：把 npm 来源的许可证/来源随安装配置透传，供主进程聚合汇总
                    ...(detail.extra?.license ? {license: String(detail.extra.license)} : {}),
                    ...(detail.source ? {source: detail.source} : {}),
                    ...(detail.sourceUrl ? {homepage: detail.sourceUrl} : {}),
                };
            }
            const result = await api.config.installServer(serverId, config, targets);
            if (result.success.length > 0) {
                addInstalledServerId(serverId);
                await refreshInstalledClients();
                setShowInstallModal(false);
                toast.success(t('detail.installSuccess') || 'Installed successfully');
            }
            if (result.failed.length > 0) {
                setInstallError(t('detail.installFailed', {list: result.failed.join(', ')}));
            }
        } catch (e) {
            console.error('Install failed:', e);
            setInstallError(String(e));
        } finally {
            setIsInstalling(false);
        }
    };

    const handleUninstall = async () => {
        if (installedClients.length === 0) return;
        if (!confirm(t('installed.confirmRemove'))) return;
        setIsUninstalling(true);
        try {
            await api.config.uninstallServer(serverId, installedClients);
            await refreshInstalledClients();
            const {servers} = await api.config.getAllServers();
            if (!servers[serverId]) removeInstalledServerId(serverId);
        } catch (e) {
            console.error('Uninstall failed:', e);
        } finally {
            setIsUninstalling(false);
        }
    };

    const openInspector = () => {
        if (!detail?.install) return;
        let config: Record<string, unknown>;
        if ('url' in detail.install) {
            // 远程托管型：Inspector 支持 URL 直连；按模板生成鉴权头（key 未输入则不带）
            const headers = buildRemoteHeaders(detail.install.headersTemplate);
            config = {
                url: remoteUrl.trim() || detail.install.url,
                type: detail.install.type,
                ...(headers ? {headers} : {}),
            };
        } else {
            config = {
                command: detail.install.command,
                args: detail.install.args,
                ...(detail.install.env
                    ? {env: Object.fromEntries(Object.entries(detail.install.env).map(([k, v]) => [k, String(v)]))}
                    : {}),
                ...(detail.install.cwd ? {cwd: detail.install.cwd} : {}),
            };
        }
        const configStr = encodeURIComponent(JSON.stringify(config));
        navigate(`/inspector?config=${configStr}`);
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full bg-[var(--color-bg)]">
                <div className="w-8 h-8 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin"/>
            </div>
        );
    }

    if (error || !detail) {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-[var(--color-bg)]">
                <div className="w-12 h-12 rounded-full bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] flex items-center justify-center mb-3">
                    <svg className="w-6 h-6 text-[var(--color-danger)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                         strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round"
                              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                    </svg>
                </div>
                <p className="text-[13px] text-[var(--color-text)] mb-1">{t('detail.loadFailed')}</p>
                <p className="text-[12px] text-[var(--color-muted)] mb-4 max-w-sm text-center">{(error as Error)?.message || t('detail.loadFailedHint')}</p>
                <button onClick={() => navigate('/store')} className="btn btn-secondary">
                    {t('detail.back')}
                </button>
            </div>
        );
    }

    // 仅本地命令型参与运行时判定；远程托管型无本地命令（runtimeInfo 已在 effect 中置为可用）
    const localInstall = detail.install && 'command' in detail.install ? detail.install : null;
    const runtime = localInstall ? commandToRuntime(localInstall.command) : 'node';
    // 远程托管型无本地运行时依赖：渲染期直接视为可用——runtimeInfo 由 effect 异步置位，
    // 首帧为 null，若等它按钮会晚一帧出现、警告横幅闪现一帧
    const isRemoteInstall = !!detail.install && 'url' in detail.install;
    const runtimeAvailable = isRemoteInstall || (runtimeInfo?.available ?? false);
    const canInstall = !!detail.install;

    // 分类标签：取当前语言的译文。
    // categories(slug) 与 categoryNames 必须同源传入——二者按索引一一对应，混用会错位；
    // 原始 slug 未被改写，分类过滤仍用它精确匹配。
    const catFields =
        detail.categories?.length || detail.categoryNames?.length
            ? { categories: detail.categories, categoryNames: detail.categoryNames }
            : { categories: seedItem?.categories, categoryNames: seedItem?.categoryNames };
    const catNames: string[] = localizeCategoryList(catFields, t, i18n);
    // 浏览量（ModelScope 详情接口不返回，需由列表项透传）
    const viewCount = seedItem?.viewCount ?? detail.stars ?? null;

    return (
        <div className="flex flex-col h-full bg-[var(--color-bg)]">
            {/* 头部导航（一体化标题栏：mac 上兼作拖拽区并为交通灯留白） */}
            <div
                className={`flex items-center gap-2 px-4 h-[32px] drag-region relative border-b border-[var(--color-border)] bg-[var(--color-bg)] text-[12px] text-[var(--color-muted)] ${isMac ? 'ps-20' : 'pe-[140px]'}`}>
                <button onClick={() => navigate(-1)} className="no-drag hover:text-[var(--color-text)] transition-colors">
                    <BackIcon className="w-4 h-4"/>
                </button>
                <span className="no-drag hover:text-[var(--color-text)] cursor-pointer" onClick={() => navigate('/store')}>Store</span>
                <span>/</span>
                <span className="no-drag hover:text-[var(--color-text)] cursor-pointer"
                      onClick={() => navigate('/store')}>{t('store.mcpPlatform') || '平台源'}</span>
                <span>/</span>
                <span className="text-[var(--color-text)]">{detail.displayName}</span>
                <WindowControls />
            </div>

            <div className="flex-1 overflow-hidden flex">
                {/* 左侧主内容 */}
                <div className="flex-1 overflow-y-auto">
                    <div className="p-6">
                        {/* 标题区域 */}
                        <div className="mb-6">
                            <div className="flex items-start gap-4 mb-3">
                                <div className="flex-shrink-0">
                                    <PlatformIcon name={detail.displayName}
                                                  iconUrl={iconError ? undefined : detail.iconUrl}/>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                                        <h1 className="text-2xl font-bold text-[var(--color-text)]">{detail.displayName}</h1>
                                        {detail.isVerified && (
                                            <span
                                                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[12px] font-medium bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)] border border-[color-mix(in_srgb,var(--color-accent)_20%,transparent)]">
                        <VerifiedIcon className="w-3 h-3"/>
                                                {t('detail.verified') || 'Verified'}
                      </span>
                                        )}
                                        {detail.isHosted && (
                                            <span
                                                className="px-1.5 py-0.5 rounded text-[12px] font-medium bg-[color-mix(in_srgb,var(--color-success)_15%,transparent)] text-[var(--color-success)] border border-[color-mix(in_srgb,var(--color-success)_20%,transparent)]">
                        {t('detail.hosted') || 'Hosted'}
                      </span>
                                        )}
                                    </div>
                                    <p className="text-[12px] text-[var(--color-muted)] font-mono break-all">{detail.id}</p>
                                </div>
                            </div>

                            <p className="text-[14px] text-[var(--color-muted2)] leading-relaxed mb-4">
                                {detail.description || t('detail.noDescription')}
                            </p>

                            {/* 统计信息 */}
                            <div className="flex items-center gap-4 text-[13px] text-[var(--color-muted2)] flex-wrap">
                                {typeof viewCount === 'number' && viewCount > 0 && (
                                    <span className="flex items-center gap-1">
                    <EyeIcon className="w-4 h-4"/>
                                        {formatNumber(viewCount)} {t('detail.views') || 'views'}
                  </span>
                                )}
                                {detail.author && (
                                    <span>by @{detail.author}</span>
                                )}
                                {license && (
                                    <span className="flex items-center gap-1">
                                        <span className="opacity-70">⚖</span>
                                        {license}
                                    </span>
                                )}
                            </div>

                            {/* 分类标签 */}
                            {catNames.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-3">
                                    {catNames.map(cat => (
                                        <span
                                            key={cat}
                                            className="px-2 py-0.5 rounded-full text-[12px] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)] border border-[color-mix(in_srgb,var(--color-accent)_20%,transparent)]"
                                        >
                      {cat}
                    </span>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* 运行时警告 */}
                        {canInstall && !runtimeAvailable && runtime !== 'docker' && (
                            <div className="card p-4 border-[color-mix(in_srgb,var(--color-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_5%,transparent)] mb-6">
                                <div className="flex items-start gap-3">
                                    <span className="text-xl">{runtime === 'node' ? '⬢' : '🐍'}</span>
                                    <div className="flex-1">
                                        <h3 className="text-[13px] font-semibold text-[var(--color-warning)] mb-1">{t('detail.runtimeRequired')}</h3>
                                        <p className="text-[12px] text-[var(--color-muted2)] mb-3">
                                            {t('detail.runtimeRequiredDesc', {
                                                runtime: runtime === 'node' ? 'Node.js' : 'Python',
                                            })}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* README */}
                        <h2 className="text-[15px] font-semibold text-[var(--color-text)] mb-4">README.md</h2>
                        <div className="card p-4 mb-6 overflow-x-auto">
                            {detail.readme ? (
                                <pre
                                    className="text-[12px] text-[var(--color-text)] font-mono leading-relaxed whitespace-pre-wrap">
                  <code>{detail.readme}</code>
                </pre>
                            ) : (
                                <p className="text-[14px] text-[var(--color-muted)] text-center py-4">{t('detail.noReadme')}</p>
                            )}
                        </div>
                    </div>
                </div>

                {/* 右侧边栏 */}
                <div className="w-[280px] flex-shrink-0 border-s border-[var(--color-border)] overflow-y-auto p-4">
                    {/* 安装按钮 */}
                    <div className="mb-4 space-y-2">
                        {canInstall && runtimeAvailable && (
                            <button
                                onClick={() => setShowInstallModal(true)}
                                className="w-full btn btn-primary text-[13px]"
                            >
                                {installedClients.length > 0 ? t('detail.installMore') : t('detail.install')}
                            </button>
                        )}
                        {!canInstall && (
                            <div className="w-full btn btn-secondary text-[13px] opacity-60 cursor-not-allowed">
                                {t('detail.noInstallConfig') || '无可用安装配置'}
                            </div>
                        )}
                        {installedClients.length > 0 && (
                            <button
                                onClick={handleUninstall}
                                disabled={isUninstalling}
                                className="w-full btn btn-danger text-[13px]"
                            >
                                {isUninstalling ? t('common.loading') : t('detail.uninstallAll')}
                            </button>
                        )}
                        {canInstall && (
                            <button
                                onClick={openInspector}
                                className="w-full btn btn-secondary text-[13px] flex items-center justify-center gap-1.5"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                     strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z"/>
                                </svg>
                                {t('detail.inspect') || 'Inspect'}
                            </button>
                        )}
                    </div>

                    {/* 已安装的客户端 */}
                    {installedClients.length > 0 && (
                        <div className="mb-4 p-3 bg-[var(--color-surface-hover)]/30 rounded-lg">
                            <p className="text-[12px] text-[var(--color-muted)] mb-2">{t('detail.installedIn')}</p>
                            <div className="flex flex-wrap gap-1">
                                {installedClients.map(clientId => {
                                    const client = clients.find(c => c.id === clientId);
                                    return (
                                        <span key={clientId}
                                              className="flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--color-surface-hover)] text-[12px] text-[var(--color-muted2)]">
                      <ClientIcon clientId={clientId} size={12}/>
                                            {client?.name || clientId}
                    </span>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Source 卡片 */}
                    <div className="card p-4 space-y-3 mb-4">
                        <h3 className="text-[13px] font-semibold text-[var(--color-text)]">Source</h3>
                        {detail.sourceUrl && (
                            <a
                                href="#"
                                onClick={(e) => {
                                    e.preventDefault();
                                    api.system.openExternal(detail.sourceUrl!);
                                }}
                                className="flex items-center justify-between text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-accent)] transition-colors"
                            >
                <span className="flex items-center gap-2">
                  <GitHubIcon className="w-4 h-4"/>
                    {detail.sourceUrl.includes('github.com') ? 'GitHub Repository' : (t('detail.viewSource') || 'View Source')}
                </span>
                                <ExternalLinkIcon className="w-3.5 h-3.5"/>
                            </a>
                        )}
                        {detail.source === 'modelscope' && (
                            <a
                                href="#"
                                onClick={(e) => {
                                    e.preventDefault();
                                    api.system.openExternal(`https://modelscope.cn/mcp?name=${encodeURIComponent(serverId)}`);
                                }}
                                className="flex items-center justify-between text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-accent)] transition-colors"
                            >
                                <span className="flex items-center gap-2">
                                    <ExternalLinkIcon className="w-4 h-4"/>
                                    {t('store.mcpPlatform') || '平台源'}（ModelScope）
                                </span>
                                <ExternalLinkIcon className="w-3.5 h-3.5"/>
                            </a>
                        )}
                    </div>

                    {/* Details 卡片 */}
                    <div className="card p-4">
                        <h3 className="text-[13px] font-semibold text-[var(--color-text)] mb-3">Details</h3>
                        <div className="space-y-2 text-[12px]">
                            <div className="flex justify-between">
                                <span className="text-[var(--color-muted)]">Platform</span>
                                <span className="text-[var(--color-text)] capitalize">{detail.source}</span>
                            </div>
                            {detail.install && (
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-muted)]">{t('detail.runtime') || 'Runtime'}</span>
                                    <div className="flex items-center gap-1">
                                        <span
                                            className={`w-2 h-2 rounded-full ${runtimeAvailable || runtime === 'docker' ? 'bg-[var(--color-success)]' : 'bg-[var(--color-warning)]'}`}/>
                                        {/* 远程托管型无本地命令，展示接入类型（sse/http 等） */}
                                        <span className="text-[var(--color-text)] capitalize">
                                            {'url' in detail.install ? detail.install.type : detail.install.command}
                                        </span>
                                    </div>
                                </div>
                            )}
                            {detail.publisher && (
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-muted)]">{t('detail.publisher') || 'Publisher'}</span>
                                    <span className="text-[var(--color-text)]">{detail.publisher}</span>
                                </div>
                            )}
                            {(detail.tags ?? []).length > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-muted)]">Tags</span>
                                    <span
                                        className="text-[var(--color-text)] text-end max-w-[160px] truncate">{(detail.tags ?? []).join(', ')}</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* 安装模态框（客户端选择 + 环境变量） */}
            <Modal
                isOpen={showInstallModal}
                onClose={() => {
                    setShowInstallModal(false);
                    setInstallError(null);
                }}
                title={t('detail.configTitle')}
                size="lg"
            >
                <div className="space-y-4">
                    {installError && (
                        <div
                            className="p-3 rounded-md bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] border border-[color-mix(in_srgb,var(--color-danger)_20%,transparent)] text-[var(--color-danger)] text-[12px]">
                            {installError}
                        </div>
                    )}

                    <div className="flex items-center gap-3 p-3 bg-[var(--color-surface-hover)]/30 rounded-lg">
                        <PlatformIcon name={detail.displayName} iconUrl={iconError ? undefined : detail.iconUrl}/>
                        <div>
                            <h3 className="text-[14px] font-medium text-[var(--color-text)]">{detail.displayName}</h3>
                            <p className="text-[12px] text-[var(--color-muted)] font-mono break-all">{detail.id}</p>
                        </div>
                    </div>

                    {/* 远程托管型：接入地址（可编辑，slug 以百炼控制台为准） */}
                    {detail.install && 'url' in detail.install && (
                        <div>
                            <label
                                className="block text-[12px] font-medium text-[var(--color-text)] mb-2">{t('detail.remoteUrlLabel') || 'MCP URL'}</label>
                            <input
                                type="text"
                                value={remoteUrl}
                                onChange={(e) => setRemoteUrl(e.target.value)}
                                className="w-full px-2.5 py-1.5 rounded-md bg-[var(--color-surface-hover)] text-[12px] text-[var(--color-text)] font-mono border-none focus:ring-1 focus:ring-[var(--color-accent)]"
                            />
                            <p className="text-[11px] text-[var(--color-muted)] mt-1">{t('detail.remoteUrlHint')}</p>
                        </div>
                    )}

                    {/* 环境变量表单 */}
                    {hasEnvForm && (
                        <div>
                            <label
                                className="block text-[12px] font-medium text-[var(--color-text)] mb-2">{t('detail.envVars') || 'Environment Variables'}</label>
                            <div className="space-y-2">
                                {Object.entries(envProps).map(([key, schema]) => {
                                    const isRequired = requiredEnv.includes(key);
                                    return (
                                        <div key={key}>
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-[12px] font-mono text-[var(--color-text)]">{key}</span>
                                                {isRequired && <span className="text-[var(--color-danger)] text-[12px]">*</span>}
                                                {schema?.description && (
                                                    <span
                                                        className="text-[12px] text-[var(--color-muted)] truncate">{(schema.description as string)}</span>
                                                )}
                                            </div>
                                            <input
                                                type="text"
                                                value={envInputs[key] ?? ''}
                                                onChange={(e) => setEnvInputs(prev => ({
                                                    ...prev,
                                                    [key]: e.target.value
                                                }))}
                                                placeholder={isRequired ? (t('detail.required') || 'required') : ''}
                                                className="w-full px-2.5 py-1.5 rounded-md bg-[var(--color-surface-hover)] text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-muted)] border-none focus:ring-1 focus:ring-[var(--color-accent)]"
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* 客户端选择 */}
                    <div>
                        <label
                            className="block text-[12px] font-medium text-[var(--color-text)] mb-2">{t('detail.selectClients')}</label>
                        <ClientMultiSelect
                            clients={clients.filter(c => c.installed && c.supportsMcp)}
                            selected={selectedClients}
                            onToggle={toggleClient}
                            className="grid grid-cols-2 gap-2"
                            iconSize={20}
                            check="check"
                            checkClassName="w-4 h-4"
                            variant="install"
                            stackedSublabel
                            disabledIds={installedClients}
                            sublabel={{installed: t('detail.alreadyInstalled'), available: t('detail.available')}}
                            unselectedClass="bg-[var(--color-surface-hover)] border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-surface-active)]"
                        />
                        {clients.filter(c => c.installed && c.supportsMcp).length === 0 && (
                            <p className="text-center text-[var(--color-muted)] text-[13px] py-4">
                                {t('detail.noClientsInstalled') || 'No installed clients support MCP'}
                            </p>
                        )}
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => {
                            setShowInstallModal(false);
                            setInstallError(null);
                        }} className="btn btn-secondary">{t('common.cancel')}</button>
                        <button
                            onClick={handleInstall}
                            disabled={selectedClients.filter(c => !installedClients.includes(c)).length === 0 || isInstalling}
                            className="btn btn-primary disabled:opacity-50"
                        >
                            {isInstalling ? t('common.loading') : t('detail.install')}
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
