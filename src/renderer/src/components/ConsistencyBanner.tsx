/**
 * 云端一致性 banner（plan-3.0）
 *
 * 进入「我的库」/ 云端 pull 完成后主动检测不一致项，在页面顶部展示：摘要 + 可折叠明细。
 * 明细按类型分组（Skill 组与 MCP Server 组互不混排），每项操作：
 * - 本地 vs 云端类（local_newer / cloud_newer / diverged）：「对照」「覆盖本地」「覆盖云端」；
 * - 本地互不一致（local_diverged）：「对照」「统一同步」（以最新版本覆盖其余已安装客户端）。
 * 内容完全相同（仅时间戳差异）与仅单侧存在的条目均为静默，不展示。一致时整体不渲染。
 */

import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {type ConsistencyItem, type ConsistencyReport} from '../lib/electron';

// 仅两侧都存在或本地互不一致的项会出现在报告里，映射只保留实际发生的判定。
const RESOLUTION_LABEL: Partial<Record<ConsistencyItem['resolution'], string>> = {
    local_newer: 'consistency.localNewer',
    cloud_newer: 'consistency.cloudNewer',
    diverged: 'consistency.diverged',
    local_diverged: 'consistency.localDiverged',
};

const RESOLUTION_COLOR: Partial<Record<ConsistencyItem['resolution'], string>> = {
    local_newer: 'text-[var(--color-success)] bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)]',
    cloud_newer: 'text-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)]',
    diverged: 'text-[var(--color-muted2)] bg-[var(--color-surface-hover)]',
    // 分叉态用紫色做三源区分编码（无对应语义令牌，保留调色板色）
    local_diverged: 'text-purple-400 bg-purple-400/10',
};

function formatTime(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString() : '—';
}

