/**
 * 多格式配置读写适配器（jsonc / json / toml）
 *
 * 原实现位于 ConfigManager.readConfig / writeConfig 内的各客户端分支，
 * 现整体下沉为纯函数，行为完全一致（分支顺序、返回形状、合并兜底均不变）。
 * ConfigManager 仅负责文件 I/O（读文件、原子写、缓存失效）与这些函数的编排。
 */

import * as jsonc from 'jsonc-parser';
import * as TOML from 'smol-toml';
import type {AnyClientId, ClientConfig, ClientType, McpServerConfig,} from './types';
import {SERVERS_KEY_CLIENTS} from './types';

/**
 * 获取客户端使用的 MCP 服务器键名
 */
export function getServersKey(client: AnyClientId): string {
    if (SERVERS_KEY_CLIENTS.includes(client as ClientType)) return 'servers';
    if (client === 'zed') return 'context_servers';
    if (client === 'opencode') return 'mcp';
    return 'mcpServers';
}

/**
 * TRAE IDE 家族：Trae / Trae CN / TRAE SOLO CN 同为 VS Code fork，共用同一 mcp.json 形态
 * （远程条目只认 url、无 type；type: stdio/sse/http 只属 TraeCode CLI）。
 */
const TRAE_IDE_CLIENTS: string[] = ['trae', 'trae-cn', 'trae-solo-cn'];

/**
 * 配置文件不存在（ENOENT）时返回的默认 ClientConfig。
 */
export function defaultConfigForMissing(client: AnyClientId): ClientConfig {
    if (client === 'zed') {
        return {mcpServers: {}, context_servers: {}};
    }
    if (client === 'opencode' || client === 'openclaw' || client === 'zcode') {
        return {mcpServers: {}};
    }
    if (SERVERS_KEY_CLIENTS.includes(client as ClientType)) {
        return {mcpServers: {}, servers: {}};
    }
    return {mcpServers: {}};
}

/**
 * 判断 writeConfig 是否进入「默认分支」（默认分支会触发客户端缓存失效）。
 * 与 ConfigManager.writeConfig 原分支结构保持一致。
 */
export function reachesDefaultBranch(client: AnyClientId): boolean {
    return !(
        client === 'jetbrains'
        || client === 'codex-cli'
        || client === 'openclaw'
        || client === 'opencode'
        || client === 'zcode'
        || client === 'claude-code'
        || client === 'zed'
        || client === 'qoder'
        || client === 'qwen-code'
        || client === 'iflow-cli'
        || client === 'warp'
        || client === 'kimi-code'
        || client === 'antigravity'
        || TRAE_IDE_CLIENTS.includes(client)
        || SERVERS_KEY_CLIENTS.includes(client as ClientType)
    );
}

/**
 * 解析已读取到的配置文件内容（非空，且一定存在）为 ClientConfig。
 * 对应 ConfigManager.readConfig 的 try 分支。
 */
