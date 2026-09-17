/**
 * 历史记录管理器
 * 负责所有客户端配置文件的备份和恢复（包括 MCP Servers 和 Skills）
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {ClientType, ConfigManager, SKILL_SUPPORTED_CLIENTS, SkillClientType} from './config-manager';

export interface BackupInfo {
    timestamp: string;
    filename: string;
    size: number;
    /** 去重后的 MCP server 数（同一 server 装在多个客户端只计 1 次） */
    serverCount: number;
    /** 去重后的 Skill 数 */
    skillCount: number;
    /** 仅含真正承载内容的客户端（有 MCP server 或 Skill），不含未安装的空配置客户端 */
    clients: ClientType[];
}

export interface DiffResult {
    added: string[];
    removed: string[];
    modified: string[];
    current: Record<string, any>;
    backup: Record<string, any>;
    // Skills 变更
    skillsAdded: string[];
    skillsRemoved: string[];
    /** 内容发生变更的 Skill 名（跨客户端去重）。仅当前后两条备份都含 skillContents 时才可能有值。 */
    skillsModified: string[];
    /** 客户端级变更（修复：按全局 server 集合比较会漏掉「从多客户端之一移除」等单客户端变更） */
    clientChanges?: { client: string; added: string[]; removed: string[]; modified: string[] }[];
    /** Skills 客户端级变更；modified 为「内容变更」（名字未变、SKILL.md 变了） */
    skillClientChanges?: { client: string; added: string[]; removed: string[]; modified: string[] }[];
}

interface BackupData {
    timestamp: string;
    clients: {
        [key in ClientType]?: {
            config: any;
            serverCount: number;
        };
    };
    skills?: {
        [key in SkillClientType]?: string[];
    };
    /** Skill 内容快照（SKILL.md 文本），用于回滚恢复（P1-3）。旧备份无此字段时跳过。 */
    skillContents?: {
        [key in SkillClientType]?: Record<string, string>;
    };
}

export class HistoryManager {
    private backupDir: string;
    private maxBackups: number = 50;
    private configManager: ConfigManager;

    constructor() {
        this.backupDir = path.join(os.homedir(), '.ai-tools', 'backups');
        this.configManager = new ConfigManager();
    }

    /**
     * 确保备份目录存在
     */
    private async ensureBackupDir(): Promise<void> {
        await fs.mkdir(this.backupDir, {recursive: true});
    }

    /**
     * 生成备份文件名
     */
    private generateBackupFilename(): string {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-');
        return `backup-${timestamp}.json`;
    }

