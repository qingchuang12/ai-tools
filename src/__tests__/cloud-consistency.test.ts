/**
 * 云端一致性检测测试（plan-3.0）
 *
 * 覆盖：技能双向（内容比对静默 / local_newer / cloud_newer / local_diverged 本地互检）、
 * MCP 内容比对（键序无关、内容一致静默、mtime 判先后、local_diverged 互检）、stableStringify 规范化。
 * 口径：内容完全相同（仅时间戳不同）视为一致静默，不产出不一致项（用户反馈修正⑤）；
 * 单侧存在：仅云端 / 仅本地均为正常状态，静默不报（用户反馈 2026-10-05：本地可能暂时不需要云端条目）。
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {checkCloudConsistency, readCompareEnds, stableStringify} from '../main/cloud-consistency';

let root: string;
let cloudSkills: string;
let cursorSkills: string;
let claudeSkills: string;
let cloudMcp: string;
let cursorMcp: string;
let claudeMcp: string;

/** 显式设置文件 mtime，避免同毫秒写入导致 mtime 判定不确定 */
async function setMtime(file: string, iso: string): Promise<void> {
    const d = new Date(iso);
    await fs.utimes(file, d, d);
}

async function writeSkill(dir: string, name: string, updatedAt?: string, skillMd = `# ${name}\ncontent\n`): Promise<void> {
    const skillDir = path.join(dir, name);
    await fs.mkdir(skillDir, {recursive: true});
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf-8');
    if (updatedAt) {
        await fs.writeFile(path.join(skillDir, '.source.json'), JSON.stringify({
            id: name, installedAt: updatedAt, updatedAt, source: {}, files: [],
        }), 'utf-8');
    }
}

async function writeMcp(file: string, servers: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, JSON.stringify({mcpServers: servers}), 'utf-8');
}

/** 与被测代码同构的本地端读取注入 */
async function readServers(configPath: string): Promise<Record<string, any>> {
    try {
        const raw = JSON.parse(await fs.readFile(configPath, 'utf-8'));
        return raw?.mcpServers || {};
    } catch {
        return {};
    }
}

/** 构造检测参数；includeClaude = true 时加入第二个本地客户端（本地互检用例用） */
function makeParams(includeClaude = false) {
    const skillClients = includeClaude
        ? [
            {client: 'cursor' as const, dir: cursorSkills},
            {client: 'claude-code' as const, dir: claudeSkills},
        ]
        : [{client: 'cursor' as const, dir: cursorSkills}];
    const mcpClients = includeClaude
        ? [
            {client: 'cursor', configPath: cursorMcp},
            {client: 'claude-code', configPath: claudeMcp},
        ]
        : [{client: 'cursor', configPath: cursorMcp}];
    return {
        cloudSkillsPath: cloudSkills,
        cloudMcpConfigPath: cloudMcp,
        localSkillDirs: skillClients,
        localMcpConfigs: mcpClients,
        readClientServers: (client: string) => readServers(client === 'cursor' ? cursorMcp : claudeMcp),
    };
}

