/**
 * 设置页面 - Surge 风格
 */

import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {type AllRuntimes, type ClientInfo, type SkillClientType, useElectronAPI} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import {clearCache} from '../api/registry';
import ClientIcon from '../components/ClientIcon';
import RuntimeIcon from '../components/RuntimeIcon';
import Modal from '../components/Modal';
import {toast} from '../components/Toast';
import mcpDockIcon from '../../assets/icons/mcp-dock.svg';
import TokenManager from '../components/TokenManager';
import ConnectionManager from '../components/ConnectionManager';
import McpSourceManager from '../components/McpSourceManager';
import CloudSyncManager from '../components/CloudSyncManager';
import WindowControls from '../components/WindowControls';
import {type ThemeMode, useStore} from '../store/useStore';
import {useActivationStore} from '../store/activationStore';
import {BUILD_FLAGS} from '../build-flags';
import {ensureLanguageLoaded, SUPPORTED_LANGUAGES} from '../i18n';

export default function Settings() {
    const {t, i18n} = useTranslation();
    const api = useElectronAPI();
    const isMac = useIsMac();

    // 云同步入口：免费版1 恒显（组件内部自行呈现锁态）；免费版2 默认隐藏，激活且拥有
    // cloud_sync 权益时恢复显示；硬砍模式（cloudSyncActivationUnlocks=false）对激活用户
    // 也保持隐藏——主进程 IPC 按同一 flag 短路，UI 显示会形成死路入口
    const cloudSyncEntitled = useActivationStore((s) => s.hasFeature('cloud_sync'));
    const cloudSyncEntryVisible = BUILD_FLAGS.cloudSyncEnabled
        || (BUILD_FLAGS.cloudSyncActivationUnlocks && cloudSyncEntitled);


    const [runtimes, setRuntimes] = useState<AllRuntimes | null>(null);
    const [clients, setClients] = useState<ClientInfo[]>([]);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isInitialLoading, setIsInitialLoading] = useState(true);
    const [version, setVersion] = useState('');

    // 配置弹窗状态
    const [editingClient, setEditingClient] = useState<ClientInfo | null>(null);
    const [editMcpPath, setEditMcpPath] = useState('');
    const [editSkillsPath, setEditSkillsPath] = useState('');

    // 未安装客户端折叠状态
    const [showUninstalled, setShowUninstalled] = useState(false);

    // 添加客户端弹窗状态
    const [addingClient, setAddingClient] = useState(false);
    const [addName, setAddName] = useState('');
    const [addConfigPath, setAddConfigPath] = useState('');
    const [addSupportsSkills, setAddSupportsSkills] = useState(false);
    const [addSkillsPath, setAddSkillsPath] = useState('');

    // 关于弹窗
    const [showAbout, setShowAbout] = useState(false);

    // 在线更新（plan-19.0）：状态由主进程 autoUpdater 事件推送
    const [update, setUpdate] = useState<{
        state: string;
        version?: string;
        percent?: number;
        message?: string;
        currentVersion?: string;
    }>({state: 'idle'});

    useEffect(() => {
        const off = api.updater.onStatus(st => setUpdate(prev => ({...prev, ...st})));
        api.updater.getStatus().then(st => setUpdate(prev => ({...prev, ...st}))).catch(() => {});
        return off;
    }, [api]);

    const handleCheckUpdate = () => {
        setUpdate(prev => ({...prev, state: 'checking'}));
        void api.updater.check();
    };
    const handleDownloadUpdate = () => {
        void api.updater.download();
    };
    const handleQuitInstall = () => {
        void api.updater.quitAndInstall();
    };
    const openDownloadPage = () => {
        void api.system.openExternal('https://www.ywhome.top');
    };

    useEffect(() => {
        loadData(true);
    }, [api]);

    const loadData = async (isInitial = false) => {
        try {
            const [runtimeInfo, clientList, appVersion] = await Promise.all([
                api.env.getAllRuntimes(),
                api.clients.getAll(true),
                api.system.getVersion(),
            ]);
            setRuntimes(runtimeInfo);
            // 显示所有受支持的客户端（含未安装的）。cloud / agent-skills 是「仅 Skill」的虚拟客户端：
            // 云端存储在「云同步」卡片单独配置；agent-skills（.agents 统一标准）没有 MCP 配置文件，
            // 但作为技能载体需要在设置页可见、可配 Skills 路径。
            setClients(clientList.filter(c => c.supportsMcp || c.id === 'agent-skills'));
            setVersion(appVersion);
        } catch (error) {
            console.error('Failed to load settings data:', error);
        } finally {
            if (isInitial) {
                setIsInitialLoading(false);
            }
        }
    };

    // 刷新数据（带动效）
    const handleRefresh = async () => {
        setIsRefreshing(true);
        const startTime = Date.now();

        try {
            const [runtimeInfo, clientList, appVersion] = await Promise.all([
                api.env.getAllRuntimes(),
                api.clients.getAll(true),
                api.system.getVersion(),
            ]);

            // 确保动画至少持续2秒
            const elapsed = Date.now() - startTime;
            if (elapsed < 2000) {
                await new Promise(resolve => setTimeout(resolve, 2000 - elapsed));
            }

            setRuntimes(runtimeInfo);
            // 显示所有受支持的客户端（含未安装的）。cloud / agent-skills 是「仅 Skill」的虚拟客户端：
            // 云端存储在「云同步」卡片单独配置；agent-skills（.agents 统一标准）没有 MCP 配置文件，
            // 但作为技能载体需要在设置页可见、可配 Skills 路径。
            setClients(clientList.filter(c => c.supportsMcp || c.id === 'agent-skills'));
            setVersion(appVersion);
            toast.success(t('settings.refreshed') || 'Settings refreshed');
        } catch (error) {
            console.error('Failed to refresh settings data:', error);
            toast.error(t('settings.refreshFailed') || 'Failed to refresh');
        } finally {
            setIsRefreshing(false);
        }
    };

    /** MCP / Skill 源增删改后清缓存，让 Store 页重新拉取列表 */
    const handleSourcesChanged = () => {
        clearCache();
    };

    const handleLanguageChange = (lang: string) => {
        // 首次切到某语言时按需动态加载其语言包（避免首屏打包全部 locale）
        ensureLanguageLoaded(lang).then((lng) => {
            i18n.changeLanguage(lng);
        });
        localStorage.setItem('language', lang);
    };

    // 打开配置弹窗
    const openEditModal = (client: ClientInfo) => {
        setEditingClient(client);
        setEditMcpPath(client.configPath || '');
        setEditSkillsPath(client.skillsPath || '');
    };

    // 保存配置
    const saveClientConfig = async () => {
        if (!editingClient) return;

        try {
            // 保存 MCP Config 路径（「仅 Skill」虚拟客户端如 agent-skills 无 MCP 配置，不写）
            if (editingClient.supportsMcp && editMcpPath !== editingClient.configPath) {
                await api.clients.setCustomPath(editingClient.id, editMcpPath || null);
            }

            // 保存 Skills 目录（如果支持）
            if (editingClient.supportsSkills && editSkillsPath !== editingClient.skillsPath) {
                await api.clients.setCustomSkillsPath(editingClient.id as SkillClientType, editSkillsPath || null);
            }

            await loadData();
            setEditingClient(null);
        } catch (error) {
            console.error('Failed to save client config:', error);
        }
    };

    // 添加自定义客户端
    const handleAddClient = async () => {
        if (!addName.trim() || !addConfigPath.trim()) {
            toast.error(t('settings.addClientRequire') || 'Please enter both name and config path');
            return;
        }
        try {
            const def = await api.clients.addCustom({
                name: addName.trim(),
                configPath: addConfigPath.trim(),
                supportsSkills: addSupportsSkills,
                skillsPath: addSupportsSkills ? addSkillsPath.trim() || undefined : undefined,
            });
            // 双保险：直接更新本地列表，避免依赖后端缓存时序
            setClients(prev => [
                ...prev.filter(c => c.id !== def.id && c.id !== 'cloud'),
                {
                    id: def.id,
                    name: def.name,
                    installed: true,
                    configPath: def.configPath,
                    configExists: false,
                    supportsSkills: def.supportsSkills,
                    supportsMcp: true,
                    skillsPath: def.supportsSkills ? def.skillsPath : undefined,
                    isCustom: true,
                },
            ]);
            setAddingClient(false);
            setAddName('');
            setAddConfigPath('');
            setAddSupportsSkills(false);
            setAddSkillsPath('');
            toast.success(t('settings.clientAdded') || 'Client added');
        } catch (error) {
            console.error('Failed to add client:', error);
            const msg = error instanceof Error ? error.message : '';
            if (msg.startsWith('DUPLICATE_CLIENT_NAME:')) {
                toast.error(t('settings.addClientDuplicate') || 'A client with this name already exists');
            } else {
                toast.error(t('settings.addClientFailed') || 'Failed to add client');
            }
        }
    };

    // 删除自定义客户端
    const handleRemoveClient = async (id: string) => {
        try {
            await api.clients.removeCustom(id);
            // 双保险：立即从本地列表移除
            setClients(prev => prev.filter(c => c.id !== id));
            toast.success(t('settings.clientRemoved') || 'Client removed');
        } catch (error) {
            console.error('Failed to remove client:', error);
        }
    };

    const currentLang = i18n.language;

    // 主题（浅色 / 暗色 / 自动随系统）
    const theme = useStore((s) => s.theme);
    const setTheme = useStore((s) => s.setTheme);
    const handleThemeChange = (mode: ThemeMode) => setTheme(mode);

    return (
        <div className="flex flex-col h-full bg-[var(--color-bg)]">
            {/* 头部（一体化标题栏：mac 上兼作拖拽区并为交通灯留白） */}
            <div
                className={`flex items-center px-4 h-[38px] drag-region relative border-b border-[var(--color-border)] bg-[var(--color-bg)] ${isMac ? 'ps-20' : 'pe-[140px]'}`}>
                <h1 className="text-[14px] font-semibold text-[var(--color-text)] tracking-tight no-drag">
                    {t('settings.title')}
                </h1>
                <WindowControls />
            </div>

            {/* 内容 */}
            <div className="flex-1 overflow-y-auto">
                <div className="p-4 space-y-4">
                    {/* 语言设置 */}
                    <div className="card p-4">
                        <h2 className="text-[13px] font-semibold text-[var(--color-text)] mb-1">
                            {t('settings.language')}
                        </h2>
                        <p className="text-[12px] text-[var(--color-muted2)] mb-3">
                            {t('settings.languageDesc')}
                        </p>

                        {/* 9 种语言：G8 主要语种 + 联合国六大官方语言（去重）。
                            选项一律显示母语写法，避免用户看不懂自己要选的语言。 */}
                        <select
                            value={SUPPORTED_LANGUAGES.some(l => l.code === currentLang) ? currentLang : 'en'}
                            onChange={(e) => handleLanguageChange(e.target.value)}
                            className="w-full px-3 py-2 rounded-md text-[13px] bg-[var(--color-surface-hover)] text-[var(--color-text)] border border-[var(--color-border)] outline-none cursor-pointer"
                        >
                            {SUPPORTED_LANGUAGES.map((l) => (
                                <option key={l.code} value={l.code}>
                                    {l.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* 主题设置 */}
                    <div className="card p-4">
                        <h2 className="text-[13px] font-semibold text-[var(--color-text)] mb-1">
                            {t('settings.theme')}
                        </h2>
                        <p className="text-[12px] text-[var(--color-muted2)] mb-3">
                            {t('settings.themeDesc')}
                        </p>

                        <div className="flex gap-2">
                            {(['light', 'dark', 'auto'] as ThemeMode[]).map((mode) => (
                                <button
                                    key={mode}
                                    onClick={() => handleThemeChange(mode)}
                                    className={`
                  flex-1 px-3 py-2 rounded-md text-[13px] font-medium transition-colors
                  ${theme === mode
                                        ? 'bg-[var(--color-accent)] text-white'
                                        : 'bg-[var(--color-surface-hover)] text-[var(--color-muted2)] hover:text-[var(--color-text)]'
                                    }
                `}
                                >
                                    {t(`settings.theme_${mode}`)}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 客户端配置 */}
                    <div className="card overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
                            <div>
                                <h2 className="text-[13px] font-semibold text-[var(--color-text)]">
                                    {t('settings.clients') || 'Supported Clients'}
                                </h2>
                                <p className="text-[12px] text-[var(--color-muted)] mt-0.5">
                                    {t('settings.clientsDesc')}
                                </p>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <button
                                    onClick={handleRefresh}
                                    disabled={isRefreshing}
                                    className="p-1.5 rounded text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50"
                                >
                                    <svg
                                        className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
                                    </svg>
                                </button>
                            </div>
                        </div>

                        {isInitialLoading && clients.length === 0 ? (
                            <div className="p-4">
                                <div className="grid grid-cols-2 gap-2">
                                    {Array.from({length: 4}).map((_, index) => (
                                        <div key={index}
                                             className="flex items-center gap-2.5 p-2.5 rounded-lg bg-[var(--color-surface-hover)]/30 animate-pulse">
                                            <div className="w-7 h-7 rounded-md bg-[var(--color-surface-hover)] flex-shrink-0"/>
                                            <div className="flex-1 space-y-1.5">
                                                <div className="h-3.5 w-16 bg-[var(--color-surface-hover)] rounded"/>
                                                <div className="h-2.5 w-24 bg-[var(--color-surface-hover)] rounded"/>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <>
                                {/* 已安装客户端 - 网格布局 */}
                                {clients.filter(c => c.installed).length > 0 && (
                                    <div className="p-3">
                                        <div className="grid grid-cols-2 gap-2">
                                            {clients.filter(c => c.installed).map(client => (
                                                <div
                                                    key={client.id}
                                                    className="group flex items-center gap-2.5 p-2.5 rounded-lg bg-[var(--color-surface-hover)]/40 hover:bg-[var(--color-surface-hover)]/60 transition-colors"
                                                >
                                                    <div className="relative flex-shrink-0">
                                                        <ClientIcon clientId={client.id} size={28}/>
                                                        {client.configExists ? (
                                                            <span
                                                                title={t('settings.configured') || '已配置 MCP'}
                                                                className="absolute -bottom-0.5 -end-0.5 w-2.5 h-2.5 rounded-full bg-[#34c759] border-2 border-[var(--color-surface)]"
                                                            />
                                                        ) : (
                                                            <span
                                                                title={t('settings.notConfigured') || '已安装，尚未配置 MCP'}
                                                                className="absolute -bottom-0.5 -end-0.5 w-2.5 h-2.5 rounded-full bg-[var(--color-border)] border-2 border-[var(--color-surface)]"
                                                            />
                                                        )}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-1.5">
                                                            <span
                                                                className="text-[12px] font-medium text-[var(--color-text)] truncate">{client.name}</span>
                                                            {client.supportsSkills && (
                                                                <span
                                                                    title={t('settings.skillCapable') || 'Supports Skills'}
                                                                    className="flex-shrink-0 px-1 py-0.5 rounded bg-[var(--color-accent)]/12 text-[var(--color-accent)] text-[9px] font-semibold leading-none"
                                                                >✦</span>
                                                            )}
                                                        </div>
                                                        <code
                                                            className="text-[9px] text-[var(--color-muted)] font-mono truncate block">
                                                            {client.configPath?.replace(/^.*[/\\]/, '') || ''}
                                                        </code>
                                                    </div>
                                                    <div className="flex items-center gap-0.5">
                                                        <button
                                                            onClick={() => openEditModal(client)}
                                                            className="p-1 rounded text-[var(--color-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-all"
                                                            title={t('settings.editPath') || 'Edit config path'}
                                                        >
                                                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24"
                                                                 stroke="currentColor" strokeWidth={2}>
                                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                                      d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>
                                                            </svg>
                                                        </button>
                                                        {client.isCustom && (
                                                            <button
                                                                onClick={() => handleRemoveClient(client.id)}
                                                                className="p-1 rounded text-[var(--color-muted)] opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-[var(--color-surface-hover)] transition-all"
                                                                title={t('settings.removeClient') || 'Remove client'}
                                                            >
                                                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24"
                                                                     stroke="currentColor" strokeWidth={2}>
                                                                    <path strokeLinecap="round" strokeLinejoin="round"
                                                                          d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>
                                                                </svg>
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* 未安装客户端 + 自定义客户端入口 - 可折叠区域，始终显示 */}
                                <>
                                        <button
                                            onClick={() => setShowUninstalled(!showUninstalled)}
                                            className="w-full flex items-center justify-between px-4 py-2.5 border-t border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]/30 transition-colors"
                                        >
                      <span className="text-[12px] text-[var(--color-muted)]">
                        {clients.filter(c => !c.installed).length > 0
                          ? (t('settings.uninstalledClients') || `${clients.filter(c => !c.installed).length} more clients not installed`)
                          : (t('settings.customClient') || 'Custom client')}
                      </span>
                                            <svg
                                                className={`w-3.5 h-3.5 text-[var(--color-muted)] transition-transform ${showUninstalled ? 'rotate-180' : ''}`}
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                      d="M19.5 8.25l-7.5 7.5-7.5-7.5"/>
                                            </svg>
                                        </button>

                                        {showUninstalled && (
                                            <div className="px-3 pb-3">
                                                <div className="grid grid-cols-3 gap-1.5">
                                                    {clients.filter(c => !c.installed).map(client => (
                                                        <div
                                                            key={client.id}
                                                            className="group flex items-center gap-2 px-2.5 py-2 rounded-md bg-[var(--color-surface-hover)]/20 hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                                                        >
                                                            <ClientIcon clientId={client.id} size={20}
                                                                        className="opacity-40 flex-shrink-0"/>
                                                            <span
                                                                className="text-[12px] text-[var(--color-muted)] truncate">{client.name}</span>
                                                            <button
                                                                onClick={() => openEditModal(client)}
                                                                className="ms-auto p-1 rounded text-[var(--color-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-all"
                                                                title={t('settings.editPath') || 'Edit config path'}
                                                            >
                                                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24"
                                                                     stroke="currentColor" strokeWidth={2}>
                                                                    <path strokeLinecap="round" strokeLinejoin="round"
                                                                          d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>
                                                                </svg>
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                                {/* 始终保留「自定义客户端」入口：点击打开发添加弹窗 */}
                                                <button
                                                    onClick={() => setAddingClient(true)}
                                                    className="mt-1.5 w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-md border border-dashed border-[var(--color-border)] text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-muted)] hover:bg-[var(--color-surface-hover)]/30 transition-colors"
                                                >
                                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15"/>
                                                    </svg>
                                                    {t('settings.customClient') || 'Custom client'}
                                                </button>
                                            </div>
                                        )}
                                    </>
                                </>
                            )}
                    </div>

                    {/* 运行时环境 */}
                    <div className="card overflow-hidden">
                        <div className="px-4 py-3 border-b border-[var(--color-border)]">
                            <h2 className="text-[13px] font-semibold text-[var(--color-text)]">
                                {t('settings.runtimes')}
                            </h2>
                            <p className="text-[12px] text-[var(--color-muted)] mt-0.5">
                                {t('settings.runtimesDesc')}
                            </p>
                        </div>

                        {isInitialLoading && !runtimes ? (
                            // 初始加载时显示骨架屏
                            <>
                                <div
                                    className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] animate-pulse">
                                    <div className="flex items-center gap-3">
                                        <div className="w-6 h-6 rounded bg-[var(--color-surface-hover)]"/>
                                        <div className="h-4 w-20 bg-[var(--color-surface-hover)] rounded"/>
                                    </div>
                                    <div className="h-4 w-12 bg-[var(--color-surface-hover)] rounded"/>
                                </div>
                                <div className="flex items-center justify-between px-4 py-3 animate-pulse">
                                    <div className="flex items-center gap-3">
                                        <div className="w-6 h-6 rounded bg-[var(--color-surface-hover)]"/>
                                        <div className="h-4 w-20 bg-[var(--color-surface-hover)] rounded"/>
                                    </div>
                                    <div className="h-4 w-12 bg-[var(--color-surface-hover)] rounded"/>
                                </div>
                            </>
                        ) : runtimes && (
                            <>
                                <RuntimeRow name="Node.js" runtime="node" info={runtimes.node}/>
                                <RuntimeRow name="Python" runtime="python" info={runtimes.python}/>
                                <RuntimeRow name="Git" runtime="git" info={runtimes.git} isLast/>
                            </>
                        )}
                    </div>

                    {/* API 令牌 */}
                    <TokenManager/>

                    {/* MCP 源管理 */}
                    <McpSourceManager onChanged={handleSourcesChanged}/>

                    {/* Skill 源管理 */}
                    <ConnectionManager onChanged={handleSourcesChanged}/>

                    {/* 云同步 */}
                    {cloudSyncEntryVisible && <CloudSyncManager runtimes={runtimes} onChanged={() => loadData()}/>}

                    {/* 关于 */}
                    <div
                        className="card p-4 cursor-pointer hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                        onClick={() => setShowAbout(true)}
                    >
                        <div className="flex items-center gap-3">
                            <img src={mcpDockIcon} alt="AI-Tools" className="w-10 h-10 rounded-lg"/>
                            <div>
                                <h3 className="text-[13px] font-semibold text-[var(--color-text)]">{t('settings.about')}</h3>
                                <p className="text-[12px] text-[var(--color-muted)]">{version ? `v${version}` : 'Loading...'}</p>
                            </div>
                            <svg className="ms-auto w-4 h-4 text-[var(--color-muted)]" fill="none" viewBox="0 0 24 24"
                                 stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/>
                            </svg>
                        </div>
                    </div>
                </div>
            </div>

            {/* 客户端配置弹窗 */}
            <Modal
                isOpen={!!editingClient}
                onClose={() => setEditingClient(null)}
                title={`${t('settings.editPath') || 'Edit'}: ${editingClient?.name || ''}`}
            >
                <div className="space-y-4">
                    <p className="text-[12px] text-[var(--color-muted2)]">
                        {t('settings.editPathHint') || 'Customize the configuration paths for this client.'}
                    </p>

                    {/* MCP Config 路径（仅支持 MCP 的客户端显示；agent-skills 等「仅 Skill」虚拟客户端无此概念） */}
                    {editingClient?.supportsMcp && (
                        <div>
                            <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">
                                {t('settings.mcpConfigPath')}
                            </label>
                            <input
                                type="text"
                                value={editMcpPath}
                                onChange={(e) => setEditMcpPath(e.target.value)}
                                className="w-full px-3 py-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] font-mono text-[12px] focus:border-[var(--color-accent)] transition-colors"
                                placeholder={t('settings.enterCustomPath') || 'Enter custom config path...'}
                            />
                        </div>
                    )}

                    {/* Skills 目录（仅支持 Skills 的客户端显示） */}
                    {editingClient?.supportsSkills && (
                        <div>
                            <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">
                                {t('settings.skillsDirectory')}
                            </label>
                            <input
                                type="text"
                                value={editSkillsPath}
                                onChange={(e) => setEditSkillsPath(e.target.value)}
                                className="w-full px-3 py-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] font-mono text-[12px] focus:border-[var(--color-accent)] transition-colors"
                                placeholder={t('settings.enterSkillsPath') || 'Enter custom skills directory...'}
                            />
                        </div>
                    )}

                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => setEditingClient(null)} className="btn btn-secondary">
                            {t('common.cancel')}
                        </button>
                        <button onClick={saveClientConfig} className="btn btn-primary">
                            {t('common.save')}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* 添加客户端弹窗 */}
            <Modal
                isOpen={addingClient}
                onClose={() => setAddingClient(false)}
                title={t('settings.addClient') || 'Add Custom Client'}
            >
                <div className="space-y-4">
                    <p className="text-[12px] text-[var(--color-muted2)]">
                        {t('settings.addClientHint') || 'Add a client by specifying its MCP config file path.'}
                    </p>

                    <div>
                        <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">
                            {t('settings.clientName') || 'Client Name'}
                        </label>
                        <input
                            type="text"
                            value={addName}
                            onChange={(e) => setAddName(e.target.value)}
                            className="w-full px-3 py-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] text-[12px] focus:border-[var(--color-accent)] transition-colors"
                            placeholder={t('settings.enterClientName') || 'My Client'}
                        />
                    </div>

                    <div>
                        <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">
                            {t('settings.mcpConfigPath')}
                        </label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={addConfigPath}
                                onChange={(e) => setAddConfigPath(e.target.value)}
                                className="flex-1 px-3 py-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] font-mono text-[12px] focus:border-[var(--color-accent)] transition-colors"
                                placeholder="/path/to/mcp.json"
                            />
                            <button
                                type="button"
                                onClick={async () => {
                                    const r = await api.dialog.selectDirectory();
                                    if (!r.canceled && r.path) setAddConfigPath(r.path);
                                }}
                                className="btn btn-secondary whitespace-nowrap"
                            >
                                {t('settings.browse') || 'Browse'}
                            </button>
                        </div>
                    </div>

                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={addSupportsSkills}
                            onChange={(e) => setAddSupportsSkills(e.target.checked)}
                            className="accent-[var(--color-accent)]"
                        />
                        <span className="text-[12px] text-[var(--color-muted2)]">
                            {t('settings.supportsSkillsLabel') || 'Supports Skills'}
                        </span>
                    </label>

                    {addSupportsSkills && (
                        <div>
                            <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">
                                {t('settings.skillsDirectory')}
                            </label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={addSkillsPath}
                                    onChange={(e) => setAddSkillsPath(e.target.value)}
                                    className="flex-1 px-3 py-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] font-mono text-[12px] focus:border-[var(--color-accent)] transition-colors"
                                    placeholder="/path/to/skills"
                                />
                                <button
                                    type="button"
                                    onClick={async () => {
                                        const r = await api.dialog.selectDirectory();
                                        if (!r.canceled && r.path) setAddSkillsPath(r.path);
                                    }}
                                    className="btn btn-secondary whitespace-nowrap"
                                >
                                    {t('settings.browse') || 'Browse'}
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => setAddingClient(false)} className="btn btn-secondary">
                            {t('common.cancel')}
                        </button>
                        <button onClick={handleAddClient} className="btn btn-primary">
                            {t('common.add')}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* 关于弹窗 */}
            <Modal
                isOpen={showAbout}
                onClose={() => setShowAbout(false)}
                title={t('settings.aboutTitle')}
            >
                <div className="flex flex-col items-center text-center">
                    <img src={mcpDockIcon} alt="AI-Tools" className="w-16 h-16 rounded-2xl mb-3"/>
                    <h3 className="text-[16px] font-semibold text-[var(--color-text)]">AI-Tools</h3>
                    <p className="text-[12px] text-[var(--color-muted2)] mt-0.5">{version ? `Version ${version}` : 'Loading...'}</p>
                    {/* 检查更新（plan-19.0）：状态由主进程推送 */}
                    <div className="w-full mt-4 p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-start">
                        <div className="flex items-center justify-between">
                            <p className="text-[12px] text-[var(--color-muted2)] font-medium">{t('update.title')}</p>
                            <p className="text-[12px] text-[var(--color-muted)]">{update.currentVersion ? `v${update.currentVersion}` : ''}</p>
                        </div>
                        <div className="mt-2 text-[12px] text-[var(--color-muted)]">
                            {(update.state === 'idle' || update.state === 'checking') && (
                                <button
                                    type="button"
                                    onClick={handleCheckUpdate}
                                    disabled={update.state === 'checking'}
                                    className="text-[var(--color-accent)] hover:underline disabled:opacity-50"
                                >
                                    {update.state === 'checking' ? t('update.checking') : t('update.check')}
                                </button>
                            )}
                            {update.state === 'available' && (
                                <div className="flex items-center justify-between gap-3">
                                    <span>{t('update.available', {version: update.version ? `v${update.version}` : ''})}</span>
                                    <button
                                        type="button"
                                        onClick={handleDownloadUpdate}
                                        className="text-[var(--color-accent)] hover:underline"
                                    >
                                        {t('update.downloadInstall')}
                                    </button>
                                </div>
                            )}
                            {update.state === 'downloading' && (
                                <div>{t('update.downloading', {percent: update.percent ? `${update.percent.toFixed(0)}%` : '…'})}</div>
                            )}
                            {update.state === 'downloaded' && (
                                <div className="flex items-center justify-between gap-3">
                                    <span>{t('update.ready')}</span>
                                    <button
                                        type="button"
                                        onClick={handleQuitInstall}
                                        className="text-[var(--color-accent)] hover:underline"
                                    >
                                        {t('update.restart')}
                                    </button>
                                </div>
                            )}
                            {update.state === 'not-available' && <span>{t('update.latest')}</span>}
                            {(update.state === 'error' || update.state === 'unsupported' || update.state === 'locked') && (
                                <div className="flex flex-col gap-1.5">
                                    <span>{update.message || t('update.failed')}</span>
                                    <button
                                        type="button"
                                        onClick={openDownloadPage}
                                        className="text-[var(--color-accent)] hover:underline text-start"
                                    >
                                        {t('update.manual')}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                    <p className="text-[12px] text-[var(--color-muted2)] mt-3 leading-relaxed">
                        {t('settings.aboutIntro')}
                    </p>
                    <div className="w-full mt-4 p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-start">
                        <p className="text-[12px] text-[var(--color-muted2)] font-medium">License</p>
                        <p className="text-[12px] text-[var(--color-muted)] mt-1.5 leading-relaxed break-all">
                            {t('settings.aboutLicense')}
                        </p>
                        <button
                            type="button"
                            onClick={() => { void api.system.openThirdPartyLicense(); }}
                            className="mt-2 block text-start text-[12px] text-[var(--color-accent)] hover:underline"
                        >
                            {t('settings.aboutThirdPartyLicense')}
                        </button>
                    </div>
                    <p className="text-[12px] text-[var(--color-muted)] mt-4 leading-relaxed whitespace-pre-line">
                        {t('settings.aboutCopyright')}
                    </p>
                    <a
                        href="mailto:qingchuang12@gmail.com"
                        className="mt-4 text-[12px] text-[var(--color-accent)] hover:underline"
                    >
                        {t('settings.aboutEmail')}
                    </a>
                </div>
            </Modal>
        </div>
    );
}

// 运行时行组件
function RuntimeRow({
                        name,
                        runtime,
                        info,
                        isLast = false,
                    }: {
    name: string;
    runtime: 'node' | 'python' | 'git';
    info: { available: boolean; version: string | null; path: string | null };
    isLast?: boolean;
}) {
    return (
        <div className={`flex items-center justify-between px-4 py-3 ${!isLast ? 'border-b border-[var(--color-border)]' : ''}`}>
            <div className="flex items-center gap-3">
                <RuntimeIcon runtime={runtime} size={24}/>
                <div>
                    <span className="text-[13px] font-medium text-[var(--color-text)]">{name}</span>
                    {info.path && (
                        <p className="text-[12px] text-[var(--color-muted)] font-mono truncate max-w-[200px]">
                            {info.path}
                        </p>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-2">
                {info.available ? (
                    <>
            <span className="text-[12px] text-[var(--color-muted2)]">
              v{info.version}
            </span>
                        <span className="status-dot active"/>
                    </>
                ) : (
                    <span className="status-dot inactive"/>
                )}
            </div>
        </div>
    );
}
