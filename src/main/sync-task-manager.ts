/**
 * SyncTaskManager - 同步任务后台队列（单例）
 *
 * 设计：
 *  - 「我的库」编辑 skill 自动同步云端、手动「立即同步」等操作，不再阻塞 UI，
 *    而是入队一个后台任务，由本管理器串行执行（云同步的 push/pull 不适合并发）。
 *  - 任务状态变化通过 emit() 回调（主进程据此向渲染层广播 sync-tasks:updated）实时刷新侧边栏面板。
 *  - 任务落盘到 ~/.ai-tools/sync-tasks.json，重启后保留历史；
 *    重启时仍在 pending/running 的任务视为中断，标记为 failed 以便用户重试。
 *  - 失败任务支持 retry() 重新入队；支持 remove()/clear() 管理列表。
 */

import fs from 'fs';
import path from 'path';
import {app} from 'electron';
import {getCloudSyncService} from './cloud-sync-service';
import type {CloudSyncResult} from '../shared/cloud-sync-constants';
import type {SyncTask, SyncTaskKind, SyncTaskOptions, SyncTaskScope} from '../shared/sync-task-types';

const MAX_TASKS = 50;
/** 任务记录保留天数 */
const TASK_RETENTION_DAYS = 7;
const TASK_RETENTION_MS = TASK_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** 兼容旧任务：从标题推断 scope（MCP / 技能 / 无法判断则全量） */
function inferScopeFromTitle(title?: string): SyncTaskScope | undefined {
    if (!title) return undefined;
    if (title.includes('MCP') || title.includes('mcp')) return 'mcp';
    if (title.includes('技能') || /skill/i.test(title)) return 'skills';
    return undefined;
}

export class SyncTaskManager {
    private tasks: SyncTask[] = [];
    /** 队列处理中标记，保证串行 */
    private running = false;
    private filePath: string;
    private emit: () => void;

    constructor(emit: () => void) {
        this.emit = emit;
        const home = app.getPath('home');
        const dir = path.join(home, '.ai-tools');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
        this.filePath = path.join(dir, 'sync-tasks.json');
        this.load();
    }

    // ==================== 持久化 ====================

