/**
 * 同步任务共享类型（主进程 / 渲染进程 / preload 共用）
 *
 * 一次「同步任务」指一次后台异步执行的云同步动作（上传/下载），
 * 由 SyncTaskManager 在后台队列中串行处理，状态变化通过 IPC 事件推送给渲染层。
 */

import type {SyncPushOptions} from './cloud-sync-constants';

/** 任务类型：对应具体的云同步动作 */
export type SyncTaskKind = 'cloud-push' | 'cloud-pull';

/** 同步内容范围：MCP 配置 / 技能 / 全部（兼容旧任务） */
export type SyncTaskScope = 'mcp' | 'skills' | 'all';

/** 任务状态机 */
export type SyncTaskStatus = 'pending' | 'running' | 'success' | 'failed';

export interface SyncTask {
    /** 任务唯一 id */
    id: string;
    /** 任务类型 */
    kind: SyncTaskKind;
    /** 同步内容范围：mcp / skills / all（用于面板区分显示与按子目录上传） */
    scope?: SyncTaskScope;
    /** 展示标题（入队时即确定，便于重启后也能读懂） */
    title: string;
    /** 当前状态 */
    status: SyncTaskStatus;
    /** 创建时间（ms） */
    createdAt: number;
    /** 开始执行时间（ms） */
    startedAt?: number;
    /** 结束时间（ms） */
    finishedAt?: number;
    /** 失败时的人类可读错误原因 */
    error?: string;
    /** 成功时的可读结果摘要 */
    detail?: string;
    /** push 镜像模式（「以本地为准覆盖云端」显式操作；见 SyncPushOptions） */
    mirror?: boolean;
    /** push 定向删除的 Skill 名清单（卸载联动；见 SyncPushOptions） */
    deletes?: string[];
}

/** 入队附加选项：随任务一起流转到 push 执行体 */
export type SyncTaskOptions = SyncPushOptions;

/** 各类型对应给用户的默认标题（渲染层也用于兜底） */
export const SYNC_TASK_TITLES: Record<SyncTaskKind, string> = {
    'cloud-push': '上传到云端',
    'cloud-pull': '从云端下载',
};
