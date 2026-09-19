import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {CloudSyncService} from '../main/cloud-sync-service';

const FAKE_HOME = path.join(os.tmpdir(), `mcp-dock-scopetest-${process.pid}`);
process.env.FAKEHOME = FAKE_HOME;

// 捕获真实 sftpPush 调用 uploadDir 时使用的 local 路径
const captured = {local: null as string | null};

vi.mock('electron', () => ({
    app: {
        getPath: (n: string) =>
            n === 'home' ? FAKE_HOME : path.join(FAKE_HOME, '.ai-tools'),
    },
}));

// 本用例只验证「上传路径隔离」，不验证授权：云同步已被 license gate 拦截（无 token 时 push 直接返回
// {ok:false}），故在此把 gate 置为放行，让流程走到 uploadDir。gate 自身的行为由 license-*.test.ts 覆盖。
vi.mock('../main/license/feature-gate', () => ({
    assertFeature: async () => ({allowed: true, code: 'LIC_OK', payload: null}),
    GATE_LOCKED_MESSAGE: 'license.errors.locked',
}));

const stagingDataDir = path.join(FAKE_HOME, '.ai-tools', 'cloud', 'ai-tools');
vi.mock('../main/cloud-sync-store', () => ({
    getCloudSyncStore: () => ({
        isActive: () => true,
        ensureStagingDirs: () => {
            fs.mkdirSync(stagingDataDir, {recursive: true});
        },
        getStagingDataDir: () => stagingDataDir,
        getConfig: () => ({
            provider: 'sftp',
            sftp: {host: 'h', port: 22, username: 'u', remoteDir: '/data'},
            git: {},
        }),
        recordSync: () => {
        },
    }),
    CLOUD_ROOT_DIR: 'ai-tools',
}));

describe('CloudSyncService.push 隔离（mock sftp 连接，端到端）', () => {
    let svc: CloudSyncService;

    beforeEach(() => {
        captured.local = null;
        fs.mkdirSync(path.join(stagingDataDir, 'skills'), {recursive: true});
        fs.writeFileSync(path.join(stagingDataDir, 'skills', 'x.json'), '{}');
        svc = new CloudSyncService();
        // 绕过真实的 sftp 连接/私钥校验，只验证 uploadDir 实际传了哪个本地目录
        const fakeClient = {
            connect: async () => {
            },
            exists: async () => false,
            mkdir: async () => {
            },
            uploadDir: async (local: string) => {
                captured.local = local;
            },
            list: async () => [] as any[],
            delete: async () => {
            },
            end: async () => {
            },
        };
        vi.spyOn(svc as any, 'sftpConnect').mockResolvedValue(fakeClient);
    });

    afterEach(() => {
        fs.rmSync(FAKE_HOME, {recursive: true, force: true});
    });

    it("push('skills') 只 uploadDir 到 skills 子目录，绝不传 mcp", async () => {
        const res = await svc.push('skills');
        expect(res.ok).toBe(true);
        expect(captured.local).not.toBeNull();
        expect(captured.local!.endsWith(path.join('ai-tools', 'skills'))).toBe(true);
        expect(captured.local!.endsWith(path.join('ai-tools', 'mcp'))).toBe(false);
    });

    it("push('mcp') 只 uploadDir 到 mcp 子目录，绝不传 skills", async () => {
        fs.mkdirSync(path.join(stagingDataDir, 'mcp'), {recursive: true});
        fs.writeFileSync(path.join(stagingDataDir, 'mcp', 'mcp.json'), '{}');
        const res = await svc.push('mcp');
        expect(res.ok).toBe(true);
        expect(captured.local!.endsWith(path.join('ai-tools', 'mcp'))).toBe(true);
        expect(captured.local!.endsWith(path.join('ai-tools', 'skills'))).toBe(false);
    });

    it("push(undefined) 走全量（整个 ai-tools）", async () => {
        const res = await svc.push(undefined);
        expect(res.ok).toBe(true);
        expect(captured.local).toBe(stagingDataDir);
    });
});
