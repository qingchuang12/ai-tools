/**
 * 直连来源浏览器
 * 选中某 API 直连后，以其绑定令牌 + Base URL 搜索对应平台 skill，
 * 点击可将解析出的源安装到客户端（复用 installFromDiscovered）。
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
    type ApiConnection,
    type DirectSearchDiagnostics,
    type PlatformPageInfo,
    type PlatformSkillListItem,
    type SkillClientType,
    useElectronAPI,
} from '../lib/electron';
import {platformLabel} from '../lib/platformLabel';
import {toast} from './Toast';

/** 每页条数 */
const PAGE_SIZE = 20;

export default function PlatformConnectionBrowser({
                                                      connection,
                                                      query,
                                                  }: {
    connection?: ApiConnection;
    query: string;
}) {
    const {t} = useTranslation();
    const api = useElectronAPI();
    const [items, setItems] = useState<PlatformSkillListItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [installing, setInstalling] = useState<string | null>(null);
    const [diag, setDiag] = useState<DirectSearchDiagnostics | null>(null);
    const [unsupported, setUnsupported] = useState(false);
    const [showDiag, setShowDiag] = useState(false);
    const [page, setPage] = useState(1);
    const [pageInfo, setPageInfo] = useState<PlatformPageInfo | null>(null);
    /** 防止乱序响应覆盖新结果（快速输入 / 连续翻页时） */
    const reqSeq = useRef(0);

    // 当前来源标识（API 直连）
    const sourceId = connection?.id ?? '';
    const platformType = connection?.platformType ?? 'custom';
    const sourceName = connection?.name ?? '';

    const search = useCallback(async (id: string, q: string, p: number) => {
        const seq = ++reqSeq.current;
        setLoading(true);
        try {
            const res = await api.apiConnections.searchPlatformPaged(id, q, p, PAGE_SIZE);
            if (seq !== reqSeq.current) return; // 已有更新的请求，丢弃本次结果
            setItems(res.items);
            setPageInfo(res.pageInfo);
            setUnsupported(!!res.unsupported);
            // 无结果时取回主进程记录的端点探测链路，向用户解释具体原因
            if (res.items.length === 0) {
                const d = await api.apiConnections.searchDiagnostics(id).catch(() => null);
                if (seq !== reqSeq.current) return;
                setDiag(d);
                console.warn('[direct-search] no results, diagnostics =', d);
            } else {
                setDiag(null);
            }
        } catch (e: any) {
            if (seq !== reqSeq.current) return;
            console.error('search platform failed', e);
            toast.error(e?.message || t('platformBrowser.searchFailed'));
            setItems([]);
            setPageInfo(null);
            const d = await api.apiConnections.searchDiagnostics(id).catch(() => null);
            if (seq === reqSeq.current) setDiag(d);
        } finally {
            if (seq === reqSeq.current) setLoading(false);
        }
    }, [api, connection]);

    // 关键词或来源变化时回到第 1 页，避免停留在越界页导致空列表
    useEffect(() => {
        setPage(1);
    }, [query, sourceId]);

    useEffect(() => {
        // 首页/输入中做防抖；翻页立即请求（用户已明确点击）
        const delay = page === 1 ? 400 : 0;
        const timer = setTimeout(() => search(sourceId, query, page), delay);
        return () => clearTimeout(timer);
    }, [query, page, sourceId, search]);

    const goToPage = useCallback((p: number) => {
        if (p < 1) return;
        setPage(p);
    }, []);

    const handleAdd = async (item: PlatformSkillListItem) => {
        setInstalling(item.id);
        try {
            const resolved: any = await api.apiConnections.resolveSkill(connection!.id, item.sourceUrl);
            if (!resolved?.success || !resolved.skills?.length) {
                toast.error(resolved?.error || t('platformBrowser.resolveFailed'));
                return;
            }
            const clients = (await api.clients.getAll())
                // 安装目标 = 已安装且支持 Skills 的客户端。supportsSkills 由主进程
                // SKILL_SUPPORTED_CLIENTS 派生（单一真源），彻底取代此前的 renderer 硬编码列表，
                // 杜绝主进程加新客户端后两处漂移。cloud 是云同步暂存区，不作为安装目标。
                .filter(c => c.supportsSkills && c.id !== 'cloud' && c.installed)
                .map(c => c.id as SkillClientType);
            if (clients.length === 0) {
                toast.error(t('platformBrowser.noClientInstalled'));
                return;
            }
            const r = await api.skills.installFromDiscovered(resolved.skills[0], clients);
            if (r.success) toast.success(t('platformBrowser.installedSuccess', {name: item.name}));
            else toast.error(r.error || t('platformBrowser.installFailed'));
        } catch (e: any) {
            toast.error(e?.message || t('platformBrowser.installFailed'));
        } finally {
            setInstalling(null);
        }
    };

    return (
        <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
        <span className="text-[12px] text-[var(--color-muted2)]">
          {t('platformBrowser.directSource')}：<span className="text-[var(--color-text)]">{sourceName}</span>
          <span
              className="ms-1 px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)] text-[12px]">{platformLabel(t, platformType)}</span>
        </span>
                {query && (
                    <span className="text-[12px] text-[var(--color-muted)]">{t('platformBrowser.keywords')}：<span className="text-[var(--color-muted2)]">{query}</span></span>
                )}
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-10">
                    <div className="w-7 h-7 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin"/>
                </div>
            ) : items.length === 0 ? (
                <div className="py-8 px-4 text-center">
                    <div
                        className={`w-10 h-10 mx-auto mb-3 rounded-full flex items-center justify-center ${unsupported ? 'bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)]' : 'bg-[color-mix(in_srgb,var(--color-warning)_15%,transparent)]'}`}>
                        <span
                            className={`text-[18px] leading-none ${unsupported ? 'text-[var(--color-accent)]' : 'text-[var(--color-warning)]'}`}>!</span>
                    </div>
                    <p className="text-[12px] text-[var(--color-muted2)] max-w-md mx-auto">
                        {unsupported
                            ? t('platformBrowser.spaUnsupported', {name: sourceName})
                            : (diag?.hint || (page > 1 ? t('platformBrowser.noMoreOnPage', {page}) : t('platformBrowser.noResults')))}
                    </p>

                    {page > 1 && (
                        <button
                            onClick={() => goToPage(1)}
                            className="mt-3 px-2.5 py-1 rounded bg-[var(--color-accent)] text-white text-[12px] font-medium hover:bg-[color-mix(in_srgb,var(--color-accent)_90%,transparent)] cursor-pointer transition-colors"
                        >
                            {t('platformBrowser.backToFirstPage')}
                        </button>
                    )}

                    {diag && diag.attempts.length > 0 && (
                        <>
                            <button
                                onClick={() => setShowDiag(v => !v)}
                                className="mt-3 text-[12px] text-[var(--color-accent)] hover:underline cursor-pointer"
                            >
                                {showDiag ? t('platformBrowser.collapseChain') : t('platformBrowser.expandChain', {count: diag.attempts.length, ms: diag.totalDurationMs})}
                            </button>

                            {showDiag && (
                                <div
                                    className="mt-3 text-start rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] overflow-hidden">
                                    <div className="px-3 py-2 border-b border-[var(--color-border)] text-[12px] text-[var(--color-muted)]">
                                        {t('platformBrowser.platform')} {diag.platform} · Base {diag.baseUrl} ·
                                        {t('platformBrowser.token')} {diag.authorized ? t('platformBrowser.attached') : t('platformBrowser.notAttached')}
                                    </div>
                                    {diag.attempts.map((a, i) => (
                                        <div key={i} className="px-3 py-2 border-b border-[var(--color-border)] last:border-0">
                                            <div className="flex items-start gap-2">
                                                <span
                                                    className={a.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}>{a.ok ? '✓' : '✗'}</span>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-[12px] text-[var(--color-muted2)] break-all">{a.url}</div>
                                                    <div className="text-[12px] text-[var(--color-muted)] mt-0.5">
                                                        {a.status ? `HTTP ${a.status}` : a.errorCode || '—'}
                                                        {a.contentType ? ` · ${a.contentType.split(';')[0]}` : ''}
                                                        {typeof a.bytes === 'number' ? ` · ${a.bytes}B` : ''}
                                                        {` · ${a.durationMs}ms`}
                                                        {a.reason ? ` · ${a.reason}` : ''}
                                                    </div>
                                                    {a.message && (
                                                        <div
                                                            className="text-[12px] text-[var(--color-warning)] mt-0.5">{a.message}</div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-3">
                        {items.map(it => (
                            <div key={it.id} className="p-3 rounded-md bg-[var(--color-surface-hover)]/40">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <h4 className="text-[12px] font-medium text-[var(--color-text)] truncate">{it.name}</h4>
                                        <p className="text-[12px] text-[var(--color-muted2)] mt-1 line-clamp-2">{it.description}</p>
                                    </div>
                                </div>
                                <div className="flex items-center justify-between mt-3">
                                    <span
                                        className="text-[12px] text-[var(--color-muted)] truncate max-w-[60%]">{it.sourceUrl}</span>
                                    <button
                                        disabled={installing === it.id}
                                        onClick={() => handleAdd(it)}
                                        className="px-2.5 py-1 rounded bg-[var(--color-accent)] text-white text-[12px] font-medium hover:bg-[color-mix(in_srgb,var(--color-accent)_90%,transparent)] transition-colors disabled:opacity-50"
                                    >
                                        {installing === it.id ? t('platformBrowser.installing') : t('platformBrowser.add')}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* 分页：有 total 时显示精确页码，否则按 hasMore 提供上一页/下一页 */}
                    {pageInfo && (pageInfo.hasMore || page > 1) && (
                        <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--color-border)]">
            <span className="text-[12px] text-[var(--color-muted)]">
              {pageInfo.total !== null
                  ? `${(page - 1) * pageInfo.pageSize + 1}-${(page - 1) * pageInfo.pageSize + items.length} / ${pageInfo.total}`
                  : t('platformBrowser.pageInfo', {page, count: items.length})}
            </span>

                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => goToPage(page - 1)}
                                    disabled={page === 1 || loading}
                                    className="p-1 rounded text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--color-muted2)] disabled:cursor-not-allowed cursor-pointer transition-colors"
                                    aria-label={t('pagination.previous')}
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                         strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M15.75 19.5L8.25 12l7.5-7.5"/>
                                    </svg>
                                </button>

                                <span className="text-[12px] text-[var(--color-muted2)] min-w-[60px] text-center">
                {pageInfo.totalPages !== null ? `${page} / ${pageInfo.totalPages}` : `${page}`}
              </span>

                                <button
                                    onClick={() => goToPage(page + 1)}
                                    disabled={!pageInfo.hasMore || loading}
                                    className="p-1 rounded text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--color-muted2)] disabled:cursor-not-allowed cursor-pointer transition-colors"
                                    aria-label={t('pagination.next')}
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                         strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M8.25 4.5l7.5 7.5-7.5 7.5"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
