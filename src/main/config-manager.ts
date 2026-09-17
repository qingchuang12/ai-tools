/**
 * 配置管理器（编排门面）
 * 读写多个 MCP 客户端的配置文件
 *
 * 内置客户端清单统一维护在 ./config/types.ts 的 ALL_BUILTIN_CLIENTS：
 * Cursor / VS Code / Claude Code / Gemini CLI / Codex CLI / Windsurf / Zed / TRAE 系列 /
 * Kiro / Opencode / JetBrains / Antigravity / OpenClaw / CodeBuddy / WorkBuddy / Qoder / ZCode 等。
 *
 * 本文件为「编排门面」：类型/常量、路径探测、格式适配器、设置持久化均已下沉到
 * `./config/*` 子模块，此处仅保留 ConfigManager 类并委托给它们，对外 API 完全不变。
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import {getCloudSyncStore} from './cloud-sync-store';
import {resolveSkillsPath} from './client-paths';

import {
    ALL_BUILTIN_CLIENTS,
    AnyClientId,
    ClientConfig,
    ClientInfo,
    ClientType,
    CustomClientDef,
    EXECUTABLE_ONLY_CLIENTS,
    McpServerConfig,
    SKILL_SUPPORTED_CLIENTS,
    SkillClientType,
} from './config/types';
import {
    findJetBrainsConfigPath,
    getClientAppPaths,
    getClientConfigMarkers,
    getClientDisplayName,
    getClientMcpCandidatePaths,
    getEnhancedPathEnv,
} from './config/client-probe';
import {
    defaultConfigForMissing,
    reachesDefaultBranch,
    readClientConfig,
    writeClientConfig,
} from './config/format-adapters';
import {assertSafeConfigPath, loadUserSettingsFile, UserSettings, writeFileAtomic,} from './config/settings-store';

export * from './config/types';

// ---------------------------------------------------------------------------
//  Phase 6：安装第三方 MCP server 时，自动将其许可证汇总进运行时文件，避免 GPL/MIT 等义务被遗漏。
//  仅当 serverConfig.license 存在才写入（modelscope 等不传则跳过，保持隔离）。
// ---------------------------------------------------------------------------
const LICENSE_INDEX_PATH = path.join(os.homedir(), '.ai-tools', 'installed-mcp-licenses.json');
const LICENSE_INDEX_VERSION = 1;

interface LicenseIndexEntry {
    serverId: string;
    license: string;
    source?: string;
    homepage?: string;
    installedAt: string;
    clients: string[];
}
interface LicenseIndexFile {
    version: number;
    updatedAt: string;
    servers: Record<string, LicenseIndexEntry>;
}

async function readLicenseIndex(): Promise<LicenseIndexFile> {
    try {
        const raw = await fs.readFile(LICENSE_INDEX_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<LicenseIndexFile>;
        return {
            version: LICENSE_INDEX_VERSION,
            updatedAt: parsed.updatedAt || new Date().toISOString(),
            servers: parsed.servers || {},
        };
    } catch {
        return {version: LICENSE_INDEX_VERSION, updatedAt: new Date().toISOString(), servers: {}};
    }
}

async function writeLicenseIndex(index: LicenseIndexFile): Promise<void> {
    index.updatedAt = new Date().toISOString();
    await fs.writeFile(LICENSE_INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
}

async function upsertInstalledLicense(serverId: string, cfg: McpServerConfig, clients: string[]): Promise<void> {
    if (!cfg.license) return;
    const index = await readLicenseIndex();
    index.servers[serverId] = {
        serverId,
        license: cfg.license,
        source: cfg.source,
        homepage: cfg.homepage,
        installedAt: new Date().toISOString(),
        clients,
    };
    await writeLicenseIndex(index);
}

async function removeInstalledLicense(serverId: string): Promise<void> {
    const index = await readLicenseIndex();
    if (index.servers[serverId]) {
        delete index.servers[serverId];
        await writeLicenseIndex(index);
    }
}

export class ConfigManager {
    private userSettingsPath: string;
    private userSettings: UserSettings = {};
    // 客户端列表缓存：安装状态在会话内很少变化，重复进入「我的库」时直接返回，避免每次重跑检测（含 CLI 的 where/which）。
    private clientsCache: ClientInfo[] | null = null;

    /** 设置加载完成的信号；所有写操作前 await，避免构造期 fire-and-forget 加载未完成就写回空对象（P0-5） */
    private ready: Promise<void> = Promise.resolve();

    constructor() {
        const home = os.homedir();

        // 用户设置文件路径
        this.userSettingsPath = path.join(home, '.ai-tools', 'settings.json');

        // 异步加载用户设置（可 await 的 ready Promise）
        this.ready = this.loadUserSettings();
    }

    /**
     * 加载用户设置
     */
    private async loadUserSettings(): Promise<void> {
        this.userSettings = await loadUserSettingsFile(this.userSettingsPath);
        this.resolvedJetBrainsPath = await findJetBrainsConfigPath(os.homedir(), process.platform);
    }

    private resolvedJetBrainsPath: string = '';

    private async saveUserSettings(): Promise<void> {
        // 确保构造期加载已完成，避免用空对象覆盖整份设置（P0-5）
        await this.ready;
        try {
            await writeFileAtomic(this.userSettingsPath, JSON.stringify(this.userSettings, null, 2));
        } catch (error) {
            console.error('Failed to save user settings:', error);
        }
    }

    /**
     * 校验自定义客户端路径安全性（P1-6）：转发到 ./config/settings-store
     */
    private assertSafeConfigPath(raw: string, field: string): string {
        return assertSafeConfigPath(raw, field);
    }

    /**
     * 设置自定义配置路径
     */
    async setCustomConfigPath(client: ClientType, customPath: string | null): Promise<void> {
        await this.ready;
        if (!this.userSettings.customConfigPaths) {
            this.userSettings.customConfigPaths = {};
        }

        if (customPath) {
            this.userSettings.customConfigPaths[client] = customPath;
        } else {
            delete this.userSettings.customConfigPaths[client];
        }

        await this.saveUserSettings();
        this.invalidateClientsCache();
    }

    /**
     * 获取客户端 Skills 目录路径（优先使用用户自定义路径）
     */
    getSkillsPath(client: SkillClientType | string): string {
        return resolveSkillsPath(client, {
            customClients: this.userSettings.customClients,
            customSkillsPaths: this.userSettings.customSkillsPaths,
        });
    }

    /**
     * 设置自定义 Skills 路径
     */
    async setCustomSkillsPath(client: SkillClientType, customPath: string | null): Promise<void> {
        if (!this.userSettings.customSkillsPaths) {
            this.userSettings.customSkillsPaths = {};
        }

        if (customPath) {
            this.userSettings.customSkillsPaths[client] = customPath;
        } else {
            delete this.userSettings.customSkillsPaths[client];
        }

        await this.saveUserSettings();
        this.invalidateClientsCache();
    }

    /**
     * 添加用户手动客户端。id 形如 custom:<slug>，slug 由 name 派生。
     * 若同名下已存在则返回已存在项（去重）。
     */
    async addCustomClient(input: { name: string; configPath: string; supportsSkills?: boolean; skillsPath?: string }): Promise<CustomClientDef> {
        await this.ready;
        if (!this.userSettings.customClients) {
            this.userSettings.customClients = [];
        }
        const name = input.name.trim() || 'Custom Client';
        // 名称去重：同名（不区分大小写）自定义客户端已存在则拒绝，避免列表出现重复项。
        const dup = this.userSettings.customClients.find(
            c => c.name.trim().toLowerCase() === name.toLowerCase(),
        );
        if (dup) {
            throw new Error(`DUPLICATE_CLIENT_NAME:${name}`);
        }
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'client';
        let id = `custom:${slug}`;
        // 保证 id 唯一
        let n = 2;
        while (this.userSettings.customClients.some(c => c.id === id)) {
            id = `custom:${slug}-${n}`;
            n++;
        }
        const def: CustomClientDef = {
            id,
            name,
            configPath: this.assertSafeConfigPath(input.configPath.trim(), 'configPath'),
            supportsSkills: !!input.supportsSkills,
            skillsPath: input.supportsSkills
                ? this.assertSafeConfigPath(input.skillsPath?.trim() || '', 'skillsPath')
                : undefined,
        };
        this.userSettings.customClients.push(def);
        await this.saveUserSettings();
        this.invalidateClientsCache();
        return def;
    }

    /**
     * 删除用户手动客户端
     */
    async removeCustomClient(id: string): Promise<void> {
        await this.ready;
        if (!this.userSettings.customClients) return;
        this.userSettings.customClients = this.userSettings.customClients.filter(c => c.id !== id);
        await this.saveUserSettings();
        this.invalidateClientsCache();
    }

    /**
     * 获取所有用户手动客户端
     */
    getCustomClients(): CustomClientDef[] {
        return this.userSettings.customClients || [];
    }

    /**
     * 返回全部应纳入备份/遍历的客户端类型：内置全量 + 用户手动添加（P1-3）。
     * 'cloud' 暂存区非真实客户端配置，不在此列。
     */
    getClientTypes(): ClientType[] {
        const custom = (this.userSettings.customClients || []).map(c => c.id as ClientType);
        return [...ALL_BUILTIN_CLIENTS, ...custom];
    }

    /**
     * 标记 MCP server 为「手动安装」：用户在「我的库」编辑保存后调用，
     * 此后该 server 不再被当作商店来源（避免从线上商店更新覆盖本地调整）。
     */
    async markMcpServerManual(serverId: string): Promise<void> {
        await this.ready;
        if (!this.userSettings.manualMcpServers) {
            this.userSettings.manualMcpServers = [];
        }
        if (!this.userSettings.manualMcpServers.includes(serverId)) {
            this.userSettings.manualMcpServers.push(serverId);
            await this.saveUserSettings();
        }
    }

    /**
     * 获取所有被标记为「手动安装」的 MCP server id 列表
     */
    getManualMcpServers(): string[] {
        return this.userSettings.manualMcpServers || [];
    }

    /**
     * 获取客户端显示名称（转发到 ./config/client-probe）
     */
    private getClientName(client: ClientType | string): string {
        return getClientDisplayName(client);
    }

    /**
     * 获取各平台的应用路径（转发到 ./config/client-probe）
     */
    private getAppPaths(client: AnyClientId): string[] {
        return getClientAppPaths(client, process.platform);
    }

    /**
     * 客户端「配置目录标记」（转发到 ./config/client-probe）
     */
    private getConfigMarkers(client: AnyClientId): string[] {
        return getClientConfigMarkers(client);
    }

    /**
     * 获取增强的 PATH（转发到 ./config/client-probe）
     */
    private getEnhancedPath(): string {
        return getEnhancedPathEnv();
    }

    /**
     * 检查客户端应用是否已安装（只检查应用程序，不检查配置文件）
     * 对于 CLI 工具（codex-cli, opencode 等），额外通过 which/where 命令检测
     */
    private async isClientInstalled(client: ClientType | string): Promise<boolean> {
        // 用户手动添加的客户端：配置文件存在即视为可用（手动指定路径，无需探测可执行文件）
        const custom = this.userSettings.customClients?.find(c => c.id === client);
        if (custom) {
            try {
                await fs.access(custom.configPath);
                return true;
            } catch {
                // 配置文件不存在：仍视为可用，让用户在"未安装"区也能看到并编辑路径
                return true;
            }
        }

        // 云端存储是虚拟客户端：只有配置好云同步（Git / SFTP）后才视为「已安装」，
        // 未配置时它不会出现在同步窗口的目标列表里。
        if (client === 'cloud') return getCloudSyncStore().isActive();

        const paths = this.getAppPaths(client);

        for (const appPath of paths) {
            try {
                await fs.access(appPath);
                return true;
            } catch {
                // 继续检查下一个路径
            }
        }

        // 配置目录探测：部分客户端以 IDE 插件形态存在（如 CodeBuddy 可作为
        // JetBrains / VS Code 插件安装），没有独立可执行文件，也不注册 CLI。
        // 此时用户主目录下的配置目录才是唯一可靠的"已安装"信号。
        // 由于本软件只需完成配置同步，配置目录存在即足以支持全部功能。
        for (const marker of this.getConfigMarkers(client)) {
            try {
                await fs.access(marker);
                return true;
            } catch {
                // 继续
            }
        }

        // CLI 工具通过 which/where 命令作为后备检测
        const cliClients: Partial<Record<ClientType, string>> = {
            'codex-cli': 'codex',
            'opencode': 'opencode',
            'claude-code': 'claude',
            'gemini-cli': 'gemini',
            'openclaw': 'openclaw',
            'codebuddy': 'codebuddy',
        };

        const cliName = cliClients[client as ClientType];
        if (cliName) {
            try {
                const {exec} = require('child_process');
                const {promisify} = require('util');
                const execAsync = promisify(exec);
                const whichCmd = process.platform === 'win32' ? 'where' : 'which';
                const {stdout} = await execAsync(`${whichCmd} ${cliName}`, {
                    timeout: 3000,
                    env: {...process.env, PATH: this.getEnhancedPath()},
                });
                if (stdout && stdout.trim()) return true;
            } catch {
                // which/where 失败，CLI 未安装
            }
        }

        // 识别优化兜底：只要该客户端的配置文件已存在，即视为已安装。
        // 许多客户端（如 vscode / zed / trae / kiro 等）即使可执行文件不在常见路径，
        // 只要用户已生成过 MCP 配置，就应该在「已安装」列表中出现，避免被误判为未安装。
        try {
            await fs.access(this.getClientConfigPath(client));
            return true;
        } catch {
            // 配置文件不存在
        }

        return false;
    }

    /**
     * 检查配置文件是否存在
     */
    private async configExists(client: ClientType | string): Promise<boolean> {
        try {
            await fs.access(this.getClientConfigPath(client));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 获取所有客户端信息
     */
    async getAllClients(force = false): Promise<ClientInfo[]> {
        // 确保用户设置已加载
        await this.loadUserSettings();

        // 命中会话缓存则直接返回（见 clientsCache / invalidateClientsCache）
        // force=true（来自刷新按钮）时绕过缓存，重新探测所有客户端的安装/配置状态。
        if (!force && this.clientsCache) {
            return this.clientsCache;
        }

        // 内置客户端清单统一取自 ALL_BUILTIN_CLIENTS，避免每加一个客户端就要同步多处字面量数组。
        // 'agent-skills'（.agents 统一标准）与 'cloud'（云同步暂存区）是「仅 Skill」的虚拟客户端，
        // 不在 ALL_BUILTIN_CLIENTS 内（避免污染 MCP 备份/服务器扫描遍历），单独追加在末尾。
        const clients: AnyClientId[] = [...ALL_BUILTIN_CLIENTS, 'agent-skills', 'cloud'];

        // 并行检测所有客户端：原先串行 await 每个客户端的 isClientInstalled（其中 CLI 客户端
        // 要走 where/which，最坏有 3s 超时），全部客户端串行累计可达 1~2s，导致「我的库」打开明显卡顿。
        // 改为并发后，耗时约等于最慢单个客户端的检测时间。
        const results: ClientInfo[] = await Promise.all(clients.map(async (client): Promise<ClientInfo> => {
            const [installed, configExists] = await Promise.all([
                this.isClientInstalled(client),
                this.configExists(client),
            ]);

            const supportsSkills = SKILL_SUPPORTED_CLIENTS.includes(client as SkillClientType);
            const supportsMcp = client !== 'cloud' && client !== 'agent-skills';

            // 已安装判定合并「客户端本体探测」与「配置文件存在」两个信号：
            // - 客户端装了但没配过 MCP（isClientInstalled=true、configExists=false）→ 应判已安装，
            //   否则会出现「装了 ZCode 却显示未安装」这类反直觉结果；
            // - 仅残留配置文件（isClientInstalled=false、configExists=true）→ 仍判已安装（GUI/IDE 形态）。
            // 例外（用户报障修正）：EXECUTABLE_ONLY_CLIENTS（纯 CLI 形态）忽略 configExists 兜底——
            // ~/.claude.json 等配置可能由第三方脚本或本应用写 MCP 配置时创建，
            // 文件存在不代表 CLI 本体已安装，误把未装的 Claude Code 显示为已安装。
            // UI 侧另有独立的 configExists 字段，可区分「已安装但未配置」。
            // cloud 是虚拟客户端，installed 由云同步是否激活决定，不并入上面的探测逻辑。
            const isInstalled = client === 'cloud' || EXECUTABLE_ONLY_CLIENTS.includes(client as ClientType)
                ? installed
                : (installed || configExists);

            return {
                id: client,
                name: this.getClientName(client),
                installed: isInstalled,
                // agent-skills 无 MCP 配置文件，configPath 指向其根目录仅作展示
                //（设置页卡片显示目录名；configExists 对它恒为 false，无副作用）
                configPath: client === 'agent-skills'
                    ? path.join(os.homedir(), '.agents')
                    : this.getClientConfigPath(client),
                configExists,
                supportsSkills,
                supportsMcp,
                skillsPath: supportsSkills ? this.getSkillsPath(client as SkillClientType) : undefined,
            };
        }));

        // 合并用户手动添加的客户端
        const customClients = this.userSettings.customClients || [];
        const customResults: ClientInfo[] = await Promise.all(customClients.map(async (def): Promise<ClientInfo> => {
            let configExists = false;
            try {
                await fs.access(def.configPath);
                configExists = true;
            } catch {
                // 配置文件不存在
            }
            return {
                id: def.id,
                name: def.name,
                installed: true,
                configPath: def.configPath,
                configExists,
                supportsSkills: def.supportsSkills,
                // 用户手动添加的客户端：本质就是指定 MCP 配置文件路径，天然支持 MCP 写入
                supportsMcp: true,
                skillsPath: def.supportsSkills ? def.skillsPath : undefined,
                isCustom: true,
            };
        }));

        this.clientsCache = [...results, ...customResults];
        return this.clientsCache;
    }

    /**
     * 客户端列表缓存失效：安装新客户端 / 改自定义路径 / 写入配置 / 云同步开关变更后调用，
     * 下次 getAllClients 会重新检测，保证「已安装 / 配置存在」状态实时准确。
     */
    invalidateClientsCache(): void {
        this.clientsCache = null;
    }

    /**
     * 获取客户端配置路径（优先用户自定义，否则在候选路径中探测首个存在者）。
     *
     * 关键增强：内置客户端的 MCP 配置文件可能存在多形态（如 Trae 的 fork/扁平布局、
     * CodeBuddy 的 .mcp.json/mcp.json/legacy），此处用同步 existsSync 在候选列表里
     * 挑第一个真实存在的文件；都不存在时回退到首选（写路径）。读取与写入因此永远落在
     * 同一文件，保证往返一致，且能兼容多种安装布局（需求 G：尽量做好自动识别客户端能力）。
     */
    private getClientConfigPath(client: ClientType | string): string {
        // 自定义客户端：直接返回其配置路径
        const custom = this.userSettings.customClients?.find(c => c.id === client);
        if (custom) return custom.configPath;

        if (client === 'jetbrains') {
            const customPath = this.userSettings.customConfigPaths?.['jetbrains'];
            if (customPath) return customPath;
            return this.resolvedJetBrainsPath || '';
        }
        const customOverride = this.userSettings.customConfigPaths?.[client as ClientType];
        if (customOverride) return customOverride;

        const candidates = getClientMcpCandidatePaths(client as AnyClientId, process.platform);
        for (const candidate of candidates) {
            try {
                fsSync.accessSync(candidate);
                return candidate;
            } catch {
                // 该候选不存在，尝试下一个
            }
        }
        return candidates[0] || '';
    }

    /**
     * 获取指定客户端的配置文件路径
     */
    getConfigPath(client: AnyClientId = 'cursor'): string {
        return this.getClientConfigPath(client);
    }

    /**
     * 确保配置目录存在
     */
    private async ensureConfigDir(client: AnyClientId): Promise<void> {
        const configPath = this.getClientConfigPath(client);
        const dir = path.dirname(configPath);
        await fs.mkdir(dir, {recursive: true});
    }

    /**
     * 读取配置文件（委托 ./config/format-adapters）
     */
    async readConfig(client: AnyClientId = 'cursor'): Promise<ClientConfig> {
        const configPath = this.getClientConfigPath(client);

        try {
            const content = await fs.readFile(configPath, 'utf-8');
            return readClientConfig(client, content);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return defaultConfigForMissing(client);
            }
            throw error;
        }
    }

    /**
     * 写入配置文件（委托 ./config/format-adapters）
     */
    async writeConfig(config: ClientConfig, client: AnyClientId = 'cursor', merge = true): Promise<void> {
        await this.ensureConfigDir(client);
        const configPath = this.getClientConfigPath(client);

        // 关键修复：以「当前客户端配置文件里【已有的】 server」为基准做合并，
        // 再叠加本次要写入的 server。这样即便前面 readConfig 因键名/格式差异漏读了
        // 用户原有的 mcpServers，这里也会兜底保留，绝不会把客户端原 mcp 覆盖掉。
        // 但卸载场景（merge=false）必须以传入内容为准：传入里被显式删除的 server
        // 必须真正从磁盘移除，不能被 live 兜底"复活"。
        if (merge) {
            try {
                const liveConfig = await this.readConfig(client);
                const liveServers = liveConfig.mcpServers || {};
                config.mcpServers = {...liveServers, ...(config.mcpServers || {})};
            } catch {
                // 读不到（如文件不存在）则退化为以传入的 config.mcpServers 为准
            }
        }

        // 读取现有内容（文件不存在则按 '{}' 处理），交由 writeClientConfig 按客户端格式序列化
        let existingContent = '{}';
        try {
            existingContent = await fs.readFile(configPath, 'utf-8');
        } catch {
            // 文件不存在
        }

        const out = writeClientConfig(client, config, existingContent);
        await writeFileAtomic(configPath, out);
        // 仅「默认分支」触发缓存失效（原 writeConfig 行为：jetbrains/codex/openclaw/opencode/
        // claude+zed/servers-key 分支提前 return，不失效缓存；只有默认分支会失效）。
        if (reachesDefaultBranch(client)) {
            this.invalidateClientsCache();
        }
    }

    /**
     * 获取已安装的服务器列表（从指定客户端）
     */
    async getInstalledServers(client: AnyClientId = 'cursor'): Promise<Record<string, McpServerConfig>> {
        const config = await this.readConfig(client);
        // 兼容不同客户端配置键名：mcpServers（Claude/VS Code/WorkBuddy 等）或 servers（部分格式）。
        return config.mcpServers || config.servers || {};
    }

    /**
     * 获取所有客户端中已安装的服务器（合并去重）
     */
    async getAllInstalledServers(): Promise<{
        servers: Record<string, { config: McpServerConfig; clients: AnyClientId[] }>;
        byClient: Record<string, Record<string, McpServerConfig>>;
    }> {
        // 确保用户设置（含自定义客户端）已加载
        await this.loadUserSettings();
        // 内置客户端 + 用户手动添加的自定义客户端（custom:<slug>），保证新增客户端也会被扫描。
        const customIds: string[] = (this.userSettings.customClients || []).map(c => c.id);
        const clients: AnyClientId[] = [
            ...ALL_BUILTIN_CLIENTS,
            'cloud',
            ...customIds,
        ];
        const servers: Record<string, { config: McpServerConfig; clients: AnyClientId[] }> = {};
        // 由 clients 派生，键集合与遍历范围永远一致，杜绝「列表加了新客户端、byClient 忘了补」的漏算
        const byClient: Record<string, Record<string, McpServerConfig>> = Object.fromEntries(
            clients.map(id => [id, {} as Record<string, McpServerConfig>])
        );

        for (const client of clients) {
            try {
                const clientServers = await this.getInstalledServers(client);
                byClient[client] = clientServers;

                for (const [serverId, config] of Object.entries(clientServers)) {
                    if (servers[serverId]) {
                        servers[serverId].clients.push(client);
                    } else {
                        servers[serverId] = {config, clients: [client]};
                    }
                }
            } catch {
                // 忽略读取失败的客户端
            }
        }

        return {servers, byClient};
    }

    /**
     * 安装服务器到指定客户端
     */
    async installServer(
        serverId: string,
        serverConfig: McpServerConfig,
        clients: AnyClientId[] = ['cursor']
    ): Promise<{ success: AnyClientId[]; failed: AnyClientId[] }> {
        const success: AnyClientId[] = [];
        const failed: AnyClientId[] = [];

        for (const client of clients) {
            try {
                const config = await this.readConfig(client);

                if (!config.mcpServers) {
                    config.mcpServers = {};
                }
                config.mcpServers[serverId] = serverConfig;

                await this.writeConfig(config, client);
                success.push(client);
            } catch (error) {
                console.error(`[ConfigManager] Failed to install to ${client}:`, error);
                failed.push(client);
            }
        }

        // Phase 6：安装成功后聚合许可证（仅当传入 license；失败不阻塞安装结果）
        try {
            if (success.length > 0) {
                await upsertInstalledLicense(serverId, serverConfig, success);
            }
        } catch (e) {
            console.warn('[ConfigManager] 许可证聚合失败（已忽略）:', e);
        }

        return {success, failed};
    }

    /**
     * 从指定客户端卸载服务器
     */
    async uninstallServer(
        serverId: string,
        clients: AnyClientId[] = ['cursor']
    ): Promise<{ success: AnyClientId[]; failed: AnyClientId[] }> {
        const success: AnyClientId[] = [];
        const failed: AnyClientId[] = [];

        for (const client of clients) {
            try {
                const config = await this.readConfig(client);
                if (config.mcpServers && config.mcpServers[serverId]) {
                    delete config.mcpServers[serverId];
                    await this.writeConfig(config, client, false);
                }
                success.push(client);
            } catch (error) {
                console.error(`Failed to uninstall from ${client}:`, error);
                failed.push(client);
            }
        }

        // Phase 6：卸载成功后从许可证汇总中移除该 server（失败不阻塞卸载结果）
        try {
            if (success.length > 0) {
                await removeInstalledLicense(serverId);
            }
        } catch (e) {
            console.warn('[ConfigManager] 许可证移除失败（已忽略）:', e);
        }

        // 若目标含云端存储：暂存区已删除该 server。远端推送统一由渲染层
        // confirmUninstall → pushCloudAsync 在后台异步完成（不阻塞卸载界面）。
        return {success, failed};
    }

    /**
     * 更新服务器配置
     */
    async updateServer(
        serverId: string,
        serverConfig: McpServerConfig,
        client: AnyClientId = 'cursor'
    ): Promise<void> {
        const config = await this.readConfig(client);
        if (!config.mcpServers) {
            config.mcpServers = {};
        }
        config.mcpServers[serverId] = serverConfig;
        await this.writeConfig(config, client);
    }

    /**
     * 同步服务器到其他客户端
     */
    async syncServerToClients(
        serverId: string,
        sourceClient: AnyClientId,
        targetClients: AnyClientId[]
    ): Promise<{ success: AnyClientId[]; failed: AnyClientId[] }> {
        const servers = await this.getInstalledServers(sourceClient);
        const serverConfig = servers[serverId];

        if (!serverConfig) {
            return {success: [], failed: targetClients};
        }

        return this.installServer(serverId, serverConfig, targetClients);
    }

    /**
     * 批量同步多个服务器到其他客户端（用于「我的库」多客户端复用）
     * 每个服务器使用自身已安装客户端的配置作为源，安装到所有目标客户端。
     */
    async syncServersToClients(
        items: { serverId: string; config: McpServerConfig }[],
        targetClients: AnyClientId[]
    ): Promise<{
        synced: number;
        failed: number;
        details: { serverId: string; success: AnyClientId[]; failed: AnyClientId[] }[];
    }> {
        const details: { serverId: string; success: AnyClientId[]; failed: AnyClientId[] }[] = [];
        let synced = 0;
        let failed = 0;

        for (const item of items) {
            if (!item.config) {
                failed += 1;
                details.push({serverId: item.serverId, success: [], failed: targetClients});
                continue;
            }
            const result = await this.installServer(item.serverId, item.config, targetClients);
            details.push({serverId: item.serverId, success: result.success, failed: result.failed});
            if (result.success.length > 0) synced += 1;
            if (result.failed.length > 0) failed += 1;
        }

        return {synced, failed, details};
    }

    /**
     * 检查服务器是否已安装（在任意客户端）
     */
    async isServerInstalled(serverId: string): Promise<boolean> {
        const {servers} = await this.getAllInstalledServers();
        return serverId in servers;
    }

    /**
     * 生成 Smithery CLI 配置
     */
    generateServerConfig(
        runtime: 'node' | 'python',
        qualifiedName: string,
        configValues: Record<string, any>,
        npxPath: string = 'npx',
        uvxPath: string = 'uvx'
    ): McpServerConfig {
        if (runtime === 'node') {
            return {
                command: npxPath,
                args: [
                    '-y',
                    '@smithery/cli@latest',
                    'run',
                    qualifiedName,
                    '--config',
                    JSON.stringify(configValues),
                ],
            };
        } else {
            return {
                command: uvxPath,
                args: [
                    'smithery-cli',
                    'run',
                    qualifiedName,
                    '--config',
                    JSON.stringify(configValues),
                ],
            };
        }
    }
}
