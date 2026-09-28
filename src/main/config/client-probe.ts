/**
 * 客户端路径探测与默认路径表（单一来源）
 *
 * 原实现散落在 ConfigManager 的构造函数与各 private 方法（getAppPaths /
 * getClientName / getConfigMarkers / getEnhancedPath），现整体下沉为模块级纯函数与
 * 数据表，行为完全一致。ConfigManager 仅做薄转发。
 */

import path from 'path';
import os from 'os';
import {CLOUD_ROOT_DIR} from '../../shared/cloud-sync-constants';
import type {AnyClientId, ClientType} from './types';

/**
 * 根据平台返回各客户端默认配置路径（含 'cloud' 虚拟客户端）。
 * 与 ConfigManager 原构造函数中的字面量表逐一对应。
 */
export function getDefaultClientPaths(home: string, platform: NodeJS.Platform): Record<ClientType, string> {
    if (platform === 'darwin') {
        return {
            cursor: path.join(home, '.cursor', 'mcp.json'),
            vscode: path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
            'claude-code': path.join(home, '.claude.json'),
            'gemini-cli': path.join(home, '.gemini', 'settings.json'),
            'codex-cli': path.join(home, '.codex', 'config.toml'),
            // Windsurf 随 Devin 品牌迁移改了配置落点：Cascade 实际加载 devin 目录，
            // 且 macOS 与 Linux 同为 XDG 风格路径（官方文档原文 macOS and Linux）。
            // 旧 ~/.codeium/windsurf/mcp_config.json 现仅作编辑器 discovery 源（需用户勾选），不再写。
            windsurf: path.join(home, '.config', 'devin', 'mcp_config.json'),
            zed: path.join(home, '.config', 'zed', 'settings.json'),
            trae: path.join(home, 'Library', 'Application Support', 'Trae', 'User', 'mcp.json'),
            'trae-cn': path.join(home, 'Library', 'Application Support', 'Trae CN', 'User', 'mcp.json'),
            // TRAE SOLO CN 不是独立配置形态：SOLO 是 TraeCode 内的模式，与 Trae CN IDE 共用同一
            // User/mcp.json（独立客户端官方名为 TraeWork）。旧「TRAE SOLO CN」目录无官方依据。
            'trae-solo-cn': path.join(home, 'Library', 'Application Support', 'Trae CN', 'User', 'mcp.json'),
            marscode: path.join(home, '.marscode', 'IDEA.mcp.config.json'),
            kiro: path.join(home, '.kiro', 'settings', 'mcp.json'),
            opencode: path.join(home, '.config', 'opencode', 'opencode.json'),
            // AI Assistant / Junie 的用户级 MCP 配置：三平台同为 ~/.junie/mcp/mcp.json
            // （Windows 即 %USERPROFILE%\.junie\mcp\mcp.json）。IDE 配置目录里的
            // <产品><版本>/mcp.json 从不被读取（本机 IDEA 2025.2 只有 options/*.xml 内部状态），
            // 且 Android Studio 落在 %APPDATA%\Google\ 下、前缀扫描永远找不到，故取消版本目录扫描。
            jetbrains: path.join(home, '.junie', 'mcp', 'mcp.json'),
            antigravity: path.join(home, '.gemini', 'config', 'mcp_config.json'),
            openclaw: path.join(home, '.openclaw', 'openclaw.json'),
            codebuddy: path.join(home, '.codebuddy', 'mcp.json'),
            workbuddy: path.join(home, '.workbuddy', 'mcp.json'),
            // Qoder 用户级 MCP 配置在 settings.json 的顶层 mcpServers 键（官方 docs/cli/mcp-reference）；
            // 写独立 mcp.json 的话 Qoder 完全不读。
            qoder: path.join(home, '.qoder', 'settings.json'),
            // ZCode 用户级配置位于 .zcode/cli/ 下（工作区级才是 .zcode/config.json，本项目只管用户级）
            zcode: path.join(home, '.zcode', 'cli', 'config.json'),
            // 以下几家的官方文档均以 `~` 表述用户级路径、不按操作系统分列（Windows 即 %USERPROFILE%），
            // 故三平台同值。Cline 的 IDE 扩展与 CLI 共用同一文件（旧 Documents/Cline/MCP 由官方自动迁移）。
            cline: path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
            'qwen-code': path.join(home, '.qwen', 'settings.json'),
            'iflow-cli': path.join(home, '.iflow', 'settings.json'),
            'lm-studio': path.join(home, '.lmstudio', 'mcp.json'),
            openhands: path.join(home, '.openhands', 'mcp.json'),
            'copilot-cli': path.join(home, '.copilot', 'mcp-config.json'),
            // Warp / Kimi Code CLI 的字段形状与通用 mcpServers 不同（Warp 用 working_directory，
            // Kimi 用 transport / enabled），读写映射见 config/format-adapters.ts。
            warp: path.join(home, '.warp', '.mcp.json'),
            // Kimi 另支持 $KIMI_CODE_HOME 与项目级 .kimi-code/mcp.json，本工具只管用户级这一处。
            'kimi-code': path.join(home, '.kimi-code', 'mcp.json'),
            cloud: path.join(home, '.ai-tools', 'cloud', CLOUD_ROOT_DIR, 'mcp', 'mcp.json'),
        };
    } else if (platform === 'win32') {
        return {
            // Cursor 全局配置三平台统一为 ~/.cursor/mcp.json（官方文档不按操作系统区分）
            cursor: path.join(home, '.cursor', 'mcp.json'),
            vscode: path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json'),
            'claude-code': path.join(home, '.claude.json'),
            'gemini-cli': path.join(home, '.gemini', 'settings.json'),
            'codex-cli': path.join(home, '.codex', 'config.toml'),
            windsurf: path.join(home, 'AppData', 'Roaming', 'devin', 'mcp_config.json'),
            zed: path.join(home, 'AppData', 'Roaming', 'Zed', 'settings.json'),
            trae: path.join(home, 'AppData', 'Roaming', 'Trae', 'User', 'mcp.json'),
            'trae-cn': path.join(home, 'AppData', 'Roaming', 'Trae CN', 'User', 'mcp.json'),
            // TRAE SOLO CN 与 Trae CN IDE 共用同一 User/mcp.json（SOLO 只是 TraeCode 内的模式）
            'trae-solo-cn': path.join(home, 'AppData', 'Roaming', 'Trae CN', 'User', 'mcp.json'),
            marscode: path.join(home, '.marscode', 'IDEA.mcp.config.json'),
            kiro: path.join(home, '.kiro', 'settings', 'mcp.json'),
            opencode: path.join(home, '.config', 'opencode', 'opencode.json'),
            jetbrains: path.join(home, '.junie', 'mcp', 'mcp.json'),
            antigravity: path.join(home, '.gemini', 'config', 'mcp_config.json'),
            openclaw: path.join(home, '.openclaw', 'openclaw.json'),
            codebuddy: path.join(home, '.codebuddy', 'mcp.json'),
            workbuddy: path.join(home, '.workbuddy', 'mcp.json'),
            qoder: path.join(home, '.qoder', 'settings.json'),
            // ZCode 用户级配置位于 .zcode/cli/ 下（工作区级才是 .zcode/config.json，本项目只管用户级）
            zcode: path.join(home, '.zcode', 'cli', 'config.json'),
            // 以下几家的官方文档均以 `~` 表述用户级路径、不按操作系统分列（Windows 即 %USERPROFILE%），
            // 故三平台同值。Cline 的 IDE 扩展与 CLI 共用同一文件（旧 Documents/Cline/MCP 由官方自动迁移）。
            cline: path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
            'qwen-code': path.join(home, '.qwen', 'settings.json'),
            'iflow-cli': path.join(home, '.iflow', 'settings.json'),
            'lm-studio': path.join(home, '.lmstudio', 'mcp.json'),
            openhands: path.join(home, '.openhands', 'mcp.json'),
            'copilot-cli': path.join(home, '.copilot', 'mcp-config.json'),
            // Warp / Kimi Code CLI 的字段形状与通用 mcpServers 不同（Warp 用 working_directory，
            // Kimi 用 transport / enabled），读写映射见 config/format-adapters.ts。
            warp: path.join(home, '.warp', '.mcp.json'),
            // Kimi 另支持 $KIMI_CODE_HOME 与项目级 .kimi-code/mcp.json，本工具只管用户级这一处。
            'kimi-code': path.join(home, '.kimi-code', 'mcp.json'),
            cloud: path.join(home, '.ai-tools', 'cloud', CLOUD_ROOT_DIR, 'mcp', 'mcp.json'),
        };
    } else {
        return {
            cursor: path.join(home, '.cursor', 'mcp.json'),
            vscode: path.join(home, '.config', 'Code', 'User', 'mcp.json'),
            'claude-code': path.join(home, '.claude.json'),
            'gemini-cli': path.join(home, '.gemini', 'settings.json'),
            'codex-cli': path.join(home, '.codex', 'config.toml'),
            windsurf: path.join(home, '.config', 'devin', 'mcp_config.json'),
            zed: path.join(home, '.config', 'zed', 'settings.json'),
            trae: path.join(home, '.config', 'Trae', 'User', 'mcp.json'),
            'trae-cn': path.join(home, '.config', 'Trae CN', 'User', 'mcp.json'),
            // TRAE SOLO CN 与 Trae CN IDE 共用同一 User/mcp.json（SOLO 只是 TraeCode 内的模式）
            'trae-solo-cn': path.join(home, '.config', 'Trae CN', 'User', 'mcp.json'),
            marscode: path.join(home, '.marscode', 'IDEA.mcp.config.json'),
            kiro: path.join(home, '.kiro', 'settings', 'mcp.json'),
            opencode: path.join(home, '.config', 'opencode', 'opencode.json'),
            jetbrains: path.join(home, '.junie', 'mcp', 'mcp.json'),
            antigravity: path.join(home, '.gemini', 'config', 'mcp_config.json'),
            openclaw: path.join(home, '.openclaw', 'openclaw.json'),
            codebuddy: path.join(home, '.codebuddy', 'mcp.json'),
            workbuddy: path.join(home, '.workbuddy', 'mcp.json'),
            qoder: path.join(home, '.qoder', 'settings.json'),
            // ZCode 用户级配置位于 .zcode/cli/ 下（工作区级才是 .zcode/config.json，本项目只管用户级）
            zcode: path.join(home, '.zcode', 'cli', 'config.json'),
            // 以下几家的官方文档均以 `~` 表述用户级路径、不按操作系统分列（Windows 即 %USERPROFILE%），
            // 故三平台同值。Cline 的 IDE 扩展与 CLI 共用同一文件（旧 Documents/Cline/MCP 由官方自动迁移）。
            cline: path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
            'qwen-code': path.join(home, '.qwen', 'settings.json'),
            'iflow-cli': path.join(home, '.iflow', 'settings.json'),
            'lm-studio': path.join(home, '.lmstudio', 'mcp.json'),
            openhands: path.join(home, '.openhands', 'mcp.json'),
            'copilot-cli': path.join(home, '.copilot', 'mcp-config.json'),
            // Warp / Kimi Code CLI 的字段形状与通用 mcpServers 不同（Warp 用 working_directory，
            // Kimi 用 transport / enabled），读写映射见 config/format-adapters.ts。
            warp: path.join(home, '.warp', '.mcp.json'),
            // Kimi 另支持 $KIMI_CODE_HOME 与项目级 .kimi-code/mcp.json，本工具只管用户级这一处。
            'kimi-code': path.join(home, '.kimi-code', 'mcp.json'),
            cloud: path.join(home, '.ai-tools', 'cloud', CLOUD_ROOT_DIR, 'mcp', 'mcp.json'),
        };
    }
}

