/**
 * 云端一致性检测（plan-3.0）
 *
 * 检测两类不一致（内容层面的分歧，时间戳差异不算）：
 * 1. 本地客户端 vs 云端暂存区（~/.ai-tools/cloud/ai-tools，与远端同构）——local_newer / cloud_newer / diverged；
 * 2. 本地多客户端之间内容互不一致——local_diverged（内容分裂后与云端比对失去意义，优先报此类）。
 *
 * 内容口径：
 * - Skill：SKILL.md 全文（与对照查看口径一致）；内容完全相同（仅 updatedAt/mtime 不同）视为一致静默；
 * - MCP Server：mcpServers 配置 deep-equal（键序无关）。
 *
 * 仅本地存在（local_only）属正常状态，不产出（上传入口本身可见）；
 * 仅云端存在（cloud_only）产出可见项——换机 pull 后「云端有 N 项本地还没下发」需被看到（P2-b）。
 * 检测结果驱动 Library 顶部 consistency banner。
 */

import fs from 'fs/promises';
import path from 'path';
import type {McpServerConfig, SkillClientType} from './config/types';
import {readSkillUpdatedAt} from './skills/conflict';

// ==================== 类型 ====================

export type ConsistencyResolution =
    | 'local_newer'    // 本地与云端都有该条目，本地更新
    | 'cloud_newer'    // 本地与云端都有该条目，云端更新
    | 'diverged'       // 两端都有但时间无法判定先后（如一端缺时间戳）
    | 'local_diverged' // 本地多个客户端之间内容互不一致（优先于云端比对）
    | 'cloud_only';    // 仅云端存在（本地无任何客户端持有），可一键下发到全部已安装客户端

/** local_diverged 时逐客户端的时间信息 */
export interface ConsistencyLocalInfo {
    client: string;
    updatedAt: string | null;
}

export interface ConsistencyItem {
    kind: 'skill' | 'server';
    name: string;
    /** 拥有该条目的本地客户端（已安装）；仅用于展示与后续同步操作 */
    localClients: string[];
    localUpdatedAt: string | null;
    cloudUpdatedAt: string | null;
    resolution: ConsistencyResolution;
    /** local_diverged 时各本地客户端的更新时间明细 */
    localDetails?: ConsistencyLocalInfo[];
}

export interface ConsistencyReport {
    items: ConsistencyItem[];
    checkedAt: string;
}

// ==================== 工具 ====================

/**
 * 键序无关的 JSON 规范化序列化（递归按键名排序），用于内容比对。
 * 同一份配置被不同客户端写入时键序可能不同，直接 stringify 会误报不一致。
 */
export function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value as Record<string, unknown>).sort();
        return '{' + keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',') + '}';
    }
    return JSON.stringify(value) ?? 'null';
}

/** 文件 mtime 的 ISO 串；文件不存在返回 null */
async function fileMtime(filePath: string): Promise<string | null> {
    try {
        const stat = await fs.stat(filePath);
        return stat.mtime.toISOString();
    } catch {
        return null;
    }
}

/** 读取目录下的直接子目录名（skill 目录清单），目录不存在返回空 */
async function listSkillDirs(root: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(root, {withFileTypes: true});
        return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
        return [];
    }
}

// ==================== 检测参数 ====================

export interface ConsistencyCheckParams {
    /** 云端 skills 暂存目录（getSkillsPath('cloud')） */
    cloudSkillsPath: string;
    /** 云端 mcp.json 暂存路径 */
    cloudMcpConfigPath: string;
    /** 已安装的技能客户端 → 各自 skills 目录 */
    localSkillDirs: Array<{ client: SkillClientType; dir: string }>;
    /** 已安装的 MCP 客户端 → 各自 mcp.json 路径 */
    localMcpConfigs: Array<{ client: string; configPath: string }>;
    /** 读取某客户端 mcp.json 中的 mcpServers（注入 configManager.getInstalledServers） */
    readClientServers: (client: string) => Promise<Record<string, McpServerConfig>>;
}

// ==================== 检测核心 ====================

/**
 * Skill 检测（重写于用户反馈修正⑤/⑥）：
 * 1. 本地多客户端内容互检：>=2 个客户端 SKILL.md 内容不同 → local_diverged（优先报，不再与云端比对）；
 * 2. 本地内容一致 → 与云端比对：SKILL.md 内容相同 → 静默（仅时间戳差异不算不一致）；
 *    内容不同 → 按 readSkillUpdatedAt 时间判 local_newer / cloud_newer / diverged。
 */