beforeEach(async () => {
    root = path.join(os.tmpdir(), `mcp-dock-consistency-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cloudSkills = path.join(root, 'cloud', 'ai-tools', 'skills');
    cursorSkills = path.join(root, '.cursor', 'skills');
    claudeSkills = path.join(root, '.claude', 'skills');
    cloudMcp = path.join(root, 'cloud', 'ai-tools', 'mcp', 'mcp.json');
    cursorMcp = path.join(root, '.cursor', 'mcp.json');
    claudeMcp = path.join(root, '.claude', 'mcp.json');
    await fs.mkdir(cloudSkills, {recursive: true});
    await fs.mkdir(cursorSkills, {recursive: true});
    await fs.mkdir(claudeSkills, {recursive: true});
});

afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true}).catch(() => {});
});

describe('stableStringify', () => {
    it('键序无关：同内容不同键序序列化结果一致', () => {
        expect(stableStringify({b: 1, a: {d: 2, c: [3, 2]}}))
            .toBe(stableStringify({a: {c: [3, 2], d: 2}, b: 1}));
    });

    it('内容不同结果不同', () => {
        expect(stableStringify({a: 1})).not.toBe(stableStringify({a: 2}));
    });
});

describe('checkCloudConsistency · Skill', () => {
    it('云端有本地无 → 静默不报（本地可能暂时不需要；需要时经云端客户端手动下发）', async () => {
        await writeSkill(cloudSkills, 'only-cloud', '2026-01-02T00:00:00Z');
        const report = await checkCloudConsistency(makeParams());
        expect(report.items.find(i => i.name === 'only-cloud')).toBeUndefined();
    });

    it('本地有云端无 → local_only 仍静默不报（上传入口本身可见，避免噪音翻倍）', async () => {
        await writeSkill(cursorSkills, 'only-local', '2026-01-02T00:00:00Z');
        const report = await checkCloudConsistency(makeParams());
        expect(report.items.find(i => i.name === 'only-local')).toBeUndefined();
    });

    it('本地比云端新（内容不同）→ local_newer（双方时间都返回）', async () => {
        await writeSkill(cursorSkills, 'demo', '2026-09-07T10:00:00Z', '# local v2\n');
        await writeSkill(cloudSkills, 'demo', '2026-09-01T10:00:00Z', '# local v1\n');
        const report = await checkCloudConsistency(makeParams());
        const item = report.items.find(i => i.name === 'demo');
        expect(item?.resolution).toBe('local_newer');
        expect(item?.localUpdatedAt).toBe('2026-09-07T10:00:00Z');
        expect(item?.cloudUpdatedAt).toBe('2026-09-01T10:00:00Z');
    });

    it('云端比本地新（内容不同）→ cloud_newer', async () => {
        await writeSkill(cursorSkills, 'demo', '2026-09-01T10:00:00Z', '# local v1\n');
        await writeSkill(cloudSkills, 'demo', '2026-09-07T10:00:00Z', '# cloud v2\n');
        const report = await checkCloudConsistency(makeParams());
        expect(report.items.find(i => i.name === 'demo')?.resolution).toBe('cloud_newer');
    });

    it('内容完全相同（时间不同）→ 默认视为已同步，静默不报（用户反馈修正⑤）', async () => {
        await writeSkill(cursorSkills, 'same', '2026-09-07T10:00:00Z', '# same\n');
        await writeSkill(cloudSkills, 'same', '2026-09-01T10:00:00Z', '# same\n');
        const report = await checkCloudConsistency(makeParams());
        expect(report.items.find(i => i.name === 'same')).toBeUndefined();
    });

    it('本地多客户端内容互不一致 → local_diverged（含逐客户端时间明细）', async () => {
        await writeSkill(cursorSkills, 'split', '2026-09-07T10:00:00Z', '# cursor version\n');
        await writeSkill(claudeSkills, 'split', '2026-09-01T10:00:00Z', '# claude version\n');
        await writeSkill(cloudSkills, 'split', '2026-09-01T10:00:00Z', '# claude version\n');
        const report = await checkCloudConsistency(makeParams(true));
        const item = report.items.find(i => i.name === 'split');
        expect(item?.resolution).toBe('local_diverged');
        expect(item?.localClients).toEqual(expect.arrayContaining(['cursor', 'claude-code']));
        expect(item?.localDetails?.map(d => d.client)).toEqual(expect.arrayContaining(['cursor', 'claude-code']));
    });

    it('本地多客户端内容一致 → 不报本地互检，只做云端比对', async () => {
        await writeSkill(cursorSkills, 'uni', '2026-09-07T10:00:00Z', '# v2\n');
        await writeSkill(claudeSkills, 'uni', '2026-09-02T10:00:00Z', '# v2\n');
        await writeSkill(cloudSkills, 'uni', '2026-09-01T10:00:00Z', '# v1\n');
        const report = await checkCloudConsistency(makeParams(true));
        const item = report.items.find(i => i.name === 'uni');
        expect(item?.resolution).toBe('local_newer'); // 本地一致后按代表与云端比时间
        expect(item?.localClients).toEqual(expect.arrayContaining(['cursor', 'claude-code']));
    });
});

describe('checkCloudConsistency · MCP Server', () => {
    it('内容一致（键序不同）→ 静默不报', async () => {
        await writeMcp(cursorMcp, {demo: {command: 'npx', args: ['-y', 'demo'], env: {A: '1'}}});
        await writeMcp(cloudMcp, {demo: {env: {A: '1'}, args: ['-y', 'demo'], command: 'npx'}});
        const report = await checkCloudConsistency(makeParams());
        expect(report.items.find(i => i.name === 'demo')).toBeUndefined();
    });

    it('内容不同且本地文件更新 → local_newer（时间为文件 mtime）', async () => {
        await writeMcp(cursorMcp, {demo: {command: 'npx', args: ['v2']}});
        await writeMcp(cloudMcp, {demo: {command: 'npx', args: ['v1']}});
        await setMtime(cursorMcp, '2026-09-07T12:00:00Z');
        await setMtime(cloudMcp, '2026-09-07T10:00:00Z');
        const report = await checkCloudConsistency(makeParams());
        const item = report.items.find(i => i.name === 'demo');
        expect(item?.resolution).toBe('local_newer');
        expect(item?.localUpdatedAt).toBe(new Date('2026-09-07T12:00:00Z').toISOString());
        expect(item?.cloudUpdatedAt).toBe(new Date('2026-09-07T10:00:00Z').toISOString());
    });

    it('内容不同且云端文件更新 → cloud_newer', async () => {
        await writeMcp(cursorMcp, {demo: {command: 'npx', args: ['v1']}});
        await writeMcp(cloudMcp, {demo: {command: 'npx', args: ['v2']}});
        await setMtime(cursorMcp, '2026-09-07T10:00:00Z');
        await setMtime(cloudMcp, '2026-09-07T12:00:00Z');
        const report = await checkCloudConsistency(makeParams());
        expect(report.items.find(i => i.name === 'demo')?.resolution).toBe('cloud_newer');
    });

    it('单侧存在均静默：仅云端不报、仅本地不报', async () => {
        await writeMcp(cloudMcp, {cloudOnly: {command: 'x'}});
        await writeMcp(cursorMcp, {localOnly: {command: 'y'}});
        await setMtime(cloudMcp, '2026-09-07T10:00:00Z');
        const report = await checkCloudConsistency(makeParams());
        expect(report.items.find(i => i.name === 'cloudOnly')).toBeUndefined();
        expect(report.items.find(i => i.name === 'localOnly')).toBeUndefined();
    });

    it('本地多客户端配置互不一致 → local_diverged（含逐客户端明细）', async () => {
        await writeMcp(cursorMcp, {split: {command: 'npx', args: ['v2']}});
        await writeMcp(claudeMcp, {split: {command: 'npx', args: ['v1']}});
        const report = await checkCloudConsistency(makeParams(true));
        const item = report.items.find(i => i.name === 'split');
        expect(item?.resolution).toBe('local_diverged');
        expect(item?.localClients).toEqual(expect.arrayContaining(['cursor', 'claude-code']));
        expect(item?.localDetails?.map(d => d.client)).toEqual(expect.arrayContaining(['cursor', 'claude-code']));
    });

    it('本地多客户端配置一致 → 不做互检报告，仅与云端比对', async () => {
        await writeMcp(cursorMcp, {demo: {command: 'npx', args: ['v2']}});
        await writeMcp(claudeMcp, {demo: {command: 'npx', args: ['v2']}});
        await writeMcp(cloudMcp, {demo: {command: 'npx', args: ['v1']}});
        await setMtime(cursorMcp, '2026-09-07T12:00:00Z');
        await setMtime(cloudMcp, '2026-09-07T10:00:00Z');
        const report = await checkCloudConsistency(makeParams(true));
        const item = report.items.find(i => i.name === 'demo');
        expect(item?.resolution).toBe('local_newer');
        expect(item?.localClients).toEqual(expect.arrayContaining(['cursor', 'claude-code']));
    });
});

describe('readCompareEnds', () => {
    it('skill：返回两端 SKILL.md 内容', async () => {
        await writeSkill(cursorSkills, 'demo', undefined, '# local version\n');
        await writeSkill(cloudSkills, 'demo', undefined, '# cloud version\n');
        const ends = await readCompareEnds({kind: 'skill', name: 'demo', localPath: cursorSkills, cloudPath: cloudSkills});
        expect(ends.local).toBe('# local version\n');
        expect(ends.cloud).toBe('# cloud version\n');
    });

    it('server：返回两端同名 server 的 JSON 配置', async () => {
        await writeMcp(cursorMcp, {demo: {command: 'npx', args: ['v2']}});
        await writeMcp(cloudMcp, {demo: {command: 'npx', args: ['v1']}});
        const ends = await readCompareEnds({kind: 'server', name: 'demo', localPath: cursorMcp, cloudPath: cloudMcp});
        expect(ends.local).toContain('v2');
        expect(ends.cloud).toContain('v1');
    });
});
