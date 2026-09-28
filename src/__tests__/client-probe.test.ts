/**
 * 客户端路径探测自动化测试
 *
 * 覆盖：三平台配置路径表完整性、Skills 目录完整性、显示名完整性。
 * 这些是「加一个内置客户端」最容易漏改的地方——漏配某个平台会导致该客户端
 * 在该平台下直接消失，故用遍历 ALL_BUILTIN_CLIENTS 的方式兜底，而非逐条硬编码。
 */

import {describe, expect, it} from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
    getClientAppPaths,
    getClientConfigMarkers,
    getClientDisplayName,
    getClientMcpCandidatePaths,
    getDefaultClientPaths
} from '../main/config/client-probe';
import {ALL_BUILTIN_CLIENTS, EXECUTABLE_ONLY_CLIENTS, SKILL_SUPPORTED_CLIENTS} from '../main/config/types';
import {computeDefaultSkillsPaths} from '../main/client-paths';

const HOME = '/home/testuser';
const PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32', 'linux'];

describe('EXECUTABLE_ONLY_CLIENTS（用户报障防回归：配置文件存在≠CLI 本体已安装）', () => {
    it('纯 CLI 形态客户端在列，GUI/IDE 形态客户端不在列', () => {
        for (const c of ['claude-code', 'gemini-cli', 'codex-cli', 'opencode', 'openclaw', 'qoder', 'zcode', 'cline', 'qwen-code', 'iflow-cli', 'openhands', 'copilot-cli', 'kimi-code']) {
            expect(EXECUTABLE_ONLY_CLIENTS, c).toContain(c);
        }
        for (const c of ['cursor', 'vscode', 'windsurf', 'zed', 'trae', 'trae-cn', 'trae-solo-cn', 'marscode', 'kiro', 'jetbrains', 'antigravity', 'codebuddy', 'workbuddy', 'lm-studio', 'warp']) {
            expect(EXECUTABLE_ONLY_CLIENTS, c).not.toContain(c);
        }
    });
});

describe('安装探测路径为文件级（用户报障防回归：裸目录存在≠本体已安装）', () => {
    it('codex-cli 三平台的探测路径均不含裸目录 ~/.codex', () => {
        for (const platform of PLATFORMS) {
            const paths = getClientAppPaths('codex-cli', platform);
            const bare = path.join(os.homedir(), '.codex');
            expect(paths, `codex-cli @ ${platform}`).not.toContain(bare);
        }
    });

    it('opencode win32 探测路径不含裸目录 ~/.config/opencode', () => {
        const paths = getClientAppPaths('opencode', 'win32');
        expect(paths).not.toContain(path.join(os.homedir(), '.config', 'opencode'));
    });

    it('openclaw win32 探测路径不含裸目录 ~/.openclaw', () => {
        const paths = getClientAppPaths('openclaw', 'win32');
        expect(paths).not.toContain(path.join(os.homedir(), '.openclaw'));
    });
});

