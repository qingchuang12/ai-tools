/**
 * 配置管理器 —— 公共类型与常量（单一来源）
 *
 * 原定义在 config-manager.ts 顶部，现下沉为独立模块，行为完全一致。
 * config-manager.ts 仍以 `export * from './config/types'` 透出，外部 import 路径不变。
 */

// 单个 MCP Server 的配置
export interface McpServerConfig {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    type?: 'stdio' | 'http' | 'streamable-http' | 'sse';
    headers?: Record<string, string>;
    /**
     * ZCode 专用：显式 false 表示在客户端内被停用，字段缺失即视为启用。
     * 读写均原样透传——若读写时丢弃该字段，客户端内已停用的 Server 会被静默重新启用。
     */
    enable?: boolean;
    /**
     * 第三方 MCP server 的许可证标识（如 MIT / Apache-2.0），由 npm 适配器在详情里给出。
     * 安装时透传到 ConfigManager，用于运行时自动汇总（Phase 6 合规）。modelscope 等不传则跳过汇总。
     */
    license?: string;
    /** 来源平台标识（如 'npm'），用于许可证汇总时标注出处。 */
    source?: string;
    /** 来源主页 URL，用于许可证汇总时附链接。 */
    homepage?: string;
}

export interface ClientConfig {
    mcpServers?: Record<string, McpServerConfig>;

    [key: string]: any;
}

// 所有 MCP 客户端类型
// 'cloud' 是虚拟客户端：指向 ~/.ai-tools/cloud/ai-tools 暂存区，由云同步（Git / SFTP）推拉到远端
export type ClientType =
    'cursor'
    | 'vscode'
    | 'claude-code'
    | 'gemini-cli'
    | 'codex-cli'
    | 'windsurf'
    | 'zed'
    | 'trae'
    | 'trae-cn'
    | 'trae-solo-cn'
    | 'marscode'
    | 'kiro'
    | 'opencode'
    | 'jetbrains'
    | 'antigravity'
    | 'openclaw'
    | 'codebuddy'
    | 'workbuddy'
    | 'qoder'
    | 'zcode'
    | 'cloud';

/** 任意客户端 id：内置 ClientType 或用户手动添加的 custom:<slug> */
export type AnyClientId = ClientType | string;

// 支持 Skills 的客户端类型（含 .agents 统一标准）
export type SkillClientType =
    'cursor'
    | 'claude-code'
    | 'gemini-cli'
    | 'codex-cli'
    | 'opencode'
    | 'agent-skills'
    | 'codebuddy'
    | 'workbuddy'
    | 'qoder'
    | 'zcode'
    | 'marscode'
    | 'trae'
    | 'trae-cn'
    | 'trae-solo-cn'
    | 'antigravity'
    | 'cloud';

// 客户端是否支持 Skills
export const SKILL_SUPPORTED_CLIENTS: SkillClientType[] = ['cursor', 'claude-code', 'gemini-cli', 'codex-cli', 'opencode', 'agent-skills', 'codebuddy', 'workbuddy', 'qoder', 'zcode', 'marscode', 'trae', 'trae-cn', 'trae-solo-cn', 'antigravity', 'cloud'];

/** 所有内置客户端类型（单一来源：备份/遍历统一复用，避免硬编码遗漏，P1-3/P2-4）。'cloud' 为暂存区非真实配置，单独排除。 */
export const ALL_BUILTIN_CLIENTS: ClientType[] = [
    'cursor', 'vscode', 'claude-code', 'gemini-cli', 'codex-cli', 'windsurf', 'zed',
    'trae', 'trae-cn', 'trae-solo-cn', 'marscode', 'kiro', 'opencode', 'jetbrains', 'antigravity',
    'openclaw', 'codebuddy', 'workbuddy', 'qoder', 'zcode',
];

// VS Code 使用 "servers" 键而非 "mcpServers"
export const SERVERS_KEY_CLIENTS: ClientType[] = ['vscode'];

/**
 * 纯 CLI 分发形态的客户端（无 GUI 本体，只有命令行/可执行文件）。
 * 它们的配置文件（~/.claude.json、~/.codex/config.toml 等）可能由第三方工具、
 * 脚本或本应用写 MCP 配置时创建——配置文件存在不代表 CLI 本体已安装（用户报障：
 * 未装 Claude Code 却因 ~/.claude.json 存在显示已安装）。
 * 因此这些客户端的「已安装」判定只看本体探测（exe / npm / CLI where / 配置目录 marker），
 * 忽略 configExists 兜底。GUI/IDE 形态客户端保留原口径（配置文件存在是强「在用」信号）。
 */
export const EXECUTABLE_ONLY_CLIENTS: ClientType[] = [
    'claude-code',
    'gemini-cli',
    'codex-cli',
    'opencode',
    'openclaw',
    'qoder',
    'zcode',
];

export interface ClientInfo {
    id: ClientType | string;
    name: string;
    installed: boolean;
    configPath: string;
    configExists: boolean;
    supportsSkills: boolean;
    /**
     * 是否支持 MCP 配置写入。cloud（云同步暂存区）与 agent-skills（.agents 统一标准）
     * 是「仅 Skill」的虚拟客户端，没有 MCP 配置文件——UI 的 MCP 安装目标应以此过滤，
     * 不再用 id !== 'cloud' 之类的魔法字符串分散判断。
     */
    supportsMcp: boolean;
    skillsPath?: string;
    /** 是否为用户手动添加的客户端 */
    isCustom?: boolean;
}

/** 用户手动添加的客户端定义（持久化到 settings.json） */
export interface CustomClientDef {
    /** 唯一 id，形如 custom:<slug> */
    id: string;
    name: string;
    /** MCP 配置文件绝对路径 */
    configPath: string;
    /** 是否支持 Skills */
    supportsSkills: boolean;
    /** Skills 目录绝对路径（supportsSkills 时有效） */
    skillsPath?: string;
}