async function checkSkills(params: ConsistencyCheckParams): Promise<ConsistencyItem[]> {
    const items: ConsistencyItem[] = [];
    const cloudNames = await listSkillDirs(params.cloudSkillsPath);
    if (cloudNames.length === 0 && params.localSkillDirs.length === 0) return items;

    // 本地各客户端的 skill 扫描：name -> [{client, updatedAt, content}]（content = SKILL.md 全文）
    const localIndex = new Map<string, Array<{ client: SkillClientType; updatedAt: string | null; content: string | null }>>();
    for (const {client, dir} of params.localSkillDirs) {
        for (const name of await listSkillDirs(dir)) {
            const skillPath = path.join(dir, name);
            const [updatedAt, content] = await Promise.all([
                readSkillUpdatedAt(skillPath),
                readSkillMd(skillPath),
            ]);
            const list = localIndex.get(name) || [];
            list.push({client, updatedAt, content});
            localIndex.set(name, list);
        }
    }

    for (const [name, locals] of localIndex) {
        // —— 本地互检：内容分裂优先于云端比对（本地先统一，云端比对才有意义）——
        const distinctContents = new Set(locals.map(l => l.content ?? ''));
        if (locals.length > 1 && distinctContents.size > 1) {
            items.push({
                kind: 'skill', name,
                localClients: locals.map(l => l.client),
                localUpdatedAt: latestTime(locals),
                cloudUpdatedAt: null,
                resolution: 'local_diverged',
                localDetails: locals.map(l => ({client: l.client, updatedAt: l.updatedAt})),
            });
            continue;
        }

        // —— 与云端比对（云端无同名 → 仅本地存在，属正常状态，静默）——
        const cloudSkillPath = path.join(params.cloudSkillsPath, name);
        const [cloudUpdatedAt, cloudContent] = await Promise.all([
            readSkillUpdatedAt(cloudSkillPath),
            readSkillMd(cloudSkillPath),
        ]);
        if (cloudUpdatedAt === null && cloudContent === null) continue;

        // 内容完全相同 → 默认视为已同步，静默（用户反馈：无需人工处理）
        const localContent = locals[0]?.content ?? null;
        if (localContent !== null && cloudContent !== null && localContent === cloudContent) {
            continue;
        }

        // 内容不同（或一端读不到内容）：按时间判先后；时间为空 → diverged
        const lu = latestTime(locals);
        const cu = cloudUpdatedAt;
        const resolution: ConsistencyResolution =
            (lu === null || cu === null)
                ? 'diverged'
                : (lu > cu ? 'local_newer' : 'cloud_newer');
        items.push({
            kind: 'skill', name,
            localClients: locals.map(l => l.client),
            localUpdatedAt: lu, cloudUpdatedAt: cu,
            resolution,
        });
    }

    // 仅云端存在（云端有 & 本地完全无）→ 产出 cloud_only（P2-b）：
    // 换机 pull 后本地还没下发的内容必须可见，否则只能自己翻云端 Tab 才发现。
    for (const name of cloudNames) {
        if (localIndex.has(name)) continue;
        items.push({
            kind: 'skill', name,
            localClients: [],
            localUpdatedAt: null,
            cloudUpdatedAt: await readSkillUpdatedAt(path.join(params.cloudSkillsPath, name)),
            resolution: 'cloud_only',
        });
    }
    return items;
}

/**
 * MCP Server 检测（重写于用户反馈修正⑤/⑥）：
 * 1. 本地多客户端内容互检：同名 server 配置不同 → local_diverged（优先报）；
 * 2. 本地一致 → 与云端 deep-equal 比对：相同 → 静默；不同 → 双方 mcp.json mtime 判先后。
 */
