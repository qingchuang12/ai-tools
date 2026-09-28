/**
 * sftpPush 删除语义（P1-b）测试
 *
 * 核心口径：常规 push 绝不删除云端任何内容；镜像清理只在显式 mirror 时执行；
 * Skill 卸载联动只定向删除明确指定的条目，且拒绝路径穿越名。
 * 用 fake sftp client 捕获 uploadDir / list / rmdir 调用，验证删除面。
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const FAKE_HOME = path.join(os.tmpdir(), `mcp-dock-pushmode-${process.pid}-${Math.random().toString(36).slice(2)}`);
const STAGING_ROOT = path.join(FAKE_HOME, '.ai-tools', 'cloud');
const STAGING_DATA = path.join(STAGING_ROOT, 'ai-tools');
const REMOTE_ROOT = '/srv/cloud';
const REMOTE_DATA = `${REMOTE_ROOT}/ai-tools`;

// 远端目录树（fake client 内部状态）：键为路径，值为 'dir' | 'file'
let remoteTree: Record<string, 'dir' | 'file'>;
let removed: string[];

vi.mock('electron', () => ({
    app: {
        getPath: (n: string) =>
            n === 'home' ? FAKE_HOME : path.join(FAKE_HOME, '.ai-tools'),
    },
}));

vi.mock('../main/license/feature-gate', () => ({
    assertFeature: async () => ({allowed: true, code: 'LIC_OK', payload: null}),
    GATE_LOCKED_MESSAGE: 'license.errors.locked',
}));

vi.mock('../main/cloud-sync-store', () => ({
    getCloudSyncStore: () => ({
        isActive: () => true,
        getStagingRoot: () => STAGING_ROOT,
        getStagingDataDir: () => STAGING_DATA,
        getStagingMcpConfigPath: () => path.join(STAGING_DATA, 'mcp', 'mcp.json'),
        getStagingSkillsPath: () => path.join(STAGING_DATA, 'skills'),
        ensureStagingDirs: () => {
            fs.mkdirSync(path.join(STAGING_DATA, 'mcp'), {recursive: true});
            fs.mkdirSync(path.join(STAGING_DATA, 'skills'), {recursive: true});
        },
        getConfig: () => ({
            enabled: true,
            provider: 'sftp',
            git: {},
            sftp: {host: 'h', port: 22, username: 'u', remoteDir: REMOTE_ROOT, authType: 'password'},
        }),
        recordSync: () => {
        },
        revealSecret: () => 'pw',
        isSecretStale: () => false,
    }),
    CLOUD_ROOT_DIR: 'ai-tools',
}));

import {CloudSyncService} from '../main/cloud-sync-service';

function baseFakeClient() {
    return {
        connect: async () => {
        },
        exists: async (p: string) => p in remoteTree,
        mkdir: async () => {
        },
        uploadDir: async () => {
        },
        list: async (dir: string) => {
            const prefix = dir.endsWith('/') ? dir : `${dir}/`;
            const names = new Set<string>();
            for (const p of Object.keys(remoteTree)) {
                if (p.startsWith(prefix)) {
                    const rest = p.slice(prefix.length);
                    if (rest && !rest.includes('/')) {
                        names.add(rest);
                    }
                }
            }
            return [...names].map(name => ({name, type: remoteTree[`${prefix}${name}`] === 'dir' ? 'd' : '-'}));
        },
        rmdir: async (p: string) => {
            removed.push(p);
            delete remoteTree[p];
        },
        end: async () => {
        },
    };
}

describe('sftpPush 删除语义（P1-b）', () => {
    let svc: CloudSyncService;

    beforeEach(() => {
        removed = [];
        remoteTree = {};
        fs.rmSync(FAKE_HOME, {recursive: true, force: true});
        fs.mkdirSync(path.join(STAGING_DATA, 'skills', 'local-skill'), {recursive: true});
        fs.writeFileSync(path.join(STAGING_DATA, 'skills', 'local-skill', 'SKILL.md'), '# local\n', 'utf-8');
        // 云端有两个本地没有的技能目录：常规 push 不得删除
        remoteTree = {
            [`${REMOTE_DATA}/skills`]: 'dir',
            [`${REMOTE_DATA}/skills/stale-skill`]: 'dir',
            [`${REMOTE_DATA}/skills/other-skill`]: 'dir',
        };
        svc = new CloudSyncService();
        vi.spyOn(svc as any, 'sftpConnect').mockResolvedValue(baseFakeClient());
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(FAKE_HOME, {recursive: true, force: true});
    });

    it('常规 push（无 opts）只增量上传，绝不删除云端多余项', async () => {
        const res = await svc.push('skills');

        expect(res.ok).toBe(true);
        expect(removed).toEqual([]);
    });

    it('mirror: true（显式「以本地为准覆盖云端」）删除云端多余项', async () => {
        const res = await svc.push('skills', {mirror: true});

        expect(res.ok).toBe(true);
        expect(removed).toEqual([`${REMOTE_DATA}/skills/stale-skill`, `${REMOTE_DATA}/skills/other-skill`]);
    });

    it('deletes 定向删除：只删指定名，其余云端内容不动（卸载联动）', async () => {
        const res = await svc.push('skills', {deletes: ['stale-skill']});

        expect(res.ok).toBe(true);
        expect(removed).toEqual([`${REMOTE_DATA}/skills/stale-skill`]);
    });

    it('deletes 含路径穿越名 → 跳过，任何情况下不发删除调用', async () => {
        const res = await svc.push('skills', {deletes: ['../evil', 'a/b', '..', '']});

        expect(res.ok).toBe(true);
        expect(removed).toEqual([]);
    });

    it('mirror 优先于 deletes（不重复删除）', async () => {
        const res = await svc.push('skills', {mirror: true, deletes: ['stale-skill']});

        expect(res.ok).toBe(true);
        expect(removed).toEqual([`${REMOTE_DATA}/skills/stale-skill`, `${REMOTE_DATA}/skills/other-skill`]);
    });

    it('deletes 对 mcp 范围不生效（MCP 暂存区为单文件，增量上传即覆盖）', async () => {
        fs.mkdirSync(path.join(STAGING_DATA, 'mcp'), {recursive: true});
        fs.writeFileSync(path.join(STAGING_DATA, 'mcp', 'mcp.json'), '{"mcpServers":{}}', 'utf-8');
        remoteTree[`${REMOTE_DATA}/mcp`] = 'dir';
        remoteTree[`${REMOTE_DATA}/mcp/stale-server.json`] = 'file';

        const res = await svc.push('mcp', {deletes: ['stale-server.json']});

        expect(res.ok).toBe(true);
        expect(removed).toEqual([]);
    });
});