export function readClientConfig(client: AnyClientId, content: string): ClientConfig {
    if (client === 'jetbrains') {
        const config = JSON.parse(content);
        return {mcpServers: config.mcpServers || {}};
    }

    if (client === 'codex-cli') {
        const tomlConfig = TOML.parse(content) as Record<string, any>;
        const mcpServers: Record<string, McpServerConfig> = {};
        const rawServers = tomlConfig.mcp_servers || {};
        for (const [name, serverDef] of Object.entries(rawServers)) {
            const def = serverDef as Record<string, any>;
            if (def.command) {
                mcpServers[name] = {
                    command: def.command,
                    args: def.args || [],
                    env: def.env || {},
                    ...(def.cwd ? {cwd: def.cwd} : {}),
                };
            }
        }
        return {mcpServers};
    }

    if (client === 'openclaw') {
        const config = jsonc.parse(content);
        const rawServers = config.mcp?.servers || {};
        const mcpServers: Record<string, McpServerConfig> = {};
        for (const [name, def] of Object.entries(rawServers)) {
            const d = def as Record<string, any>;
            // 规范字段是 transport（stdio/sse/streamable-http）；type 仅 CLI 兼容写法，
            // doctor --fix 会把它改写成 transport，故读侧两者都认。enabled:false ≡ 内部 enable:false。
            const transport = d.transport || d.type;
            const enable = d.enabled === false ? {enable: false} : {};
            if (d.url) {
                mcpServers[name] = {
                    url: d.url,
                    type: transport === 'sse' ? 'sse' : 'http',
                    headers: d.headers || {},
                    ...enable,
                };
            } else if (d.command) {
                mcpServers[name] = {
                    command: d.command,
                    args: d.args || [],
                    env: {},
                    ...(d.cwd ? {cwd: d.cwd} : {}),
                    ...enable,
                };
            }
        }
        return {mcpServers, ...config};
    }

    // ZCode：配置挂在 mcp.servers 下（与 openclaw 同形），另带 enable 启停标记需透传
    if (client === 'zcode') {
        const config = jsonc.parse(content);
        const rawServers = config.mcp?.servers || {};
        const mcpServers: Record<string, McpServerConfig> = {};
        for (const [name, def] of Object.entries(rawServers)) {
            const d = def as Record<string, any>;
            // enable 只保留显式 false——缺失即启用，写回时补 true 会给客户端配置平添噪声
            const enable = d.enable === false ? {enable: false} : {};
            if (d.url) {
                mcpServers[name] = {
                    url: d.url,
                    type: d.type || 'http',
                    headers: d.headers || {},
                    ...enable,
                };
            } else if (d.command) {
                mcpServers[name] = {
                    command: d.command,
                    args: d.args || [],
                    env: d.env || {},
                    ...(d.cwd ? {cwd: d.cwd} : {}),
                    ...enable,
                };
            }
        }
        return {mcpServers, ...config};
    }

    if (client === 'opencode') {
        const config = jsonc.parse(content);
        const rawMcp = config.mcp || {};
        const mcpServers: Record<string, McpServerConfig> = {};
        for (const [name, def] of Object.entries(rawMcp)) {
            const d = def as Record<string, any>;
            if (d.type === 'local' && Array.isArray(d.command) && d.command.length > 0) {
                mcpServers[name] = {
                    command: d.command[0],
                    args: d.command.slice(1),
                    env: d.environment || d.env || {},
                    ...(d.cwd ? {cwd: d.cwd} : {}),
                };
            } else if (d.type === 'remote' && d.url) {
                mcpServers[name] = {
                    url: d.url,
                    type: 'http',
                    headers: d.headers || {},
                };
            }
        }
        return {mcpServers, ...config};
    }

    // Warp：官方 schema 用 working_directory 而非 cwd（docs.warp.dev/agents/capabilities/mcp），
    // 且不以 type/transport 区分本地/远程（由 command / url 决定）。
    if (client === 'warp') {
        const config = jsonc.parse(content);
        const mcpServers: Record<string, McpServerConfig> = {};
        for (const [name, def] of Object.entries(config.mcpServers || {})) {
            const {working_directory: workingDirectory, ...rest} = def as Record<string, any>;
            mcpServers[name] = {...rest, ...(workingDirectory ? {cwd: workingDirectory} : {})};
        }
        return {...config, mcpServers};
    }

    // Kimi Code CLI：官方 schema 用 transport 而非 type、enabled 而非 enable
    // （www.kimi.com/code/docs/kimi-code-cli/customization/mcp）
    if (client === 'kimi-code') {
        const config = jsonc.parse(content);
        const mcpServers: Record<string, McpServerConfig> = {};
        for (const [name, def] of Object.entries(config.mcpServers || {})) {
            const {transport, enabled, ...rest} = def as Record<string, any>;
            mcpServers[name] = {
                ...rest,
                ...(transport ? {type: transport} : {}),
                // 只回读显式 false：缺失即启用，补 true 会给客户端配置平添噪声
                ...(enabled === false ? {enable: false} : {}),
            };
        }
        return {...config, mcpServers};
    }

    // TRAE IDE 家族：官方形态无 type（远程靠 url 区分），停用字段是 disabled，
    // 实文件另有 fromGalleryId 等扩展字段——除这两个映射外原样保留。
    if (TRAE_IDE_CLIENTS.includes(client)) {
        const config = jsonc.parse(content);
        const mcpServers: Record<string, McpServerConfig> = {};
        for (const [name, def] of Object.entries(config.mcpServers || {})) {
            const {disabled, type, ...rest} = def as Record<string, any>;
            const enable = disabled === true ? {enable: false} : {};
            mcpServers[name] = rest.url
                ? {...rest, type: type === 'sse' ? 'sse' : 'http', ...enable}
                : {...rest, ...enable};
        }
        return {...config, mcpServers};
    }

    // Antigravity：远程条目用 serverUrl（与通用 url 不同），SSE / streamable HTTP 共用同一字段；
    // schema 拒绝未知属性，故 type 不参与读写。停用字段为 disabled（mcp_config.json 实测字段集
    // command/args/env/disabled）。
    if (client === 'antigravity') {
        const config = jsonc.parse(content);
        const mcpServers: Record<string, McpServerConfig> = {};
        for (const [name, def] of Object.entries(config.mcpServers || {})) {
            const {serverUrl, disabled, ...rest} = def as Record<string, any>;
            mcpServers[name] = {
                ...rest,
                ...(serverUrl ? {url: serverUrl, type: rest.type || 'http'} : {}),
                ...(disabled === true ? {enable: false} : {}),
            };
        }
        return {...config, mcpServers};
    }

    if (client === 'claude-code' || client === 'zed') {
        const config = jsonc.parse(content);
        const serversKey = getServersKey(client);
        return {
            mcpServers: config[serversKey] || {},
            ...config,
        };
    }

    if (SERVERS_KEY_CLIENTS.includes(client as ClientType)) {
        const config = jsonc.parse(content);
        return {
            mcpServers: config.servers || {},
            ...config,
        };
    }

    const config = jsonc.parse(content);
    return config;
}