export default function ConsistencyBanner({
    report,
    resolvingKey,
    clientName,
    onCompare,
    onResolve,
    onRefresh,
}: {
    report: ConsistencyReport | null;
    /** 正在执行操作的条目 key（`${kind}:${name}`），按钮转圈/禁用防重复点击 */
    resolvingKey: string | null;
    /** 客户端 id → 显示名（由 Library 注入，与页面其余展示口径一致） */
    clientName: (id: string) => string;
    onCompare: (item: ConsistencyItem) => void;
    /** direction：upload = 覆盖云端；download = 覆盖本地；unify = 本地互不一致时以最新统一 */
    onResolve: (item: ConsistencyItem, direction: 'upload' | 'download' | 'unify') => void;
    onRefresh: () => void;
}) {
    const {t} = useTranslation();
    const [expanded, setExpanded] = useState(false);

    if (!report || report.items.length === 0) return null;

    const skillCount = report.items.filter(i => i.kind === 'skill').length;
    const serverCount = report.items.filter(i => i.kind === 'server').length;

    /** 单个条目行 */
    const renderItem = (item: ConsistencyItem) => {
        const key = `${item.kind}:${item.name}`;
        const resolving = resolvingKey === key;
        const isLocalDiverged = item.resolution === 'local_diverged';
        return (
            <div key={key}
                 className="flex items-center gap-2.5 px-2 py-1.5 rounded-md bg-[var(--color-surface-hover)]/30">
                <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-[var(--color-text)] font-medium truncate">
                        {item.name}
                    </div>
                    <div className="text-[10.5px] text-[var(--color-muted2)] truncate">
                        {isLocalDiverged && item.localDetails
                            // 本地互不一致：逐客户端展示时间（用户反馈修正⑥）
                            ? item.localDetails
                                .map(d => `${clientName(d.client)}：${formatTime(d.updatedAt)}`)
                                .join('  ·  ')
                            : (
                                <>
                                    {t('consistency.localTime') || '本地'}：{formatTime(item.localUpdatedAt)}
                                    {'  ·  '}
                                    {t('consistency.cloudTime') || '云端'}：{formatTime(item.cloudUpdatedAt)}
                                    {item.localClients.length > 0 && (
                                        <span className="ms-1">（{item.localClients.map(clientName).join('、')}）</span>
                                    )}
                                </>
                            )}
                    </div>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${RESOLUTION_COLOR[item.resolution] || ''}`}>
                    {t(RESOLUTION_LABEL[item.resolution] || '')}
                </span>
                <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                        onClick={() => onCompare(item)}
                        className="text-[11px] px-2 py-0.5 rounded text-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] transition-colors"
                    >
                        {t('consistency.compare') || '对照'}
                    </button>
                    {isLocalDiverged ? (
                        <button
                            onClick={() => onResolve(item, 'unify')}
                            disabled={resolving}
                            title={t('consistency.unifySyncTitle') || '以最新时间和版本统一覆盖其他所有已安装客户端'}
                            className="text-[11px] px-2 py-0.5 rounded text-purple-400 hover:bg-purple-400/10 transition-colors disabled:opacity-50"
                        >
                            {resolving ? '…' : (t('consistency.unifySync') || '统一同步')}
                        </button>
                    ) : (
                        <>
                            <button
                                onClick={() => onResolve(item, 'download')}
                                disabled={resolving}
                                title={t('consistency.overwriteLocalTitle') || '用云端版本覆盖所有已安装客户端'}
                                className="text-[11px] px-2 py-0.5 rounded text-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] transition-colors disabled:opacity-50"
                            >
                                {resolving ? '…' : (t('consistency.overwriteLocal') || '覆盖本地')}
                            </button>
                            <button
                                onClick={() => onResolve(item, 'upload')}
                                disabled={resolving}
                                title={t('consistency.overwriteCloudTitle') || '用本地版本覆盖云端'}
                                className="text-[11px] px-2 py-0.5 rounded text-[var(--color-success)] hover:bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)] transition-colors disabled:opacity-50"
                            >
                                {resolving ? '…' : (t('consistency.overwriteCloud') || '覆盖云端')}
                            </button>
                        </>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_5%,transparent)] mb-3 overflow-hidden">
            {/* 摘要行 */}
            <div className="flex items-center gap-2 px-3 py-2">
        <span className="w-5 h-5 rounded-full bg-[color-mix(in_srgb,var(--color-warning)_15%,transparent)] text-[var(--color-warning)] flex items-center justify-center flex-shrink-0 text-[13px]">
            !
        </span>
                <span className="text-[12.5px] text-[var(--color-text)] flex-1 min-w-0 truncate">
            {t('consistency.bannerTitle', {count: report.items.length})
                || `云端与本地有 ${report.items.length} 项不一致`}
                    <span className="text-[var(--color-muted)] ms-1.5">
                （{([
                            skillCount > 0 ? (t('consistency.skillCount', {count: skillCount}) || `${skillCount} 个 Skill`) : null,
                            serverCount > 0 ? (t('consistency.serverCount', {count: serverCount}) || `${serverCount} 个 MCP Server`) : null,
                        ].filter(Boolean) as string[]).join(' · ')}）
            </span>
        </span>
                <button
                    onClick={onRefresh}
                    className="p-1 rounded text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
                    title={t('consistency.recheck') || '重新检测'}
                >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                         strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round"
                              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
                    </svg>
                </button>
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="text-[12px] text-[var(--color-warning)] hover:underline flex-shrink-0"
                >
                    {expanded
                        ? (t('consistency.collapse') || '收起')
                        : (t('consistency.expand') || '查看明细')}
                </button>
            </div>

            {/* 明细：Skill 与 MCP 分组展示，互不混排（用户反馈） */}
            {expanded && (
                <div className="border-t border-[color-mix(in_srgb,var(--color-warning)_20%,transparent)] px-3 py-2 max-h-[320px] overflow-y-auto space-y-2">
                    {skillCount > 0 && (
                        <div>
                            <div className="text-[10.5px] font-semibold text-[color-mix(in_srgb,var(--color-text)_80%,transparent)] mb-1 px-1">
                                {t('consistency.skillsGroup', {count: skillCount}) || `Skills（${skillCount}）`}
                            </div>
                            <div className="space-y-1.5">
                                {report.items.filter(i => i.kind === 'skill').map(renderItem)}
                            </div>
                        </div>
                    )}
                    {serverCount > 0 && (
                        <div>
                            <div className="text-[10.5px] font-semibold text-[color-mix(in_srgb,var(--color-text)_80%,transparent)] mb-1 px-1">
                                {t('consistency.serversGroup', {count: serverCount}) || `MCP Servers（${serverCount}）`}
                            </div>
                            <div className="space-y-1.5">
                                {report.items.filter(i => i.kind === 'server').map(renderItem)}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}