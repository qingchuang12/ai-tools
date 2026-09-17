/**
 * 客户端路径探测与默认路径表（单一来源）
 *
 * 原实现散落在 ConfigManager 的构造函数与各 private 方法（getAppPaths /
 * getClientName / getConfigMarkers / getEnhancedPath / findJetBrainsConfigPath），
 * 现整体下沉为模块级纯函数与数据表，行为完全一致。ConfigManager 仅做薄转发。
 */

import fs from 'fs/promises';
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
            windsurf: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
            zed: path.join(home, '.config', 'zed', 'settings.json'),
            trae: path.join(home, 'Library', 'Application Support', 'Trae', 'User', 'mcp.json'),
            'trae-cn': path.join(home, 'Library', 'Application Support', 'Trae CN', 'User', 'mcp.json'),
            // TRAE SOLO CN（TraeWork 桌面端）：VS Code fork，MCP 配置走标准 User/mcp.json
            'trae-solo-cn': path.join(home, 'Library', 'Application Support', 'TRAE SOLO CN', 'User', 'mcp.json'),
            marscode: path.join(home, '.marscode', 'IDEA.mcp.config.json'),
            kiro: path.join(home, '.kiro', 'settings', 'mcp.json'),
            opencode: path.join(home, '.config', 'opencode', 'opencode.json'),
            jetbrains: '', // resolved dynamically via findJetBrainsConfigPath
            antigravity: path.join(home, '.gemini', 'config', 'mcp_config.json'),
            openclaw: path.join(home, '.openclaw', 'openclaw.json'),
            codebuddy: path.join(home, '.codebuddy', 'mcp.json'),
            workbuddy: path.join(home, '.workbuddy', 'mcp.json'),
            qoder: path.join(home, '.qoder', 'mcp.json'),
            // ZCode 用户级配置位于 .zcode/cli/ 下（工作区级才是 .zcode/config.json，本项目只管用户级）
            zcode: path.join(home, '.zcode', 'cli', 'config.json'),
            cloud: path.join(home, '.ai-tools', 'cloud', CLOUD_ROOT_DIR, 'mcp', 'mcp.json'),
        };
    } else if (platform === 'win32') {
        return {
            cursor: path.join(home, 'AppData', 'Roaming', 'Cursor', 'mcp.json'),
            vscode: path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json'),
            'claude-code': path.join(home, '.claude.json'),
            'gemini-cli': path.join(home, '.gemini', 'settings.json'),
            'codex-cli': path.join(home, '.codex', 'config.toml'),
            windsurf: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
            zed: path.join(home, 'AppData', 'Roaming', 'Zed', 'settings.json'),
            trae: path.join(home, 'AppData', 'Roaming', 'Trae', 'User', 'mcp.json'),
            'trae-cn': path.join(home, 'AppData', 'Roaming', 'Trae CN', 'User', 'mcp.json'),
            // TRAE SOLO CN（TraeWork 桌面端）：VS Code fork，MCP 配置走标准 User/mcp.json
            'trae-solo-cn': path.join(home, 'AppData', 'Roaming', 'TRAE SOLO CN', 'User', 'mcp.json'),
            marscode: path.join(home, '.marscode', 'IDEA.mcp.config.json'),
            kiro: path.join(home, '.kiro', 'settings', 'mcp.json'),
            opencode: path.join(home, '.config', 'opencode', 'opencode.json'),
            jetbrains: '', // resolved dynamically
            antigravity: path.join(home, '.gemini', 'config', 'mcp_config.json'),
            openclaw: path.join(home, '.openclaw', 'openclaw.json'),
            codebuddy: path.join(home, '.codebuddy', 'mcp.json'),
            workbuddy: path.join(home, '.workbuddy', 'mcp.json'),
            qoder: path.join(home, '.qoder', 'mcp.json'),
            // ZCode 用户级配置位于 .zcode/cli/ 下（工作区级才是 .zcode/config.json，本项目只管用户级）
            zcode: path.join(home, '.zcode', 'cli', 'config.json'),
            cloud: path.join(home, '.ai-tools', 'cloud', CLOUD_ROOT_DIR, 'mcp', 'mcp.json'),
        };
    } else {
        return {
            cursor: path.join(home, '.cursor', 'mcp.json'),
            vscode: path.join(home, '.config', 'Code', 'User', 'mcp.json'),
            'claude-code': path.join(home, '.claude.json'),
            'gemini-cli': path.join(home, '.gemini', 'settings.json'),
            'codex-cli': path.join(home, '.codex', 'config.toml'),
            windsurf: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
            zed: path.join(home, '.config', 'zed', 'settings.json'),
            trae: path.join(home, '.config', 'Trae', 'User', 'mcp.json'),
            'trae-cn': path.join(home, '.config', 'Trae CN', 'User', 'mcp.json'),
            // TRAE SOLO CN（TraeWork 桌面端）：VS Code fork，MCP 配置走标准 User/mcp.json
            'trae-solo-cn': path.join(home, '.config', 'TRAE SOLO CN', 'User', 'mcp.json'),
            marscode: path.join(home, '.marscode', 'IDEA.mcp.config.json'),
            kiro: path.join(home, '.kiro', 'settings', 'mcp.json'),
            opencode: path.join(home, '.config', 'opencode', 'opencode.json'),
            jetbrains: '', // resolved dynamically
            antigravity: path.join(home, '.gemini', 'config', 'mcp_config.json'),
            openclaw: path.join(home, '.openclaw', 'openclaw.json'),
            codebuddy: path.join(home, '.codebuddy', 'mcp.json'),
            workbuddy: path.join(home, '.workbuddy', 'mcp.json'),
            qoder: path.join(home, '.qoder', 'mcp.json'),
            // ZCode 用户级配置位于 .zcode/cli/ 下（工作区级才是 .zcode/config.json，本项目只管用户级）
            zcode: path.join(home, '.zcode', 'cli', 'config.json'),
            cloud: path.join(home, '.ai-tools', 'cloud', CLOUD_ROOT_DIR, 'mcp', 'mcp.json'),
        };
    }
}