/**
 * 返回某客户端的 MCP 配置文件「候选路径」有序列表（用于自动识别）。
 *
 * 设计动机：单一硬编码路径在以下场景会漏判——
 * - CodeBuddy 官方优先级为 `~/.codebuddy/.mcp.json`(推荐) > `~/.codebuddy/mcp.json`(弃用) > `~/.codebuddy.json`(legacy)；
 * - antigravity 旧代码误写成 `~/.gemini/antigravity/...`，真实路径为 `~/.gemini/config/mcp_config.json`。
 *
 * 注：Trae / Trae CN 只有 VS Code fork 布局（AppData 下 Trae 系列的 User/mcp.json）——旧代码里的
 * 「扁平布局」候选 `~/.trae/mcp.json`、`~/.trae-cn/mcp.json` 系由项目级 `<项目>/.trae/mcp.json`
 * 误推（`~/.trae-cn` 实为 TraeCode CLI 目录，不放 mcp.json），已移除。
 *
 * 列表第一项即「首选写路径」（无已有配置时的落盘位置），其余为「探测回退」。
 * 解析时取首个 `fs.existsSync` 命中的候选；全不存在则回退到第一项（首选）。
 * 这样读取与写入永远落在同一文件，保证往返一致、且能兼容多种布局。
 */
