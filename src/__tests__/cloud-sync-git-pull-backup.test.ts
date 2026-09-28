/**
 * gitPull 拉取前备份（P1-a）集成测试
 *
 * 真实 git 仓库（本地 bare 远端 + 真实暂存工作副本），只把 electron / license gate / store 做最小 mock。
 * 覆盖三态：① 未提交改动 → 备份分支留存后重置；② 本地独有提交（push 被拒残留）→ 备份分支留存；
 * ③ 干净且无独有提交 → 不建备份分支；另覆盖 ④ 备份失败 → 中止本次 pull（不得在未备份状态下硬重置）。
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.join(os.tmpdir(), `mcp-dock-gitpull-${process.pid}-${Math.random().toString(36).slice(2)}`);
const FAKE_HOME = path.join(ROOT, 'home');
const STAGING_ROOT = path.join(FAKE_HOME, '.ai-tools', 'cloud');
const REMOTE = path.join(ROOT, 'remote.git');
const SEED = path.join(ROOT, 'seed');

function git(args: string[], cwd: string): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        env: {...process.env, GIT_TERMINAL_PROMPT: '0'},
    });
}

vi.mock('electron', () => ({
    app: {
        getPath: (n: string) =>
            n === 'home' ? FAKE_HOME : path.join(FAKE_HOME, '.ai-tools'),
    },
}));

// 本用例只验证 pull 的备份/重置语义，不验证授权（gate 行为由 license-*.test.ts 覆盖）
vi.mock('../main/license/feature-gate', () => ({
    assertFeature: async () => ({allowed: true, code: 'LIC_OK', payload: null}),
    GATE_LOCKED_MESSAGE: 'license.errors.locked',
}));

vi.mock('../main/cloud-sync-store', () => ({
    getCloudSyncStore: () => ({
        isActive: () => true,
        getStagingRoot: () => STAGING_ROOT,
        getStagingDataDir: () => path.join(STAGING_ROOT, 'ai-tools'),
        getStagingMcpConfigPath: () => path.join(STAGING_ROOT, 'ai-tools', 'mcp', 'mcp.json'),
        getStagingSkillsPath: () => path.join(STAGING_ROOT, 'ai-tools', 'skills'),
        ensureStagingDirs: () => {
            fs.mkdirSync(path.join(STAGING_ROOT, 'ai-tools', 'mcp'), {recursive: true});
            fs.mkdirSync(path.join(STAGING_ROOT, 'ai-tools', 'skills'), {recursive: true});
        },
        getConfig: () => ({
            enabled: true,
            provider: 'git',
            git: {repoUrl: REMOTE, branch: 'main', authType: 'none', userName: 'tester', userEmail: 'tester@localhost'},
            sftp: {},
        }),
        recordSync: () => {
        },
        revealSecret: () => undefined,
        isSecretStale: () => false,
    }),
    CLOUD_ROOT_DIR: 'ai-tools',
}));

import {CloudSyncService} from '../main/cloud-sync-service';

const MCP_REL = path.join('ai-tools', 'mcp', 'mcp.json');
const stagedMcp = path.join(STAGING_ROOT, MCP_REL);

/** 远端初始内容（seed 提交） */
const REMOTE_MCP = '{"mcpServers":{"remote":{"command":"remote-cmd"}}}';
/** 本地暂存区 clone 后未提交的改动 */
const DIRTY_MCP = '{"mcpServers":{"remote":{"command":"remote-cmd"},"local-edit":{"command":"wip"}}}';

function listBackupBranches(): string[] {
    return git(['branch', '--list', 'backup-before-pull-*'], STAGING_ROOT)
        .split('\n')
        .map(l => l.replace(/^[*+]\s*/, '').trim())
        .filter(Boolean);
}

function currentBranch(): string {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], STAGING_ROOT).trim();
}

function headCommit(): string {
    return git(['rev-parse', 'HEAD'], STAGING_ROOT).trim();
}

