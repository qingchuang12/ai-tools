/**
 * AI-Tools - Electron 主进程入口
 */

import {app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell} from 'electron';
import path from 'path';
import {existsSync} from 'fs';
import {ClientType, ConfigManager, SkillClientType} from './config-manager';
import {EnvManager} from './env-manager';
import {HistoryManager} from './history-manager';
import {
    DiscoveredSkill,
    SkillCloudConflict,
    SkillInstallResult,
    SkillsManager,
    SkillSourceMeta
} from './skills-manager';
import {exportSkillsToZip, type SkillsExportResult} from './skills-export';
import type {
    PlatformFacets,
    PlatformSearchPage,
    PlatformServerDetail,
    PlatformServerSearchPage,
    PlatformSkillListItem
} from './platforms/types';
import {platformTypeToSupported} from './platforms/types';
import {
    fetchPlatformServerDetail,
    getLastDirectSearchDiagnostics,
    resolveDirectSkill,
    resolvePlatformSkillUrl,
    searchPlatformDirect,
    searchPlatformDirectPaged,
    searchPlatformServersPaged
} from './platform-skill-resolver';
import {getAdapter, getFacets, listAdapters} from './platforms/registry';
import {buildPlatformSearchKey, withPlatformSearchCache} from './platforms/search-cache';
import {getCacheManager} from './cache-manager';
import {getSecretStore, TokenMeta, TokenScope} from './secret-store';
import {ApiConnection, getConnectionsStore} from './connections-store';
import {createMcpClient, disconnectAllClients, getMcpClient, removeMcpClient} from './mcp-client';
import {getCloudSyncStore} from './cloud-sync-store';
import {getCloudSyncService} from './cloud-sync-service';
import {checkCloudConsistency, type ConsistencyReport, readCompareEnds} from './cloud-consistency';
import {getSyncTaskManager, initSyncTaskManager} from './sync-task-manager';
import type {SyncTask, SyncTaskKind, SyncTaskScope} from '../shared/sync-task-types';
import type {CloudSyncConfig, CloudSyncConfigInput, CloudSyncResult} from '../shared/cloud-sync-constants';
import {
    checkForUpdatesAndNotify,
    downloadUpdateAndInstall,
    getUpdateStatus,
    initUpdater,
    quitAndInstall
} from './updater';

/** 仅允许 http/https 外部链接，避免 file:// 等被带出（P1-6） */
function isSafeExternalUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

// 管理器实例
const configManager = new ConfigManager();
const envManager = new EnvManager();
const historyManager = new HistoryManager();
const skillsManager = new SkillsManager();
const cacheManager = getCacheManager();
const secretStore = getSecretStore();
const connectionsStore = getConnectionsStore();
const cloudSyncStore = getCloudSyncStore();
const cloudSyncService = getCloudSyncService();

let mainWindow: BrowserWindow | null = null;

// 进程级兜底：避免未捕获的 Promise 拒绝 / 异常导致静默崩溃
process.on('unhandledRejection', (reason: unknown) => {
    console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err: Error) => {
    console.error('[uncaughtException]', err);
});

// 开发模式：明确设置了 NODE_ENV=development 或 VITE_DEV_SERVER_URL
const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;

function createWindow() {
    const isMac = process.platform === 'darwin';
    const isWin = process.platform === 'win32';

    // 图标路径：根据平台和模式选择正确的图标文件
    // 开发模式: __dirname = mcp-dock-core/dist/main, build 在 ../../build
    // 生产模式: __dirname = app.asar/dist/main, build 在 app.asar/build (即 ../../build)
    const getIconPath = () => {
        const basePath = path.join(__dirname, '../../build');
        if (isMac) {
            return path.join(basePath, 'icon.icns');
        } else if (isWin) {
            return path.join(basePath, 'icon.ico');
        } else {
            return path.join(basePath, 'icon.png');
        }
    };

    mainWindow = new BrowserWindow({
        width: 1024,
        height: 700,
        minWidth: 900,
        minHeight: 600,
        icon: getIconPath(),
        // macOS 特有的标题栏样式
        ...(isMac ? {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: {x: 16, y: 18},
        } : {}),
        // Windows / Linux 使用无边框窗口 + 自定义标题栏，避免原生标题栏与深色界面割裂
        ...(isWin ? {
            frame: false,
            autoHideMenuBar: true,
        } : {}),
        backgroundColor: '#1c1c1e',
        webPreferences: {
            // 显式关闭沙箱：Electron 43 默认开启 sandbox，其自带 sandboxed renderer
            // 在初始化时会读取内部 startupData.preloadScripts，若该值为 null 会导致
            // 渲染进程启动时崩溃（Cannot destructure 'preloadScripts' of
            // 'binding.startupData' as it is null）。关闭后 preload 仍通过 contextBridge
            // 安全暴露 API，nodeIntegration=false + contextIsolation=true 已保证隔离。
            sandbox: false,
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../preload', 'index.js'),
        },
    });

    // 开发模式加载 Vite 开发服务器
    if (isDev) {
        // 兜底地址与 vite.config.mts 的 server.host/port 保持一致（显式 IPv4，避免地址族错配）
        const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';
        // 开发模式下移除 HTML 中的 CSP 限制，避免拦截 Vite 的 localhost/ws 模块与 HMR 连接导致黑屏
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    'Content-Security-Policy': [],
                },
            });
        });
        mainWindow.loadURL(devServerUrl);
        mainWindow.webContents.openDevTools();
    } else {
        // 生产模式加载打包后的文件
        mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 首屏加载完成后，向渲染进程推送一次当前系统主题（auto 模式下作为权威初始值，
    // 纠正 matchMedia 在部分平台初始读取不准确的情形）
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow?.webContents.send('theme:system-changed', nativeTheme.shouldUseDarkColors);
    });

    // 自定义标题栏：广播窗口最大化状态变化（双击标题栏/拖拽到顶部/系统快照等触发）
    mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximize-changed', true));
    mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximize-changed', false));
    mainWindow.on('restore', () => mainWindow?.webContents.send('window:maximize-changed', false));

    // 外部链接在默认浏览器中打开（仅允许 http/https，避免 file:// 等带出，P1-6）
    mainWindow.webContents.setWindowOpenHandler(({url}) => {
        if (isSafeExternalUrl(url)) shell.openExternal(url);
        return {action: 'deny'};
    });
}

