/**
 * Electron Preload 脚本类型定义
 */

export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    /** 第三方 server 许可证标识（npm 来源）。Phase 6 合规汇总用。 */
    license?: string;
    /** 来源平台标识（如 'npm'）。 */
    source?: string;
    /** 来源主页 URL。 */
    homepage?: string;
}

export interface RuntimeInfo {
    available: boolean;
    version: string | null;
    path: string | null;
}

export interface AllRuntimes {
    node: RuntimeInfo;
    python: RuntimeInfo;
    npx: RuntimeInfo;
    uvx: RuntimeInfo;
    /** git：云同步的 Git 通道依赖系统 git CLI */
    git: RuntimeInfo;
}

export interface BackupInfo {
    timestamp: string;
    filename: string;
    size: number;
    serverCount: number;
}

export interface DiffResult {
    added: string[];
    removed: string[];
    modified: string[];
    current: any;
    backup: any;
    skillsAdded: string[];
    skillsRemoved: string[];
    /** 内容发生变更的 Skill 名；仅当前后两条备份都含 skillContents 时才可能有值 */
    skillsModified: string[];
    /** 客户端级变更（按客户端分别比对，识别「从多客户端之一移除」等单客户端变更） */
    clientChanges?: { client: string; added: string[]; removed: string[]; modified: string[] }[];
    /** Skills 客户端级变更；modified 为「内容变更」（名字未变、SKILL.md 变了） */
    skillClientChanges?: { client: string; added: string[]; removed: string[]; modified: string[] }[];
}

// 客户端类型统一从主进程 config-manager 引入，避免多端重复定义导致类型不兼容
import type {ClientInfo, ClientType, SkillClientType} from '../main/config-manager';
// 云同步类型统一从 shared 引入
import type {CloudSyncConfig, CloudSyncConfigInput, CloudSyncResult} from '../shared/cloud-sync-constants';

export type {ClientType, SkillClientType, ClientInfo};

// Skills 相关类型
export interface SkillSourceMeta {
    id: string;
    installedAt: string;
    updatedAt: string;
    source: {
        repositoryUrl: string;
        branch: string;
        skillPath: string;
        rawBaseUrl: string;
    };
    files: string[];
}

export interface InstalledSkill {
    name: string;
    path: string;
    source: SkillSourceMeta | null;
    hasUpdate?: boolean;
}

export interface SkillInstallResult {
    success: boolean;
    error?: string;
}

export interface SkillSyncResult {
    success: SkillClientType[];
    failed: SkillClientType[];
    errors: Record<string, string>;
}

export interface SkillBatchSyncResult {
    synced: number;
    failed: number;
    details: Array<{
        name: string;
        success: SkillClientType[];
        failed: SkillClientType[];
    }>;
}

export interface SkillCloudConflict {
    name: string;
    localUpdatedAt: string | null;
    cloudUpdatedAt: string | null;
    resolution: 'local_newer' | 'cloud_newer' | 'same';
}

export interface DiscoveredSkill {
    name: string;
    path: string;
    skillMdUrl: string;
    skillMdContent: string;
    files: Array<{ name: string; path: string; rawUrl: string }>;
    repository: {
        url: string;
        branch: string;
        owner: string;
        repo: string;
    };
    downloadUrl?: string;
}

export interface ImportParseResult {
    success: boolean;
    skills: DiscoveredSkill[];
    error?: string;
}

export interface AllSkillsResult {
    skills: Record<string, { name: string; clients: SkillClientType[] }>;
    byClient: Record<SkillClientType, InstalledSkill[]>;
}

export type {CloudSyncConfig, CloudSyncConfigInput, CloudSyncResult};

export interface InstallResult {
    success: ClientType[];
    failed: ClientType[];
}

export interface AllServersResult {
    servers: Record<string, { config: McpServerConfig; clients: ClientType[] }>;
    byClient: Record<ClientType, Record<string, McpServerConfig>>;
}

