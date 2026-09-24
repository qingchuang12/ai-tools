/**
 * 云端一致性对照弹窗（plan-3.0）
 *
 * 左右并排展示同一 Skill（SKILL.md）或 MCP Server（JSON 配置）的本地版与云端版，
 * 逐行比对：相同行淡化，差异行高亮。比对为「行号对齐」而非 LCS——插入/删除行
 * 会导致后续行整体错位高亮，恰好向用户暴露「这里发生了结构性改动」，足够直观。
 *
 * 窗口规格（用户反馈后调整）：
 * - 默认 xl 宽幅（1024px），两栏各约 500px，代码/JSON 可读；
 * - 「全面显示」切换近全屏（95vw）并拉高内容区，适合长 SKILL.md 逐屏对照。
 *
 * 本地多客户端说明（用户反馈后调整）：
 * - 读取每个持有该条目的本地客户端内容做一致性判断；
 * - 全部一致 → 顶部注明「本地 N 个客户端（名单）内容一致，以下为共同版本」；
 * - 存在差异 → 顶部注明「本地客户端内容不一致，以下显示 X 的版本」。
 */

import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {type ConsistencyItem, useElectronAPI} from '../lib/electron';
import Modal from './Modal';

interface CompareRow {
    left: string;
    right: string;
    same: boolean;
}

function buildRows(local: string | null, cloud: string | null): CompareRow[] {
    const leftLines = (local ?? '').split('\n');
    const rightLines = (cloud ?? '').split('\n');
    const rows: CompareRow[] = [];
    const max = Math.max(leftLines.length, rightLines.length);
    for (let i = 0; i < max; i++) {
        const l = leftLines[i] ?? '';
        const r = rightLines[i] ?? '';
        rows.push({left: l, right: r, same: l === r});
    }
    return rows;
}