// 单一实例锁：避免重复启动产生多个窗口
if (!app.requestSingleInstanceLock()) {
    app.quit();
}

app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

// 应用准备就绪
app.whenReady().then(() => {
    // ============================================================================
    // DNS 配置：使用安全的 DNS 服务器避免 DNS 污染
    // ============================================================================
    app.configureHostResolver({
        enableBuiltInResolver: true,
        secureDnsMode: 'secure',
        secureDnsServers: [
            'https://1.1.1.1/dns-query',      // Cloudflare DoH
            'https://8.8.8.8/dns-query',      // Google DoH
            'https://dns.alidns.com/dns-query' // 阿里 DoH（国内备用）
        ],
    });
    // macOS: 设置 Dock 图标（使用 PNG 格式，因为 dock.setIcon 不支持 icns）
    if (process.platform === 'darwin') {
        const dockIconPath = path.join(__dirname, '../../build/icon.png');
        try {
            if (app.dock) {
                app.dock.setIcon(dockIconPath);
            }
        } catch (e) {
            console.warn('Failed to set dock icon:', e);
        }
    }

    createWindow();

    // 初始化同步任务管理器：后台队列处理云同步，状态变化广播给渲染层侧边栏面板。
    // emit 回调在窗口就绪后调用（createWindow 已执行），可安全向渲染层推送。
    initSyncTaskManager(() => {
        const list = getSyncTaskManager().list();
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('sync-tasks:updated', list));
    });

    // 初始化在线更新（订阅 autoUpdater 事件，广播给渲染层）；不触发检测，检测由 IPC/渲染层发起。
    initUpdater();

    // 启动后静默检查一次更新：不下载、只在有新版时由渲染层收到 available 后询问用户。
    // 仅在支持该形态（打包 + NSIS/AppImage）时真正发起；dev / portable / mac 会广播 unsupported。
    setTimeout(() => checkForUpdatesAndNotify(), 3000);

    // 启动后后台异步以云端为准拉取一次（覆盖本地暂存区），不阻塞启动。
    // 经由同步队列执行（P1-1），与手动 push 串行；拉取完成（无论成败）通知渲染层刷新；
    // 仅在已配置云同步时执行。
    void (async () => {
        try {
            if (!getCloudSyncStore().isActive()) return;
            const res = await enqueueCloudAndWait('cloud-pull', '从云端下载');
            mainWindow?.webContents.send('cloud-sync:pulled', res);
        } catch (e: any) {
            console.error('[CloudSync] startup pull error:', e?.message || e);
        }
    })();

    // 系统主题跟随：操作系统明暗切换时，经 nativeTheme 桥接通知渲染进程重新计算主题。
    // 渲染进程内 matchMedia 的 change 在 Electron 某些版本下不可靠（窗口失焦/未重绘时不触发），
    // 主进程 nativeTheme.on('updated') 是更权威、更及时的来源。
    nativeTheme.on('updated', () => {
        mainWindow?.webContents.send('theme:system-changed', nativeTheme.shouldUseDarkColors);
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// 所有窗口关闭时退出应用 (macOS 除外)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        disconnectAllClients();
        app.quit();
    }
});

// 退出前兜底清理：MCP Inspector 的 spawn 子进程（shell:true 派生）若不杀干净，
// stdio 管道句柄会保持事件循环存活，导致主进程退出后仍残留。
app.on('before-quit', () => {
    disconnectAllClients();
    // 兜底：若仍有句柄阻止正常退出，1.5s 后强制退出
    const forceQuitTimer = setTimeout(() => app.exit(0), 1500);
    forceQuitTimer.unref?.();
});

// ============ IPC 处理器 ============

// 客户端管理
ipcMain.handle('clients:get-all', async (_, force?: boolean) => {
    return configManager.getAllClients(force);
});

// 配置管理
ipcMain.handle('config:read', async (_, client?: ClientType) => {
    return configManager.readConfig(client);
});

ipcMain.handle('config:write', async (_, config: any, client?: ClientType) => {
    const result = await configManager.writeConfig(config, client);
    // 在变更【之后】快照，确保历史记录反映本次操作后的真实状态
    await historyManager.backup();
    return result;
});

ipcMain.handle('config:get-servers', async (_, client?: ClientType) => {
    return configManager.getInstalledServers(client);
});

ipcMain.handle('config:get-all-servers', async () => {
    return configManager.getAllInstalledServers();
});

ipcMain.handle('config:install-server', async (_, serverId: string, serverConfig: any, clients: ClientType[]) => {
    const result = await configManager.installServer(serverId, serverConfig, clients);
    await historyManager.backup();
    return result;
});

ipcMain.handle('config:uninstall-server', async (_, serverId: string, clients: ClientType[]) => {
    const result = await configManager.uninstallServer(serverId, clients);
    await historyManager.backup();
    return result;
});

ipcMain.handle('config:update-server', async (_, serverId: string, serverConfig: any, client?: ClientType) => {
    const result = await configManager.updateServer(serverId, serverConfig, client);
    await historyManager.backup();
    return result;
});

// 标记 MCP server 为「手动安装」（编辑保存后调用，避免线上商店更新覆盖本地调整）
ipcMain.handle('config:mark-server-manual', async (_, serverId: string) => {
    return configManager.markMcpServerManual(serverId);
});

// 获取所有被标记为「手动安装」的 MCP server id 列表
ipcMain.handle('config:get-manual-servers', async (): Promise<string[]> => {
    return configManager.getManualMcpServers();
});

ipcMain.handle('config:sync-server', async (_, serverId: string, sourceClient: ClientType, targetClients: ClientType[]) => {
    const result = await configManager.syncServerToClients(serverId, sourceClient, targetClients);
    // 在同步【之后】快照，确保「同步到客户端」这一操作被正确记录到历史
    await historyManager.backup();
    return result;
});

ipcMain.handle('config:sync-servers-batch', async (_, items: {
    serverId: string;
    config: any
}[], targetClients: ClientType[]) => {
    const result = await configManager.syncServersToClients(items, targetClients);
    await historyManager.backup();
    return result;
});

// 环境检测
ipcMain.handle('env:check-runtime', async (_, runtime: 'node' | 'python') => {
    return envManager.checkRuntime(runtime);
});

ipcMain.handle('env:get-all-runtimes', async () => {
    return envManager.getAllRuntimes();
});

