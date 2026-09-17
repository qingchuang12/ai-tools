/**
 * Electron API 类型定义和访问
 */

import type {TokenMeta, TokenScope} from '../../../main/secret-store';
import type {ApiConnection} from '../../../main/connections-store';
import type {
    DirectSearchDiagnostics,
    PlatformFacets,
    PlatformSearchPage,
    PlatformServerDetail,
    PlatformServerSearchPage,
    PlatformSkillListItem,
} from '../../../main/platforms/types';
// 客户端类型统一从主进程 config-manager 引入，避免渲染端重复定义导致类型不兼容
import type {AnyClientId, ClientInfo, ClientType, CustomClientDef, SkillClientType} from '../../../main/config-manager';
// 云端一致性报告类型同样以主进程为单一来源（plan-3.0）
import type {ConsistencyItem, ConsistencyReport} from '../../../main/cloud-consistency';
import type {CloudSyncConfig, CloudSyncConfigInput, CloudSyncResult} from '../../../shared/cloud-sync-constants';
import {defaultCloudSyncConfig} from '../../../shared/cloud-sync-constants';
import type {SyncTask, SyncTaskKind, SyncTaskScope} from '../../../shared/sync-task-types';
import type {UpdateEventPayload} from '../../../main/updater';
import type {McpServerConfig} from '../../../main/config/types';
import type {ActivationApi, ActivationState} from '../../../shared/activation-types';
// Skill 导出结果：与本文件共用（data 声明为 Uint8Array 而非 main 侧的 Node Buffer，
// 避免 renderer 类型图引入 node Buffer 导致 Blob 构造参数类型冲突）
export interface SkillsExportResult {
    ok: boolean;
    error?: string;
    fileName?: string;
    /** zip 二进制（主进程 IPC 传来时为 Uint8Array） */
    data?: Uint8Array;
}

export {defaultCloudSyncConfig};

export type {
    CloudProvider,
    CloudSyncConfig,
    CloudSyncConfigInput,
    CloudSyncResult,
    GitCloudConfig,
    SftpCloudConfig,
} from '../../../shared/cloud-sync-constants';
export type {TokenMeta, TokenScope} from '../../../main/secret-store';
export type {ApiConnection, PlatformType} from '../../../main/connections-store';
export type {
    PlatformSkillListItem,
    DirectSearchDiagnostics,
    DirectSearchAttempt,
    PlatformServerListItem,
    PlatformServerSearchPage,
    PlatformServerDetail,
    PlatformSearchPage,
    PlatformPageInfo,
    PlatformFacets,
    CategoryNode,
    SortOption,
    SourceFilter,
} from '../../../main/platforms/types';

// McpServerConfig 统一 re-export 主进程单一事实源（config/types.ts），不再本地重复定义——
// 本地旧定义缺少 cwd / enable 可选字段，存在类型漂移隐患（与 preload 同款改法）
export type {McpServerConfig} from '../../../main/config/types';
export type {ActivationApi, ActivationState, ActivationStatus} from '../../../shared/activation-types';

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
    /** 去重后的 MCP server 数（同一 server 装在多个客户端只计 1 次） */
    serverCount: number;
    /** 去重后的 Skill 数 */
    skillCount: number;
    /** 仅含真正承载内容的客户端（有 MCP server 或 Skill），不含未安装的空配置客户端 */
    clients: AnyClientId[];
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

export type {ClientType, SkillClientType, ClientInfo, AnyClientId, CustomClientDef, ConsistencyItem, ConsistencyReport};

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

export interface CustomSkillInput {
    name: string;
    description: string;
    body: string;
    /** zip 导入的附属文件（scripts/、references/ 等），创建时一并落盘 */
    files?: Array<{ path: string; data: Uint8Array }>;
    /** 编辑模式要删除的附属文件（相对路径列表；编辑面板提交） */
    removedFiles?: string[];
}

/** 附属文件列表项（skill 目录内相对路径；与 main 的 SkillFileItem 一致） */
export interface SkillFileItem {
    path: string;
    size: number;
    /** protected = SKILL.md（正文区编辑，面板禁止改删）；file = 普通附属文件 */
    kind: 'protected' | 'file';
}

/** 附属文件读取结果 */
export type ReadSkillFileResult =
    | { success: true; mode: 'editable'; content: string }
    | { success: true; mode: 'readonly'; reason: 'binary' | 'too_large' }
    | { success: false; error: string };