export default function ConsistencyCompareModal({
    item,
    clientName,
    onClose,
}: {
    item: ConsistencyItem | null;
    /** 客户端 id → 显示名（由 Library 注入） */
    clientName: (id: string) => string;
    onClose: () => void;
}) {
    const {t} = useTranslation();
    const api = useElectronAPI();
    const [loading, setLoading] = useState(false);
    /** 各本地客户端 → 两端内容；cloud 端同源，但逐客户端读取保持结构简单 */
    const [endsByClient, setEndsByClient] = useState<Record<string, { local: string | null; cloud: string | null }>>({});
    /** 「全面显示」模式：近全屏宽度 + 更高内容区；切换条目时回到默认尺寸 */
    const [fullView, setFullView] = useState(false);

    useEffect(() => {
        if (!item) return;
        setFullView(false);
        setLoading(true);
        setEndsByClient({});
        const clients = item.localClients;
        if (clients.length === 0) {
            // 正常情况下不会出现（仅云端存在的条目已被过滤）；防御性兜底
            setEndsByClient({});
            setLoading(false);
            return;
        }
        // 逐个客户端读取本地端内容（用于顶部「本地客户端内容是否一致」的说明）
        Promise.all(clients.map(client =>
            api.cloudSync.readEnds({kind: item.kind, name: item.name, localClient: client})
                .catch(() => ({local: null, cloud: null}))
                .then(ends => ({client, ends}))
        )).then(results => {
            const map: Record<string, { local: string | null; cloud: string | null }> = {};
            for (const r of results) map[r.client] = r.ends;
            setEndsByClient(map);
        }).finally(() => setLoading(false));
    }, [item, api]);

    if (!item) return null;

    const isLocalDiverged = item.resolution === 'local_diverged';

    // —— 对照数据源 ——
    // 常规（本地 vs 云端）：左 = 首个本地客户端内容，右 = 云端内容；
    // 本地互不一致：左 = 最新客户端内容，右 = 另一个内容不同的客户端内容（逐客户端对照）。
    const leftClient = isLocalDiverged
        ? ([...(item.localDetails || [])].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0]?.client
            || item.localClients[0])
        : item.localClients[0];
    const leftEnds = leftClient ? endsByClient[leftClient] : undefined;
    let rightClient: string | undefined;
    // 常规模式：右栏 = 云端内容（任何本地客户端读到的 cloud 都来自同一云端路径）
    let rightText: string | null = leftEnds?.cloud ?? null;
    if (isLocalDiverged && leftClient) {
        const leftContent = (leftEnds?.local ?? null) ?? '';
        rightClient = item.localClients.find(
            c => c !== leftClient && (((endsByClient[c]?.local ?? null) ?? '') !== leftContent)
        );
        rightText = rightClient ? (endsByClient[rightClient]?.local ?? null) : null;
    }

    const rows = buildRows(leftEnds?.local ?? null, rightText);
    const diffCount = rows.filter(r => !r.same).length;

    // 本地多客户端一致性：内容两两相同即「一致」（仅常规模式需要这段说明）
    const localContents = item.localClients.map(c => endsByClient[c]?.local ?? null);
    const allLocalSame = localContents.length > 1
        && localContents.slice(1).every(v => v === localContents[0]);

    // 全面显示时内容区撑得更高（Modal 自身限高 90vh + 标题行）
    const colMaxHeight = fullView ? '70vh' : '48vh';

    const formatTime = (iso: string | null) =>
        iso ? new Date(iso).toLocaleString() : '—';

    return (
        <Modal
            isOpen={!!item}
            onClose={onClose}
            size={fullView ? 'full' : 'xl'}
            title={`${t('consistency.compareTitle') || '对照查看'}：${item.name}`}
        >
            <div className="space-y-3 w-full">
                <div className="flex items-center justify-between gap-3 text-[12px] text-[var(--color-muted2)]">
                    <span className="flex items-center gap-3 flex-1 min-w-0">
                        <span className="flex-shrink-0">
                            {item.kind === 'skill' ? (t('consistency.kindSkill') || 'Skill') : (t('consistency.kindServer') || 'MCP Server')}
                            {' · '}
                            {isLocalDiverged
                                ? (t('consistency.localDivergedCompare') || '本地客户端互相对照')
                                : `${t('consistency.diffCount', {count: diffCount}) || `${diffCount} 行差异`}`}
                        </span>
                        <span className="truncate">
                            {isLocalDiverged
                                ? item.localDetails?.map(d => `${clientName(d.client)}：${formatTime(d.updatedAt)}`).join('  ·  ')
                                : (
                                    <>
                                        {t('consistency.localTime') || '本地'}：{formatTime(item.localUpdatedAt)}
                                        {'  ·  '}
                                        {t('consistency.cloudTime') || '云端'}：{formatTime(item.cloudUpdatedAt)}
                                    </>
                                )}
                        </span>
                    </span>
                    <button
                        onClick={() => setFullView(!fullView)}
                        className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] transition-colors"
                    >
                        {fullView ? (
                            <>
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5M15 15l5.25 5.25"/>
                                </svg>
                                {t('consistency.exitFullView') || '收起'}
                            </>
                        ) : (
                            <>
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"/>
                                </svg>
                                {t('consistency.fullView') || '全面显示'}
                            </>
                        )}
                    </button>
                </div>

                {/* 本地多客户端时：顶部说明「显示的是哪个客户端 / 本地客户端内容是否一致」（用户反馈）；
                    本地互不一致模式由时间明细行 + 两栏标题交代对照双方 */}
                {!isLocalDiverged && item.localClients.length > 1 && !loading && (
                    <div className="px-2.5 py-1.5 rounded-md bg-[var(--color-surface-hover)]/40 text-[11.5px] text-[var(--color-muted2)]">
                        {allLocalSame
                            ? t('consistency.localClientsSame', {
                                count: item.localClients.length,
                                clients: item.localClients.map(clientName).join('、'),
                            })
                            : t('consistency.localClientsDiffer', {
                                client: clientName(leftClient),
                                clients: item.localClients.map(clientName).join('、'),
                            })}
                    </div>
                )}

                {loading ? (
                    <div className="py-10 text-center text-[13px] text-[var(--color-muted)]">
                        {t('consistency.loading') || '读取两端内容…'}
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <div className="text-[11px] font-semibold text-[var(--color-text)] mb-1 px-1">
                                {leftClient
                                    ? clientName(leftClient)
                                    : (t('consistency.localEnd') || '本地版本')}
                            </div>
                            <div
                                className="rounded-md border border-[var(--color-border)] overflow-y-auto bg-[var(--color-bg)]"
                                style={{maxHeight: colMaxHeight}}
                            >
                                {rows.map((row, i) => (
                                    <div key={i}
                                         className={`px-2 py-px font-mono text-[11px] leading-4 whitespace-pre-wrap break-all ${
                                             row.same
                                                 ? 'text-[var(--color-muted)]'
                                                 : 'bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] text-[var(--color-text)]'
                                         }`}>
                                        {row.left || ' '}
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div>
                            <div className="text-[11px] font-semibold text-[var(--color-text)] mb-1 px-1">
                                {isLocalDiverged && rightClient
                                    ? clientName(rightClient)
                                    : (t('consistency.cloudEnd') || '云端版本')}
                            </div>
                            <div
                                className="rounded-md border border-[var(--color-border)] overflow-y-auto bg-[var(--color-bg)]"
                                style={{maxHeight: colMaxHeight}}
                            >
                                {rows.map((row, i) => (
                                    <div key={i}
                                         className={`px-2 py-px font-mono text-[11px] leading-4 whitespace-pre-wrap break-all ${
                                             row.same
                                                 ? 'text-[var(--color-muted)]'
                                                 : 'bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-text)]'
                                         }`}>
                                        {row.right || ' '}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                <div className="flex justify-end pt-1">
                    <button onClick={onClose} className="btn btn-secondary">
                        {t('common.close') || '关闭'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}