ipcMain.handle('env:get-npx-path', async () => {
    return envManager.getNpxPath();
});

ipcMain.handle('env:get-uvx-path', async () => {
    return envManager.getUvxPath();
});

// 历史记录
ipcMain.handle('history:list', async () => {
    return historyManager.listBackups();
});

ipcMain.handle('history:restore', async (_, timestamp: string) => {
    return historyManager.restore(timestamp);
});

ipcMain.handle('history:get-diff', async (_, timestamp: string) => {
    return historyManager.getDiff(timestamp);
});

ipcMain.handle('history:clear-all', async () => {
    return historyManager.clearAll();
});

// 系统信息
ipcMain.handle('system:get-platform', () => {
    return process.platform;
});

ipcMain.handle('system:get-version', () => {
    return app.getVersion();
});

// ============ 在线更新（plan-19.0） ============
// 主进程只提供 IPC 动作与状态查询；autoUpdater 事件经 `update:status` 推给渲染层。
ipcMain.handle('update:get-status', () => {
    return getUpdateStatus();
});
ipcMain.handle('update:check', () => {
    checkForUpdatesAndNotify();
    return true;
});
ipcMain.handle('update:download', () => {
    downloadUpdateAndInstall();
    return true;
});
ipcMain.handle('update:quit-and-install', () => {
    quitAndInstall();
    return true;
});

ipcMain.handle('system:open-external', async (_, url: string) => {
    if (!isSafeExternalUrl(url)) {
        throw new Error('仅允许打开 http/https 链接');
    }
    return shell.openExternal(url);
});

ipcMain.handle('system:open-third-party-license', async () => {
    const candidates = [
        path.join(process.resourcesPath || '', 'THIRD_PARTY_LICENSES.md'),
        path.join(app.getAppPath(), 'THIRD_PARTY_LICENSES.md'),
        path.join(__dirname, '..', '..', 'THIRD_PARTY_LICENSES.md'),
        path.join(__dirname, '..', 'THIRD_PARTY_LICENSES.md'),
    ];
    for (const candidate of candidates) {
        try {
            if (existsSync(candidate)) {
                return shell.openPath(candidate);
            }
        } catch {
            // 忽略不可访问的路径
        }
    }
    throw new Error('未找到第三方开源许可声明文件');
});

// 自定义标题栏：窗口控制（Windows / Linux 无边框窗口）
ipcMain.on('window:minimize', () => {
    mainWindow?.minimize();
});

ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

ipcMain.on('window:close', () => {
    mainWindow?.close();
});

ipcMain.handle('window:is-maximized', () => {
    return mainWindow?.isMaximized() ?? false;
});

ipcMain.handle('system:get-config-path', (_, client?: ClientType) => {
    return configManager.getConfigPath(client);
});

ipcMain.handle('clients:set-custom-path', async (_, client: ClientType, customPath: string | null) => {
    return configManager.setCustomConfigPath(client, customPath);
});

// 添加用户手动客户端（并指定配置文件位置）
ipcMain.handle('clients:add-custom', async (_, input: { name: string; configPath: string; supportsSkills?: boolean; skillsPath?: string }) => {
    return configManager.addCustomClient(input);
});

// 删除用户手动客户端
ipcMain.handle('clients:remove-custom', async (_, id: string) => {
    return configManager.removeCustomClient(id);
});

// 打开配置文件所在目录
ipcMain.handle('system:open-config-directory', async (_, client: ClientType) => {
    const configPath = configManager.getConfigPath(client);
    const dir = require('path').dirname(configPath);
    return shell.openPath(dir);
});

// ============ MCP Inspector IPC 处理器 ============

// 连接到 MCP Server
ipcMain.handle('mcp:connect', async (_, sessionId: string, config: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    type?: 'stdio' | 'http' | 'streamable-http' | 'sse';
    headers?: Record<string, string>;
}) => {
    try {
        const client = createMcpClient(sessionId);

        // 设置事件监听
        client.on('stderr', (message: string) => {
            mainWindow?.webContents.send('mcp:stderr', {sessionId, message});
        });

        client.on('disconnected', (code: number) => {
            mainWindow?.webContents.send('mcp:disconnected', {sessionId, code});
        });

        client.on('error', (error: Error) => {
            mainWindow?.webContents.send('mcp:error', {sessionId, error: error.message});
        });

        const serverInfo = await client.connect(config);
        return {success: true, serverInfo};
    } catch (error) {
        return {success: false, error: (error as Error).message};
    }
});

// 断开连接
ipcMain.handle('mcp:disconnect', async (_, sessionId: string) => {
    removeMcpClient(sessionId);
    return {success: true};
});

// 获取连接状态
ipcMain.handle('mcp:is-connected', async (_, sessionId: string) => {
    const client = getMcpClient(sessionId);
    return client?.isConnected() || false;
});

// 获取工具列表
ipcMain.handle('mcp:list-tools', async (_, sessionId: string) => {
    try {
        const client = getMcpClient(sessionId);
        if (!client) {
            return {success: false, error: 'Not connected'};
        }
        const tools = await client.listTools();
        return {success: true, tools};
    } catch (error) {
        return {success: false, error: (error as Error).message};
    }
});

// 调用工具
ipcMain.handle('mcp:call-tool', async (_, sessionId: string, name: string, args: Record<string, unknown>) => {
    try {
        const client = getMcpClient(sessionId);
        if (!client) {
            return {success: false, error: 'Not connected'};
        }
        const result = await client.callTool(name, args);
        return {success: true, result};
    } catch (error) {
        return {success: false, error: (error as Error).message};
    }
});

// 获取资源列表
ipcMain.handle('mcp:list-resources', async (_, sessionId: string) => {
    try {
        const client = getMcpClient(sessionId);
        if (!client) {
            return {success: false, error: 'Not connected'};
        }
        const resources = await client.listResources();
        return {success: true, resources};
    } catch (error) {
        return {success: false, error: (error as Error).message};
    }
});

// 获取 Prompt 列表
ipcMain.handle('mcp:list-prompts', async (_, sessionId: string) => {
    try {
        const client = getMcpClient(sessionId);
        if (!client) {
            return {success: false, error: 'Not connected'};
        }
        const prompts = await client.listPrompts();
        return {success: true, prompts};
    } catch (error) {
        return {success: false, error: (error as Error).message};
    }
});

// ============ Skills IPC 处理器 ============

