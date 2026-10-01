import {describe, expect, it, vi} from 'vitest';
import path from 'path';
import os from 'os';
import {SyncTaskManager} from '../main/sync-task-manager';

vi.mock('electron', () => ({
    app: {
        getPath: (name: string) => (name === 'home'
            ? path.join(os.tmpdir(), 'sync-task-dedup-test')
            : ''),
    },
}));

const fakePush = vi.fn(async () => ({ok: true, message: 'ok'}));
const fakePull = vi.fn(async () => ({ok: true, message: 'ok'}));
vi.mock('../main/cloud-sync-service', () => ({
    getCloudSyncService: () => ({push: fakePush, pull: fakePull}),
}));

function fresh(): SyncTaskManager {
    const mgr = new SyncTaskManager(() => {});
    // 清空可能从磁盘载入的历史，保证用例隔离
    (mgr as any).tasks = [];
    (mgr as any).persist();
    fakePush.mockClear();
    fakePull.mockClear();
    return mgr;
}

describe('SyncTaskManager 去重', () => {
    it('相同 kind+scope 的待处理任务不会重复入队', () => {
        const mgr = fresh();
        const a = mgr.enqueue('cloud-push', '上传 MCP 配置到云端', 'mcp');
        const b = mgr.enqueue('cloud-push', '上传 MCP 配置到云端', 'mcp');
        expect(b.id).toBe(a.id);
        const same = mgr.list().filter(t => t.kind === 'cloud-push' && t.scope === 'mcp');
        expect(same.length).toBe(1);
    });

    it('不同 scope 视为不同任务，可分别入队', () => {
        const mgr = fresh();
        const a = mgr.enqueue('cloud-push', 'MCP', 'mcp');
        const b = mgr.enqueue('cloud-push', 'Skills', 'skills');
        expect(b.id).not.toBe(a.id);
        expect(mgr.list().length).toBe(2);
    });

    it('已完成的任务不阻止新任务入队', async () => {
        const mgr = fresh();
        const a = mgr.enqueue('cloud-push', 'MCP', 'mcp');
        a.status = 'success';
        (mgr as any).persist();
        const b = mgr.enqueue('cloud-push', 'MCP', 'mcp');
        expect(b.id).not.toBe(a.id);
    });

    it('正在同步(running)的任务也被视为重复', () => {
        const mgr = fresh();
        const a = mgr.enqueue('cloud-push', 'MCP', 'mcp');
        a.status = 'running';
        const b = mgr.enqueue('cloud-push', 'MCP', 'mcp');
        expect(b.id).toBe(a.id);
    });

    it('mirror 选项不同视为不同任务（镜像覆盖不被增量任务吞掉）', () => {
        const mgr = fresh();
        const incremental = mgr.enqueue('cloud-push', 'Skills', 'skills');
        const mirrored = mgr.enqueue('cloud-push', 'Skills', 'skills', {mirror: true});
        expect(mirrored.id).not.toBe(incremental.id);
        expect(mirrored.mirror).toBe(true);
        expect(incremental.mirror).toBeUndefined();
        // 同 mirror 的再一次入队仍去重
        const again = mgr.enqueue('cloud-push', 'Skills', 'skills', {mirror: true});
        expect(again.id).toBe(mirrored.id);
    });

    it('deletes 清单不同视为不同任务，相同则去重', () => {
        const mgr = fresh();
        const a = mgr.enqueue('cloud-push', 'Skills', 'skills', {deletes: ['skill-a']});
        const b = mgr.enqueue('cloud-push', 'Skills', 'skills', {deletes: ['skill-b']});
        expect(b.id).not.toBe(a.id);
        expect(a.deletes).toEqual(['skill-a']);
        const sameAsA = mgr.enqueue('cloud-push', 'Skills', 'skills', {deletes: ['skill-a']});
        expect(sameAsA.id).toBe(a.id);
    });
});

describe('SyncTaskManager.enqueueAndWait（P2-a）', () => {
    it('成功时返回任务 detail，并把 mirror/deletes 透传给 push', async () => {
        const mgr = fresh();
        fakePush.mockResolvedValueOnce({ok: true, message: '已上传到云端(2 项变更)'});

        const res = await mgr.enqueueAndWait('cloud-push', '上传技能到云端', 'skills', {deletes: ['skill-a']});

        expect(res).toEqual({ok: true, message: '已上传到云端(2 项变更)'});
        expect(fakePush).toHaveBeenCalledWith('skills', {mirror: undefined, deletes: ['skill-a']});
    });

    it('失败时按任务 error 返回，不谎报成功', async () => {
        const mgr = fresh();
        fakePush.mockResolvedValueOnce({ok: false, message: '连接超时'});

        const res = await mgr.enqueueAndWait('cloud-push', '上传到云端');

        expect(res.ok).toBe(false);
        expect(res.message).toBe('连接超时');
    });

    it('任务记录被移除 → 按失败返回（不得当作成功）', async () => {
        const mgr = fresh();
        const pending = mgr.enqueueAndWait('cloud-push', '上传到云端', 'skills');
        const id = mgr.list()[0].id;
        mgr.remove(id);

        const res = await pending;

        expect(res.ok).toBe(false);
        expect(res.message).toContain('已被移除');
    });
});