async function checkServers(params: ConsistencyCheckParams): Promise<ConsistencyItem[]> {
    const items: ConsistencyItem[] = [];
    const cloudRaw = await readJson(params.cloudMcpConfigPath);

    // client -> mcp.json 路径（算逐客户端 mtime 用）
    const clientConfigPath = new Map(params.localMcpConfigs.map(c => [c.client, c.configPath]));

    // name -> [{client, config}]（每个客户端的每份配置都保留，供互检）
    const localIndex = new Map<string, Array<{ client: string; config: McpServerConfig }>>();
    for (const {client} of params.localMcpConfigs) {
        const servers = await params.readClientServers(client);
        for (const [name, config] of Object.entries(servers)) {
            const list = localIndex.get(name) || [];
            list.push({client, config});
            localIndex.set(name, list);
        }
    }

    const cloudServers = (cloudRaw?.mcpServers || {}) as Record<string, McpServerConfig>;
    const cloudMcpMtime = await fileMtime(params.cloudMcpConfigPath);

    for (const [name, locals] of localIndex) {
        // —— 本地互检：配置内容分裂优先 ——
        const localSigs = locals.map(l => stableStringify(l.config));
        if (locals.length > 1 && new Set(localSigs).size > 1) {
            items.push({
                kind: 'server', name,
                localClients: locals.map(l => l.client),
                localUpdatedAt: await fileMtime(clientConfigPath.get(locals[0].client) || ''),
                cloudUpdatedAt: null,
                resolution: 'local_diverged',
                localDetails: await Promise.all(locals.map(async l => ({
                    client: l.client,
                    updatedAt: await fileMtime(clientConfigPath.get(l.client) || ''),
                }))),
            });
            continue;
        }

        // —— 与云端比对（云端无同名 → 仅本地存在，正常状态，静默）——
        const cloudConfig = cloudServers[name];
        if (!cloudConfig) continue;
        if (localSigs[0] === stableStringify(cloudConfig)) {
            continue; // 内容一致，静默（不受文件 mtime 影响）
        }

        // 内容不同：本地代表客户端的 mcp.json mtime vs 云端 mcp.json mtime 判先后
        const localMcpMtime = await fileMtime(clientConfigPath.get(locals[0].client) || '');
        const resolution: ConsistencyResolution =
            (localMcpMtime === null || cloudMcpMtime === null)
                ? 'diverged'
                : (localMcpMtime >= cloudMcpMtime ? 'local_newer' : 'cloud_newer');
        items.push({
            kind: 'server', name,
            localClients: locals.map(l => l.client),
            localUpdatedAt: localMcpMtime, cloudUpdatedAt: cloudMcpMtime,
            resolution,
        });
    }

    // 仅云端存在 → 产出 cloud_only（P2-b），与 Skill 同口径：逐项可下发到全部已安装客户端
    for (const name of Object.keys(cloudServers)) {
        if (localIndex.has(name)) continue;
        items.push({
            kind: 'server', name,
            localClients: [],
            localUpdatedAt: null,
            cloudUpdatedAt: cloudMcpMtime,
            resolution: 'cloud_only',
        });
    }

    return items;
}

/** 取一组条目中最大的 updatedAt（时间排序的最新者），缺省 null */
function latestTime(entries: Array<{ updatedAt: string | null }>): string | null {
    let best: string | null = null;
    for (const e of entries) {
        if (e.updatedAt && (!best || e.updatedAt > best)) best = e.updatedAt;
    }
    return best;
}

/** 读取 skill 目录下的 SKILL.md 全文；不存在/读取失败返回 null */
async function readSkillMd(skillPath: string): Promise<string | null> {
    try {
        return await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf-8');
    } catch {
        return null;
    }
}

async function readJson(filePath: string): Promise<any | null> {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

/** 一致性检测入口：返回全部「内容不一致」项（内容一致项与仅本地存在的条目在内层静默，仅云端存在产出 cloud_only）。云同步未激活时由调用方短路。 */
export async function checkCloudConsistency(params: ConsistencyCheckParams): Promise<ConsistencyReport> {
    const [skillItems, serverItems] = await Promise.all([checkSkills(params), checkServers(params)]);
    return {
        items: [...skillItems, ...serverItems],
        checkedAt: new Date().toISOString(),
    };
}

/**
 * 对照查看：读取单个条目在本地端与云端端的内容（文本形式）。
 * - skill：SKILL.md 全文；读取失败返回 null；
 * - server：规范化 JSON.stringify(config, null, 2)。
 */
export async function readCompareEnds(params: {
    kind: 'skill' | 'server';
    name: string;
    /** 本地代表（skill: skills 目录；server: mcp.json 路径） */
    localPath: string;
    cloudPath: string;
}): Promise<{ local: string | null; cloud: string | null }> {
    if (params.kind === 'skill') {
        const readMd = async (dir: string) => {
            try {
                return await fs.readFile(path.join(dir, params.name, 'SKILL.md'), 'utf-8');
            } catch {
                return null;
            }
        };
        return {local: await readMd(params.localPath), cloud: await readMd(params.cloudPath)};
    }
    // server：两端的 mcp.json 里取同名 server 配置，规范化展示
    const readServer = async (configPath: string) => {
        const raw = await readJson(configPath);
        const config = raw?.mcpServers?.[params.name];
        return config ? JSON.stringify(config, null, 2) : null;
    };
    return {local: await readServer(params.localPath), cloud: await readServer(params.cloudPath)};
}