    private load(): void {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw) as SyncTask[];
            const cutoff = Date.now() - TASK_RETENTION_MS;
            if (Array.isArray(parsed)) {
                this.tasks = parsed
                    // 超过保留期的任务自动清理
                    .filter(t => t.createdAt >= cutoff)
                    .map(t => {
                        let task = t;
                        if (t.status === 'pending' || t.status === 'running') {
                            task = {
                                ...t,
                                status: 'failed' as const,
                                error: '应用重启，任务中断',
                                startedAt: t.startedAt ?? t.createdAt,
                                finishedAt: Date.now(),
                            };
                        }
                        if (!task.scope) {
                            task = {...task, scope: inferScopeFromTitle(task.title)};
                        }
                        return task;
                    });
                // 清理后若文件内容有变，回写磁盘
                if (this.tasks.length !== parsed.length) {
                    this.persist();
                }
            }
        } catch {
            this.tasks = [];
        }
    }

    private persist(): void {
        try {
            const cutoff = Date.now() - TASK_RETENTION_MS;
            const valid = this.tasks
                .filter(t => t.createdAt >= cutoff)
                .slice(-MAX_TASKS);
            fs.writeFileSync(this.filePath, JSON.stringify(valid, null, 2), 'utf-8');
        } catch {
            // 持久化失败不阻断内存中的任务流转
        }
    }

    // ==================== 对外接口 ====================

    /** 返回任务列表（最新在前） */
    list(): SyncTask[] {
        return [...this.tasks].reverse();
    }

    /** 入队一个同步任务，立即触发队列处理
     * 去重：已存在「相同类型 + 相同范围 + 相同选项」且处于 pending/running（待处理/正在同步）的任务时，
     * 不再重复添加，直接返回已有任务。选项不同（如普通上传 vs 镜像覆盖 vs 定向删除）时视为不同任务。 */
    enqueue(kind: SyncTaskKind, title: string, scope?: SyncTaskScope, opts?: SyncTaskOptions): SyncTask {
        const normScope = scope ?? 'all';
        const sameOpts = (t: SyncTask) =>
            !!t.mirror === !!opts?.mirror &&
            JSON.stringify(t.deletes ?? []) === JSON.stringify(opts?.deletes ?? []);
        const existing = this.tasks.find(t =>
            (t.status === 'pending' || t.status === 'running') &&
            t.kind === kind &&
            (t.scope ?? 'all') === normScope &&
            sameOpts(t)
        );
        if (existing) {
            return existing;
        }

        const task: SyncTask = {
            id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            kind,
            scope,
            title: title || (kind === 'cloud-push' ? '上传到云端' : '从云端下载'),
            status: 'pending',
            createdAt: Date.now(),
            ...(opts?.mirror ? {mirror: true} : {}),
            ...(opts?.deletes?.length ? {deletes: [...opts.deletes]} : {}),
        };
        this.tasks.push(task);
        if (this.tasks.length > MAX_TASKS) this.tasks = this.tasks.slice(-MAX_TASKS);
        this.persist();
        this.emit();
        void this.pump();
        return task;
    }

    /**
     * 入队并等待任务到达终态，返回与 CloudSyncService 一致的 CloudSyncResult。
     * 供需要同步拿到结果的 IPC 入口（手动 push/pull、启动拉取）使用，任务同时出现在「同步任务」面板。
     * 任务记录查不到（被 remove/clear 清除或超出保留上限）时按失败返回——
     * 绝不能静默当作成功，否则 UI 会显示「同步完成」而实际结果未知（P2-a）。
     */
    async enqueueAndWait(kind: SyncTaskKind, title: string, scope?: SyncTaskScope, opts?: SyncTaskOptions): Promise<CloudSyncResult> {
        const task = this.enqueue(kind, title, scope, opts);
        return new Promise<CloudSyncResult>((resolve) => {
            const timer = setInterval(() => {
                const t = this.tasks.find(x => x.id === task.id);
                if (!t) {
                    clearInterval(timer);
                    resolve({ok: false, message: '同步任务已被移除，无法确认结果'});
                } else if (t.status === 'success') {
                    clearInterval(timer);
                    resolve({ok: true, message: t.detail ?? '同步完成'});
                } else if (t.status === 'failed') {
                    clearInterval(timer);
                    resolve({ok: false, message: t.error ?? '同步失败'});
                }
            }, 150);
        });
    }

    /** 重试一个失败的任务 */
    retry(id: string): boolean {
        const task = this.tasks.find(t => t.id === id);
        if (!task || task.status !== 'failed') return false;
        task.status = 'pending';
        task.error = undefined;
        task.detail = undefined;
        task.startedAt = undefined;
        task.finishedAt = undefined;
        this.persist();
        this.emit();
        void this.pump();
        return true;
    }

    /** 移除单条任务 */
    remove(id: string): void {
        this.tasks = this.tasks.filter(t => t.id !== id);
        this.persist();
        this.emit();
    }

    /** 清空全部任务（不影响进行中的任务继续执行） */
    clear(): void {
        this.tasks = [];
        this.persist();
        this.emit();
    }

    // ==================== 队列执行 ====================

    private async pump(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (true) {
                const task = this.tasks.find(t => t.status === 'pending');
                if (!task) break;

                task.status = 'running';
                task.startedAt = Date.now();
                this.persist();
                this.emit();

                try {
                    const res: CloudSyncResult = task.kind === 'cloud-push'
                        ? await getCloudSyncService().push(task.scope, {mirror: task.mirror, deletes: task.deletes})
                        : await getCloudSyncService().pull();
                    if (res.ok) {
                        task.status = 'success';
                        task.detail = res.message;
                    } else {
                        task.status = 'failed';
                        task.error = res.message;
                    }
                } catch (e: any) {
                    task.status = 'failed';
                    task.error = (e as Error)?.message || '未知错误';
                }

                task.finishedAt = Date.now();
                this.persist();
                this.emit();
            }
        } finally {
            this.running = false;
        }
    }
}

// ==================== 单例 ====================

let instance: SyncTaskManager | null = null;

/** 在 app ready 后、窗口创建完成时调用，传入广播回调 */
export function initSyncTaskManager(emit: () => void): SyncTaskManager {
    if (!instance) {
        instance = new SyncTaskManager(emit);
        // 构造完成后（instance 已赋值）再广播一次初始列表；
        // 不可在构造函数内 emit，否则回调里 getSyncTaskManager() 会因 instance 尚未赋值而抛错。
        emit();
    }
    return instance;
}

export function getSyncTaskManager(): SyncTaskManager {
    if (!instance) throw new Error('SyncTaskManager 尚未初始化');
    return instance;
}
