/**
 * MCP Server 详情页面 - 参考 Skill 详情页风格
 * 支持数据源 (Smithery)
 * 布局：左侧信息 + 右侧操作区
 */

import {useEffect, useState} from 'react';
import {useLocation, useNavigate, useParams, useSearchParams} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {
    type DataSource,
    fetchServerDetail,
    isSmitheryDetail,
    type ServerListItem,
    type SmitheryDetail,
} from '../api/registry';
import {type AnyClientId, type ClientInfo, type RuntimeInfo, useElectronAPI} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import {useStore} from '../store/useStore';
import Modal from '../components/Modal';
import ConfigForm from '../components/ConfigForm';
import ClientIcon from '../components/ClientIcon';
import ClientMultiSelect from '../components/ClientMultiSelect';
import PlatformServerDetail from './PlatformServerDetail';
import WindowControls from '../components/WindowControls';
import {BackIcon, ClockIcon, DownloadIcon, ExternalLinkIcon, GitHubIcon, VerifiedIcon} from '../components/Icons';

// 从仓库 URL 提取 GitHub 用户名
function extractGitHubUsername(repoUrl: string | null | undefined): string | null {
    if (!repoUrl) return null;
    const match = repoUrl.match(/github\.com\/([^\/]+)/);
    return match ? match[1] : null;
}

// 获取 GitHub 用户头像 URL
function getGitHubAvatarUrl(username: string): string {
    return `https://avatars.githubusercontent.com/${username}`;
}

// 格式化数字
function formatNumber(count: number): string {
    if (count >= 1000000) {
        return `${(count / 1000000).toFixed(1)}M`;
    }
    if (count >= 1000) {
        return `${(count / 1000).toFixed(1)}K`;
    }
    return count.toString();
}

// 默认图标
function DefaultIcon({name, repoUrl}: { name: string; repoUrl?: string | null }) {
    const [imgError, setImgError] = useState(false);
    const githubUsername = extractGitHubUsername(repoUrl);

    // 尝试使用 GitHub 头像
    if (githubUsername && !imgError) {
        return (
            <img
                src={getGitHubAvatarUrl(githubUsername)}
                alt={name}
                className="w-12 h-12 rounded-xl object-cover"
                onError={() => setImgError(true)}
            />
        );
    }

    // 回退到首字母图标
    const initial = name.charAt(0).toUpperCase();
    const colors = ['bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500', 'bg-pink-500'];
    const colorIndex = name.charCodeAt(0) % colors.length;

    return (
        <div
            className={`w-12 h-12 rounded-xl ${colors[colorIndex]} flex items-center justify-center text-[var(--color-text)] font-bold text-lg`}>
            {initial}
        </div>
    );
}

