/**
 * Skill 附属文件管理测试（plan-3.1 · 编辑模式「附属文件」面板的 main 层）
 *
 * 覆盖：
 *  - listSkillFiles：SKILL.md 置顶受保护、递归收集、排除 .source.json、目录条目不下发
 *  - readSkillFile：文本可编辑 / 二进制只读 / 超大只读 / 穿越与受保护拒绝
 *  - updateCustomSkill 扩展：files（新建/覆盖）写入所有目标客户端、removedFiles 删除、
 *    穿越与受保护文件整批拒绝（无半成品残留）、改名 + 附件并行落盘
 */

import {describe, expect, it} from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {SkillsManager} from '../main/skills-manager';

const CLIENTS = ['cursor', 'claude-code'] as const;

/** 在临时 HOME/USERPROFILE 下执行（隔离真实客户端目录），结束后还原并清理 */
async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
    const tmp = path.join(os.tmpdir(), `mcp-dock-files-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const oldHome = process.env.HOME;
    const oldProfile = process.env.USERPROFILE;
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    try {
        await fn(tmp);
    } finally {
        process.env.HOME = oldHome;
        process.env.USERPROFILE = oldProfile;
        await fs.rm(tmp, {recursive: true, force: true}).catch(() => {});
    }
}

function skillDir(home: string, client: string): string {
    return path.join(home, client === 'claude-code' ? '.claude' : `.${client}`, 'skills', 'files-demo');
}

/** 预置一份带附属文件的 skill（多客户端） */
async function seedSkill(home: string, clients: readonly string[] = CLIENTS): Promise<void> {
    for (const c of clients) {
        const dir = skillDir(home, c);
        await fs.mkdir(path.join(dir, 'scripts'), {recursive: true});
        await fs.mkdir(path.join(dir, 'references'), {recursive: true});
        await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: files-demo\ndescription: demo\n---\n# 正文\n', 'utf-8');
        await fs.writeFile(path.join(dir, 'scripts', 'run.mjs'), 'console.log(1)', 'utf-8');
        await fs.writeFile(path.join(dir, 'references', 'a.md'), '引用内容', 'utf-8');
        await fs.writeFile(path.join(dir, 'references', 'big.txt'), Buffer.alloc(600 * 1024, 0x61)); // >512KB 纯文本
        await fs.writeFile(path.join(dir, 'icon.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02])); // 含 NUL
        await fs.writeFile(path.join(dir, '.source.json'), '{"id":"origin"}', 'utf-8');
    }
}

describe('listSkillFiles', () => {
    it('递归收集全部文件：SKILL.md 置顶受保护，排除 .source.json，目录条目不下发', async () => {
        await withTempHome(async home => {
            await seedSkill(home, ['cursor']);
            const list = await new SkillsManager().listSkillFiles('files-demo', 'cursor');
            expect(list).not.toBeNull();
            const paths = list!.map(f => f.path);
            expect(paths[0]).toBe('SKILL.md');
            expect(list![0].kind).toBe('protected');
            expect(paths).toContain('scripts/run.mjs');
            expect(paths).toContain('references/a.md');
            expect(paths).toContain('icon.bin');
            expect(list!.find(f => f.path === 'scripts/run.mjs')!.kind).toBe('file');
            expect(paths).not.toContain('.source.json'); // 来源元数据隐藏
            expect(paths).not.toContain('scripts');      // 目录条目不下发
        });
    });

    it('skill 目录不存在 → 返回 null', async () => {
        await withTempHome(async () => {
            const res = await new SkillsManager().listSkillFiles('not-exists', 'cursor');
            expect(res).toBeNull();
        });
    });
});

describe('readSkillFile', () => {
    it('文本文件 → editable，内容一致（含中文）', async () => {
        await withTempHome(async home => {
            await seedSkill(home, ['cursor']);
            const res = await new SkillsManager().readSkillFile('files-demo', 'cursor', 'scripts/run.mjs');
            expect(res.success).toBe(true);
            if (res.success) {
                expect(res.mode).toBe('editable');
            }
            if (res.success && res.mode === 'editable') {
                expect(res.content).toBe('console.log(1)');
            }
            const md = await new SkillsManager().readSkillFile('files-demo', 'cursor', 'references/a.md');
            expect(md.success && md.mode === 'editable').toBe(true);
            if (md.success && md.mode === 'editable') expect(md.content).toBe('引用内容');
        });
    });

    it('二进制（含 NUL）→ readonly/binary，不回灌内容', async () => {
        await withTempHome(async home => {
            await seedSkill(home, ['cursor']);
            const res = await new SkillsManager().readSkillFile('files-demo', 'cursor', 'icon.bin');
            expect(res.success).toBe(true);
            if (res.success) {
                expect(res.mode).toBe('readonly');
            }
            if (res.success && res.mode === 'readonly') {
                expect(res.reason).toBe('binary');
            }
        });
    });

    it('>512KB → readonly/too_large，不加载内容', async () => {
        await withTempHome(async home => {
            await seedSkill(home, ['cursor']);
            const res = await new SkillsManager().readSkillFile('files-demo', 'cursor', 'references/big.txt');
            expect(res.success).toBe(true);
            if (res.success) {
                expect(res.mode).toBe('readonly');
            }
            if (res.success && res.mode === 'readonly') {
                expect(res.reason).toBe('too_large');
            }
        });
    });

    it('穿越路径 / 受保护文件 / 不存在 → 拒绝', async () => {
        await withTempHome(async home => {
            await seedSkill(home, ['cursor']);
            const m = new SkillsManager();
            const esc = await m.readSkillFile('files-demo', 'cursor', '../escape.txt');
            expect(esc.success).toBe(false);
            const skillMd = await m.readSkillFile('files-demo', 'cursor', 'SKILL.md');
            expect(skillMd.success).toBe(false);
            const meta = await m.readSkillFile('files-demo', 'cursor', '.source.json');
            expect(meta.success).toBe(false);
            const miss = await m.readSkillFile('files-demo', 'cursor', 'nope.txt');
            expect(miss.success).toBe(false);
        });
    });
});

describe('updateCustomSkill 附属文件通道', () => {
    it('files 新建/覆盖写入所有目标客户端，旧附属文件保留', async () => {
        await withTempHome(async home => {
            await seedSkill(home);
            const res = await new SkillsManager().updateCustomSkill('files-demo', {
                name: 'files-demo',
                description: 'demo',
                body: '# 更新后的正文\n',
                files: [
                    {path: 'scripts/new.py', data: Buffer.from('print(1)')},
                    {path: 'references/a.md', data: Buffer.from('覆盖后的引用')},
                ],
            }, [...CLIENTS]);
            expect(res.success, JSON.stringify(res)).toBe(true);
            for (const c of CLIENTS) {
                const dir = skillDir(home, c);
                expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8')).toContain('更新后的正文');
                expect(await fs.readFile(path.join(dir, 'scripts', 'new.py'), 'utf-8')).toBe('print(1)');
                expect(await fs.readFile(path.join(dir, 'references', 'a.md'), 'utf-8')).toBe('覆盖后的引用');
                expect(await fs.readFile(path.join(dir, 'scripts', 'run.mjs'), 'utf-8')).toBe('console.log(1)'); // 未删除保留
            }
        });
    });

    it('removedFiles 删除所有目标客户端中的指定文件，SKILL.md 保留', async () => {
        await withTempHome(async home => {
            await seedSkill(home);
            const res = await new SkillsManager().updateCustomSkill('files-demo', {
                name: 'files-demo',
                description: 'demo',
                body: '# 正文\n',
                removedFiles: ['scripts/run.mjs', 'icon.bin'],
            }, [...CLIENTS]);
            expect(res.success, JSON.stringify(res)).toBe(true);
            for (const c of CLIENTS) {
                const dir = skillDir(home, c);
                await expect(fs.access(path.join(dir, 'scripts', 'run.mjs'))).rejects.toThrow();
                await expect(fs.access(path.join(dir, 'icon.bin'))).rejects.toThrow();
                expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8')).toContain('# 正文');
            }
        });
    });

    it('files 含穿越路径 → 整批拒绝，SKILL.md 不落盘（无半成品）', async () => {
        await withTempHome(async home => {
            await seedSkill(home);
            const res = await new SkillsManager().updateCustomSkill('files-demo', {
                name: 'files-demo',
                description: 'demo',
                body: '# 不应写入的正文\n',
                files: [{path: '../escape.txt', data: Buffer.from('pwn')}],
            }, [...CLIENTS]);
            expect(res.success).toBe(false);
            for (const c of CLIENTS) {
                const content = await fs.readFile(path.join(skillDir(home, c), 'SKILL.md'), 'utf-8');
                expect(content).not.toContain('不应写入');
            }
        });
    });

    it('files / removedFiles 含受保护文件（SKILL.md、.source.json）→ 拒绝', async () => {
        await withTempHome(async home => {
            await seedSkill(home);
            const m = new SkillsManager();
            const w1 = await m.updateCustomSkill('files-demo', {
                name: 'files-demo',
                description: 'demo',
                body: '# 正文\n',
                files: [{path: 'SKILL.md', data: Buffer.from('# x')}],
            }, [...CLIENTS]);
            expect(w1.success).toBe(false);
            expect(w1.error).toContain('受保护');
            const w2 = await m.updateCustomSkill('files-demo', {
                name: 'files-demo',
                description: 'demo',
                body: '# 正文\n',
                removedFiles: ['.source.json'],
            }, [...CLIENTS]);
            expect(w2.success).toBe(false);
            expect(w2.error).toContain('受保护');
            // .source.json 仍在（未被误删）
            await expect(fs.access(path.join(skillDir(home, 'cursor'), '.source.json'))).resolves.toBeUndefined();
        });
    });

    it('改名 + files 并行：附属文件写入新目录', async () => {
        await withTempHome(async home => {
            await seedSkill(home, ['cursor']);
            const res = await new SkillsManager().updateCustomSkill('files-demo', {
                name: 'renamed-demo',
                description: 'demo',
                body: '# 改名后的正文\n',
                files: [{path: 'scripts/after.mjs', data: Buffer.from('console.log(2)')}],
            }, ['cursor']);
            expect(res.success, JSON.stringify(res)).toBe(true);
            const newDir = path.join(home, '.cursor', 'skills', 'renamed-demo');
            expect(await fs.readFile(path.join(newDir, 'SKILL.md'), 'utf-8')).toContain('改名后的正文');
            expect(await fs.readFile(path.join(newDir, 'scripts', 'after.mjs'), 'utf-8')).toBe('console.log(2)');
            expect(await fs.readFile(path.join(newDir, 'scripts', 'run.mjs'), 'utf-8')).toBe('console.log(1)'); // 随目录迁移
            await expect(fs.access(path.join(home, '.cursor', 'skills', 'files-demo'))).rejects.toThrow();
        });
    });
});