    /**
     * 获取指定客户端的已安装 Skills 列表
     */
    private async getInstalledSkillNames(client: SkillClientType): Promise<string[]> {
        const skillsPath = this.configManager.getSkillsPath(client);
        const skillNames: string[] = [];

        try {
            const entries = await fs.readdir(skillsPath, {withFileTypes: true});
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    // 检查是否有 SKILL.md 文件
                    const skillMdPath = path.join(skillsPath, entry.name, 'SKILL.md');
                    try {
                        await fs.access(skillMdPath);
                        skillNames.push(entry.name);
                    } catch {
                        // 没有 SKILL.md，不是有效的 Skill
                    }
                }
            }
        } catch {
            // 目录不存在或无法读取
        }

        return skillNames;
    }

    /**
     * 读取指定客户端各已安装 Skill 的 SKILL.md 内容（用于回滚快照，P1-3）
     */
    private async getInstalledSkillContents(client: SkillClientType): Promise<Record<string, string>> {
        const skillsPath = this.configManager.getSkillsPath(client);
        const result: Record<string, string> = {};
        try {
            const entries = await fs.readdir(skillsPath, {withFileTypes: true});
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const skillMdPath = path.join(skillsPath, entry.name, 'SKILL.md');
                try {
                    result[entry.name] = await fs.readFile(skillMdPath, 'utf-8');
                } catch {
                    // 无 SKILL.md 或读取失败，跳过该 Skill
                }
            }
        } catch {
            // 目录不存在或无法读取
        }
        return result;
    }

    /**
     * 创建备份（备份所有客户端的配置，包括 Skills）
     */
    async backup(): Promise<string | null> {
        try {
            await this.ensureBackupDir();

            // 客户端清单统一走 config-manager（含全部内置 + 自定义，P1-3）
            const clients: ClientType[] = this.configManager.getClientTypes();
            const backupData: BackupData = {
                timestamp: new Date().toISOString(),
                clients: {},
                skills: {},
                skillContents: {},
            };

            let totalServerCount = 0;
            let totalSkillCount = 0;

            for (const client of clients) {
                try {
                    const config = await this.configManager.readConfig(client);
                    const serverCount = Object.keys(config.mcpServers || {}).length;
                    totalServerCount += serverCount;

                    backupData.clients[client] = {
                        config,
                        serverCount,
                    };
                } catch {
                    // 忽略读取失败的客户端
                }
            }

            // 备份 Skills（云端暂存区不属于本机客户端，跳过）
            for (const client of SKILL_SUPPORTED_CLIENTS) {
                if (client === 'cloud') continue;
                const skillNames = await this.getInstalledSkillNames(client);
                if (skillNames.length > 0) {
                    backupData.skills![client] = skillNames;
                    const contents = await this.getInstalledSkillContents(client);
                    if (Object.keys(contents).length > 0) {
                        backupData.skillContents![client] = contents;
                    }
                    totalSkillCount += skillNames.length;
                }
            }

            // 只有在有配置时才创建备份
            if (totalServerCount === 0 && totalSkillCount === 0 && Object.keys(backupData.clients).length === 0) {
                return null;
            }

            // 去重：若新快照与「最近一条」备份完全一致，说明本次操作未发生实际变更
            // （例如重复创建已存在的 MCP、或该 MCP 在上一条备份里就已存在）。
            // 若仍创建备份，会与上一条内容相同，getDiff 比较两者会得到空变更，
            // 表现为「创建/操作后历史记录为空」。此处跳过，避免产生空变更历史条目。
            const latest = await this.getLatestBackupData();
            if (latest && this.backupSignature(latest) === this.backupSignature(backupData)) {
                return null;
            }

            const filename = this.generateBackupFilename();
            const backupPath = path.join(this.backupDir, filename);

            await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2), 'utf-8');

            // 清理旧备份
            await this.cleanOldBackups();

            return filename;
        } catch (error) {
            console.error('Backup failed:', error);
            return null;
        }
    }

    /**
     * 清理旧备份
     */
    private async cleanOldBackups(): Promise<void> {
        try {
            const files = await fs.readdir(this.backupDir);
            const backupFiles = files
                .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
                .sort()
                .reverse();

            const toDelete = backupFiles.slice(this.maxBackups);
            for (const file of toDelete) {
                await fs.unlink(path.join(this.backupDir, file));
            }
        } catch {
            // 忽略清理错误
        }
    }

    /**
     * 清空所有备份
     */
    async clearAll(): Promise<boolean> {
        try {
            const files = await fs.readdir(this.backupDir);
            const backupFiles = files.filter(f => f.startsWith('backup-') && f.endsWith('.json'));

            for (const file of backupFiles) {
                await fs.unlink(path.join(this.backupDir, file));
            }

            return true;
        } catch (error) {
            console.error('Clear all backups failed:', error);
            return false;
        }
    }

    /**
     * 列出所有备份
     */
    async listBackups(): Promise<BackupInfo[]> {
        try {
            await this.ensureBackupDir();

            const files = await fs.readdir(this.backupDir);
            const backupFiles = files
                .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
                .sort()
                .reverse();

            const backups: BackupInfo[] = [];

            for (const filename of backupFiles) {
                const filePath = path.join(this.backupDir, filename);

                try {
                    const stat = await fs.stat(filePath);
                    const content = await fs.readFile(filePath, 'utf-8');
                    const data: BackupData = JSON.parse(content);

                    // 服务器总数：跨客户端【去重】。同一个 server 装在 N 个客户端只算 1 个，
                    // 与 skillCount 的去重口径保持一致——此前 serverCount 累加、skillCount 去重，
                    // 两个数字并排展示却口径不同，实测同一份数据算出 22 与 11 两个值，易被误读为数据错误。
                    const allServerIds = new Set<string>();
                    const clientList: ClientType[] = [];
                    const skillsMap = (data.skills || {}) as Record<string, string[]>;

                    for (const [clientId, clientData] of Object.entries(data.clients || {})) {
                        if (!clientData) continue;
                        const clientServerIds = Object.keys(clientData.config?.mcpServers || {});
                        clientServerIds.forEach(id => allServerIds.add(id));
                        // 只纳入真正承载内容的客户端。备份时无条件遍历全部内置 + 自定义客户端，
                        // 未安装者的配置文件不存在，readConfig 返回空配置而非抛错，同样会落盘；
                        // 不过滤的话每条历史都会渲染全部客户端图标（实测 19 个里 16 个是空的）。
                        if (clientServerIds.length > 0 || (skillsMap[clientId]?.length ?? 0) > 0) {
                            clientList.push(clientId as ClientType);
                        }
                    }

                    // 计算总 Skills 数（去重）
                    const allSkillNames = new Set<string>();
                    for (const skillNames of Object.values(skillsMap)) {
                        if (skillNames) {
                            skillNames.forEach(name => allSkillNames.add(name));
                        }
                    }

                    backups.push({
                        timestamp: data.timestamp,
                        filename,
                        size: stat.size,
                        serverCount: allServerIds.size,
                        skillCount: allSkillNames.size,
                        clients: clientList,
                    });
                } catch {
                    // 忽略解析错误的文件
                }
            }

            return backups;
        } catch {
            return [];
        }
    }

    /**
     * 读取单个备份文件内容（容错：解析失败返回 null）
     */
    private async readBackupFile(filename: string): Promise<BackupData | null> {
        try {
            const filePath = path.join(this.backupDir, filename);
            const content = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(content) as BackupData;
        } catch {
            return null;
        }
    }

    /** 读取最近一条备份文件内容（用于去重判断；失败返回 null） */
    private async getLatestBackupData(): Promise<BackupData | null> {
        try {
            const files = (await fs.readdir(this.backupDir))
                .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
                .sort()
                .reverse();
            if (files.length === 0) return null;
            return this.readBackupFile(files[0]);
        } catch {
            return null;
        }
    }

    /** 计算备份的「内容签名」（忽略 timestamp，仅比较客户端配置 / Skills 名 / Skill 内容） */
    private backupSignature(data: BackupData): string {
        const clients: Record<string, unknown> = {};
        for (const [cid, cd] of Object.entries(data.clients || {})) {
            clients[cid] = cd?.config ?? null;
        }
        return JSON.stringify({
            clients,
            skills: data.skills || {},
            skillContents: data.skillContents || {},
        });
    }

    /** 从备份数据中提取全部 server（跨客户端去重，先到先得） */
    private serversFromBackup(data: BackupData): Record<string, any> {
        const servers: Record<string, any> = {};
        for (const clientData of Object.values(data.clients || {})) {
            if (clientData?.config?.mcpServers) {
                for (const [serverId, serverConfig] of Object.entries(clientData.config.mcpServers)) {
                    if (!servers[serverId]) {
                        servers[serverId] = serverConfig;
                    }
                }
            }
        }
        return servers;
    }

    /** 计算某条备份相对「上一条（更早）备份」的变更。
     * 每条备份记录的是变更【之后】的状态，因此与更早一条备份比较才能得到
     * 本次操作实际变更了什么。
     * 比较按【客户端级】进行：装/卸到「多个客户端之一」时，该 server 仍存在于
     * 其它客户端，若按全局 server 集合比较则差异恒为空（表现为「从某客户端移除后
     * 历史记录为空」）。按客户端分别比对可正确识别「serverX 从 cursor 移除」。
     */
    async getDiff(timestamp: string): Promise<DiffResult | null> {
        try {
            const backups = await this.listBackups(); // 按时间倒序：最新在前
            const idx = backups.findIndex(b => b.timestamp === timestamp);

            if (idx === -1) {
                return null;
            }

            const targetData = await this.readBackupFile(backups[idx].filename);
            if (!targetData) {
                return null;
            }

            // 上一条（更早的）备份；不存在则视为空基线
            let prevData: BackupData | null = null;
            if (idx + 1 < backups.length) {
                prevData = await this.readBackupFile(backups[idx + 1].filename);
            }

            const targetServers = this.serversFromBackup(targetData);
            const prevServers = prevData ? this.serversFromBackup(prevData) : {};

            // —— 客户端级比较（MCP Servers）——
            const targetClients = (targetData.clients || {}) as Record<string, any>;
            const prevClients = (prevData?.clients || {}) as Record<string, any>;
            const allClientIds = new Set<string>([
                ...Object.keys(targetClients),
                ...Object.keys(prevClients),
            ]);
            const clientChanges: { client: string; added: string[]; removed: string[]; modified: string[] }[] = [];
            const aggAdded = new Set<string>();
            const aggRemoved = new Set<string>();
            const aggModified = new Set<string>();
            for (const cid of allClientIds) {
                const prevMap = (prevClients[cid]?.config?.mcpServers) || {};
                const targetMap = (targetClients[cid]?.config?.mcpServers) || {};
                const prevIds = Object.keys(prevMap);
                const targetIds = Object.keys(targetMap);
                const added = targetIds.filter(id => !prevIds.includes(id));
                const removed = prevIds.filter(id => !targetIds.includes(id));
                const modified = targetIds.filter(
                    id => prevIds.includes(id) && JSON.stringify(targetMap[id]) !== JSON.stringify(prevMap[id])
                );
                if (added.length || removed.length || modified.length) {
                    clientChanges.push({client: cid, added, removed, modified});
                }
                added.forEach(id => aggAdded.add(id));
                removed.forEach(id => aggRemoved.add(id));
                modified.forEach(id => aggModified.add(id));
            }

            // —— 客户端级比较（Skills）——
            const targetSkillsMap = (targetData.skills || {}) as Record<string, string[]>;
            const prevSkillsMap = (prevData?.skills || {}) as Record<string, string[]>;
            const allSkillClients = new Set<string>([
                ...Object.keys(targetSkillsMap),
                ...Object.keys(prevSkillsMap),
            ]);
            const skillClientChanges: { client: string; added: string[]; removed: string[]; modified: string[] }[] = [];
            const aggSkillAdded = new Set<string>();
            const aggSkillRemoved = new Set<string>();
            const aggSkillModified = new Set<string>();

            // Skill 内容比较：仅当前后两条备份【都】采到该客户端的 skillContents 时才进行。
            // 旧备份（P1-3 之前产生）无此字段，或某侧因自定义路径 / 读取失败而缺失时，
            // 一律跳过——否则「字段缺失」会被误判成「内容已修改」，表现为满屏 ~modified。
            const targetContents = (targetData.skillContents || {}) as Record<string, Record<string, string>>;
            const prevContents = (prevData?.skillContents || {}) as Record<string, Record<string, string>>;

            for (const cid of allSkillClients) {
                const prevSet = new Set(prevSkillsMap[cid] || []);
                const targetSet = new Set(targetSkillsMap[cid] || []);
                const added = [...targetSet].filter(n => !prevSet.has(n));
                const removed = [...prevSet].filter(n => !targetSet.has(n));

                const prevC = prevContents[cid];
                const targetC = targetContents[cid];
                const modified = (prevC && targetC)
                    ? [...targetSet].filter(n => prevSet.has(n) && prevC[n] !== targetC[n])
                    : [];

                if (added.length || removed.length || modified.length) {
                    skillClientChanges.push({client: cid, added, removed, modified});
                }
                added.forEach(n => aggSkillAdded.add(n));
                removed.forEach(n => aggSkillRemoved.add(n));
                modified.forEach(n => aggSkillModified.add(n));
            }

            return {
                added: [...aggAdded],
                removed: [...aggRemoved],
                modified: [...aggModified],
                current: targetServers,
                backup: prevServers,
                skillsAdded: [...aggSkillAdded],
                skillsRemoved: [...aggSkillRemoved],
                skillsModified: [...aggSkillModified],
                clientChanges,
                skillClientChanges,
            };
        } catch (error) {
            console.error('Get diff failed:', error);
            return null;
        }
    }
}