describe('getDefaultClientPaths', () => {
    it.each(PLATFORMS)('%s 下每个内置客户端都有配置路径', (platform: NodeJS.Platform) => {
        const paths = getDefaultClientPaths(HOME, platform);
        for (const client of ALL_BUILTIN_CLIENTS) {
            expect(paths[client], `${client} @ ${platform}`).toBeTruthy();
        }
    });

    it('JetBrains 三平台均指向用户级 ~/.junie/mcp/mcp.json（AI Assistant/Junie 唯一可编辑入口）', () => {
        for (const platform of PLATFORMS) {
            expect(getDefaultClientPaths(HOME, platform).jetbrains)
                .toBe(path.join(HOME, '.junie', 'mcp', 'mcp.json'));
        }
    });

    it('ZCode 指向用户级 ~/.zcode/cli/config.json（三平台一致）', () => {
        for (const platform of PLATFORMS) {
            expect(getDefaultClientPaths(HOME, platform).zcode)
                .toBe(path.join(HOME, '.zcode', 'cli', 'config.json'));
        }
    });

    it('Warp 三平台均指向 ~/.warp/.mcp.json（官方 File and folder locations 按三平台同列）', () => {
        for (const platform of PLATFORMS) {
            expect(getDefaultClientPaths(HOME, platform).warp)
                .toBe(path.join(HOME, '.warp', '.mcp.json'));
        }
    });

    it('Kimi Code CLI 三平台均指向用户级 ~/.kimi-code/mcp.json', () => {
        for (const platform of PLATFORMS) {
            expect(getDefaultClientPaths(HOME, platform)['kimi-code'])
                .toBe(path.join(HOME, '.kimi-code', 'mcp.json'));
        }
    });

    it('TRAE SOLO CN 与 Trae CN 共用同一 User/mcp.json（防回归：独立 SOLO CN 目录无官方依据）', () => {
        for (const platform of PLATFORMS) {
            expect(getDefaultClientPaths(HOME, platform)['trae-solo-cn'])
                .toBe(getDefaultClientPaths(HOME, platform)['trae-cn']);
        }
        expect(getDefaultClientPaths(HOME, 'win32')['trae-solo-cn'])
            .toBe(path.join(HOME, 'AppData', 'Roaming', 'Trae CN', 'User', 'mcp.json'));
    });

    it('Qoder 用户级 MCP 在 ~/.qoder/settings.json 的 mcpServers 键（防回归：独立 mcp.json 客户端不读）', () => {
        for (const platform of PLATFORMS) {
            expect(getDefaultClientPaths(HOME, platform).qoder)
                .toBe(path.join(HOME, '.qoder', 'settings.json'));
        }
    });

    it('Cursor 三平台统一 ~/.cursor/mcp.json（官方文档不按操作系统区分）', () => {
        for (const platform of PLATFORMS) {
            expect(getDefaultClientPaths(HOME, platform).cursor)
                .toBe(path.join(HOME, '.cursor', 'mcp.json'));
        }
    });

    it('Windsurf 跟随 Devin 迁移落到 devin 目录（防回归：旧 ~/.codeium/windsurf 仅作需勾选的 discovery 源）', () => {
        expect(getDefaultClientPaths(HOME, 'darwin').windsurf)
            .toBe(path.join(HOME, '.config', 'devin', 'mcp_config.json'));
        expect(getDefaultClientPaths(HOME, 'linux').windsurf)
            .toBe(path.join(HOME, '.config', 'devin', 'mcp_config.json'));
        expect(getDefaultClientPaths(HOME, 'win32').windsurf)
            .toBe(path.join(HOME, 'AppData', 'Roaming', 'devin', 'mcp_config.json'));
    });
});

describe('getClientMcpCandidatePaths', () => {
    it('Qoder / Cursor 单候选路径（不留旧错误路径的回退，读写永远落同一文件）', () => {
        const realHome = os.homedir();
        for (const platform of PLATFORMS) {
            expect(getClientMcpCandidatePaths('qoder', platform))
                .toEqual([path.join(realHome, '.qoder', 'settings.json')]);
            expect(getClientMcpCandidatePaths('cursor', platform))
                .toEqual([path.join(realHome, '.cursor', 'mcp.json')]);
        }
    });

    it('TRAE 家族单候选路径（防回归：~/.trae、~/.trae-cn 扁平布局系项目级路径误推）', () => {
        const realHome = os.homedir();
        const expected: Record<NodeJS.Platform, string[]> = {
            darwin: [path.join(realHome, 'Library', 'Application Support', 'Trae', 'User', 'mcp.json')],
            win32: [path.join(realHome, 'AppData', 'Roaming', 'Trae', 'User', 'mcp.json')],
            linux: [path.join(realHome, '.config', 'Trae', 'User', 'mcp.json')],
        } as Record<NodeJS.Platform, string[]>;
        for (const platform of PLATFORMS) {
            expect(getClientMcpCandidatePaths('trae', platform), platform).toEqual(expected[platform]);
            // 家族另外两个成员都只有自身那一条，不含 ~/.trae-cn 之类的扁平回退
            for (const client of ['trae-cn', 'trae-solo-cn']) {
                const candidates = getClientMcpCandidatePaths(client, platform);
                expect(candidates.length, `${client} @ ${platform}`).toBe(1);
                expect(candidates[0], `${client} @ ${platform}`).not.toContain('.trae');
            }
        }
    });
});

describe('computeDefaultSkillsPaths', () => {
    it('每个支持 Skills 的客户端都有 Skills 目录', () => {
        const paths = computeDefaultSkillsPaths(HOME);
        for (const client of SKILL_SUPPORTED_CLIENTS) {
            expect(paths[client], client).toBeTruthy();
        }
    });
});