// 获取指定客户端的已安装 Skills
ipcMain.handle('skills:get-installed', async (_, client: SkillClientType) => {
    return skillsManager.getInstalledSkills(client);
});

// 获取所有客户端的已安装 Skills
// 注入安装态：共享同一物理 Skills 目录的客户端（如 trae-cn 与 trae-solo-cn 共用 ~/.trae-cn/skills）
// 技能只归属给其中实际已安装者，避免重复计数
ipcMain.handle('skills:get-all-installed', async () => {
    const clients = await configManager.getAllClients();
    const installed = clients.filter(c => c.installed).map(c => c.id as SkillClientType);
    return skillsManager.getAllInstalledSkills(installed);
});

// 安装 Skill
ipcMain.handle('skills:install', async (_, skillId: string, sourceInfo: SkillSourceMeta, clients: SkillClientType[]) => {
    const result = await skillsManager.installSkill(skillId, sourceInfo, clients);
    await historyManager.backup();
    return result;
});

// 卸载 Skill
ipcMain.handle('skills:uninstall', async (_, skillName: string, clients: SkillClientType[]) => {
    const result = await skillsManager.uninstallSkill(skillName, clients);
    await historyManager.backup();
    return result;
});

// 更新单个 Skill
ipcMain.handle('skills:update', async (_, skillName: string, client: SkillClientType) => {
    return skillsManager.updateSkill(skillName, client);
});

// 导出选中 Skill 为 zip 包（plan-3.0 后续增强）：选中多个打成一个 zip，每个 skill 一个目录
ipcMain.handle('skills:export-zip', async (_, names: string[]): Promise<SkillsExportResult> => {
    if (!Array.isArray(names) || names.length === 0) {
        return {ok: false, error: '没有可导出的 Skill'};
    }
    return exportSkillsToZip(names, () => skillsManager.getAllInstalledSkills());
});

// 批量更新所有 Skills
ipcMain.handle('skills:update-all', async (_, client: SkillClientType) => {
    return skillsManager.updateAllSkills(client);
});

// 检查 Skill 是否已安装
ipcMain.handle('skills:is-installed', async (_, skillId: string) => {
    return skillsManager.isSkillInstalled(skillId);
});

// 解析导入 URL，发现 Skills
ipcMain.handle('skills:parse-import-url', async (_, url: string) => {
    return skillsManager.parseImportUrl(url);
});

// 解析平台（ModelScope / SafeSkill / SkillHub）skill 详情页 URL，自动提取可下载源
ipcMain.handle('skills:resolve-platform-url', async (_, url: string) => {
    return resolvePlatformSkillUrl(skillsManager, url);
});

// 从发现的 Skill 安装
ipcMain.handle('skills:install-from-discovered', async (_, skill: DiscoveredSkill, clients: SkillClientType[]) => {
    const result = await skillsManager.installFromDiscovered(skill, clients);
    await historyManager.backup();
    return result;
});

/**
 * 从平台源（如虾评）安装 Skill：用连接绑定的令牌换取 zip 下载直链，再复用既有 zip 安装通道。
 * 平台未实现 fetchSkillDownload 时明确报错，避免静默回退到「无文件清单」的兜底路径产出空壳目录。
 */
ipcMain.handle('skills:install-platform-skill', async (_, connectionId: string, skillId: string, skillName: string, clients: SkillClientType[]): Promise<SkillInstallResult> => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) return {success: false, error: '连接不存在'};

    const sp = platformTypeToSupported(conn.platformType);
    const adapter = sp ? getAdapter(sp) : null;
    if (!adapter?.fetchSkillDownload) {
        return {
            success: false,
            error: `该平台源不支持在 mcp-dock 内安装（${conn.platformType}）：没有可用的下载通道。`,
        };
    }

    const secret = conn.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    let download: { downloadUrl: string; version?: string; coinsSpent?: number };
    try {
        download = await adapter.fetchSkillDownload({baseUrl: conn.baseUrl, skillId, secret});
    } catch (error) {
        // 取直链阶段尚未产生本地写入，直接透出平台原因（key 无效 / 未绑定 / 余额不足等）
        return {success: false, error: (error as Error).message};
    }

    const result = await skillsManager.installSkillFromZip(download.downloadUrl, skillName, clients, {
        id: skillId,
        repositoryUrl: conn.baseUrl,
    });
    if (result.success) await historyManager.backup();
    return result;
});

// 创建自定义 Skill（本地，无网络；zip 导入时 input.files 携带附属文件一并落盘）
ipcMain.handle('skills:create-custom', async (_, input: {
    name: string;
    description: string;
    body: string;
    files?: Array<{ path: string; data: Uint8Array }>;
}, clients: SkillClientType[]) => {
    const result = await skillsManager.createCustomSkill(input, clients);
    await historyManager.backup();
    return result;
});

// 更新自定义 Skill（改写 SKILL.md，可重命名；files/removedFiles 为附属文件变更）
ipcMain.handle('skills:update-custom', async (_, originalName: string, input: {
    name: string;
    description: string;
    body: string;
    files?: Array<{ path: string; data: Uint8Array }>;
    removedFiles?: string[];
}, clients: SkillClientType[]) => {
    const result = await skillsManager.updateCustomSkill(originalName, input, clients);
    await historyManager.backup();
    return result;
});

/**
 * 保存自定义 Skill 并同步云端。
 * 对应需求：在「我的库」编辑/创建 skill 后，同步更新到所选目标客户端。
 * 云同步规则（用户拍板：未选择云端存储时，不默认加入云端）：
 *   - 先按原逻辑写入 selectedClients（update-custom / create-custom）；
 *   - 仅当用户显式勾选了 cloud 客户端时才入队后台 push（cloud 暂存区已随 create/update 写入）；
 *   - 未勾选 cloud 或云端未配置 → 跳过云端同步，不影响本地保存。
 * 返回本地保存结果与云端同步状态，供 UI 提示。
 */