export function getClientMcpCandidatePaths(client: AnyClientId, platform: NodeJS.Platform): string[] {
    const home = os.homedir();
    const primary = getDefaultClientPaths(home, platform)[client as ClientType];

    switch (client) {
        case 'antigravity':
            return [
                path.join(home, '.gemini', 'config', 'mcp_config.json'),
                // 旧误写路径：仅作读取回退，便于迁移现有用户（若有手工配置落在此处）
                path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
            ];
        case 'codebuddy':
            return [
                path.join(home, '.codebuddy', '.mcp.json'), // 官方推荐
                path.join(home, '.codebuddy', 'mcp.json'), // 弃用但有效
                path.join(home, '.codebuddy.json'), // legacy
            ];
        default:
            return [primary];
    }
}

/**
 * 获取客户端显示名称
 */
export function getClientDisplayName(client: AnyClientId): string {
    const names: Partial<Record<AnyClientId, string>> = {
        cursor: 'Cursor',
        vscode: 'VS Code',
        'claude-code': 'Claude Code',
        'gemini-cli': 'Gemini CLI',
        'codex-cli': 'Codex CLI',
        windsurf: 'Windsurf',
        zed: 'Zed',
        trae: 'TRAE',
        'trae-cn': 'TRAE CN',
        'trae-solo-cn': 'TRAE SOLO CN',
        marscode: 'TRAE Plugin',
        kiro: 'Kiro',
        opencode: 'Opencode',
        jetbrains: 'JetBrains',
        antigravity: 'Antigravity',
        openclaw: 'OpenClaw',
        codebuddy: 'CodeBuddy',
        workbuddy: 'WorkBuddy',
        qoder: 'Qoder',
        zcode: 'ZCode',
        cline: 'Cline',
        'qwen-code': 'Qwen Code',
        'iflow-cli': 'iFlow CLI',
        'lm-studio': 'LM Studio',
        openhands: 'OpenHands',
        'copilot-cli': 'GitHub Copilot CLI',
        warp: 'Warp',
        'kimi-code': 'Kimi Code CLI',
        // .agents 统一标准目录（skills.sh），虚拟客户端：无 MCP 配置、仅作 Skill 载体
        'agent-skills': 'Agent Skills (.agents)',
        cloud: '云端存储',
    };
    return names[client] || (typeof client === 'string' ? client.replace(/^custom:/, '') : 'Unknown Client');
}