describe('agent-skills 虚拟客户端建模（plan-2.0）', () => {
    it('agent-skills 不在 ALL_BUILTIN_CLIENTS 内（防回归：避免污染 MCP 备份/服务器扫描遍历）', () => {
        expect(ALL_BUILTIN_CLIENTS).not.toContain('agent-skills');
        // 但必须是合法的 Skill 客户端（技能能装、库能扫）
        expect(SKILL_SUPPORTED_CLIENTS).toContain('agent-skills');
    });
});

describe('getClientDisplayName', () => {
    it('每个内置客户端都有显式显示名（而非回退成原始 id）', () => {
        for (const client of ALL_BUILTIN_CLIENTS) {
            expect(getClientDisplayName(client), client).not.toBe(client);
        }
    });

    it('每个「仅 Skill」虚拟客户端（agent-skills / cloud）也有显式显示名', () => {
        expect(getClientDisplayName('agent-skills')).toBe('Agent Skills (.agents)');
        expect(getClientDisplayName('cloud')).toBe('云端存储');
    });

    it('ZCode 显示名为 ZCode', () => {
        expect(getClientDisplayName('zcode')).toBe('ZCode');
    });

    it('TRAE SOLO CN 显示名为 TRAE SOLO CN', () => {
        expect(getClientDisplayName('trae-solo-cn')).toBe('TRAE SOLO CN');
    });
});

describe('getClientConfigMarkers', () => {
    it('有独立可执行文件的客户端无目录 marker（目录可能只是装技能 mkdir 出来的，不代表本体安装）', () => {
        // plan-2.0 执行修正：曾误给 ~/.claude 等加 marker，导致未装 Claude Code 的机器显示「已安装」。
        // 已安装判定只走 exe / npm / CLI where；目录 marker 仅限插件形态与纯目录标准（.agents）。
        const exeBackedClients = ['cursor', 'claude-code', 'gemini-cli', 'codex-cli', 'trae', 'trae-cn', 'trae-solo-cn', 'opencode'];
        for (const client of exeBackedClients) {
            expect(getClientConfigMarkers(client), `${client} 不应有目录 marker`).toEqual([]);
        }
    });

    it('agent-skills 的 marker 指向 ~/.agents（纯目录标准，目录即「在用」）', () => {
        expect(getClientConfigMarkers('agent-skills')).toEqual([path.join(os.homedir(), '.agents')]);
    });

    it('插件形态客户端保留目录 marker', () => {
        expect(getClientConfigMarkers('codebuddy').length).toBeGreaterThan(0);
        expect(getClientConfigMarkers('marscode').length).toBeGreaterThan(0);
    });
});

describe('gemini-cli win32 探测', () => {
    it('包含 npm 全局安装路径（与 claude-code / codex-cli 对齐）', () => {
        const paths = getClientAppPaths('gemini-cli', 'win32');
        expect(paths).toContain(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'gemini.cmd'));
    });
});

describe('ZCode 已安装判定（本机相关，CI 未装则跳过）', () => {
    it('config marker 指向本机 ~/.zcode，命中即判已安装', async () => {
        const marker = path.join(os.homedir(), '.zcode');
        let exists = false;
        try {
            await fs.access(marker);
            exists = true;
        } catch {
            // 仅在已安装 ZCode 的机器上验证
        }
        if (!exists) return;

        // isClientInstalled 遍历 getConfigMarkers 命中即 return true；
        // 本机 ~/.zcode 存在 与 marker 配置正确 共同保证 ZCode 被识别为已安装。
        expect(getClientConfigMarkers('zcode')).toContain(marker);
    });
});

describe('TRAE SOLO CN 已安装判定（本机相关，CI 未装则跳过）', () => {
    it('win32 应用路径探测包含本机实际安装的 exe', async () => {
        const exe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'TRAE SOLO CN', 'TRAE SOLO CN.exe');
        let exists = false;
        try {
            await fs.access(exe);
            exists = true;
        } catch {
            // 仅在已安装 TRAE SOLO CN 的机器上验证
        }
        if (!exists) return;

        // isClientInstalled 遍历 getClientAppPaths 命中即判已安装；
        // 本机 exe 存在 与探测表配置正确 共同保证 TRAE SOLO CN 被识别。
        expect(getClientAppPaths('trae-solo-cn', 'win32')).toContain(exe);
    });
});
