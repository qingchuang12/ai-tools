import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router-dom';
import type {InstalledServer} from '../pages/Library';
import type {ServerListItem} from '../api/registry';
import type {ClientInfo} from '../lib/electron';
import ServerIcon from './ServerIcon';
import ClientIcon from './ClientIcon';
import LoadingSkeleton from './store/LoadingSkeleton';

interface LibraryMcpListProps {
    servers: InstalledServer[];
    serverInfoMap: Map<string, ServerListItem>;
    hasLoaded: boolean;
    serverSelectMode: boolean;
    selectedServers: string[];
    clients: ClientInfo[];
    onServerClick: (server: InstalledServer) => void;
    onOpenSync: (server: InstalledServer) => void;
    onEdit: (server: InstalledServer) => void;
    onUninstall: (type: 'mcp' | 'skill', id: string, displayName: string, clients: string[]) => void;
    onToggleSelect: (serverId: string) => void;
    getDisplayName: (id: string) => string;
}

export default function LibraryMcpList({
    servers,
    serverInfoMap,
    hasLoaded,
    serverSelectMode,
    selectedServers,
    clients,
    onServerClick,
    onOpenSync,
    onEdit,
    onUninstall,
    onToggleSelect,
    getDisplayName,
}: LibraryMcpListProps) {
    const {t} = useTranslation();
    const navigate = useNavigate();

    if (!hasLoaded) return <LoadingSkeleton/>;

    if (servers.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full">
                <div className="w-12 h-12 rounded-full bg-[var(--color-surface-hover)] flex items-center justify-center mb-3">
                    <svg className="w-6 h-6 text-[var(--color-muted)]" fill="none" viewBox="0 0 24 24"
                         stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round"
                              d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"/>
                    </svg>
                </div>
                <p className="text-[13px] text-[var(--color-text)] mb-1">{t('installed.empty')}</p>
                <p className="text-[12px] text-[var(--color-muted)] mb-4">{t('installed.emptyHint')}</p>
                <button onClick={() => navigate('/store')} className="btn btn-primary text-[13px]">
                    {t('installed.goToStore')}
                </button>
            </div>
        );
    }

    return (
        <div className="p-4">
            <div className="card overflow-hidden">
                {servers.map((server, index) => {
                    const serverInfo = serverInfoMap.get(server.id);
                    const isServerSelected = selectedServers.includes(server.id);
                    return (
                        <div
                            key={server.id}
                            className={`
                        flex items-center gap-3 px-4 py-3
                        ${serverSelectMode ? 'cursor-pointer' : server.isMcpDock ? 'cursor-pointer hover:bg-[var(--color-surface-hover)]/50' : ''}
                        transition-colors
                        ${index !== servers.length - 1 ? 'border-b border-[var(--color-border)]' : ''}
                        ${serverSelectMode && isServerSelected ? 'bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]' : ''}
                      `}
                            onClick={() => serverSelectMode ? onToggleSelect(server.id) : onServerClick(server)}
                        >
                            {/* 选择模式：复选框 */}
                            {serverSelectMode ? (
                                <div className="flex-shrink-0">
                          <span
                              className={`w-4 h-4 rounded border flex items-center justify-center ${isServerSelected ? 'bg-[var(--color-accent)] border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
                            {isServerSelected && (
                                <svg className="w-3 h-3 text-[var(--color-text)]" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd"
                                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                          clipRule="evenodd"/>
                                </svg>
                            )}
                          </span>
                                </div>
                            ) : (
                                <div className="flex-shrink-0">
                                    <ServerIcon server={server} serverInfo={serverInfo}/>
                                </div>
                            )}

                            {/* 内容 */}
                            <div className="flex-1 min-w-0">
                                <h3 className="text-[13px] font-medium text-[var(--color-text)] truncate">
                                    {getDisplayName(server.id)}
                                </h3>
                                {/* 已安装的客户端 */}
                                <div className="flex items-center gap-2 mt-1">
                                    {server.clients.map(clientId => (
                                        <span key={clientId}
                                              className="text-[12px] text-[var(--color-muted2)] flex items-center gap-1">
                              <ClientIcon clientId={clientId} size={14}/>
                                            {clients.find(c => c.id === clientId)?.name}
                            </span>
                                    ))}
                                </div>
                            </div>

                            {/* 操作按钮区域 - AI-Tools 标志在最左边 */}
                            {!serverSelectMode && (
                                <div className="flex items-center gap-2 flex-shrink-0"
                                     onClick={e => e.stopPropagation()}>
                                    {/* 来源标记 - 最左边：手动安装 > AI-Tools（从商店安装统一显示） */}
                                    {server.manual ? (
                                        <span
                                            className="tag tag-default">{t('library.manual') || 'Manual'}</span>
                                    ) : (
                                        <span className="tag tag-info">AI-Tools</span>
                                    )}

                                    {/* 操作按钮 */}
                                    <button
                                        onClick={() => {
                                            const config = server.config;
                                            const configStr = encodeURIComponent(JSON.stringify(config));
                                            navigate(`/inspector?config=${configStr}`);
                                        }}
                                        className="p-1.5 rounded text-[var(--color-muted2)] hover:text-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] transition-colors"
                                        title={t('installed.inspect') || 'Inspect'}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                             stroke="currentColor" strokeWidth={1.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                  d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z"/>
                                        </svg>
                                    </button>

                                    <button
                                        onClick={() => onEdit(server)}
                                        className="p-1.5 rounded text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
                                        title={t('installed.edit')}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                             stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                  d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>
                                        </svg>
                                    </button>

                                    {/* 同步到其他客户端（多客户端复用） */}
                                    <button
                                        onClick={() => onOpenSync(server)}
                                        className="p-1.5 rounded text-[var(--color-muted2)] hover:text-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] transition-colors"
                                        title={t('installed.sync') || 'Sync'}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                             stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                  d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"/>
                                        </svg>
                                    </button>

                                    <button
                                        onClick={() => onUninstall('mcp', server.id, getDisplayName(server.id), server.clients as string[])}
                                        className="p-1.5 rounded text-[var(--color-danger)] hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] transition-colors"
                                        title={t('installed.remove')}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                             stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                  d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>
                                        </svg>
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