ipcMain.handle('skills:save-with-cloud-sync', async (_,
    isEdit: boolean,
    originalName: string | undefined,
    input: { name: string; description: string; body: string; files?: Array<{ path: string; data: Uint8Array }>; removedFiles?: string[] },
    clients: SkillClientType[]
): Promise<{
    success: boolean;
    error?: string;
    skillName?: string;
    cloud?: { pushed: boolean; skipped: boolean; message: string };
}> => {
    const saveRes = isEdit
        ? await skillsManager.updateCustomSkill(originalName!, input, clients)
        : await skillsManager.createCustomSkill(input, clients);

    if (!saveRes.success) {
        return {success: false, error: saveRes.error};
    }
    // 本地 skill 已写入成功后在【之后】快照，确保历史记录反映本次保存后的状态
    await historyManager.backup();
    const finalName = saveRes.skillName || input.name;

    const cloud: { pushed: boolean; skipped: boolean; enqueued: boolean; message: string } = {
        pushed: false,
        skipped: false,
        enqueued: false,
        message: '',
    };

    try {
        if (!cloudSyncStore.isActive()) {
            cloud.skipped = true;
            cloud.message = '云端未配置，已跳过';
        } else if (!clients.includes('cloud')) {
            // 未显式选择云端存储：不同步云端（P：不默认加入云端）
            cloud.skipped = true;
            cloud.message = '未选择云端存储，已跳过云端同步';
        } else {
            // cloud 已在写入目标中（暂存区由 create/update 直接写入），仅做后台 push，
            // 任务进入侧边栏「同步任务」面板跟踪状态
            getSyncTaskManager().enqueue('cloud-push', `上传到云端 · ${finalName}`, 'skills');
            cloud.enqueued = true;
            cloud.message = '已加入后台同步队列';
        }
    } catch (e: any) {
        cloud.message = (e as Error)?.message || '云端同步失败';
    }

    return {success: true, skillName: finalName, cloud};
});

// ==================== 同步任务（后台异步队列） ====================
// 「我的库」自动同步云端、手动「立即同步」等动作入队后，由 SyncTaskManager 后台串行处理；
// 侧边栏「同步任务」面板通过 sync-tasks:updated 事件实时刷新，失败任务可 retry 重同步。

ipcMain.handle('sync-tasks:list', (): SyncTask[] => {
    return getSyncTaskManager().list();
});

ipcMain.handle('sync-tasks:enqueue', (_, kind: SyncTaskKind, title: string, scope?: SyncTaskScope): SyncTask => {
    return getSyncTaskManager().enqueue(kind, title, scope);
});

ipcMain.handle('sync-tasks:retry', (_, id: string): boolean => {
    return getSyncTaskManager().retry(id);
});

ipcMain.handle('sync-tasks:remove', (_, id: string): void => {
    getSyncTaskManager().remove(id);
});

ipcMain.handle('sync-tasks:clear', (): void => {
    getSyncTaskManager().clear();
});

// 读取本地 Skill 的 SKILL.md（解析 frontmatter 与正文，用于编辑回填）
ipcMain.handle('skills:read-skill-md', async (_, skillName: string, client: SkillClientType) => {
    return skillsManager.readSkillMd(skillName, client);
});

// 列出 Skill 目录内附属文件（编辑模式「附属文件」面板；排除 .source.json，SKILL.md 标受保护）
ipcMain.handle('skills:list-skill-files', async (_, skillName: string, client: SkillClientType) => {
    return skillsManager.listSkillFiles(skillName, client);
});

// 读取 Skill 附属文件内容（UTF-8 校验；二进制 / 超大返回只读）
ipcMain.handle('skills:read-skill-file', async (_, skillName: string, client: SkillClientType, relPath: string) => {
    return skillsManager.readSkillFile(skillName, client, relPath);
});

// 从本地 .zip / .skill 文件解析 Skill（解包后读取 SKILL.md），用于「我的库」上传创建
ipcMain.handle('skills:import-file', async (_, filePath: string) => {
    return skillsManager.importFromFile(filePath);
});

// 从 ZIP/.skill 二进制（拖拽/选择文件读成 ArrayBuffer 传入）解析 Skill——不依赖 File.path，
// 沙箱/新版 Electron 下拖拽即用（plan-3.0 后续增强）
ipcMain.handle('skills:import-zip-buffer', async (_, data: Uint8Array) => {
    if (!data || data.byteLength === 0) {
        return {success: false, error: '未接收到文件内容'};
    }
    return skillsManager.importFromZipBuffer(data);
});

// 打开系统对话框选择一个已解压的 skill 文件夹，用于「我的库」上传创建
ipcMain.handle('skills:pick-folder', async () => {
    const result = await dialog.showOpenDialog({
        title: '选择 Skill 文件夹',
        properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return {canceled: true};
    return {canceled: false, path: result.filePaths[0]};
});

// 打开系统目录选择对话框（设置-添加自定义客户端等场景复用）。
// defaultPath 缺省回退到用户主目录，满足「选取默认当前用户目录」诉求。
ipcMain.handle('dialog:select-directory', async (_, defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
        title: '选择目录',
        properties: ['openDirectory'],
        defaultPath: defaultPath || app.getPath('home'),
    });
    if (result.canceled || result.filePaths.length === 0) return {canceled: true};
    return {canceled: false, path: result.filePaths[0]};
});

// 获取本地 Skill 详情（同样注入安装态做共享目录归属，见 skills:get-all-installed）
ipcMain.handle('skills:get-local-detail', async (_, skillId: string) => {
    const clients = await configManager.getAllClients();
    const installed = clients.filter(c => c.installed).map(c => c.id as SkillClientType);
    return skillsManager.getLocalSkillDetail(skillId, installed);
});

// 远程 GitHub Registry skill 详情：复用 parseImportUrl 解析仓库并取回首个 Skill 的源 / SKILL.md
// （替代渲染端 fetchSkillDetail 桩——该桩对所有内置 skill 一律抛错，导致详情页“加载失败”）
ipcMain.handle('skills:get-remote-detail', async (_, githubPath: string) => {
    try {
        const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(githubPath) ? githubPath : `https://github.com/${githubPath}`;
        const result = await skillsManager.parseImportUrl(url);
        if (!result.success || result.skills.length === 0) {
            return {success: false, skill: null, error: result.error || 'No SKILL.md found in this repository'};
        }
        return {success: true, skill: result.skills[0], error: null};
    } catch (e) {
        return {success: false, skill: null, error: (e as Error).message || 'Failed to load skill detail'};
    }
});

// 同步单个 Skill 到目标客户端
ipcMain.handle('skills:sync', async (_, skillName: string, sourceClient: SkillClientType, targetClients: SkillClientType[]) => {
    return skillsManager.syncSkillToClients(skillName, sourceClient, targetClients);
});

