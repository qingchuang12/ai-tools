/**
 * 侧边栏「同步任务」面板
 *
 * 位置：左侧菜单栏，设置按钮下方。
 * 功能：
 *  - 展示后台异步云同步任务队列（「我的库」编辑自动同步、手动「立即同步」等入队的任务）；
 *  - 实时反映任务状态：等待中 / 同步中 / 已完成 / 失败；
 *  - 失败任务提供「重试」按钮重新同步；
 *  - 任务列表可滚动查看，支持单条移除与清空。
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {TFunction} from 'i18next';
import {useElectronAPI} from '../lib/electron';
import type {SyncTask, SyncTaskStatus} from '../../../shared/sync-task-types';
import type {CloudSyncConfig} from '../../../shared/cloud-sync-constants';
import {CheckIcon, CloseIcon, ErrorIcon, RefreshIcon} from './Icons';
import Modal from './Modal';

/** 把时间戳格式化为「刚刚 / N 分钟前 / N 小时前 / HH:mm」的相对/绝对时间 */
function formatTime(ts: number | undefined, t: TFunction): string {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (diff < 0) return '';
    if (diff < 60_000) return t('time.justNow');
    if (min < 60) return t('time.minutesAgo', {count: min});
    const hr = Math.floor(min / 60);
    if (hr < 24) return t('time.hoursAgo', {count: hr});
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STATUS_META: Record<SyncTaskStatus, {labelKey: string; iconColor: string}> = {
    pending: {labelKey: 'syncTasks.queued', iconColor: 'text-amber-500'},
    running: {labelKey: 'syncTasks.syncing', iconColor: 'text-[var(--color-accent)]'},
    success: {labelKey: 'syncTasks.done', iconColor: 'text-green-500'},
    failed: {labelKey: 'syncTasks.failed', iconColor: 'text-red-500'},
};

export default function SyncTasksPanel() {
    const {t} = useTranslation();
    const api = useElectronAPI();

    const [tasks, setTasks] = useState<SyncTask[]>([]);
    const [detailTask, setDetailTask] = useState<SyncTask | null>(null);
    const [cloudInfo, setCloudInfo] = useState('');
    const isMounted = useRef(true);

    useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);

    // 拉取初始列表 + 订阅主进程实时推送 + 记录云端目标（用于详情描述）
    useEffect(() => {
        let unsub: (() => void) | undefined;
        (async () => {
            try {
                const list = await api.syncTasks.list();
                if (isMounted.current) setTasks(list);
            } catch {
                /* 忽略初始化失败 */
            }
            try {
                unsub = api.syncTasks.onUpdated((list) => {
                    if (isMounted.current) setTasks(list);
                });
            } catch {
                /* 不支持事件时静默 */
            }
            try {
                const cfg = await api.cloudSync.getConfig();
                if (isMounted.current) setCloudInfo(describeCloudTarget(cfg));
            } catch {
                /* 忽略 */
            }
        })();
        return () => {
            unsub?.();
        };
    }, [api]);

    const handleRetry = useCallback(async (id: string) => {
        try {
            await api.syncTasks.retry(id);
        } catch {
            /* 忽略 */
        }
    }, [api]);

    const handleRemove = useCallback(async (id: string) => {
        try {
            await api.syncTasks.remove(id);
        } catch {
            /* 忽略 */
        }
    }, [api]);

    const handleClear = useCallback(async () => {
        try {
            await api.syncTasks.clear();
        } catch {
            /* 忽略 */
        }
    }, [api]);

    const hasTasks = tasks.length > 0;
    const failedCount = tasks.filter(t => t.status === 'failed').length;

    return (
        <div className="px-2 pb-2 pt-1 border-t border-content-border">
            {/* 头部：标题 + 清空 */}
            <div className="flex items-center justify-between px-2 py-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                    <RefreshIcon className="w-3.5 h-3.5 text-muted2"/>
                    <span className="text-[12px] font-semibold text-muted uppercase tracking-wider truncate">
                        {t('syncTasks.title') || '同步任务'}
                    </span>
                    {failedCount > 0 && (
                        <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-500">
                            {failedCount}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-0.5 no-drag">
                    {hasTasks && (
                        <button
                            onClick={handleClear}
                            title={t('syncTasks.clear') || '清空任务'}
                            className="rounded p-1 text-muted2 transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                            aria-label={t('syncTasks.clear') || '清空任务'}
                        >
                            <CloseIcon className="w-3.5 h-3.5"/>
                        </button>
                    )}
                </div>
            </div>

            {/* 任务列表：可滚动，最多展示固定高度 */}
            {hasTasks ? (
                <div className="max-h-[200px] overflow-y-auto pr-0.5 space-y-1">
                    {tasks.map((task) => {
                        const meta = STATUS_META[task.status];
                        const isFailed = task.status === 'failed';
                        const isActive = task.status === 'pending' || task.status === 'running';
                        return (
                            <div
                                key={task.id}
                                onClick={() => setDetailTask(task)}
                                className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
                            >
                                {/* 状态图标 */}
                                <span className={`mt-0.5 flex-shrink-0 ${meta.iconColor}`}>
                                    {isActive ? (
                                        <RefreshIcon className="w-3.5 h-3.5 animate-spin"/>
                                    ) : task.status === 'success' ? (
                                        <CheckIcon className="w-3.5 h-3.5"/>
                                    ) : (
                                        <ErrorIcon className="w-3.5 h-3.5"/>
                                    )}
                                </span>

                                {/* 主体：标题 + 状态/时间 */}
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[12px] text-[var(--color-text)]" title={detailSyncTarget(task, t)}>
                                        {detailSyncTarget(task, t)}
                                    </div>
                                    <div className="truncate text-[11px] text-muted2">
                                        {t(meta.labelKey)}
                                        {isFailed && task.error ? ` · ${task.error}` : ''}
                                        {!isFailed && task.detail ? ` · ${task.detail}` : ''}
                                        <span className="ml-1 opacity-70">
                                            {formatTime(task.finishedAt ?? task.startedAt ?? task.createdAt, t)}
                                        </span>
                                    </div>
                                </div>

                                {/* 操作：失败 -> 重试；悬停 -> 移除 */}
                                <div className="flex-shrink-0 flex items-center gap-0.5 no-drag">
                                    {isFailed && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleRetry(task.id); }}
                                            title={t('syncTasks.retry') || '重试'}
                                            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
                                        >
                                            {t('syncTasks.retry') || '重试'}
                                        </button>
                                    )}
                                    <button
                                        onClick={(e) => { e.stopPropagation(); handleRemove(task.id); }}
                                        title={t('syncTasks.remove') || '移除'}
                                        className="rounded p-1 text-muted2 opacity-0 group-hover:opacity-100 transition-opacity hover:text-[var(--color-text)]"
                                        aria-label={t('syncTasks.remove') || '移除'}
                                    >
                                        <CloseIcon className="w-3 h-3"/>
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="px-2 py-3 text-[11px] text-muted2 leading-relaxed">
                    {t('syncTasks.empty') || '暂无同步任务'}
                </div>
            )}

            {/* 任务详情弹框：点击任务条目查看完整信息 */}
            <Modal
                isOpen={!!detailTask}
                onClose={() => setDetailTask(null)}
                title={t('syncTasks.detailTitle') || '同步任务详情'}
                size="sm"
            >
                {detailTask && (
                    <div className="space-y-3 text-[13px]">
                        {/* 标题 */}
                        <div>
                            <div className="text-[11px] uppercase tracking-wider text-muted2 mb-1">
                                {t('syncTasks.detailFieldTitle') || '任务'}
                            </div>
                            <div className="text-[var(--color-text)] font-medium break-words">
                                {detailTask.title}
                            </div>
                        </div>

                        {/* 状态 + 类型 */}
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <div className="text-[11px] uppercase tracking-wider text-muted2 mb-1">
                                    {t('syncTasks.detailFieldStatus') || '状态'}
                                </div>
                                <div className={`font-medium ${STATUS_META[detailTask.status].iconColor}`}>
                                    {t(STATUS_META[detailTask.status].labelKey)}
                                </div>
                            </div>
                            <div>
                                <div className="text-[11px] uppercase tracking-wider text-muted2 mb-1">
                                    {t('syncTasks.detailFieldKind') || '类型'}
                                </div>
                                <div className="text-[var(--color-text)]">
                                    {detailTask.kind === 'cloud-push'
                                        ? (t('syncTasks.pushTitle') || '上传到云端')
                                        : (t('syncTasks.pullTitle') || '从云端下载')}
                                </div>
                            </div>
                        </div>

                        {/* 同步内容：明确这次同步的是什么（详细描述） */}
                        <div>
                            <div className="text-[11px] uppercase tracking-wider text-muted2 mb-1">
                                {t('syncTasks.detailFieldTarget') || '同步内容'}
                            </div>
                            <div className="text-[var(--color-text)] break-words whitespace-pre-line leading-relaxed">
                                {detailSyncTargetVerbose(detailTask, t)}
                            </div>
                            {cloudInfo && (
                                <div className="mt-1.5 text-[11px] text-muted2">
                                    {t('syncTasks.detailFieldTargetCloud') || '目标云端'}：{cloudInfo}
                                </div>
                            )}
                        </div>

                        {/* 时间线 */}
                        <div className="space-y-1.5">
                            <div className="text-[11px] uppercase tracking-wider text-muted2">
                                {t('syncTasks.detailFieldTime') || '时间'}
                            </div>
                            <div className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-[var(--color-text)]">
                                <span className="text-muted2">{t('syncTasks.detailCreated') || '创建'}</span>
                                <span>{formatFull(detailTask.createdAt)}</span>
                                {detailTask.startedAt && (
                                    <>
                                        <span className="text-muted2">{t('syncTasks.detailStarted') || '开始'}</span>
                                        <span>{formatFull(detailTask.startedAt)}</span>
                                    </>
                                )}
                                {detailTask.finishedAt && (
                                    <>
                                        <span className="text-muted2">{t('syncTasks.detailFinished') || '结束'}</span>
                                        <span>{formatFull(detailTask.finishedAt)}</span>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* 失败原因 */}
                        {detailTask.status === 'failed' && detailTask.error && (
                            <div>
                                <div className="text-[11px] uppercase tracking-wider text-red-500 mb-1">
                                    {t('syncTasks.detailFieldError') || '失败原因'}
                                </div>
                                <div className="rounded-md bg-red-500/10 px-2.5 py-2 text-red-400 break-words whitespace-pre-wrap">
                                    {detailTask.error}
                                </div>
                            </div>
                        )}

                        {/* 成功摘要 */}
                        {detailTask.status === 'success' && detailTask.detail && (
                            <div>
                                <div className="text-[11px] uppercase tracking-wider text-green-500 mb-1">
                                    {t('syncTasks.detailFieldResult') || '结果'}
                                </div>
                                <div className="rounded-md bg-green-500/10 px-2.5 py-2 text-green-400 break-words whitespace-pre-wrap">
                                    {detailTask.detail}
                                </div>
                            </div>
                        )}

                        {/* 任务 ID */}
                        <div>
                            <div className="text-[11px] uppercase tracking-wider text-muted2 mb-1">
                                ID
                            </div>
                            <div className="text-[11px] text-muted2 font-mono break-all">
                                {detailTask.id}
                            </div>
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
}

/** 完整时间格式化（YYYY-MM-DD HH:mm:ss），用于详情弹框 */
function formatFull(ts?: number): string {
    if (!ts) return '-';
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 从任务推导「同步内容」的人类可读描述 */
function detailSyncTarget(task: SyncTask, t: (k: string) => string): string {
    // 编辑/创建单个 skill 保存时，title 形如「上传到云端 · <skill名>」，提取具体对象
    const sep = task.title.indexOf('·');
    if (sep >= 0) {
        const name = task.title.slice(sep + 1).trim();
        if (name) {
            return task.kind === 'cloud-push'
                ? `${t('syncTasks.detailTargetSkillPush') || '上传技能'}「${name}」${t('syncTasks.detailTargetToCloud') || '到云端'}`
                : `${t('syncTasks.detailTargetSkillPull') || '从云端下载技能'}「${name}」`;
        }
    }
    // 按 scope 给出明确的内容描述（MCP / 技能 / 全部）
    if (task.scope === 'mcp') {
        return task.kind === 'cloud-push'
            ? (t('syncTasks.detailTargetMcpPush') || '上传 MCP 配置到云端')
            : (t('syncTasks.detailTargetMcpPull') || '从云端下载 MCP 配置');
    }
    if (task.scope === 'skills') {
        return task.kind === 'cloud-push'
            ? (t('syncTasks.detailTargetSkillsPush') || '上传技能到云端')
            : (t('syncTasks.detailTargetSkillsPull') || '从云端下载技能');
    }
    // 兼容旧任务（无 scope）：全量
    return task.kind === 'cloud-push'
        ? (t('syncTasks.detailTargetAllPush') || '上传全部 MCP 配置与技能到云端')
        : (t('syncTasks.detailTargetAllPull') || '从云端下载全部 MCP 配置与技能');
}

/**
 * 详情弹框用的「同步内容」详细描述（多行）。
 * 在简短描述基础上，补充「同步了什么 / 内容范围」等细节，便于事后回溯。
 */
function detailSyncTargetVerbose(task: SyncTask, t: (k: string) => string): string {
    const isPush = task.kind === 'cloud-push';
    // 编辑/创建单个 skill 保存时，title 形如「上传到云端 · <skill名>」，提取具体对象
    const sep = task.title.indexOf('·');
    if (sep >= 0) {
        const name = task.title.slice(sep + 1).trim();
        if (name) {
            if (isPush) {
                return [
                    t('syncTasks.detailTargetSkillPush') || '上传技能', `「${name}」`, t('syncTasks.detailTargetToCloud') || '到云端',
                ].join('') + '\n' +
                `• ${t('syncTasks.detailVerboseContent') || '内容'}：${t('syncTasks.detailVerboseSkillContent') || '该技能的源码、配置与文档'}\n` +
                `• ${t('syncTasks.detailVerboseLocation') || '位置'}：skills/${name}\n` +
                `• ${t('syncTasks.detailVerboseScope') || '范围'}：${t('syncTasks.detailVerboseScopeOnlySkills') || '仅技能，不影响 MCP 配置'}`;
            }
            return [
                t('syncTasks.detailTargetSkillPull') || '从云端下载技能', `「${name}」`,
            ].join('') + '\n' +
            `• ${t('syncTasks.detailVerboseContent') || '内容'}：${t('syncTasks.detailVerboseSkillContent') || '该技能的源码、配置与文档'}\n` +
            `• ${t('syncTasks.detailVerboseLocation') || '位置'}：skills/${name}\n` +
            `• ${t('syncTasks.detailVerboseScope') || '范围'}：${t('syncTasks.detailVerboseScopeOnlySkills') || '仅技能，不影响 MCP 配置'}`;
        }
    }
    if (task.scope === 'mcp') {
        return (isPush
            ? (t('syncTasks.detailTargetMcpPush') || '上传 MCP 配置到云端')
            : (t('syncTasks.detailTargetMcpPull') || '从云端下载 MCP 配置')) + '\n' +
            `• ${t('syncTasks.detailVerboseContent') || '内容'}：${t('syncTasks.detailVerboseMcpContent') || '~/.ai-tools/cloud/ai-tools/mcp 下的全部服务器配置'}\n` +
            `• ${t('syncTasks.detailVerboseScope') || '范围'}：${t('syncTasks.detailVerboseScopeOnlyMcp') || '仅 MCP 配置，不影响技能'}`;
    }
    if (task.scope === 'skills') {
        return (isPush
            ? (t('syncTasks.detailTargetSkillsPush') || '上传技能到云端')
            : (t('syncTasks.detailTargetSkillsPull') || '从云端下载技能')) + '\n' +
            `• ${t('syncTasks.detailVerboseContent') || '内容'}：${t('syncTasks.detailVerboseSkillsContent') || '~/.ai-tools/cloud/ai-tools/skills 目录（源码 + 配置 + 文档）'}\n` +
            `• ${t('syncTasks.detailVerboseScope') || '范围'}：${t('syncTasks.detailVerboseScopeOnlySkills') || '仅技能，不影响 MCP 配置'}`;
    }
    // 兼容旧任务（无 scope）：全量
    return (isPush
        ? (t('syncTasks.detailTargetAllPush') || '上传全部 MCP 配置与技能到云端')
        : (t('syncTasks.detailTargetAllPull') || '从云端下载全部 MCP 配置与技能')) + '\n' +
        `• ${t('syncTasks.detailVerboseContent') || '内容'}：${t('syncTasks.detailVerboseAllContent') || 'MCP 配置与技能目录'}\n` +
        `• ${t('syncTasks.detailVerboseScope') || '范围'}：${t('syncTasks.detailVerboseScopeAll') || 'MCP 配置 + 技能'}`;
}

/** 由云端配置拼接一个简洁的「目标云端」描述，用于详情弹框 */
function describeCloudTarget(cfg: CloudSyncConfig): string {
    if (!cfg) return '';
    if (cfg.provider === 'sftp') {
        const {host, port, username} = cfg.sftp;
        if (!host) return '';
        return `SFTP · ${username || '?'}@${host}:${port || 22}`;
    }
    const {repoUrl, branch} = cfg.git;
    if (!repoUrl) return '';
    return `Git · ${repoUrl}${branch ? ` (${branch})` : ''}`;
}
