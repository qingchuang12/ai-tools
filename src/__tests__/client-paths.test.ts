import {describe, expect, it} from 'vitest';
import path from 'path';
import {computeDefaultSkillsPaths, resolveSkillsPath} from '../main/client-paths';
import {CLOUD_ROOT_DIR} from '../shared/cloud-sync-constants';

const HOME = '/home/testuser';

describe('computeDefaultSkillsPaths', () => {
    it('应为每个内置客户端生成跨平台一致的默认路径', () => {
        const paths = computeDefaultSkillsPaths(HOME);
        expect(paths.cursor).toBe(path.join(HOME, '.cursor', 'skills'));
        expect(paths['claude-code']).toBe(path.join(HOME, '.claude', 'skills'));
        expect(paths['codex-cli']).toBe(path.join(HOME, '.codex', 'skills'));
        expect(paths.opencode).toBe(path.join(HOME, '.config', 'opencode', 'skills'));
        expect(paths['agent-skills']).toBe(path.join(HOME, '.agents', 'skills'));
        expect(paths.codebuddy).toBe(path.join(HOME, '.codebuddy', 'skills'));
        expect(paths.workbuddy).toBe(path.join(HOME, '.workbuddy', 'skills'));
        expect(paths.qoder).toBe(path.join(HOME, '.qoder', 'skills'));
        expect(paths.zcode).toBe(path.join(HOME, '.zcode', 'skills'));
        expect(paths.marscode).toBe(path.join(HOME, '.marscode', 'skills'));
        expect(paths.cloud).toBe(path.join(HOME, '.ai-tools', 'cloud', CLOUD_ROOT_DIR, 'skills'));
    });

    it('默认不依赖 os.homedir，传入 home 即确定性输出', () => {
        expect(computeDefaultSkillsPaths(HOME)).toEqual(computeDefaultSkillsPaths(HOME));
    });
});

describe('resolveSkillsPath（单一来源）', () => {
    it('优先使用自定义客户端的 skillsPath', () => {
        const result = resolveSkillsPath('cursor', {
            customClients: [{id: 'cursor', name: 'Cursor', configPath: '/custom/cursor/mcp.json', supportsSkills: true, skillsPath: '/custom/cursor/skills'}],
            customSkillsPaths: {cursor: '/global/cursor/skills'},
        });
        expect(result).toBe('/custom/cursor/skills');
    });

    it('其次使用全局 customSkillsPaths', () => {
        const result = resolveSkillsPath('cursor', {
            customSkillsPaths: {cursor: '/global/cursor/skills'},
        });
        expect(result).toBe('/global/cursor/skills');
    });

    it('最后回退到内置默认路径', () => {
        const result = resolveSkillsPath('claude-code', {});
        expect(result).toBe(computeDefaultSkillsPaths()['claude-code']);
    });

    it('未知客户端回退为空（与历史硬编码表行为一致）', () => {
        const result = resolveSkillsPath('nonexistent', {});
        expect(result).toBeUndefined();
    });
});