// 批量同步多个 Skill 到目标客户端
ipcMain.handle('skills:sync-batch', async (_, items: Array<{
    name: string;
    sourceClient: SkillClientType
}>, targetClients: SkillClientType[]) => {
    return skillsManager.syncSkillsToClients(items, targetClients);
});

// 检查 Skill 同步到云端前的冲突
ipcMain.handle('skills:check-cloud-conflicts', async (_, items: Array<{
    name: string;
    sourceClient: SkillClientType
}>): Promise<SkillCloudConflict[]> => {
    return skillsManager.checkCloudSyncConflicts(items);
});

// 按用户确认结果同步 Skill 到云端
ipcMain.handle('skills:sync-to-cloud-resolved', async (_, items: Array<{
    name: string;
    sourceClient: SkillClientType
}>, resolutions: Record<string, 'overwrite' | 'skip'>) => {
    return skillsManager.syncSkillsToCloudResolved(items, resolutions);
});

// 设置自定义 Skills 路径
ipcMain.handle('clients:set-custom-skills-path', async (_, client: SkillClientType, customPath: string | null) => {
    return configManager.setCustomSkillsPath(client, customPath);
});

// 打开 Skills 目录
ipcMain.handle('system:open-skills-directory', async (_, client: SkillClientType) => {
    const skillsPath = configManager.getSkillsPath(client);
    return shell.openPath(skillsPath);
});

// ============ API 令牌 IPC 处理器 ============
ipcMain.handle('api-tokens:list', async (): Promise<TokenMeta[]> => {
    return secretStore.listTokens();
});

ipcMain.handle('api-tokens:create', async (_, name: string, scopes: TokenScope[], expiresAt: number | null): Promise<TokenMeta> => {
    if (!name || !name.trim()) throw new Error('令牌名称不能为空');
    return secretStore.createToken(name, scopes, expiresAt);
});

ipcMain.handle('api-tokens:import', async (_, rawKey: string, name: string, platform?: string, expiresAt?: number | null): Promise<TokenMeta> => {
    if (!name || !name.trim()) throw new Error('令牌名称不能为空');
    return secretStore.importToken(rawKey, name, platform, expiresAt ?? null);
});

ipcMain.handle('api-tokens:reveal', async (_, id: string): Promise<string | null> => {
    return secretStore.revealToken(id);
});

ipcMain.handle('api-tokens:revoke', async (_, id: string): Promise<TokenMeta | null> => {
    return secretStore.revokeToken(id);
});

ipcMain.handle('api-tokens:restore', async (_, id: string): Promise<TokenMeta | null> => {
    return secretStore.restoreToken(id);
});

ipcMain.handle('api-tokens:delete', async (_, id: string): Promise<void> => {
    secretStore.deleteToken(id);
});

// ============ API 直连 IPC 处理器 ============
ipcMain.handle('api-connections:list', async (_, kind?: 'mcp' | 'skill'): Promise<ApiConnection[]> => {
    return connectionsStore.list(kind);
});

ipcMain.handle('api-connections:create', async (_, conn: Omit<ApiConnection, 'id' | 'createdAt' | 'status' | 'lastCheckedAt'>): Promise<ApiConnection> => {
    if (!conn.name || !conn.name.trim()) throw new Error('连接名称不能为空');
    if (!conn.baseUrl || !/^https?:\/\//i.test(conn.baseUrl)) throw new Error('Base URL 格式无效');
    return connectionsStore.upsert(conn);
});

ipcMain.handle('api-connections:update', async (_, conn: ApiConnection): Promise<ApiConnection> => {
    if (!conn.id) throw new Error('缺少连接 ID');
    return connectionsStore.upsert(conn);
});

ipcMain.handle('api-connections:delete', async (_, id: string): Promise<void> => {
    connectionsStore.delete(id);
});

ipcMain.handle('api-connections:verify', async (_, id: string): Promise<ApiConnection> => {
    return connectionsStore.verify(id);
});

ipcMain.handle('api-connections:export', async (_, id?: string): Promise<string> => {
    return connectionsStore.exportConfig(id);
});

// ============ API 直连驱动的平台搜索 / 解析 ============
ipcMain.handle('api-connections:search-platform', async (_, connectionId: string, query: string, page: number, pageSize?: number, category?: string): Promise<PlatformSkillListItem[]> => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    const secret = conn.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    // 资源类型决定 ModelScope 配额窗口（skill 2400 / mcp 100）；存量连接缺省视为 skill
    return searchPlatformDirect(conn.platformType, conn.baseUrl, secret, query, page, pageSize, category, conn.kind ?? 'skill');
});

/**
 * 分页搜索：返回条目 + 平台分页元信息（total / totalPages / hasMore）。
 * 渲染层据此渲染翻页控件。
 */
ipcMain.handle('api-connections:search-platform-paged', async (_, connectionId: string, query: string, page: number, pageSize?: number, category?: string): Promise<PlatformSearchPage> => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    const secret = conn.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    // 资源类型决定 ModelScope 配额窗口（skill 2400 / mcp 100）；存量连接缺省视为 skill
    return searchPlatformDirectPaged(conn.platformType, conn.baseUrl, secret, query, page, pageSize, category, conn.kind ?? 'skill');
});

/**
 * 获取最近一次直连搜索的诊断信息（端点探测链路、状态码、耗时、失败原因）。
 * 渲染层在"无结果"时调用，向用户展示具体原因而非空白列表。
 */
ipcMain.handle('api-connections:search-diagnostics', async (_, connectionId: string) => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    return getLastDirectSearchDiagnostics(conn.platformType);
});

ipcMain.handle('api-connections:resolve-skill', async (_, connectionId: string, sourceUrl: string): Promise<ReturnType<typeof resolveDirectSkill>> => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    return resolveDirectSkill(skillsManager, conn.platformType, sourceUrl);
});

/**
 * 分页搜索 MCP server（平台直连，如 ModelScope MCP 广场）。
 * 复用连接绑定的令牌，服务端分页；渲染层据此渲染翻页控件。
 */
ipcMain.handle('api-connections:search-servers-paged', async (_, connectionId: string, query: string, page: number, pageSize?: number, category?: string): Promise<PlatformServerSearchPage> => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    const secret = conn.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    return searchPlatformServersPaged(conn.platformType, conn.baseUrl, secret, query, page, pageSize, category);
});

