/**
 * 商店页面 - 编排容器
 * 支持 MCP Servers 和 Skills 双资源类型，网格布局
 * 数据查询收口到 hooks，本文件只负责状态编排与子组件渲染
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {flushSync} from 'react-dom';
import {useTranslation} from 'react-i18next';
import {useStore} from '../store/useStore';
import {useElectronAPI} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import Pagination from '../components/Pagination';
import {toast} from '../components/Toast';
import {useStoreSourceSelection} from '../hooks/useStoreSourceSelection';
import {useStoreData} from '../hooks/useStoreData';
import {useStoreFacets} from '../hooks/useStoreFacets';
import {useDebouncedValue} from '../hooks/useDebouncedValue';
import {useStoreAttribution} from '../hooks/useStoreAttribution';
import StoreToolbar from '../components/store/StoreToolbar';
import StoreFilterBar from '../components/store/StoreFilterBar';
import StoreGrid from '../components/store/StoreGrid';
import StoreEmptyState from '../components/store/StoreEmptyState';
import StoreErrorState from '../components/store/StoreErrorState';

export default function StorePage() {
  const { t } = useTranslation();
  const api = useElectronAPI();
  const isMac = useIsMac();

  const {
    resourceType,
    setResourceType,
    searchQuery,
    setSearchQuery,
    currentPage,
    setCurrentPage,
    pageSize,
    setPageSize,
    installedServerIds,
    setInstalledServerIds,
    installedSkillIds,
    setInstalledSkillIds,
    storeCategory: category,
    setStoreCategory: setCategory,
    storeSort: sort,
    setStoreSort: setSort,
    storeSourceFilter: sourceFilter,
    setStoreSourceFilter: setSourceFilter,
  } = useStore();

  const [isForceRefreshing, setIsForceRefreshing] = useState(false);

  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const source = useStoreSourceSelection();

  const selectedMcpConn = source.mcpSources.find(c => c.id === source.mcpConnId) || null;

  // S1-13: 平台源（如 ModelScope）受「页码 × 每页条数 ≤ 100」配额限制，100 条/页翻到第 2 页必触发配额空态；
  // 平台源上限 50 条/页，内置源（smithery）才放开到 100。
  const isPlatformSource = !!source.mcpConnId || source.isDirectSkillSource;
  const pageSizeOptions = isPlatformSource ? [10, 20, 50] : [10, 20, 50, 100];

  // 仅在「切换资源类型 / 切换源」时把筛选项重置为默认；挂载/返回不重置。
  // 用「源快照比较」而非单次布尔标志：React.StrictMode 开发模式会双执行 effect，
  // 单布尔标志首次执行就被置 false，第二次执行不再 return，把分类冲成 'all'，
  // 表现为「进详情返回后分类变回全部」。快照比较下挂载时 deps===快照，永不触发重置。
  const prevSource = useRef({resourceType, mcpConnId: source.mcpConnId, selectedSkillSourceId: source.selectedSkillSourceId});
  useEffect(() => {
    const changed =
      prevSource.current.resourceType !== resourceType ||
      prevSource.current.mcpConnId !== source.mcpConnId ||
      prevSource.current.selectedSkillSourceId !== source.selectedSkillSourceId;
    prevSource.current = {resourceType, mcpConnId: source.mcpConnId, selectedSkillSourceId: source.selectedSkillSourceId};
    if (!changed) return;
    setCategory('all');
    setSort('relevance');
    setSourceFilter('all');
  }, [resourceType, source.mcpConnId, source.selectedSkillSourceId]);

  const data = useStoreData({
    resourceType,
    mcpConnId: source.mcpConnId,
    dataSource: source.dataSource,
    mcpPlatformType: selectedMcpConn?.platformType ?? undefined,
    selectedConn: source.selectedConn,
    isDirectSkillSource: source.isDirectSkillSource,
    selectedSkillSourceId: source.selectedSkillSourceId,
    page: currentPage,
    pageSize,
    debouncedSearch,
    category,
    sort,
    source: sourceFilter,
    // S0-4: 强制刷新时透传，使 Skills 内置源绕过磁盘缓存拉取最新
    forceRefresh: isForceRefreshing,
  });

  const facets = useStoreFacets({
    resourceType,
    mcpConnId: source.mcpConnId,
    // S0-1: 传 MCP 连接的 platformType，而非 Skill 源连接，避免分类面取错
    mcpPlatformType: selectedMcpConn?.platformType ?? null,
    selectedConn: source.selectedConn,
    isDirectSkillSource: source.isDirectSkillSource,
    dataSource: source.dataSource,
  });

  useEffect(() => {
    // S0-5: 切源（含 MCP 连接 / Skill 源切换）或改变每页条数时重置到第一页，
    // 避免停留越界页（如旧源第 5 页、新源仅 1 页；或改小每页条数后页码超出新总页数）。
    // S1-13: 切到平台源时若当前每页条数超过其上限（50），先收敛，避免配额空态。
    const maxPageSize = isPlatformSource ? 50 : 100;
    if (pageSize > maxPageSize) {
      setPageSize(maxPageSize);
      return;
    }
    setCurrentPage(1);
  }, [resourceType, source.mcpConnId, source.selectedSkillSourceId, source.isDirectSkillSource, pageSize, isPlatformSource, setCurrentPage, setPageSize]);

  useEffect(() => {
    setCurrentPage(1);
  }, [category, sort, sourceFilter, debouncedSearch, setCurrentPage]);

  // S0-7: 已安装状态需在返回商店 / 窗口聚焦时刷新（详情页安装/卸载后徽章才更新）
  // S0-8: 两个请求都加 .catch，避免失败时 unhandled rejection 导致徽章静默失效
  useEffect(() => {
    const refreshInstalled = () => {
      api.config.getAllServers()
        .then(({ servers }) => setInstalledServerIds(Object.keys(servers)))
        .catch(() => {});
      api.skills.getAllInstalled()
        .then(({ skills }) => setInstalledSkillIds(Object.keys(skills)))
        .catch(() => {});
    };
    refreshInstalled();
    window.addEventListener('focus', refreshInstalled);
    window.addEventListener('hashchange', refreshInstalled);
    return () => {
      window.removeEventListener('focus', refreshInstalled);
      window.removeEventListener('hashchange', refreshInstalled);
    };
  }, [api, setInstalledServerIds, setInstalledSkillIds]);

  const handleForceRefresh = useCallback(async () => {
    // S0-4: 强制刷新需先把 isForceRefreshing 同步提交到渲染，底层数据 hook 才能读到 noCache=true
    flushSync(() => setIsForceRefreshing(true));
    try {
      await data.refetch();
      toast.success(t('store.refreshSuccess', {defaultValue: 'Data refreshed'}));
    } catch {
      toast.error(t('store.refreshFailed', {defaultValue: 'Failed to refresh data'}));
    } finally {
      setIsForceRefreshing(false);
    }
  }, [data, t]);

  const handleRetry = useCallback(async () => {
    try {
      await data.refetch();
      toast.success(t('store.retrySuccess', {defaultValue: 'Data loaded successfully'}));
    } catch {
      toast.error(t('store.retryFailed', {defaultValue: 'Failed to load data'}));
    }
  }, [data, t]);

  const attributionText = useStoreAttribution({
    resourceType,
    selectedMcpConn,
    selectedConn: source.selectedConn,
  });

  const handleMcpSourceChange = useCallback((sourceId: string) => {
    const src = source.mcpSources.find(c => c.id === sourceId);
    if (!src) return;
    if (src.platformType === 'smithery') {
      source.setDataSource(src.platformType);
      source.setMcpConnId(null);
    } else {
      source.setMcpConnId(src.id);
    }
  }, [source]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      <StoreToolbar
        isMac={isMac}
        resourceType={resourceType}
        displayTotal={data.totalItems}
        searchQuery={searchQuery}
        dataSource={source.dataSource}
        mcpSources={source.mcpSources}
        selectedMcpSourceId={source.selectedMcpSourceId}
        selectedMcpConn={selectedMcpConn}
        connections={source.connections}
        selectedSkillSourceId={source.selectedSkillSourceId}
        isForceRefreshing={isForceRefreshing}
        isLoading={data.isLoading}
        isFetching={data.isFetching}
        categories={facets?.categories ?? []}
        category={category}
        onCategoryChange={setCategory}
        onResourceTypeChange={setResourceType}
        onSearchQueryChange={setSearchQuery}
        onMcpSourceChange={handleMcpSourceChange}
        onSkillSourceChange={source.setSelectedSkillSourceId}
        onForceRefresh={handleForceRefresh}
        onPageReset={() => setCurrentPage(1)}
      />

      <div className="flex-1 overflow-y-auto">
        {/* 翻页时 react-query 保留上一页数据作占位（keepPreviousData），若不给可见反馈，
            用户点击翻页后会看到「内容没变化」。用顶部进度条表明请求正在进行。 */}
        {data.isFetching && data.items.length > 0 && (
          <div className="h-[2px] w-full bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] overflow-hidden">
            <div className="h-full w-1/3 bg-[var(--color-accent)] animate-pulse" />
          </div>
        )}

        <StoreFilterBar
          facets={facets}
          sort={sort}
          sourceFilter={sourceFilter}
          onSortChange={setSort}
          onSourceFilterChange={setSourceFilter}
          onClearFilters={() => { setCategory('all'); setSort('relevance'); setSourceFilter('all'); }}
        />

        {data.isLoading && data.items.length === 0 ? (
          <LoadingSpinner />
        ) : data.error ? (
          <StoreErrorState onRetry={handleRetry} />
        ) : data.items.length === 0 ? (
          <StoreEmptyState
            resourceType={resourceType}
            friendlyMessage={data.message ?? null}
            isUnsupported={data.isUnsupported}
            connectionsCount={source.connections.length}
            mcpConnId={source.mcpConnId}
            connName={source.selectedConn?.name || null}
            onRetry={handleRetry}
          />
        ) : (
          <StoreGrid
            resourceType={resourceType}
            items={data.items}
            dataSource={source.dataSource}
            installedServerIds={installedServerIds}
            installedSkillIds={installedSkillIds}
            mcpConnId={source.mcpConnId}
            isDirectSkillSource={source.isDirectSkillSource}
            selectedSkillSourceId={source.selectedSkillSourceId}
          />
        )}
      </div>

      {/* 空结果但带提示（如页码越界）时也保留分页器，否则用户无法点回有效页 */}
      {!data.isLoading && !data.error && (data.items.length > 0 || !!data.message) && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
          <span className="text-[12px] text-[var(--color-muted)] truncate">
            {attributionText}
          </span>
          <div className="flex items-center gap-3 shrink-0">
            <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted2)] whitespace-nowrap">
              {t('store.pageSize', {defaultValue: '每页'})}
              <select
                value={pageSize}
                onChange={e => setPageSize(Number(e.target.value))}
                className="px-1.5 py-0.5 rounded-md text-[12px] bg-[var(--color-surface-hover)] text-[var(--color-text)] border border-[var(--color-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              >
                {pageSizeOptions.map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              {t('store.items', {defaultValue: '条'})}
            </label>
            <Pagination
              currentPage={currentPage}
              totalPages={data.totalPages}
              totalItems={data.totalItems}
              startIndex={data.startIndex}
              endIndex={data.endIndex}
              onPageChange={setCurrentPage}
              canJump={data.total !== null}
              hasMore={data.hasMore}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function LoadingSpinner() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin mb-3" />
      <p className="text-[13px] text-[var(--color-muted2)]">{t('store.loading')}</p>
    </div>
  );
}