export interface CreateCustomSkillResult {
    success: boolean;
    error?: string;
    skillName?: string;
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

export interface LocalSkillDetail {
    found: boolean;
    name: string;
    skillMdContent: string;
    source: SkillSourceMeta | null;
    files: string[];
    clients: SkillClientType[];
}

export interface ImportParseResult {
    success: boolean;
    skills: DiscoveredSkill[];
    error?: string;
}

export interface ImportSkillFileResult {
    success: boolean;
    name?: string;
    description?: string;
    body?: string;
    /** zip 解包的附属文件（不含 SKILL.md 与 .source.json），创建时随 input.files 一并落盘 */
    files?: Array<{ path: string; data: Uint8Array }>;
    error?: string;
}

export interface AllSkillsResult {
    skills: Record<string, { name: string; clients: SkillClientType[] }>;
    /** 键含内置 SkillClientType 与 custom:<slug>（用户自定义 supportsSkills 客户端），故用 string */
    byClient: Record<string, InstalledSkill[]>;
}

export interface InstallResult {
    success: AnyClientId[];
    failed: AnyClientId[];
}

export interface AllServersResult {
    servers: Record<string, { config: McpServerConfig; clients: AnyClientId[] }>;
    byClient: Record<string, Record<string, McpServerConfig>>;
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

export interface McpApi {
    connect: (sessionId: string, config: McpServerConfig) => Promise<{ success: boolean; serverInfo?: { name?: string; version?: string }; error?: string }>;
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
}

interface ElectronAPI {
    clients: {
        getAll: (force?: boolean) => Promise<ClientInfo[]>;
        setCustomPath: (client: AnyClientId, customPath: string | null) => Promise<void>;
        setCustomSkillsPath: (client: SkillClientType, customPath: string | null) => Promise<void>;
        /** 添加用户手动客户端（并指定配置文件位置） */
        addCustom: (input: { name: string; configPath: string; supportsSkills?: boolean; skillsPath?: string }) => Promise<CustomClientDef>;
        /** 删除用户手动客户端 */
        removeCustom: (id: string) => Promise<void>;
    };
    config: {
        read: (client?: AnyClientId) => Promise<any>;
        write: (config: any, client?: AnyClientId) => Promise<void>;
        getServers: (client?: AnyClientId) => Promise<Record<string, McpServerConfig>>;
        getAllServers: () => Promise<AllServersResult>;
        installServer: (serverId: string, serverConfig: McpServerConfig, clients: AnyClientId[]) => Promise<InstallResult>;
        uninstallServer: (serverId: string, clients: AnyClientId[]) => Promise<InstallResult>;
        updateServer: (serverId: string, serverConfig: McpServerConfig, client?: AnyClientId) => Promise<void>;
        /** 标记 MCP server 为「手动安装」（编辑保存后调用，避免线上商店更新覆盖本地调整） */
        markServerManual: (serverId: string) => Promise<void>;
        /** 获取所有被标记为「手动安装」的 MCP server id 列表 */
        getManualServers: () => Promise<string[]>;
        syncServer: (serverId: string, sourceClient: AnyClientId, targetClients: AnyClientId[]) => Promise<InstallResult>;
        syncServersBatch: (items: {
            serverId: string;
            config: McpServerConfig
        }[], targetClients: AnyClientId[]) => Promise<{
            synced: number;
            failed: number;
            details: { serverId: string; success: AnyClientId[]; failed: AnyClientId[] }[]
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
        restore: (timestamp: string) => Promise<boolean>;
        getDiff: (timestamp: string) => Promise<DiffResult | null>;
        clearAll: () => Promise<boolean>;
    };
    system: {
        getPlatform: () => Promise<string>;
        getVersion: () => Promise<string>;
        openExternal: (url: string) => Promise<void>;
        openThirdPartyLicense: () => Promise<string>;
        getConfigPath: (client?: AnyClientId) => Promise<string>;
        openConfigDirectory: (client: AnyClientId) => Promise<string>;
        openSkillsDirectory: (client: SkillClientType) => Promise<string>;
    };
    dialog: {
        /** 打开系统目录选择对话框；defaultPath 缺省时使用用户主目录 */
        selectDirectory: (defaultPath?: string) => Promise<{ canceled: boolean; path?: string }>;
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
        resolvePlatformUrl: (url: string) => Promise<ImportParseResult>;
        installFromDiscovered: (skill: DiscoveredSkill, clients: SkillClientType[]) => Promise<SkillInstallResult>;
        /** 平台源（如虾评）安装：用连接绑定的令牌换下载直链后落盘 */
        installPlatformSkill: (connectionId: string, skillId: string, skillName: string, clients: SkillClientType[]) => Promise<SkillInstallResult>;
        getLocalDetail: (skillId: string) => Promise<LocalSkillDetail | null>;
        /** 创建本地自定义 Skill（无网络） */
        createCustom: (input: CustomSkillInput, clients: SkillClientType[]) => Promise<CreateCustomSkillResult>;
        /** 更新本地自定义 Skill（改写 SKILL.md，可重命名） */
        updateCustom: (originalName: string, input: CustomSkillInput, clients: SkillClientType[]) => Promise<CreateCustomSkillResult>;
        /**
         * 保存自定义 Skill 并自动同步到云端（暂存区 + 自动 push）。
         * 返回本地保存结果与云端同步状态；云端未配置时 cloud.skipped=true。
         */
        saveWithCloudSync: (
            isEdit: boolean,
            originalName: string | undefined,
            input: CustomSkillInput,
            clients: SkillClientType[]
        ) => Promise<{
            success: boolean;
            error?: string;
            skillName?: string;
            cloud?: { pushed: boolean; skipped: boolean; enqueued: boolean; message: string };
        }>;
        /** 读取本地 Skill 的 SKILL.md（解析 frontmatter 与正文，用于编辑回填） */
        readSkillMd: (skillName: string, client: SkillClientType) => Promise<{
            name: string;
            description: string;
            body: string
        } | null>;
        /** 列出 Skill 目录内附属文件（编辑模式「附属文件」面板；排除 .source.json，SKILL.md 标受保护） */
        listSkillFiles: (skillName: string, client: SkillClientType) => Promise<SkillFileItem[] | null>;
        /** 读取 Skill 附属文件内容（UTF-8 校验；二进制 / >512KB 返回只读） */
        readSkillFile: (skillName: string, client: SkillClientType, relPath: string) => Promise<ReadSkillFileResult>;
        /** 从本地 .zip / .skill 文件或目录解析 Skill（用于「我的库」上传创建） */
        importFromFile: (filePath: string) => Promise<ImportSkillFileResult>;
        /** 从 ZIP/.skill 二进制解析 Skill（拖拽/选择文件直接传 bytes，不依赖 File.path） */
        importFromZipBuffer: (data: Uint8Array) => Promise<ImportSkillFileResult>;
        /** 打开系统对话框选择一个已解压的 skill 文件夹 */
        pickFolder: () => Promise<{ canceled: boolean; path?: string }>;
        /** 远程 GitHub Registry skill 详情：解析仓库并取回首个 Skill 的源 / SKILL.md（替代渲染端抛错的 fetchSkillDetail 桩） */
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
        /** 检查 Skill 同步到云端前的冲突 */
        checkCloudConflicts: (items: Array<{
            name: string;
            sourceClient: SkillClientType
        }>) => Promise<SkillCloudConflict[]>;
        /** 按用户确认结果同步 Skill 到云端 */
        syncToCloudResolved: (items: Array<{
            name: string;
            sourceClient: SkillClientType
        }>, resolutions: Record<string, 'overwrite' | 'skip'>) => Promise<SkillBatchSyncResult>;
        /** 导出选中 Skill 为 zip 包（每个 skill 一个目录，可直接解压复用） */
        exportZip: (names: string[]) => Promise<SkillsExportResult>;
    };
    // API 令牌管理
    apiTokens: {
        list: () => Promise<TokenMeta[]>;
        create: (name: string, scopes: TokenScope[], expiresAt: number | null) => Promise<TokenMeta>;
        import: (rawKey: string, name: string, platform?: string, expiresAt?: number | null) => Promise<TokenMeta>;
        reveal: (id: string) => Promise<string | null>;
        revoke: (id: string) => Promise<TokenMeta | null>;
        restore: (id: string) => Promise<TokenMeta | null>;
        delete: (id: string) => Promise<void>;
    };
    // API 直连管理
    apiConnections: {
        /** 列出连接；传 kind 只返回该类型（'mcp' | 'skill'） */
        list: (kind?: 'mcp' | 'skill') => Promise<ApiConnection[]>;
        create: (conn: Omit<ApiConnection, 'id' | 'createdAt' | 'status' | 'lastCheckedAt'>) => Promise<ApiConnection>;
        update: (conn: ApiConnection) => Promise<ApiConnection>;
        delete: (id: string) => Promise<void>;
        verify: (id: string) => Promise<ApiConnection>;
        export: (id?: string) => Promise<string>;
        searchPlatform: (connectionId: string, query: string, page: number, pageSize?: number) => Promise<PlatformSkillListItem[]>;
        /** 分页搜索：返回条目 + 平台分页元信息（total/totalPages/hasMore） */
        searchPlatformPaged: (connectionId: string, query: string, page: number, pageSize?: number, category?: string) => Promise<PlatformSearchPage>;
        /** 平台 MCP server 分页搜索（如 ModelScope MCP 广场），返回条目 + 分页元信息 */
        searchPlatformServersPaged: (connectionId: string, query: string, page: number, pageSize?: number, category?: string) => Promise<PlatformServerSearchPage>;
        /** 获取平台 MCP server 详情（含安装配置 / README），如 ModelScope */
        getServerDetail: (connectionId: string, serverId: string) => Promise<PlatformServerDetail>;
        /** 取回最近一次直连搜索的端点探测诊断（无结果时用于展示原因） */
        searchDiagnostics: (connectionId: string) => Promise<DirectSearchDiagnostics | null>;
        resolveSkill: (connectionId: string, sourceUrl: string) => Promise<any>;
        /** 将某连接设为默认来源 */
        setDefault: (id: string) => Promise<ApiConnection>;
        /** 启用 / 禁用某连接 */
        setEnabled: (id: string, enabled: boolean) => Promise<ApiConnection>;
        /** 恢复被删除的内置 MCP 源（smithery） */
        restoreBuiltinMcp: () => Promise<ApiConnection[]>;
        /** 恢复被删除的内置 Skill 源（ClawHub 等） */
        restoreBuiltinSkill: () => Promise<ApiConnection[]>;
    };
    // 统一平台适配器通道（新架构）
    platforms: {
        list: () => Promise<{id: string; name: string}[]>;
        searchSkills: (platformType: string, query: string, page: number, pageSize?: number, category?: string, sort?: string, connectionId?: string) => Promise<PlatformSearchPage>;
        searchServers: (platformType: string, query: string, page: number, pageSize?: number, category?: string, sort?: string, source?: string, connectionId?: string) => Promise<PlatformServerSearchPage>;
        getServerDetail: (platformType: string, serverId: string, connectionId?: string) => Promise<PlatformServerDetail>;
        facets: (platformType: string, resourceType?: 'mcp' | 'skills') => Promise<PlatformFacets>;
        diagnostics: (platformType: string) => Promise<any>;
    };
    // 云同步（Git / SFTP）：把云端存储当作一个客户端
    cloudSync: {
        getConfig: () => Promise<CloudSyncConfig>;
        setConfig: (patch: CloudSyncConfigInput) => Promise<CloudSyncConfig>;
        test: () => Promise<CloudSyncResult>;
        push: () => Promise<CloudSyncResult>;
        pull: () => Promise<CloudSyncResult>;
        onPulled: (callback: (result: CloudSyncResult) => void) => () => void;
        /** 主动检测本地客户端与云端的不一致项（云同步未激活返回空报告） */
        checkConsistency: () => Promise<ConsistencyReport>;
        /** 对照查看：读取单个条目在本地端与云端端的内容文本 */
        readEnds: (req: { kind: 'skill' | 'server'; name: string; localClient: string }) => Promise<{ local: string | null; cloud: string | null }>;
    };
    // MCP Inspector
    mcp: McpApi;
    // 激活（授权）
    activation: ActivationApi;
    // 本地持久化缓存（落盘 ~/.ai-tools/cache/，用于 store 列表 SWR 秒开）
    cache: {
        get: <T>(key: string) => Promise<{
            data: T;
            cachedAt: number;
            expiresAt: number;
            version: string;
            etag?: string
        } | null>;
        set: <T>(key: string, data: T, etag?: string) => Promise<void>;
        getMeta: (key: string) => Promise<{ cachedAt: number; expiresAt: number; version: string; exists: boolean }>;
        isExpired: (key: string) => Promise<boolean>;
        has: (key: string) => Promise<boolean>;
        delete: (key: string) => Promise<void>;
        clear: () => Promise<void>;
        clearByPrefix: (prefix: 'smithery' | 'skills') => Promise<void>;
        getStats: () => Promise<{
            totalFiles: number;
            totalSize: number;
            indexCaches: string[];
            detailCaches: number;
            encrypted: boolean
        }>;
        getDirectory: () => Promise<string>;
    };
    // 自定义标题栏：窗口控制（Windows / Linux 无边框窗口）
    window: {
        minimize: () => void;
        toggleMaximize: () => void;
        close: () => void;
        isMaximized: () => Promise<boolean>;
        onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
    };
    // 系统主题跟随：主进程 nativeTheme 变化时回调（auto 模式用于实时刷新）
    theme: {
        onSystemThemeChange: (callback: (shouldUseDarkColors: boolean) => void) => () => void;
    };
    // 同步任务：后台异步云同步队列，侧边栏「同步任务」面板使用
    syncTasks: {
        /** 拉取当前任务列表 */
        list: () => Promise<SyncTask[]>;
        /** 入队一个同步任务（kind: 'cloud-push' | 'cloud-pull'，scope: 'mcp' | 'skills' | 'all'） */
        enqueue: (kind: SyncTaskKind, title?: string, scope?: SyncTaskScope) => Promise<SyncTask>;
        /** 重试一个失败的任务 */
        retry: (id: string) => Promise<boolean>;
        /** 移除单条任务 */
        remove: (id: string) => Promise<void>;
        /** 清空全部任务 */
        clear: () => Promise<void>;
        /** 订阅任务列表变化（主进程每次状态更新都会回调最新列表），返回取消订阅函数 */
        onUpdated: (callback: (tasks: SyncTask[]) => void) => () => void;
    };

    /** 在线更新（plan-19.0）：动作走 invoke，状态经 onStatus 订阅 */
    updater: {
        getStatus: () => Promise<UpdateEventPayload>;
        check: () => Promise<boolean>;
        download: () => Promise<boolean>;
        quitAndInstall: () => Promise<boolean>;
        onStatus: (callback: (payload: UpdateEventPayload) => void) => () => void;
    };
}

// 获取 Electron API
export function getElectronAPI(): ElectronAPI | null {
    if (typeof window !== 'undefined' && 'electronAPI' in window) {
        return (window as any).electronAPI as ElectronAPI;
    }
    return null;
}

// 检查是否在 Electron 环境中
export function isElectron(): boolean {
    return getElectronAPI() !== null;
}

// Mock API for development in browser
const mockAPI: ElectronAPI = {
    clients: {
        getAll: async () => [
            {
                id: 'cursor',
                name: 'Cursor',
                installed: true,
                configPath: '~/.cursor/mcp.json',
                configExists: true,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.cursor/skills'
            },
            {
                id: 'claude-code',
                name: 'Claude Code',
                installed: true,
                configPath: '~/.claude/mcp.json',
                configExists: true,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.claude/skills'
            },
            {
                id: 'gemini-cli',
                name: 'Gemini CLI',
                installed: false,
                configPath: '~/.gemini/settings.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.gemini/skills'
            },
            {
                id: 'codex-cli',
                name: 'Codex CLI',
                installed: false,
                configPath: '~/.codex/config.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.codex/skills'
            },
            {
                id: 'windsurf',
                name: 'Windsurf',
                installed: false,
                configPath: '~/.windsurf/mcp.json',
                configExists: false,
                supportsSkills: false,
                supportsMcp: true
            },
            {
                id: 'zed',
                name: 'Zed',
                installed: true,
                configPath: '~/.config/zed/settings.json',
                configExists: false,
                supportsSkills: false,
                supportsMcp: true
            },
            {
                id: 'trae',
                name: 'TRAE',
                installed: false,
                configPath: '~/.trae/mcp.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.trae/skills'
            },
            {
                id: 'trae-cn',
                name: 'TRAE CN',
                installed: false,
                configPath: '~/AppData/Roaming/Trae CN/User/mcp.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.trae-cn/skills'
            },
            {
                id: 'trae-solo-cn',
                name: 'TRAE SOLO CN',
                installed: false,
                configPath: '~/AppData/Roaming/TRAE SOLO CN/User/mcp.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.trae-cn/skills'
            },
            {
                id: 'marscode',
                name: 'TRAE Plugin',
                installed: false,
                configPath: '~/.marscode/IDEA.mcp.config.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.marscode/skills'
            },
            {
                id: 'opencode',
                name: 'Opencode',
                installed: false,
                configPath: '~/.config/opencode/opencode.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.config/opencode/skills'
            },
            {
                id: 'codebuddy',
                name: 'CodeBuddy',
                installed: false,
                configPath: '~/.codebuddy/mcp.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.codebuddy/skills'
            },
            {
                id: 'workbuddy',
                name: 'WorkBuddy',
                installed: false,
                configPath: '~/.workbuddy/mcp.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.workbuddy/skills'
            },
            {
                id: 'qoder',
                name: 'Qoder',
                installed: false,
                configPath: '~/.qoder/mcp.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.qoder/skills'
            },
            {
                id: 'zcode',
                name: 'ZCode',
                installed: false,
                configPath: '~/.zcode/cli/config.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: true,
                skillsPath: '~/.zcode/skills'
            },
            {
                id: 'agent-skills',
                name: 'Agent Skills (.agents)',
                installed: false,
                configPath: '~/.agents',
                configExists: false,
                supportsSkills: true,
                supportsMcp: false,
                skillsPath: '~/.agents/skills'
            },
            {
                id: 'cloud',
                name: '云端存储',
                installed: false,
                configPath: '~/.ai-tools/cloud/ai-tools/mcp/mcp.json',
                configExists: false,
                supportsSkills: true,
                supportsMcp: false,
                skillsPath: '~/.ai-tools/cloud/ai-tools/skills'
            },
        ],
        setCustomPath: async () => {
        },
        setCustomSkillsPath: async () => {
        },
        addCustom: async (input: { name: string; configPath: string; supportsSkills?: boolean; skillsPath?: string }) => ({
            id: `custom:${(input.name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            name: input.name,
            configPath: input.configPath,
            supportsSkills: !!input.supportsSkills,
            skillsPath: input.supportsSkills ? input.skillsPath : undefined,
        }),
        removeCustom: async () => {
        },
    },
    config: {
        read: async () => ({mcpServers: {}}),
        write: async () => {
        },
        getServers: async () => ({}),
        getAllServers: async () => ({
            servers: {},
            byClient: {
                cursor: {},
                vscode: {},
                'claude-code': {},
                'gemini-cli': {},
                'codex-cli': {},
                windsurf: {},
                zed: {},
                trae: {},
                'trae-cn': {},
                'trae-solo-cn': {},
                marscode: {},
                kiro: {},
                opencode: {},
                jetbrains: {},
                antigravity: {},
                openclaw: {},
                codebuddy: {},
                workbuddy: {},
                qoder: {},
                zcode: {},
                cloud: {}

            }
        }),
        installServer: async (_, __, clients) => ({success: clients, failed: []}),
        uninstallServer: async (_, clients) => ({success: clients, failed: []}),
        updateServer: async () => {
        },
        markServerManual: async () => {
        },
        getManualServers: async () => [],
        syncServer: async (_, __, targets) => ({success: targets, failed: []}),
        syncServersBatch: async (items, targets) => ({
            synced: items.length,
            failed: 0,
            details: items.map(i => ({serverId: i.serverId, success: targets, failed: []}))
        }),
    },
    env: {
        checkRuntime: async () => ({available: true, version: '20.0.0', path: '/usr/local/bin/node'}),
        getAllRuntimes: async () => ({
            node: {available: true, version: '20.0.0', path: '/usr/local/bin/node'},
            python: {available: true, version: '3.11.0', path: '/usr/bin/python3'},
            npx: {available: true, version: '10.0.0', path: '/usr/local/bin/npx'},
            uvx: {available: false, version: null, path: null},
            git: {available: true, version: '2.43.0', path: '/usr/bin/git'},
        }),
        getNpxPath: async () => 'npx',
        getUvxPath: async () => 'uvx',
    },
    history: {
        list: async () => [],
        restore: async () => true,
        getDiff: async () => null,
        clearAll: async () => true,
    },
    system: {
        getPlatform: async () => 'darwin',
        getVersion: async () => '1.0.0-dev',
        openExternal: async (url) => {
            window.open(url, '_blank');
        },
        openThirdPartyLicense: async () => '',
        getConfigPath: async () => '~/Library/Application Support/Claude/claude_desktop_config.json',
        openConfigDirectory: async () => '',
        openSkillsDirectory: async () => '',
    },
    dialog: {
        selectDirectory: async () => ({canceled: true}),
    },
    skills: {
        getInstalled: async () => [],
        getAllInstalled: async () => ({
            skills: {},
            byClient: {
                cursor: [],
                'claude-code': [],
                'gemini-cli': [],
                'codex-cli': [],
                opencode: [],
                'agent-skills': [],
                codebuddy: [],
                workbuddy: [],
                qoder: [],
                zcode: [],
                marscode: [],
                trae: [],
                'trae-cn': [],
                'trae-solo-cn': [],
                cloud: []
            }
        }),
        install: async () => ({success: true}),
        uninstall: async () => {
        },
        update: async () => ({updated: true}),
        updateAll: async () => ({updated: 0, failed: 0}),
        isInstalled: async () => false,
        parseImportUrl: async () => ({success: false, skills: [], error: 'Not available in browser'}),
        resolvePlatformUrl: async () => ({success: false, skills: [], error: 'Not available in browser'}),
        installFromDiscovered: async () => ({success: true}),
        installPlatformSkill: async () => ({success: false, error: 'Not available in browser'}),
        createCustom: async (input) => ({success: true, skillName: input.name}),
        updateCustom: async (originalName) => ({success: true, skillName: originalName}),
        saveWithCloudSync: async () => ({success: false, error: 'Not available in browser'}),
        readSkillMd: async (skillName) => ({name: skillName, description: '', body: ''}),
        listSkillFiles: async () => [],
        readSkillFile: async () => ({success: false, error: 'Not available in browser'}),
        importFromFile: async () => ({success: false, error: 'Not available in browser'}),
        importFromZipBuffer: async () => ({success: false, error: 'Not available in browser'}),
        pickFolder: async () => ({canceled: true}),
        getLocalDetail: async () => null,
        getRemoteDetail: async () => ({success: false, skill: null, error: 'Not available in browser'}),
        sync: async () => ({success: [], failed: [], errors: {}}),
        syncBatch: async () => ({synced: 0, failed: 0, details: []}),
        checkCloudConflicts: async () => [],
        syncToCloudResolved: async () => ({synced: 0, failed: 0, details: []}),
        exportZip: async () => ({ok: false, error: 'Not available in browser'}),
    },
    apiTokens: {
        list: async () => [],
        create: async (name) => ({
            id: 'tok_mock',
            name,
            scopes: [],
            expiresAt: null,
            createdAt: Date.now(),
            revoked: false,
            preview: 'mock'
        }),
        import: async (_, name, platform) => ({
            id: 'tok_mock',
            name,
            scopes: [],
            expiresAt: null,
            createdAt: Date.now(),
            revoked: false,
            preview: 'mock',
            platform,
            kind: 'imported'
        }),
        reveal: async () => null,
        revoke: async () => null,
        restore: async () => null,
        delete: async () => {
        },
    },
    apiConnections: {
        list: async () => [],
        create: async (conn) => ({
            ...conn,
            id: 'conn_mock',
            createdAt: Date.now(),
            status: 'unverified',
            lastCheckedAt: null
        }),
        update: async (conn) => conn,
        delete: async () => {
        },
        verify: async (conn: any) => ({...conn, status: 'unverified'} as ApiConnection),
        export: async () => '{}',
        searchPlatform: async () => [],
        searchPlatformPaged: async () => ({
            items: [],
            pageInfo: {page: 1, pageSize: 20, total: 0, totalPages: 0, hasMore: false},
        }),
        searchPlatformServersPaged: async () => ({
            items: [],
            pageInfo: {page: 1, pageSize: 20, total: 0, totalPages: 0, hasMore: false},
        }),
        getServerDetail: async () => {
            throw new Error('Not available in browser');
        },
        searchDiagnostics: async () => null,
        resolveSkill: async () => ({success: false, skills: [], error: 'Not available in browser'}),
        setDefault: async (id: string) => ({id, isDefault: true} as ApiConnection),
        setEnabled: async (id: string, enabled: boolean) => ({id, enabled} as ApiConnection),
        restoreBuiltinMcp: async () => [],
        restoreBuiltinSkill: async () => [],
    },
    platforms: {
        list: async () => [],
        searchSkills: async () => ({items: [], pageInfo: {page: 1, pageSize: 20, total: 0, totalPages: 0, hasMore: false}}),
        searchServers: async () => ({items: [], pageInfo: {page: 1, pageSize: 20, total: 0, totalPages: 0, hasMore: false}}),
        getServerDetail: async () => { throw new Error('Not available in browser'); },
        facets: async () => ({categories: [], sortOptions: [], supportsSubcategories: false}),
        diagnostics: async () => null,
    },
    cloudSync: {
        getConfig: async () => defaultCloudSyncConfig(),
        setConfig: async () => defaultCloudSyncConfig(),
        test: async () => ({ok: false, message: 'Not available in browser'}),
        push: async () => ({ok: false, message: 'Not available in browser'}),
        pull: async () => ({ok: false, message: 'Not available in browser'}),
        onPulled: () => () => {},
        checkConsistency: async () => ({items: [], checkedAt: new Date().toISOString()}),
        readEnds: async () => ({local: null, cloud: null}),
    },
    mcp: {
        connect: async () => ({success: false, error: 'Not available in browser'}),
        disconnect: async () => ({success: false}),
        isConnected: async () => false,
        listTools: async () => ({success: false, tools: [], error: 'Not available in browser'}),
        callTool: async () => ({success: false, error: 'Not available in browser'}),
        listResources: async () => ({success: false, resources: [], error: 'Not available in browser'}),
        listPrompts: async () => ({success: false, prompts: [], error: 'Not available in browser'}),
        onStderr: () => () => {
        },
        onDisconnected: () => () => {
        },
        onError: () => () => {
        },
    },
    activation: {
        getState: async (): Promise<ActivationState> => ({
            status: 'trial',
            trialExpiresAt: Date.now() + 30 * 86400000,
            activatedExpiresAt: null,
            activatedAt: null,
            machineCode: null,
        }),
        getMachineCode: async (): Promise<string> => 'AI-MOCK-MACHINE-CODE-0001',
        offlineActivate: async (_mc: string, code: string) => {
            if (!code) return { success: false, error: '请输入激活码' };
            return {
                success: true,
                state: {
                    status: 'activated',
                    trialExpiresAt: null,
                    activatedExpiresAt: null,
                    activatedAt: Date.now(),
                    machineCode: _mc,
                },
            };
        },
        onlineActivate: async () => ({ success: false, error: '在线激活占位（浏览器预览）' }),
        deactivate: async (): Promise<ActivationState> => ({
            status: 'inactive',
            trialExpiresAt: null,
            activatedExpiresAt: null,
            activatedAt: null,
            machineCode: null,
        }),
    },
    cache: {
        get: async () => null,
        set: async () => {
        },
        getMeta: async () => ({cachedAt: 0, expiresAt: 0, version: '', exists: false}),
        isExpired: async () => true,
        has: async () => false,
        delete: async () => {
        },
        clear: async () => {
        },
        clearByPrefix: async () => {
        },
        getStats: async () => ({totalFiles: 0, totalSize: 0, indexCaches: [], detailCaches: 0, encrypted: false}),
        getDirectory: async () => '',
    },
    window: {
        minimize: () => {
        },
        toggleMaximize: () => {
        },
        close: () => {
        },
        isMaximized: async () => false,
        onMaximizeChange: () => () => {
        },
    },
    theme: {
        onSystemThemeChange: () => () => {
        },
    },
    syncTasks: {
        list: async () => [],
        enqueue: async (_kind: SyncTaskKind, _title?: string) => ({
            id: `mock_${Date.now()}`,
            kind: _kind,
            title: _title || (_kind === 'cloud-push' ? '上传到云端' : '从云端下载'),
            status: 'success',
            createdAt: Date.now(),
            finishedAt: Date.now(),
        }),
        retry: async () => false,
        remove: async () => {
        },
        clear: async () => {
        },
        onUpdated: () => () => {
        },
    },

    // 在线更新：浏览器预览无实际更新源，统一回退为「不支持」
    updater: {
        getStatus: async (): Promise<UpdateEventPayload> => ({
            state: 'unsupported',
            unsupported: true,
            message: '浏览器预览环境不支持在线更新。',
            currentVersion: '1.0.0-dev',
        }),
        check: async () => false,
        download: async () => false,
        quitAndInstall: async () => false,
        onStatus: () => () => {
        },
    },
};

// 获取 API。生产环境必须由 preload 注入真实 API；若缺失则直接抛错，
// 避免回落到 mock 让用户看到完全虚假的可用界面（见 P1-8）。
// 仅开发环境（无 Electron 宿主，如纯浏览器预览）才允许使用 mock。
export function useElectronAPI(): ElectronAPI {
    const api = getElectronAPI();
    if (api) return api;
    if (process.env.NODE_ENV !== 'production') {
        console.warn('[electron] 未检测到 preload API，开发环境使用 mock API');
        return mockAPI;
    }
    throw new Error('Electron API 未注入，应用无法运行（preload 加载失败）');
}