/**
 * 获取单个平台 MCP server 的详情（含安装配置 / README）。
 * 复用连接绑定的令牌，平台直连（如 ModelScope）。
 */
ipcMain.handle('api-connections:get-server-detail', async (_, connectionId: string, serverId: string): Promise<PlatformServerDetail> => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    const secret = conn.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    return fetchPlatformServerDetail(conn.platformType, conn.baseUrl, secret, serverId);
});

// ============ 统一平台适配器通道（新架构） ============
// 以上旧通道保留向后兼容；以下通道委托 platforms/registry 统一调度，新增平台无需改动此处。
ipcMain.handle('platforms:search-skills', async (_, platformType: string, query: string, page: number, pageSize?: number, category?: string, sort?: string, connectionId?: string): Promise<PlatformSearchPage> => {
    const sp = platformTypeToSupported(platformType);
    // 未知平台类型仍抛错：避免把「类型写错」伪装成「平台不支持」。
    if (!sp) throw new Error(`不支持的平台类型：${platformType}`);
    const adapter = getAdapter(sp);
    // 已知平台类型但未注册 adapter、或该 adapter 没有 skill 搜索能力
    // （如 safeskill：站点未开放公开列表接口，官方文档声明的 /v1/search 实测 404）：
    // 返回 unsupported 而非抛错，让商店如实展示「该 Skill 源未提供公开列表接口」空态，
    // 与「有 adapter、但端点全返回 SPA」时置位的 unsupported 语义一致。
    // 抛错会退化为通用错误态（data.error），把「上游没有这个能力」误导成「加载失败」。
    if (!adapter || !adapter.searchSkills) {
        return {
            items: [],
            pageInfo: {page, pageSize: pageSize || 20, total: 0, totalPages: 0, hasMore: false},
            unsupported: true,
        };
    }
    // 提取为局部变量：闭包内 TS 不保留对可选属性的收窄；bind 保证方法内 this 指向 adapter
    const searchSkills = adapter.searchSkills.bind(adapter);
    // S0-6: 优先按连接 ID 精确取 token/baseUrl；未传则回退「按 platformType 取第一个」以兼容旧调用
    const conn = (connectionId && connectionsStore.get(connectionId)) || connectionsStore.list().find(c => c.platformType === platformType);
    const baseUrl = conn?.baseUrl || '';
    const secret = conn?.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    const params = {
        query,
        page,
        pageSize: pageSize || 20,
        category,
        sort,
        baseUrl,
        secret,
        // 运行时离线缓存目录（ClawHub 累积在线结果作为离线索引，避免写死静态索引）
        cacheDir: path.join(app.getPath('home'), '.ai-tools', 'cache', 'platforms'),
    };
    // 磁盘缓存 + SWR：命中缓存立即返回（过期则后台刷新），让平台源与内置源一样首屏秒开，
    // 冷启动/重启后不再每次都等一次网络。key 不含 secret，凭证不落盘；
    // 鉴权态参与 key（D11），避免绑定 Token 后仍命中匿名旧缓存。
    return withPlatformSearchCache(
        cacheManager,
        buildPlatformSearchKey({
            platformType,
            connectionId: conn?.id ?? null,
            baseUrl,
            query,
            page,
            pageSize: params.pageSize,
            category,
            sort,
            authorized: !!secret,
        }),
        () => searchSkills(params)
    );
});

ipcMain.handle('platforms:search-servers', async (_, platformType: string, query: string, page: number, pageSize?: number, category?: string, sort?: string, source?: string, connectionId?: string): Promise<PlatformServerSearchPage> => {
    const sp = platformTypeToSupported(platformType);
    const adapter = sp ? getAdapter(sp) : null;
    if (!adapter) throw new Error(`不支持的平台直连类型：${platformType}`);
    // S0-6: 优先按连接 ID 精确取 token/baseUrl；未传则回退「按 platformType 取第一个」以兼容旧调用
    const conn = (connectionId && connectionsStore.get(connectionId)) || connectionsStore.list().find(c => c.platformType === platformType);
    const baseUrl = conn?.baseUrl || '';
    const secret = conn?.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    if (!adapter.searchServers) return {items: [], pageInfo: {page, pageSize: pageSize || 20, total: 0, totalPages: 0, hasMore: false}};
    return adapter.searchServers({query, page, pageSize: pageSize || 20, category, sort, source, baseUrl, secret});
});

ipcMain.handle('platforms:server-detail', async (_, platformType: string, serverId: string, connectionId?: string): Promise<PlatformServerDetail> => {
    const sp = platformTypeToSupported(platformType);
    const adapter = sp ? getAdapter(sp) : null;
    if (!adapter || !adapter.fetchServerDetail) throw new Error(`该平台不支持 server 详情：${platformType}`);
    // S0-6: 优先按连接 ID 精确取 token/baseUrl；未传则回退「按 platformType 取第一个」以兼容旧调用
    const conn = (connectionId && connectionsStore.get(connectionId)) || connectionsStore.list().find(c => c.platformType === platformType);
    const baseUrl = conn?.baseUrl || '';
    const secret = conn?.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    return adapter.fetchServerDetail({query: '', page: 1, pageSize: 20, baseUrl, secret}, serverId);
});

ipcMain.handle('platforms:facets', async (_, platformType: string, resourceType?: 'mcp' | 'skills'): Promise<PlatformFacets> => {
    const sp = platformTypeToSupported(platformType);
    if (!sp) return {categories: [], sortOptions: [], supportsSubcategories: false};
    return getFacets(sp, resourceType);
});

ipcMain.handle('platforms:diagnostics', async (_, platformType: string) => {
    const sp = platformTypeToSupported(platformType);
    if (!sp) return null;
    return getLastDirectSearchDiagnostics(sp);
});

ipcMain.handle('platforms:list', async () => {
    return listAdapters().map(a => ({id: a.id, name: a.name}));
});

// ============ API 直连默认来源 ============
ipcMain.handle('api-connections:set-default', async (_, id: string): Promise<ApiConnection> => {
    connectionsStore.setDefault(id);
    return connectionsStore.get(id)!;
});

ipcMain.handle('api-connections:set-enabled', async (_, id: string, enabled: boolean): Promise<ApiConnection> => {
    return connectionsStore.setEnabled(id, enabled);
});