/**
 * 将 ClientConfig 序列化为待写入的配置文本。
 * 对应 ConfigManager.writeConfig 的各分支（jetbrains / codex-cli / openclaw /
 * zcode / opencode / warp / kimi-code / claude-code+zed / servers-key / 默认），行为与原文逐字一致。
 * existingContent 为「已读取到的现有文件内容」（文件不存在时由调用方传入 '{}'）。
 */
export function writeClientConfig(client: AnyClientId, config: ClientConfig, existingContent: string): string {
    if (client === 'jetbrains') {
        let existingConfig: Record<string, any> = {};
        try {
            existingConfig = JSON.parse(existingContent);
        } catch {
            // file doesn't exist
        }
        existingConfig.mcpServers = config.mcpServers || {};
        return JSON.stringify(existingConfig, null, 2);
    }

    if (client === 'codex-cli') {
        let existingToml: Record<string, any> = {};
        try {
            existingToml = TOML.parse(existingContent) as Record<string, any>;
        } catch {
            // 文件不存在或解析失败
        }
        const mcpServers = config.mcpServers || {};
        const tomlServers: Record<string, any> = {};
        for (const [name, serverDef] of Object.entries(mcpServers)) {
            tomlServers[name] = {
                command: serverDef.command,
                ...(serverDef.args && serverDef.args.length > 0 ? {args: serverDef.args} : {}),
                ...(serverDef.env && Object.keys(serverDef.env).length > 0 ? {env: serverDef.env} : {}),
                ...(serverDef.cwd ? {cwd: serverDef.cwd} : {}),
            };
        }
        existingToml.mcp_servers = tomlServers;
        return TOML.stringify(existingToml);
    }

    if (client === 'openclaw') {
        const mcpServers = config.mcpServers || {};
        const openclawServers: Record<string, any> = {};
        for (const [name, def] of Object.entries(mcpServers)) {
            // 只写显式 false：缺失即启用，补 enabled:true 会给客户端配置平添噪声
            const enabled = def.enable === false ? {enabled: false} : {};
            if (def.url) {
                openclawServers[name] = {
                    url: def.url,
                    // 官方规范字段为 transport（stdio/sse/streamable-http），type 是会被 doctor --fix
                    // 改写的 CLI 兼容写法；内部 'http' 即 streamable HTTP。
                    transport: def.type === 'sse' ? 'sse' : 'streamable-http',
                    ...(def.headers && Object.keys(def.headers).length > 0 ? {headers: def.headers} : {}),
                    ...enabled,
                };
            } else {
                openclawServers[name] = {
                    command: def.command,
                    ...(def.args && def.args.length > 0 ? {args: def.args} : {}),
                    ...(def.cwd ? {cwd: def.cwd} : {}),
                    ...enabled,
                };
            }
        }

        const edits = jsonc.modify(existingContent, ['mcp', 'servers'], openclawServers, {
            formattingOptions: {tabSize: 2, insertSpaces: true}
        });
        return jsonc.applyEdits(existingContent, edits);
    }

    // ZCode：同样写 mcp.servers，但保留 env（openclaw 分支不写 env，勿照抄）与 enable 标记
    if (client === 'zcode') {
        const mcpServers = config.mcpServers || {};
        const zcodeServers: Record<string, any> = {};
        for (const [name, def] of Object.entries(mcpServers)) {
            const enable = def.enable === false ? {enable: false} : {};
            if (def.url) {
                zcodeServers[name] = {
                    url: def.url,
                    type: def.type || 'http',
                    ...(def.headers && Object.keys(def.headers).length > 0 ? {headers: def.headers} : {}),
                    ...enable,
                };
            } else {
                zcodeServers[name] = {
                    command: def.command,
                    ...(def.args && def.args.length > 0 ? {args: def.args} : {}),
                    ...(def.env && Object.keys(def.env).length > 0 ? {env: def.env} : {}),
                    ...(def.cwd ? {cwd: def.cwd} : {}),
                    ...enable,
                };
            }
        }

        const edits = jsonc.modify(existingContent, ['mcp', 'servers'], zcodeServers, {
            formattingOptions: {tabSize: 2, insertSpaces: true}
        });
        return jsonc.applyEdits(existingContent, edits);
    }

    if (client === 'opencode') {
        const mcpServers = config.mcpServers || {};
        const opencodeMcp: Record<string, any> = {};
        for (const [name, def] of Object.entries(mcpServers)) {
            if (def.url) {
                opencodeMcp[name] = {
                    type: 'remote',
                    url: def.url,
                    ...(def.headers && Object.keys(def.headers).length > 0 ? {headers: def.headers} : {}),
                    enabled: true,
                };
            } else {
                opencodeMcp[name] = {
                    type: 'local',
                    command: [def.command, ...(def.args || [])],
                    ...(def.env && Object.keys(def.env).length > 0 ? {environment: def.env} : {}),
                    ...(def.cwd ? {cwd: def.cwd} : {}),
                    enabled: true,
                };
            }
        }

        const edits = jsonc.modify(existingContent, ['mcp'], opencodeMcp, {
            formattingOptions: {tabSize: 2, insertSpaces: true}
        });
        return jsonc.applyEdits(existingContent, edits);
    }

    // Warp：写盘前把 cwd 换成官方字段名 working_directory，其余字段原样保留（含用户手写的扩展字段）
    if (client === 'warp') {
        const {mcpServers, ...rest} = config;
        const warpServers: Record<string, any> = {};
        for (const [name, def] of Object.entries(mcpServers || {})) {
            const {cwd, ...withoutCwd} = def;
            warpServers[name] = {...withoutCwd, ...(cwd ? {working_directory: cwd} : {})};
        }
        return JSON.stringify({...rest, mcpServers: warpServers}, null, 2);
    }

    // Kimi Code CLI：type -> transport（stdio 由 command 隐含，官方 schema 无该取值）、
    // enable -> enabled（只写显式 false）
    if (client === 'kimi-code') {
        const {mcpServers, ...rest} = config;
        const kimiServers: Record<string, any> = {};
        for (const [name, def] of Object.entries(mcpServers || {})) {
            const {type, enable, ...withoutType} = def;
            kimiServers[name] = {
                ...withoutType,
                ...(type && type !== 'stdio' ? {transport: type} : {}),
                ...(enable === false ? {enabled: false} : {}),
            };
        }
        return JSON.stringify({...rest, mcpServers: kimiServers}, null, 2);
    }

    // TRAE IDE 家族：写盘剥掉官方形态不认的 type / enable，停用映射为 disabled:true
    if (TRAE_IDE_CLIENTS.includes(client)) {
        const {mcpServers, ...rest} = config;
        const traeServers: Record<string, any> = {};
        for (const [name, def] of Object.entries(mcpServers || {})) {
            const {type, enable, ...withoutSpecial} = def;
            traeServers[name] = {...withoutSpecial, ...(enable === false ? {disabled: true} : {})};
        }
        return JSON.stringify({...rest, mcpServers: traeServers}, null, 2);
    }

    // Antigravity：写盘前把 url 换成官方字段名 serverUrl、去掉 schema 不认的 type/cwd，
    // enable:false 映射为 disabled:true（其余字段原样保留）。
    if (client === 'antigravity') {
        const {mcpServers, ...rest} = config;
        const antigravityServers: Record<string, any> = {};
        for (const [name, def] of Object.entries(mcpServers || {})) {
            const {type, url, cwd, enable, ...withoutSpecial} = def;
            antigravityServers[name] = {
                ...withoutSpecial,
                ...(url ? {serverUrl: url} : {}),
                ...(enable === false ? {disabled: true} : {}),
            };
        }
        return JSON.stringify({...rest, mcpServers: antigravityServers}, null, 2);
    }

    // Claude Code / Zed / Qoder / Qwen Code / iFlow CLI: 配置文件同时承载客户端自身的其他设置
    // （~/.claude.json、Zed/Qoder/Qwen/iFlow 的 settings.json），只能定点改 mcpServers 键，
    // 整文件重写会压掉用户的注释与无关配置。
    if (client === 'claude-code' || client === 'zed' || client === 'qoder'
        || client === 'qwen-code' || client === 'iflow-cli') {
        const serversKey = getServersKey(client);
        const mcpServers = config.mcpServers || (config as any)[serversKey] || {};

        const edits = jsonc.modify(existingContent, [serversKey], mcpServers, {
            formattingOptions: {tabSize: 2, insertSpaces: true}
        });

        return jsonc.applyEdits(existingContent, edits);
    }

    // VS Code: 写入时将 mcpServers -> servers
    if (SERVERS_KEY_CLIENTS.includes(client as ClientType)) {
        const {mcpServers, servers, ...rest} = config;
        const writeConfig = {
            ...rest,
            servers: mcpServers || servers || {},
        };
        return JSON.stringify(writeConfig, null, 2);
    }

    return JSON.stringify(config, null, 2);
}