/** 建 bare 远端 + seed 推送，并把远端内容 clone 成「暂存区已就绪」状态 */
function setupRemoteAndStaging(): void {
    fs.mkdirSync(REMOTE, {recursive: true});
    git(['init', '--bare', '-b', 'main', '.'], REMOTE);

    fs.mkdirSync(SEED, {recursive: true});
    git(['init', '-b', 'main', '.'], SEED);
    git(['config', 'user.name', 'seed'], SEED);
    git(['config', 'user.email', 'seed@localhost'], SEED);
    fs.mkdirSync(path.join(SEED, 'ai-tools', 'mcp'), {recursive: true});
    fs.mkdirSync(path.join(SEED, 'ai-tools', 'skills', 'remote-skill'), {recursive: true});
    fs.writeFileSync(path.join(SEED, MCP_REL), REMOTE_MCP, 'utf-8');
    fs.writeFileSync(path.join(SEED, 'ai-tools', 'skills', 'remote-skill', 'SKILL.md'), '# remote\n', 'utf-8');
    git(['add', '-A'], SEED);
    git(['commit', '-m', 'seed'], SEED);
    git(['remote', 'add', 'origin', REMOTE], SEED);
    git(['push', '-u', 'origin', 'main'], SEED);

    fs.mkdirSync(STAGING_ROOT, {recursive: true});
    git(['clone', REMOTE, '.'], STAGING_ROOT);
    git(['config', 'user.name', 'tester'], STAGING_ROOT);
    git(['config', 'user.email', 'tester@localhost'], STAGING_ROOT);
}

describe('gitPull 拉取前备份（P1-a）', () => {
    let svc: CloudSyncService;

    beforeEach(() => {
        fs.mkdirSync(ROOT, {recursive: true});
        setupRemoteAndStaging();
        svc = new CloudSyncService();
    });

    afterEach(() => {
        fs.rmSync(ROOT, {recursive: true, force: true});
    });

    it('未提交改动 → 备份到分支后重置，内容可从备份分支取回', async () => {
        fs.writeFileSync(stagedMcp, DIRTY_MCP, 'utf-8');

        const res = await svc.pull();

        expect(res.ok).toBe(true);
        expect(res.message).toMatch(/backup-before-pull-\d+/);
        // 工作区已重置为远端版本
        expect(fs.readFileSync(stagedMcp, 'utf-8')).toBe(REMOTE_MCP);
        // 备份分支留存了未提交改动
        const backups = listBackupBranches();
        expect(backups.length).toBe(1);
        expect(git(['show', `${backups[0]}:${MCP_REL.replace(/\\/g, '/')}`], STAGING_ROOT)).toBe(DIRTY_MCP);
        // 回到工作分支
        expect(currentBranch()).toBe('main');
    });

    it('本地独有提交（push 被拒残留）→ 备份到分支后重置，提交仍可追溯', async () => {
        fs.writeFileSync(stagedMcp, DIRTY_MCP, 'utf-8');
        git(['add', '-A'], STAGING_ROOT);
        git(['commit', '-m', 'local-only commit'], STAGING_ROOT);
        const localOnly = headCommit();

        const res = await svc.pull();

        expect(res.ok).toBe(true);
        expect(res.message).toMatch(/backup-before-pull-\d+/);
        expect(headCommit()).not.toBe(localOnly);
        // 远端内容已落地
        expect(fs.readFileSync(stagedMcp, 'utf-8')).toBe(REMOTE_MCP);
        // 本地独有提交保留在备份分支上
        const backups = listBackupBranches();
        expect(backups.length).toBe(1);
        expect(git(['branch', '--contains', localOnly], STAGING_ROOT)).toMatch(/backup-before-pull-/);
    });

    it('干净且无独有提交 → 不建备份分支，正常下载', async () => {
        const res = await svc.pull();

        expect(res.ok).toBe(true);
        expect(res.message).not.toMatch(/backup-before-pull-\d+/);
        expect(listBackupBranches().length).toBe(0);
        expect(fs.readFileSync(stagedMcp, 'utf-8')).toBe(REMOTE_MCP);
    });

    it('备份失败 → 中止本次 pull，本地改动原样保留（不硬重置）', async () => {
        fs.writeFileSync(stagedMcp, DIRTY_MCP, 'utf-8');
        vi.spyOn(svc as any, 'backupBeforePull').mockResolvedValue(null);

        const res = await svc.pull();

        expect(res.ok).toBe(false);
        expect(res.message).toContain('已取消本次下载');
        // 改动未被丢弃
        expect(fs.readFileSync(stagedMcp, 'utf-8')).toBe(DIRTY_MCP);
    });
});