/**
 * 返回某客户端的 MCP 配置文件「候选路径」有序列表（用于自动识别）。
 *
 * 设计动机：单一硬编码路径在以下场景会漏判——
 * - Trae / Trae CN 同时存在「VS Code fork 布局」(`AppData/Roaming/Trae/User/mcp.json`)
 *   与「扁平布局」(`~/.trae/mcp.json`) 两种形态，随版本而异；
 * - CodeBuddy 官方优先级为 `~/.codebuddy/.mcp.json`(推荐) > `~/.codebuddy/mcp.json`(弃用) > `~/.codebuddy.json`(legacy)；
 * - antigravity 旧代码误写成 `~/.gemini/antigravity/...`，真实路径为 `~/.gemini/config/mcp_config.json`。
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
        case 'trae':
            return [
                primary, // VS Code fork 布局（当前默认，保持向后兼容）
                path.join(home, '.trae', 'mcp.json'), // 扁平布局
            ];
        case 'trae-cn':
            return [
                primary,
                path.join(home, '.trae-cn', 'mcp.json'),
            ];
        case 'trae-solo-cn':
            // 官方论坛确认此即全局路径，单路径即可，无需回退
            return [primary];
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

/**
 * 扫描 JetBrains 配置目录，找到最新版本的 mcp.json
 */
export async function findJetBrainsConfigPath(home: string, platform: NodeJS.Platform): Promise<string> {
    let baseDir: string;
    if (platform === 'darwin') {
        baseDir = path.join(home, 'Library', 'Application Support', 'JetBrains');
    } else if (platform === 'win32') {
        baseDir = path.join(home, 'AppData', 'Roaming', 'JetBrains');
    } else {
        baseDir = path.join(home, '.config', 'JetBrains');
    }

    try {
        const entries = await fs.readdir(baseDir, {withFileTypes: true});
        const idePatterns = /^(IntelliJIdea|IdeaIC|WebStorm|PyCharm|GoLand|Rider|CLion|PhpStorm|RubyMine|DataGrip)/;
        const ideDirs = entries
            .filter(e => e.isDirectory() && idePatterns.test(e.name))
            .map(e => e.name)
            .sort()
            .reverse();

        for (const dir of ideDirs) {
            const mcpPath = path.join(baseDir, dir, 'mcp.json');
            try {
                await fs.access(mcpPath);
                return mcpPath;
            } catch {
                // mcp.json doesn't exist in this dir
            }
        }
        if (ideDirs.length > 0) {
            return path.join(baseDir, ideDirs[0], 'mcp.json');
        }
    } catch {
        // JetBrains dir doesn't exist
    }
    return '';
}