/**
 * 获取各平台的应用路径（用于安装状态探测）
 */
export function getClientAppPaths(client: AnyClientId, platform: NodeJS.Platform): string[] {
    const home = os.homedir();

    const darwinPaths: Record<string, string[]> = {
        cursor: ['/Applications/Cursor.app', path.join(home, 'Applications', 'Cursor.app')],
        vscode: ['/Applications/Visual Studio Code.app', path.join(home, 'Applications', 'Visual Studio Code.app')],
        'claude-code': ['/usr/local/bin/claude', path.join(home, '.local', 'bin', 'claude')],
        'gemini-cli': ['/usr/local/bin/gemini', path.join(home, '.local', 'bin', 'gemini')],
        'codex-cli': [
            '/usr/local/bin/codex',
            path.join(home, '.local', 'bin', 'codex'),
            '/opt/homebrew/bin/codex',
            path.join(home, '.npm', 'bin', 'codex'),
        ],
        windsurf: ['/Applications/Windsurf.app', path.join(home, 'Applications', 'Windsurf.app')],
        zed: ['/Applications/Zed.app', path.join(home, 'Applications', 'Zed.app')],
        trae: ['/Applications/Trae.app', path.join(home, 'Applications', 'Trae.app'), '/Applications/TRAE.app', path.join(home, 'Applications', 'TRAE.app')],
        'trae-cn': ['/Applications/Trae CN.app', path.join(home, 'Applications', 'Trae CN.app')],
        'trae-solo-cn': ['/Applications/TRAE SOLO CN.app', path.join(home, 'Applications', 'TRAE SOLO CN.app')],
        marscode: [],
        kiro: ['/Applications/Kiro.app', path.join(home, 'Applications', 'Kiro.app')],
        opencode: ['/usr/local/bin/opencode', path.join(home, '.local', 'bin', 'opencode'), '/opt/homebrew/bin/opencode'],
        antigravity: ['/Applications/Antigravity.app', path.join(home, 'Applications', 'Antigravity.app')],
        openclaw: ['/usr/local/bin/openclaw', '/usr/local/bin/oclaw', path.join(home, '.local', 'bin', 'openclaw'), '/opt/homebrew/bin/openclaw'],
        codebuddy: ['/Applications/CodeBuddy.app', path.join(home, 'Applications', 'CodeBuddy.app')],
        workbuddy: ['/Applications/WorkBuddy.app', path.join(home, 'Applications', 'WorkBuddy.app')],
        qoder: ['/Applications/Qoder.app', path.join(home, 'Applications', 'Qoder.app')],
        zcode: [
            '/Applications/ZCode.app',
            path.join(home, 'Applications', 'ZCode.app'),
            '/usr/local/bin/zcode',
            path.join(home, '.local', 'bin', 'zcode'),
            path.join(home, '.zcode', 'cli'),
        ],
        // 新增客户端：GUI 形态按 .app bundle 探测，CLI 形态按 PATH 上的可执行文件 + which 查找（cliClients）。
        cline: ['/usr/local/bin/cline', path.join(home, '.local', 'bin', 'cline'), '/opt/homebrew/bin/cline'],
        'qwen-code': ['/usr/local/bin/qwen', path.join(home, '.local', 'bin', 'qwen'), '/opt/homebrew/bin/qwen'],
        'iflow-cli': ['/usr/local/bin/iflow', path.join(home, '.local', 'bin', 'iflow'), '/opt/homebrew/bin/iflow'],
        'lm-studio': ['/Applications/LM Studio.app', path.join(home, 'Applications', 'LM Studio.app')],
        openhands: ['/usr/local/bin/openhands', path.join(home, '.local', 'bin', 'openhands'), '/opt/homebrew/bin/openhands'],
        'copilot-cli': ['/usr/local/bin/copilot', path.join(home, '.local', 'bin', 'copilot'), '/opt/homebrew/bin/copilot'],
        // Warp 本体为 GUI 终端应用；Kimi Code CLI 的可执行文件名官方文档给出为 kimi。
        warp: ['/Applications/Warp.app', path.join(home, 'Applications', 'Warp.app')],
        'kimi-code': ['/usr/local/bin/kimi', path.join(home, '.local', 'bin', 'kimi'), '/opt/homebrew/bin/kimi'],
        cloud: [], // 虚拟客户端：可用性由云同步配置决定，不做文件探测
        jetbrains: [
            '/Applications/IntelliJ IDEA.app',
            '/Applications/IntelliJ IDEA CE.app',
            '/Applications/WebStorm.app',
            '/Applications/PyCharm.app',
            '/Applications/GoLand.app',
            '/Applications/CLion.app',
            '/Applications/PhpStorm.app',
            '/Applications/Rider.app',
            path.join(home, 'Applications', 'IntelliJ IDEA.app'),
            path.join(home, 'Library', 'Application Support', 'JetBrains', 'Toolbox'),
        ],
    };

    const win32Paths: Record<string, string[]> = {
        cursor: [
            path.join(home, 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe'),
            path.join(home, 'AppData', 'Local', 'cursor', 'Cursor.exe'),
        ],
        vscode: [
            path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
            path.join('C:', 'Program Files', 'Microsoft VS Code', 'Code.exe'),
        ],
        'claude-code': [
            path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
            path.join(home, '.claude', 'claude.exe'),
            path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        ],
        'gemini-cli': [
            path.join(home, 'AppData', 'Local', 'Programs', 'gemini', 'gemini.exe'),
            path.join(home, '.gemini', 'gemini.exe'),
            // npm 全局安装形态（与 claude-code / codex-cli 的 npm 探测对齐）
            path.join(home, 'AppData', 'Roaming', 'npm', 'gemini.cmd'),
        ],
        'codex-cli': [
            path.join(home, 'AppData', 'Local', 'Programs', 'codex', 'codex.exe'),
            path.join(home, '.codex', 'codex.exe'),
            path.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
        ],
        windsurf: [
            path.join(home, 'AppData', 'Local', 'Programs', 'windsurf', 'Windsurf.exe'),
            path.join(home, 'AppData', 'Local', 'Windsurf', 'Windsurf.exe'),
        ],
        zed: [
            path.join(home, 'AppData', 'Local', 'Programs', 'Zed', 'Zed.exe'),
            path.join(home, 'AppData', 'Local', 'Zed', 'Zed.exe'),
        ],
        trae: [
            path.join(home, 'AppData', 'Local', 'Programs', 'trae', 'TRAE.exe'),
            path.join(home, 'AppData', 'Local', 'TRAE', 'TRAE.exe'),
        ],
        'trae-cn': [
            path.join(home, 'AppData', 'Local', 'Programs', 'trae-cn', 'TRAE CN.exe'),
            path.join(home, 'AppData', 'Local', 'Trae CN', 'Trae CN.exe'),
        ],
        'trae-solo-cn': [
            path.join(home, 'AppData', 'Local', 'Programs', 'TRAE SOLO CN', 'TRAE SOLO CN.exe'),
            path.join(home, 'AppData', 'Local', 'TRAE SOLO CN', 'TRAE SOLO CN.exe'),
        ],
        marscode: [],
        kiro: [
            path.join(home, 'AppData', 'Local', 'Programs', 'Kiro', 'Kiro.exe'),
            path.join(home, 'AppData', 'Local', 'Kiro', 'Kiro.exe'),
        ],
        opencode: [
            path.join(home, 'AppData', 'Local', 'Programs', 'opencode', 'opencode.exe'),
        ],
        antigravity: [
            path.join(home, 'AppData', 'Local', 'Programs', 'Antigravity', 'Antigravity.exe'),
        ],
        openclaw: [
            path.join(home, 'AppData', 'Roaming', 'npm', 'openclaw.cmd'),
            path.join(home, 'AppData', 'Local', 'Programs', 'openclaw', 'openclaw.exe'),
        ],
        codebuddy: [
            path.join(home, 'AppData', 'Local', 'Programs', 'CodeBuddy', 'CodeBuddy.exe'),
            path.join(home, 'AppData', 'Local', 'CodeBuddy', 'CodeBuddy.exe'),
            path.join(home, '.codebuddy', 'bin', 'codebuddy.exe'),
        ],
        workbuddy: [
            path.join(home, 'AppData', 'Local', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
            path.join(home, 'AppData', 'Local', 'WorkBuddy', 'WorkBuddy.exe'),
            path.join(home, '.workbuddy', 'bin', 'workbuddy.exe'),
        ],
        qoder: [
            path.join(home, 'AppData', 'Local', 'Programs', 'Qoder', 'Qoder.exe'),
            path.join(home, 'AppData', 'Local', 'Qoder', 'Qoder.exe'),
            path.join(home, '.qoder', 'bin', 'qoder.exe'),
        ],
        zcode: [
            path.join(home, 'AppData', 'Local', 'Programs', 'ZCode', 'ZCode.exe'),
            path.join(home, 'AppData', 'Local', 'ZCode', 'ZCode.exe'),
            path.join(home, 'AppData', 'Roaming', 'npm', 'zcode.cmd'),
            path.join(home, '.zcode', 'cli'),
        ],
        // 新增 CLI 形态客户端：本体探测以 npm 全局 bin + PATH 查找（cliClients）为准，
        // 不臆造未文档化的安装目录。
        cline: [path.join(home, 'AppData', 'Roaming', 'npm', 'cline.cmd')],
        'qwen-code': [path.join(home, 'AppData', 'Roaming', 'npm', 'qwen.cmd')],
        'iflow-cli': [path.join(home, 'AppData', 'Roaming', 'npm', 'iflow.cmd')],
        'lm-studio': [],
        openhands: [path.join(home, 'AppData', 'Roaming', 'npm', 'openhands.cmd')],
        'copilot-cli': [path.join(home, 'AppData', 'Roaming', 'npm', 'copilot.cmd')],
        // Warp 官方「File and folder locations」文档给出的 Windows 本地配置目录（仅 Warp 自身创建，
        // 本工具不写入该处），故可作为本体探测信号；exe 具体落点官方未列，不臆造。
        warp: [path.join(home, 'AppData', 'Local', 'warp', 'Warp', 'config')],
        'kimi-code': [path.join(home, 'AppData', 'Roaming', 'npm', 'kimi.cmd')],
        cloud: [],
        jetbrains: [
            path.join(home, 'AppData', 'Local', 'JetBrains', 'Toolbox'),
            path.join('C:', 'Program Files', 'JetBrains'),
        ],
    };

    const linuxPaths: Record<string, string[]> = {
        cursor: [
            '/usr/bin/cursor',
            '/usr/local/bin/cursor',
            path.join(home, '.local', 'bin', 'cursor'),
            '/opt/Cursor/cursor',
        ],
        vscode: [
            '/usr/bin/code',
            '/usr/local/bin/code',
            '/snap/bin/code',
            '/usr/share/code/code',
        ],
        'claude-code': [
            '/usr/bin/claude',
            '/usr/local/bin/claude',
            path.join(home, '.local', 'bin', 'claude'),
        ],
        'gemini-cli': [
            '/usr/bin/gemini',
            '/usr/local/bin/gemini',
            path.join(home, '.local', 'bin', 'gemini'),
        ],
        'codex-cli': [
            '/usr/bin/codex',
            '/usr/local/bin/codex',
            path.join(home, '.local', 'bin', 'codex'),
            path.join(home, '.npm', 'bin', 'codex'),
        ],
        windsurf: [
            '/usr/bin/windsurf',
            '/usr/local/bin/windsurf',
            '/opt/Windsurf/windsurf',
        ],
        zed: [
            '/usr/bin/zed',
            '/usr/local/bin/zed',
            path.join(home, '.local', 'bin', 'zed'),
            '/opt/Zed/zed',
        ],
        trae: [
            '/usr/bin/trae',
            '/usr/local/bin/trae',
            '/opt/TRAE/trae',
        ],
        'trae-cn': [
            '/usr/bin/trae-cn',
            '/usr/local/bin/trae-cn',
            '/opt/Trae CN/trae-cn',
        ],
        'trae-solo-cn': [
            '/usr/bin/trae-solo-cn',
            '/usr/local/bin/trae-solo-cn',
            '/opt/TRAE SOLO CN/trae-solo-cn',
        ],
        marscode: [],
        kiro: [
            '/usr/bin/kiro',
            '/usr/local/bin/kiro',
            path.join(home, '.local', 'bin', 'kiro'),
        ],
        opencode: [
            '/usr/bin/opencode',
            '/usr/local/bin/opencode',
            path.join(home, '.local', 'bin', 'opencode'),
        ],
        antigravity: [
            '/usr/bin/antigravity',
            path.join(home, '.local', 'bin', 'antigravity'),
        ],
        openclaw: [
            '/usr/local/bin/openclaw',
            '/usr/local/bin/oclaw',
            path.join(home, '.local', 'bin', 'openclaw'),
        ],
        codebuddy: [
            '/usr/bin/codebuddy',
            '/usr/local/bin/codebuddy',
            path.join(home, '.local', 'bin', 'codebuddy'),
            path.join(home, '.codebuddy', 'bin', 'codebuddy'),
        ],
        workbuddy: [
            '/usr/bin/workbuddy',
            '/usr/local/bin/workbuddy',
            path.join(home, '.local', 'bin', 'workbuddy'),
            path.join(home, '.workbuddy', 'bin', 'workbuddy'),
        ],
        qoder: [
            '/usr/bin/qoder',
            '/usr/local/bin/qoder',
            path.join(home, '.local', 'bin', 'qoder'),
            path.join(home, '.qoder', 'bin', 'qoder'),
        ],
        zcode: [
            '/usr/bin/zcode',
            '/usr/local/bin/zcode',
            path.join(home, '.local', 'bin', 'zcode'),
            path.join(home, '.zcode', 'cli'),
        ],
        // 新增 CLI 形态客户端：本体探测以 PATH 上的可执行文件 + which 查找（cliClients）为准。
        cline: ['/usr/bin/cline', '/usr/local/bin/cline', path.join(home, '.local', 'bin', 'cline')],
        'qwen-code': ['/usr/bin/qwen', '/usr/local/bin/qwen', path.join(home, '.local', 'bin', 'qwen')],
        'iflow-cli': ['/usr/bin/iflow', '/usr/local/bin/iflow', path.join(home, '.local', 'bin', 'iflow')],
        'lm-studio': [],
        openhands: ['/usr/bin/openhands', '/usr/local/bin/openhands', path.join(home, '.local', 'bin', 'openhands')],
        'copilot-cli': ['/usr/bin/copilot', '/usr/local/bin/copilot', path.join(home, '.local', 'bin', 'copilot')],
        // Warp 官方文档 Linux 配置目录为 ${XDG_CONFIG_HOME:-~/.config}/warp-terminal（仅 Warp 自身创建）。
        warp: [path.join(home, '.config', 'warp-terminal')],
        'kimi-code': ['/usr/bin/kimi', '/usr/local/bin/kimi', path.join(home, '.local', 'bin', 'kimi')],
        cloud: [],
        jetbrains: [
            path.join(home, '.local', 'share', 'JetBrains', 'Toolbox'),
            '/opt/idea',
            '/opt/webstorm',
            '/opt/pycharm',
        ],
    };

    if (platform === 'darwin') {
        return darwinPaths[client] || [];
    } else if (platform === 'win32') {
        return win32Paths[client] || [];
    } else {
        return linuxPaths[client] || [];
    }
}

/**
 * 客户端「配置目录标记」：这些路径存在即视为客户端可用。
 * 仅适用于两类客户端：
 * 1. 以 IDE 插件 / 无独立可执行文件形态分发的（如 CodeBuddy、MarsCode）；
 * 2. 纯目录标准（agent-skills 的 ~/.agents，目录本身就是「在用」的全部证据）。
 *
 * 注意：有独立可执行文件的客户端（claude-code / gemini-cli / cursor 等）**不加**目录 marker——
 * 它们的家目录（~/.claude 等）可能只是 mcp-dock 安装技能时 mkdir 出来的、或卸载残留，
 * 并不代表客户端本体已安装；已安装判定只走 exe / npm / CLI where 探测
 * （否则会出现「没装 Claude Code 却显示已安装」的反直觉结果，plan-2.0 执行修正）。
 *
 * trae-cn / trae-solo-cn 均无目录标记：二者共享 ~/.trae-cn 撞名，任一方加 marker
 * 都会把对方误判为已安装（plan-1.8 决策），exe 探测已足够。
 */
export function getClientConfigMarkers(client: AnyClientId): string[] {
    const home = os.homedir();
    const markers: Record<string, string[]> = {
        codebuddy: [
            path.join(home, '.codebuddy'),
        ],
        workbuddy: [
            path.join(home, '.workbuddy'),
        ],
        qoder: [
            path.join(home, '.qoder'),
        ],
        zcode: [
            path.join(home, '.zcode'),
        ],
        openclaw: [
            path.join(home, '.openclaw'),
        ],
        marscode: [
            path.join(home, '.marscode'),
        ],
        'agent-skills': [
            path.join(home, '.agents'),
        ],
    };
    return markers[client] || [];
}

/**
 * 获取增强的 PATH（包含常见安装路径）
 */
export function getEnhancedPathEnv(): string {
    const home = os.homedir();
    const currentPath = process.env.PATH || '';
    const additionalPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(home, '.local', 'bin'),
        path.join(home, '.npm', 'bin'),
        path.join(home, '.cargo', 'bin'),
    ];
    return [...additionalPaths, currentPath].join(path.delimiter);
}