ipcMain.handle('api-connections:restore-builtin-mcp', async (): Promise<ApiConnection[]> => {
    return connectionsStore.restoreBuiltinMcpSources();
});

ipcMain.handle('api-connections:restore-builtin-skill', async (): Promise<ApiConnection[]> => {
    return connectionsStore.restoreBuiltinSkillSources();
});

// ============ 云同步 IPC 处理器 ============

ipcMain.handle('cloud-sync:get-config', async (): Promise<CloudSyncConfig> => {
    return cloudSyncStore.getConfig();
});

ipcMain.handle('cloud-sync:set-config', async (_, patch: CloudSyncConfigInput): Promise<CloudSyncConfig> => {
    const cfg = cloudSyncStore.setConfig(patch);
    // 云端存储是否作为「客户端」出现，取决于此配置；必须让客户端列表缓存失效，
    // 否则本会话内仍返回旧的 installed 状态，要重启才生效。
    configManager.invalidateClientsCache();
    return cfg;
});

ipcMain.handle('cloud-sync:test', async (): Promise<CloudSyncResult> => {
    return cloudSyncService.testConnection();
});

ipcMain.handle('cloud-sync:push', async (): Promise<CloudSyncResult> => {
    // 经由同步队列执行（P1-1），与启动 pull / 其他 push 串行，状态可见且避免并发冲突
    return enqueueCloudAndWait('cloud-push', '上传到云端');
});

ipcMain.handle('cloud-sync:pull', async (): Promise<CloudSyncResult> => {
    return enqueueCloudAndWait('cloud-pull', '从云端下载');
});

// ============ 云端一致性（plan-3.0） ============

/**
 * 主动检测本地客户端与云端（暂存区）的不一致项。
 * 云同步未激活时返回空报告（cloud 未激活时暂存区内容无意义，不产生噪音）。
 */
ipcMain.handle('cloud-sync:check-consistency', async (): Promise<ConsistencyReport> => {
    if (!getCloudSyncStore().isActive()) {
        return {items: [], checkedAt: new Date().toISOString()};
    }
    const clients = await configManager.getAllClients();
    const installed = clients.filter(c => c.installed && c.id !== 'cloud');
    const skillClients = installed
        .filter(c => c.supportsSkills)
        .map(c => c.id as SkillClientType);
    const mcpClients = installed
        .filter(c => c.supportsMcp)
        .map(c => c.id);

    return checkCloudConsistency({
        cloudSkillsPath: skillsManager.getSkillsPath('cloud'),
        cloudMcpConfigPath: configManager.getConfigPath('cloud'),
        localSkillDirs: skillClients.map(client => ({client, dir: skillsManager.getSkillsPath(client)})),
        localMcpConfigs: mcpClients.map(client => ({
            client,
            configPath: configManager.getConfigPath(client),
        })),
        readClientServers: (client) => configManager.getInstalledServers(client),
    });
});

/**
 * 对照查看：读取单个条目（skill / server）在本地端与云端端的内容文本。
 * renderer 只传 kind/name/localClient，路径解析收在 main，避免暴露暂存区结构。
 */
ipcMain.handle('cloud-sync:read-ends', async (_, req: {
    kind: 'skill' | 'server';
    name: string;
    localClient: string;
}): Promise<{ local: string | null; cloud: string | null }> => {
    if (!getCloudSyncStore().isActive()) {
        return {local: null, cloud: null};
    }
    const localPath = req.kind === 'skill'
        ? skillsManager.getSkillsPath(req.localClient as SkillClientType)
        : configManager.getConfigPath(req.localClient);
    const cloudPath = req.kind === 'skill'
        ? skillsManager.getSkillsPath('cloud')
        : configManager.getConfigPath('cloud');
    return readCompareEnds({kind: req.kind, name: req.name, localPath, cloudPath});
});

/**
 * 入队一个云同步任务并等待其完成，返回与 cloudSyncService 一致的 CloudSyncResult。
 * 轮询任务状态（队列本身已串行化），保证 IPC 调用方拿到的仍是结果对象，
 * 同时让任务出现在「同步任务」面板（P1-1）。
 */
async function enqueueCloudAndWait(kind: SyncTaskKind, title: string): Promise<CloudSyncResult> {
    const mgr = getSyncTaskManager();
    const task = mgr.enqueue(kind, title);
    return new Promise<CloudSyncResult>((resolve) => {
        const timer = setInterval(() => {
            const t = mgr.list().find(x => x.id === task.id);
            if (!t || t.status === 'success') {
                clearInterval(timer);
                resolve({ok: true, message: t?.detail ?? '同步完成'});
            } else if (t.status === 'failed') {
                clearInterval(timer);
                resolve({ok: false, message: t?.error ?? '同步失败'});
            }
        }, 150);
    });
}

// ============ 缓存 IPC 处理器 ============

// 缓存键类型
type CacheKey =
    | 'smithery-index'
    | 'skills-index'
    | `smithery-detail-${string}`
    | `skills-detail-${string}`;

// 获取缓存
ipcMain.handle('cache:get', async (_event, key: CacheKey) => {
    return cacheManager.get(key);
});

// 设置缓存
ipcMain.handle('cache:set', async (_event, key: CacheKey, data: unknown, etag?: string) => {
    return cacheManager.set(key, data, etag);
});

// 获取缓存元数据
ipcMain.handle('cache:get-meta', async (_, key: CacheKey) => {
    return cacheManager.getMeta(key);
});

// 检查缓存是否过期
ipcMain.handle('cache:is-expired', async (_, key: CacheKey) => {
    return cacheManager.isExpired(key);
});

// 检查缓存是否存在
ipcMain.handle('cache:has', async (_, key: CacheKey) => {
    return cacheManager.has(key);
});

// 删除指定缓存
ipcMain.handle('cache:delete', async (_, key: CacheKey) => {
    return cacheManager.delete(key);
});

// 清除所有缓存
ipcMain.handle('cache:clear', async () => {
    return cacheManager.clear();
});

// 按前缀清除缓存
ipcMain.handle('cache:clear-by-prefix', async (_, prefix: 'smithery' | 'skills') => {
    return cacheManager.clearByPrefix(prefix);
});

// 获取缓存统计信息
ipcMain.handle('cache:get-stats', async () => {
    return cacheManager.getStats();
});

// 获取缓存目录路径
ipcMain.handle('cache:get-directory', async () => {
    return cacheManager.getCacheDirectory();
});
