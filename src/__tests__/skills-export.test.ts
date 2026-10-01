/**
 * skill 导出 zip 端到端测试（plan-3.0 后续增强）
 *
 * 覆盖：按名称定位 skill 目录（注入 getAllInstalled 模拟）、递归收集目录全部文件、
 * zip 内路径 = {skillName}/{相对路径}、多 skill 打一个 zip、缺目录报错。
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {exportSkillsToZip} from '../main/skills-export';

let root: string;

beforeEach(async () => {
    root = path.join(os.tmpdir(), `mcp-dock-export-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(root, {recursive: true});
});

afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true}).catch(() => {});
});

/** 解析 zip 条目名（复用 zip-writer 测试里的简易实现） */
function listZipNames(buf: Buffer): string[] {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const names: string[] = [];
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
        p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
}

async function makeSkill(dirName: string): Promise<string> {
    const dir = path.join(root, dirName);
    await fs.mkdir(path.join(dir, 'references'), {recursive: true});
    await fs.mkdir(path.join(dir, 'codes'), {recursive: true});
    await fs.writeFile(path.join(dir, 'SKILL.md'), `# ${dirName}\n`, 'utf8');
    await fs.writeFile(path.join(dir, 'references', 'a.md'), 'ref', 'utf8');
    await fs.writeFile(path.join(dir, 'codes', 'run.ts'), 'export {}', 'utf8');
    await fs.writeFile(path.join(dir, '.source.json'), JSON.stringify({id: dirName}), 'utf8');
    return dir;
}

describe('exportSkillsToZip', () => {
    it('单 skill：递归打包全部文件，zip 内路径带 {skillName}/ 前缀', async () => {
        const dir = await makeSkill('demo');
        const res = await exportSkillsToZip(['demo'], async () => ({byClient: {cursor: [{name: 'demo', path: dir, source: null} as any]}}));
        expect(res.ok).toBe(true);
        expect(res.fileName).toBe('demo.zip');
        const names = listZipNames(res.data!).sort();
        expect(names).toEqual([
            'demo/.source.json',
            'demo/SKILL.md',
            'demo/codes/run.ts',
            'demo/references/a.md',
        ]);
    });

    it('多 skill：打成一个 zip，各自独立目录', async () => {
        const dirA = await makeSkill('alpha');
        const dirB = await makeSkill('beta');
        const res = await exportSkillsToZip(['alpha', 'beta'], async () => ({
            byClient: {
                cursor: [
                    {name: 'alpha', path: dirA, source: null},
                    {name: 'beta', path: dirB, source: null},
                ] as any[],
            },
        }));
        expect(res.ok).toBe(true);
        expect(res.fileName).toMatch(/^skills-export-\d{8}-\d{6}\.zip$/);
        const names = listZipNames(res.data!);
        expect(names).toContain('alpha/SKILL.md');
        expect(names).toContain('beta/SKILL.md');
        expect(names.some(n => n.startsWith('alpha/'))).toBe(true);
        expect(names.some(n => n.startsWith('beta/'))).toBe(true);
    });

    it('找不到目录 → 报错', async () => {
        await makeSkill('demo');
        const res = await exportSkillsToZip(['ghost'], async () => ({byClient: {cursor: [{
            name: 'demo', path: path.join(root, 'demo'), source: null,
        } as any]}}));
        expect(res.ok).toBe(false);
        expect(res.error).toContain('ghost');
    });

    it('空列表 → 报错', async () => {
        const res = await exportSkillsToZip([], async () => ({byClient: {}}));
        expect(res.ok).toBe(false);
    });
});