export interface McpTool {
    name: string;
    description?: string;
    inputSchema?: {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

declare const api: {
    clients: {
        getAll: () => Promise<ClientInfo[]>;
        setCustomPath: (client: ClientType, customPath: string | null) => Promise<void>;
        setCustomSkillsPath: (client: SkillClientType, customPath: string | null) => Promise<void>;
    };
    config: {
        read: (client?: ClientType) => Promise<any>;
        write: (config: any, client?: ClientType) => Promise<void>;
        getServers: (client?: ClientType) => Promise<Record<string, McpServerConfig>>;
        getAllServers: () => Promise<AllServersResult>;
        installServer: (serverId: string, serverConfig: McpServerConfig, clients: ClientType[]) => Promise<InstallResult>;
        uninstallServer: (serverId: string, clients: ClientType[]) => Promise<InstallResult>;
        updateServer: (serverId: string, serverConfig: McpServerConfig, client?: ClientType) => Promise<void>;
        markServerManual: (serverId: string) => Promise<void>;
        getManualServers: () => Promise<string[]>;
        syncServer: (serverId: string, sourceClient: ClientType, targetClients: ClientType[]) => Promise<InstallResult>;
        syncServersBatch: (items: {
            serverId: string;
            config: McpServerConfig
        }[], targetClients: ClientType[]) => Promise<{
            synced: number;
            failed: number;
            details: { serverId: string; success: ClientType[]; failed: ClientType[] }[]
        }>;
    };
    env: {
        checkRuntime: (runtime: 'node' | 'python') => Promise<RuntimeInfo>;
        getAllRuntimes: () => Promise<AllRuntimes>;
        getNpxPath: () => Promise<string>;
        getUvxPath: () => Promise<string>;
    };
    history: {
        list: () => Promise<BackupInfo[]>;
        getDiff: (timestamp: string) => Promise<DiffResult | null>;
        clearAll: () => Promise<boolean>;
    };
    system: {
        getPlatform: () => Promise<string>;
        getVersion: () => Promise<string>;
        openExternal: (url: string) => Promise<void>;
        openThirdPartyLicense: () => Promise<string>;
        getConfigPath: (client?: ClientType) => Promise<string>;
        openConfigDirectory: (client: ClientType) => Promise<string>;
        openSkillsDirectory: (client: SkillClientType) => Promise<string>;
    };
    skills: {
        getInstalled: (client: SkillClientType) => Promise<InstalledSkill[]>;
        getAllInstalled: () => Promise<AllSkillsResult>;
        install: (skillId: string, sourceInfo: SkillSourceMeta, clients: SkillClientType[]) => Promise<SkillInstallResult>;
        uninstall: (skillName: string, clients: SkillClientType[]) => Promise<void>;
        update: (skillName: string, client: SkillClientType) => Promise<{ updated: boolean; error?: string }>;
        updateAll: (client: SkillClientType) => Promise<{ updated: number; failed: number }>;
        isInstalled: (skillId: string) => Promise<boolean>;
        parseImportUrl: (url: string) => Promise<ImportParseResult>;
        installFromDiscovered: (skill: DiscoveredSkill, clients: SkillClientType[]) => Promise<SkillInstallResult>;
        /** 平台源（如虾评）安装：用连接绑定的令牌换下载直链后落盘 */
        installPlatformSkill: (connectionId: string, skillId: string, skillName: string, clients: SkillClientType[]) => Promise<SkillInstallResult>;
        getRemoteDetail: (githubPath: string) => Promise<{
            success: boolean;
            skill: DiscoveredSkill | null;
            error: string | null
        }>;
        sync: (skillName: string, sourceClient: SkillClientType, targetClients: SkillClientType[]) => Promise<SkillSyncResult>;
        syncBatch: (items: Array<{
            name: string;
            sourceClient: SkillClientType
        }>, targetClients: SkillClientType[]) => Promise<SkillBatchSyncResult>;
        checkCloudConflicts: (items: Array<{
            name: string;
            sourceClient: SkillClientType
        }>) => Promise<SkillCloudConflict[]>;
        syncToCloudResolved: (items: Array<{
            name: string;
            sourceClient: SkillClientType
        }>, resolutions: Record<string, 'overwrite' | 'skip'>) => Promise<SkillBatchSyncResult>;
    };
    cloudSync: {
        getConfig: () => Promise<CloudSyncConfig>;
        setConfig: (patch: CloudSyncConfigInput) => Promise<CloudSyncConfig>;
        test: () => Promise<CloudSyncResult>;
        push: () => Promise<CloudSyncResult>;
        pull: () => Promise<CloudSyncResult>;
    };
    mcp: {
        connect: (sessionId: string, config: {
            command: string;
            args?: string[];
            env?: Record<string, string>
        }) => Promise<{ success: boolean; serverInfo?: { name?: string; version?: string }; error?: string }>;
        disconnect: (sessionId: string) => Promise<{ success: boolean }>;
        isConnected: (sessionId: string) => Promise<boolean>;
        listTools: (sessionId: string) => Promise<{ success: boolean; tools?: McpTool[]; error?: string }>;
        callTool: (sessionId: string, name: string, args: Record<string, unknown>) => Promise<{
            success: boolean;
            result?: unknown;
            error?: string
        }>;
        listResources: (sessionId: string) => Promise<{ success: boolean; resources?: unknown[]; error?: string }>;
        listPrompts: (sessionId: string) => Promise<{ success: boolean; prompts?: unknown[]; error?: string }>;
        onStderr: (callback: (data: { sessionId: string; message: string }) => void) => () => void;
        onDisconnected: (callback: (data: { sessionId: string; code: number }) => void) => () => void;
        onError: (callback: (data: { sessionId: string; error: string }) => void) => () => void;
    };
    window: {
        minimize: () => void;
        toggleMaximize: () => void;
        close: () => void;
        isMaximized: () => Promise<boolean>;
        onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
    };
    theme: {
        onSystemThemeChange: (callback: (shouldUseDarkColors: boolean) => void) => () => void;
    };
};

export type ElectronAPI = typeof api;