export default function Detail() {
    const {source, id} = useParams<{ source: string; id: string }>();
    const [searchParams] = useSearchParams();
    const location = useLocation();
    const navigate = useNavigate();
    const {t} = useTranslation();
    const api = useElectronAPI();
    const isMac = useIsMac();

    const {addInstalledServerId, removeInstalledServerId} = useStore();

    const [showConfigModal, setShowConfigModal] = useState(false);
    const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
    const [isInstalling, setIsInstalling] = useState(false);
    const [isUninstalling, setIsUninstalling] = useState(false);
    const [clients, setClients] = useState<ClientInfo[]>([]);
    const [selectedClients, setSelectedClients] = useState<AnyClientId[]>([]);
    const [installedClients, setInstalledClients] = useState<AnyClientId[]>([]);
    const [installError, setInstallError] = useState<string | null>(null);
    const [iconError, setIconError] = useState(false);

    const dataSource = (source || 'smithery') as DataSource;
    const decodedId = id ? decodeURIComponent(id) : '';
    // 平台源（如 ModelScope）走独立详情页
    const isPlatform = source === 'platform';
    const connId = searchParams.get('conn');

    // 平台源：交给 PlatformServerDetail 组件处理（提前返回，不执行官方/Smithery 查询）
    if (isPlatform) {
        if (!connId) {
            return (
                <div className="flex flex-col items-center justify-center h-full bg-[var(--color-bg)]">
                    <div className="w-12 h-12 rounded-full bg-[#ff3b30]/10 flex items-center justify-center mb-3">
                        <svg className="w-6 h-6 text-[#ff3b30]" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                             strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round"
                                  d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                        </svg>
                    </div>
                    <p className="text-[13px] text-[var(--color-text)] mb-3">{t('detail.loadFailed')}</p>
                    <button onClick={() => navigate('/store')} className="btn btn-secondary">{t('detail.back')}</button>
                </div>
            );
        }
        const seedServer = (location.state as { server?: ServerListItem } | null)?.server;
        return <PlatformServerDetail connId={connId} serverId={decodedId} seedItem={seedServer}/>;
    }

    // 获取服务器详情
    const {data: server, isLoading, error} = useQuery({
        queryKey: ['serverDetail', dataSource, decodedId],
        queryFn: () => fetchServerDetail(dataSource, decodedId),
        enabled: !!decodedId && !isPlatform,
        retry: 1,
    });

    // 加载客户端列表
    useEffect(() => {
        api.clients.getAll().then(setClients);
    }, [api]);

    // 检查运行时
    useEffect(() => {
        if (server) {
            if (isSmitheryDetail(server) && server.connection?.runtime) {
                api.env.checkRuntime(server.connection.runtime as 'node' | 'python').then(setRuntimeInfo);
            } else {
                api.env.checkRuntime('node').then(setRuntimeInfo);
            }
        }
    }, [server, api]);

    // 检查此服务器安装在哪些客户端
    const refreshInstalledClients = async () => {
        try {
            const {servers} = await api.config.getAllServers();
            const serverInfo = servers[decodedId];
            if (serverInfo) {
                setInstalledClients(serverInfo.clients);
            } else {
                setInstalledClients([]);
            }
        } catch (error) {
            console.error('Failed to get installed clients:', error);
        }
    };

    useEffect(() => {
        refreshInstalledClients();
    }, [api, decodedId]);

    // 默认选择已安装的客户端
    useEffect(() => {
        // 仅限支持 MCP 配置写入的客户端：cloud（云同步暂存区）/ agent-skills（.agents 统一标准）
        // 没有 MCP 配置文件，不能作为 MCP 安装目标
        const installedClientIds = clients.filter(c => c.installed && c.supportsMcp).map(c => c.id);
        if (installedClientIds.length > 0 && selectedClients.length === 0) {
            if (installedClientIds.includes('cursor')) {
                setSelectedClients(['cursor']);
            } else if (installedClientIds.includes('claude-code')) {
                setSelectedClients(['claude-code']);
            } else {
                setSelectedClients([installedClientIds[0]]);
            }
        }
    }, [clients]);

    // 切换客户端选择
    const toggleClient = (clientId: AnyClientId) => {
        setSelectedClients(prev =>
            prev.includes(clientId)
                ? prev.filter(c => c !== clientId)
                : [...prev, clientId]
        );
    };

    // Smithery 安装
    const handleSmitheryInstall = async (configValues: Record<string, any>) => {
        const clientsToInstall = selectedClients.filter(c => !installedClients.includes(c));

        if (clientsToInstall.length === 0) {
            setInstallError('Please select at least one client.');
            return;
        }

        setIsInstalling(true);
        setInstallError(null);

        try {
            const npxPath = await api.env.getNpxPath();
            const uvxPath = await api.env.getUvxPath();

            const smitheryServer = server as SmitheryDetail;
            const runtime = smitheryServer.connection?.runtime || 'node';
            const qualifiedName = smitheryServer.qualifiedName || decodedId.replace(/^smithery-/, '');
            const config = {
                command: runtime === 'node' ? npxPath : uvxPath,
                args: runtime === 'node'
                    ? ['-y', '@smithery/cli@latest', 'run', qualifiedName, '--config', JSON.stringify(configValues)]
                    : ['smithery-cli', 'run', qualifiedName, '--config', JSON.stringify(configValues)],
            };

            const result = await api.config.installServer(decodedId, config, clientsToInstall);

            if (result.success.length > 0) {
                addInstalledServerId(decodedId);
                await refreshInstalledClients();
                setShowConfigModal(false);
            }

            if (result.failed.length > 0) {
                setInstallError(`Failed to install to: ${result.failed.join(', ')}`);
            }
        } catch (error) {
            console.error('Install failed:', error);
            setInstallError(String(error));
        } finally {
            setIsInstalling(false);
        }
    };

    // 卸载服务器
    const handleUninstall = async (clientsToRemove?: AnyClientId[]) => {
        const targets = clientsToRemove || installedClients;
        if (targets.length === 0) return;

        if (!confirm(t('installed.confirmRemove'))) return;

        setIsUninstalling(true);
        try {
            await api.config.uninstallServer(decodedId, targets);
            await refreshInstalledClients();

            const {servers} = await api.config.getAllServers();
            if (!servers[decodedId]) {
                removeInstalledServerId(decodedId);
            }
        } catch (error) {
            console.error('Uninstall failed:', error);
        } finally {
            setIsUninstalling(false);
        }
    };

    const formatDate = (dateStr: string) => {
        try {
            return new Date(dateStr).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
            });
        } catch {
            return dateStr;
        }
    };

    // 获取运行时信息
    const getRuntime = () => {
        if (isSmitheryDetail(server!)) {
            return server!.connection?.runtime || 'node';
        }
        return 'node';
    };

    // 获取仓库 URL（github.com 地址用于头像回退；smithery 首页等非 GitHub 地址自然返回 null）
    const getRepoUrl = () => {
        return server!.repository?.url || null;
    };

    const runtimeAvailable = runtimeInfo?.available ?? false;

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full bg-[var(--color-bg)]">
                <div className="w-8 h-8 border-2 border-[var(--color-border)] border-t-[#0a84ff] rounded-full animate-spin"/>
            </div>
        );
    }

    if (error || !server) {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-[var(--color-bg)]">
                <div className="w-12 h-12 rounded-full bg-[#ff3b30]/10 flex items-center justify-center mb-3">
                    <svg className="w-6 h-6 text-[#ff3b30]" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                         strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round"
                              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                    </svg>
                </div>
                <p className="text-[13px] text-[var(--color-text)] mb-1">{t('detail.loadFailed')}</p>
                <p className="text-[12px] text-[var(--color-muted)] mb-4 max-w-sm text-center">{t('detail.loadFailedHint')}</p>
                <button onClick={() => navigate('/store')} className="btn btn-secondary">
                    {t('detail.back')}
                </button>
            </div>
        );
    }

    const runtime = getRuntime();
    const repoUrl = getRepoUrl();

    // Smithery 服务器若没有任何配置项，ConfigForm 会渲染「无需配置」空态；
    // 此时上方的「安装前请配置服务器设置」与之语义矛盾，需要一并隐藏。
    const hideConfigDescription =
        isSmitheryDetail(server) &&
        Object.keys(server.connection?.configSchema?.properties || {}).length === 0;

    return (
        <div className="flex flex-col h-full bg-[var(--color-bg)]">
            {/* 头部导航 - 参考 SkillDetail 风格 */}
            <div className={`flex items-center gap-2 px-4 py-2 drag-region relative border-b border-[var(--color-border)] text-[12px] text-[var(--color-muted)] ${isMac ? 'ps-20' : 'pe-[140px]'}`}>
                <button onClick={() => navigate(-1)} className="no-drag hover:text-[var(--color-text)] transition-colors">
                    <BackIcon className="w-4 h-4"/>
                </button>
                <span className="no-drag hover:text-[var(--color-text)] cursor-pointer" onClick={() => navigate('/store')}>Store</span>
                <span>/</span>
                <span
                    className="no-drag hover:text-[var(--color-text)] cursor-pointer">Smithery</span>
                <span>/</span>
                <span className="text-[var(--color-text)]">{server.displayName}</span>
                <WindowControls />
            </div>

            {/* 内容区域 - 左右布局 */}
            <div className="flex-1 overflow-hidden flex">
                {/* 左侧主内容 */}
                <div className="flex-1 overflow-y-auto">
                    <div className="p-6">
                        {/* 标题区域 */}
                        <div className="mb-6">
                            <div className="flex items-start gap-4 mb-3">
                                {/* 图标 */}
                                <div className="flex-shrink-0">
                                    {server.iconUrl && !iconError ? (
                                        <img
                                            src={server.iconUrl}
                                            alt={server.displayName}
                                            className="w-12 h-12 rounded-xl object-cover"
                                            onError={() => setIconError(true)}
                                        />
                                    ) : (
                                        <DefaultIcon name={server.displayName} repoUrl={repoUrl}/>
                                    )}
                                </div>

                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <h1 className="text-2xl font-bold text-[var(--color-text)]">{server.displayName}</h1>
                                        {isSmitheryDetail(server) && server.verified && (
                                            <VerifiedIcon className="w-5 h-5 text-[var(--color-accent)]"/>
                                        )}
                                    </div>
                                    <p className="text-[12px] text-[var(--color-muted)] font-mono">{server.id}</p>
                                </div>
                            </div>

                            <p className="text-[14px] text-[var(--color-muted2)] leading-relaxed mb-4">
                                {server.description || t('detail.noDescription')}
                            </p>

                            {/* 统计信息 - 与 Skill 详情页风格一致 */}
                            <div className="flex items-center gap-4 text-[13px] text-[var(--color-muted2)]">
                                {isSmitheryDetail(server) && (
                                    <>
                    <span className="flex items-center gap-1">
                      <DownloadIcon className="w-4 h-4"/>
                        {formatNumber(server.downloads || 0)} Downloads
                    </span>
                                        {server.createdAt && (
                                            <span className="flex items-center gap-1">
                        <ClockIcon className="w-4 h-4 text-[var(--color-muted)]"/>
                        Created {formatDate(server.createdAt)}
                      </span>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>

                        {/* 运行时警告 */}
                        {!runtimeAvailable && (
                            <div className="card p-4 border-[#ff9f0a]/30 bg-[#ff9f0a]/5 mb-6">
                                <div className="flex items-start gap-3">
                                    <span
                                        className="text-xl">{runtime === 'node' ? '⬢' : runtime === 'python' ? '🐍' : '🐳'}</span>
                                    <div className="flex-1">
                                        <h3 className="text-[13px] font-semibold text-[#ff9f0a] mb-1">
                                            {t('detail.runtimeRequired')}
                                        </h3>
                                        <p className="text-[12px] text-[var(--color-muted2)] mb-3">
                                            {t('detail.runtimeRequiredDesc', {
                                                runtime: runtime === 'node' ? 'Node.js' : runtime === 'python' ? 'Python' : 'Docker'
                                            })}
                                        </p>
                                        <div className="space-y-2">
                                            {runtime === 'node' && (
                                                <>
                                                    <div className="bg-[var(--color-bg)] rounded-lg p-2">
                                                        <p className="text-[12px] text-[var(--color-muted)] mb-1">macOS
                                                            (Homebrew)</p>
                                                        <code className="text-[12px] text-[var(--color-accent)] font-mono">brew
                                                            install node</code>
                                                    </div>
                                                    <div className="bg-[var(--color-bg)] rounded-lg p-2">
                                                        <p className="text-[12px] text-[var(--color-muted)] mb-1">Windows</p>
                                                        <code className="text-[12px] text-[var(--color-accent)] font-mono">winget
                                                            install OpenJS.NodeJS</code>
                                                    </div>
                                                </>
                                            )}
                                            {runtime === 'python' && (
                                                <>
                                                    <div className="bg-[var(--color-bg)] rounded-lg p-2">
                                                        <p className="text-[12px] text-[var(--color-muted)] mb-1">macOS
                                                            (Homebrew)</p>
                                                        <code className="text-[12px] text-[var(--color-accent)] font-mono">brew
                                                            install python</code>
                                                    </div>
                                                    <div className="bg-[var(--color-bg)] rounded-lg p-2">
                                                        <p className="text-[12px] text-[var(--color-muted)] mb-1">uv
                                                            (recommended)</p>
                                                        <code className="text-[12px] text-[var(--color-accent)] font-mono">curl
                                                            -LsSf https://astral.sh/uv/install.sh | sh</code>
                                                    </div>
                                                </>
                                            )}
                                            {runtime === 'docker' && (
                                                <div className="bg-[var(--color-bg)] rounded-lg p-2">
                                                    <p className="text-[12px] text-[var(--color-muted)] mb-1">Docker Desktop</p>
                                                    <a
                                                        href="#"
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            api.system.openExternal('https://www.docker.com/products/docker-desktop/');
                                                        }}
                                                        className="text-[12px] text-[var(--color-accent)] font-mono hover:underline"
                                                    >
                                                        https://docker.com/products/docker-desktop/
                                                    </a>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* 功能列表 (Smithery 数据源) */}
                        {isSmitheryDetail(server) && server.capabilities && server.capabilities.length > 0 && (
                            <div className="card overflow-hidden mb-6">
                                <div className="px-4 py-3 border-b border-[var(--color-border)]">
                                    <h2 className="text-[13px] font-semibold text-[var(--color-text)]">
                                        {t('detail.capabilities')} ({server.capabilities?.length ?? 0})
                                    </h2>
                                </div>
                                {(server.capabilities ?? []).map((cap, index) => (
                                    <div
                                        key={index}
                                        className={`px-4 py-3 ${index !== (server.capabilities ?? []).length - 1 ? 'border-b border-[var(--color-border)]' : ''}`}
                                    >
                                        <h4 className="text-[12px] font-mono text-[var(--color-accent)] mb-0.5">{cap.name}</h4>
                                        <p className="text-[12px] text-[var(--color-muted)]">{cap.description || t('detail.noToolDescription')}</p>
                                    </div>
                                ))}
                            </div>
                        )}


                    </div>
                </div>

                {/* 右侧边栏 */}
                <div className="w-[280px] flex-shrink-0 border-s border-[var(--color-border)] overflow-y-auto p-4">
                    {/* 安装按钮 */}
                    <div className="mb-4 space-y-2">
                        {runtimeAvailable && (
                            <button
                                onClick={() => setShowConfigModal(true)}
                                className="w-full btn btn-primary text-[13px]"
                            >
                                {installedClients.length > 0 ? t('detail.installMore') : t('detail.install')}
                            </button>
                        )}
                        {installedClients.length > 0 && (
                            <button
                                onClick={() => handleUninstall()}
                                disabled={isUninstalling}
                                className="w-full btn btn-danger text-[13px]"
                            >
                                {isUninstalling ? t('common.loading') : t('detail.uninstallAll')}
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
                                        <span
                                            key={clientId}
                                            className="flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--color-surface-hover)] text-[12px] text-[var(--color-muted2)]"
                                        >
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

                        {isSmitheryDetail(server) && server.links?.registry && (
                            <a
                                href="#"
                                onClick={(e) => {
                                    e.preventDefault();
                                    api.system.openExternal(server.links?.registry ?? '');
                                }}
                                className="flex items-center justify-between text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-accent)] transition-colors"
                            >
                <span className="flex items-center gap-2">
                  <GitHubIcon className="w-4 h-4"/>
                  Smithery Registry
                </span>
                                <ExternalLinkIcon className="w-3.5 h-3.5"/>
                            </a>
                        )}

                        {isSmitheryDetail(server) && server.links?.homepage && (
                            <a
                                href="#"
                                onClick={(e) => {
                                    e.preventDefault();
                                    api.system.openExternal(server.links?.homepage ?? '');
                                }}
                                className="flex items-center justify-between text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-accent)] transition-colors"
                            >
                <span className="flex items-center gap-2">
                  <ExternalLinkIcon className="w-4 h-4"/>
                  Homepage
                </span>
                                <ExternalLinkIcon className="w-3.5 h-3.5"/>
                            </a>
                        )}
                    </div>

                    {/* Details 卡片 */}
                    <div className="card p-4 mb-4">
                        <h3 className="text-[13px] font-semibold text-[var(--color-text)] mb-3">Details</h3>
                        <div className="space-y-2 text-[12px]">
                            <div className="flex justify-between">
                                <span className="text-[var(--color-muted)]">Runtime</span>
                                <div className="flex items-center gap-1">
                                    <span
                                        className={`w-2 h-2 rounded-full ${runtimeAvailable ? 'bg-[#34c759]' : 'bg-[#ff9f0a]'}`}/>
                                    <span className="text-[var(--color-text)] capitalize">{runtime}</span>
                                </div>
                            </div>

                            {isSmitheryDetail(server) && (
                                <>
                                    <div className="flex justify-between">
                                        <span className="text-[var(--color-muted)]">Downloads</span>
                                        <span className="text-[var(--color-text)]">{formatNumber(server.downloads || 0)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-[var(--color-muted)]">Verified</span>
                                        <span className="text-[var(--color-text)]">{server.verified ? 'Yes' : 'No'}</span>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* 配置模态框 */}
            <Modal
                isOpen={showConfigModal}
                onClose={() => {
                    setShowConfigModal(false);
                    setInstallError(null);
                }}
                title={t('detail.configTitle')}
                size="lg"
            >
                <div className="space-y-4">
                    {installError && (
                        <div
                            className="p-3 rounded-md bg-[#ff3b30]/10 border border-[#ff3b30]/20 text-[#ff3b30] text-[12px]">
                            {installError}
                        </div>
                    )}

                    {/* Server 信息头部 - 与 Skills 安装弹窗一致 */}
                    <div className="flex items-center gap-3 p-3 bg-[var(--color-surface-hover)]/30 rounded-lg">
                        {server.iconUrl && !iconError ? (
                            <img
                                src={server.iconUrl}
                                alt={server.displayName}
                                className="w-10 h-10 rounded-lg object-cover"
                                onError={() => setIconError(true)}
                            />
                        ) : (
                            <DefaultIcon name={server.displayName} repoUrl={repoUrl}/>
                        )}
                        <div>
                            <h3 className="text-[14px] font-medium text-[var(--color-text)]">{server.displayName}</h3>
                            <p className="text-[12px] text-[var(--color-muted)]">{server.id}</p>
                        </div>
                    </div>

                    {/* 客户端选择 - 只展示已安装的 Client */}
                    <div>
                        <label className="block text-[12px] font-medium text-[var(--color-text)] mb-2">
                            {t('detail.selectClients')}
                        </label>
                        <ClientMultiSelect
                            clients={clients.filter(client => client.installed && client.supportsMcp)}
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
                            unselectedClass="bg-[var(--color-surface-hover)] border-[var(--color-border)] text-[var(--color-text)] hover:border-[#636366]"
                        />

                        {clients.filter(c => c.installed && c.supportsMcp).length === 0 && (
                            <p className="text-center text-[var(--color-muted)] text-[13px] py-4">
                                {t('detail.noClientsInstalled') || 'No installed clients support MCP'}
                            </p>
                        )}
                    </div>

                    {/* 配置表单 */}
                    {selectedClients.filter(c => !installedClients.includes(c)).length > 0 && (
                        <>
                            {!hideConfigDescription && (
                                <div className="border-t border-[var(--color-border)] pt-4">
                                    <p className="text-[12px] text-[var(--color-muted2)] mb-4">
                                        {t('detail.configDescription')}
                                    </p>
                                </div>
                            )}

                            {/* Smithery 配置表单 */}
                            {isSmitheryDetail(server) && (
                                <ConfigForm
                                    schema={server.connection?.configSchema || {
                                        type: 'object',
                                        properties: {},
                                        required: []
                                    }}
                                    onSubmit={handleSmitheryInstall}
                                    onCancel={() => {
                                        setShowConfigModal(false);
                                        setInstallError(null);
                                    }}
                                    isLoading={isInstalling}
                                />
                            )}
                        </>
                    )}
                </div>
            </Modal>
        </div>
    );
}
