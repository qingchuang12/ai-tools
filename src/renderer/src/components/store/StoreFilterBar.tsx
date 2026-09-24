import {useTranslation} from 'react-i18next';
import type {PlatformFacets} from '../../lib/electron';
import {hasActiveStoreFilters, resolveSortDisplayValue} from '../../lib/store-filters';

interface StoreFilterBarProps {
  facets: PlatformFacets | null;
  sort: string;
  sourceFilter: string;
  onSortChange: (id: string) => void;
  onSourceFilterChange: (id: string) => void;
  onClearFilters: () => void;
}

export default function StoreFilterBar({
  facets,
  sort,
  sourceFilter,
  onSortChange,
  onSourceFilterChange,
  onClearFilters,
}: StoreFilterBarProps) {
  const { t } = useTranslation();

  // 排序与来源过滤都没有可选项时，第二栏整体隐藏
  if (!facets) {
    return null;
  }

  const hasSort = facets.sortOptions.length > 0;
  const hasSourceFilter = !!(facets.sourceFilter && facets.sourceFilter.length > 0);

  if (!hasSort && !hasSourceFilter) {
    return null;
  }

  // 当前 sort 值可能不属于该源的选项集：应用层默认 id 是 'relevance'，而部分源并无此排序
  // （SkillsMP 只有 stars/updated；Coze、百炼同理）。此时受控 <select> 的 value 匹配不到任何
  // <option>，React 会告警且下拉显示为空白。这里仅在**显示层**回退到首个选项，不改写 sort 状态，
  // 故请求语义不变（未知值由各 adapter 自行解释为「默认序」）。
  const sortValue = resolveSortDisplayValue(sort, facets.sortOptions);

  // 「未筛选」基准 = 排序处于该源默认选项（sortOptions[0]，与上方显示值一致）：
  // 硬编码 'relevance' 会让用户在无 relevance 的源上选回首选项时误判为「有筛选」，
  // 清除按钮常驻（详见 lib/store-filters.ts 头注释）。
  const hasActiveFilters = hasActiveStoreFilters(sort, facets.sortOptions, sourceFilter);

  return (
    <div className="px-4 pt-3 pb-2 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_60%,transparent)] backdrop-blur-sm">
      <div className="flex items-center gap-2">
        {hasSort && (
          <>
            <span className="text-[12px] text-[var(--color-muted)] shrink-0">{t('store.sort')}</span>
            <select
              value={sortValue}
              onChange={e => onSortChange(e.target.value)}
              aria-label={t('store.sortLabel', {defaultValue: 'Sort by'})}
              className="px-2 py-0.5 rounded-md text-[12px] bg-[var(--color-surface-hover)] text-[var(--color-text)] border border-[var(--color-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            >
              {facets.sortOptions.map(o => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </>
        )}

        {facets.sourceFilter && facets.sourceFilter.length > 0 && (
          <>
            <span className="text-[12px] text-[var(--color-muted)] shrink-0 ms-2">{t('store.source')}</span>
            <select
              value={sourceFilter}
              onChange={e => onSourceFilterChange(e.target.value)}
              aria-label={t('store.sourceFilterLabel', {defaultValue: 'Filter by source'})}
              className="px-2 py-0.5 rounded-md text-[12px] bg-[var(--color-surface-hover)] text-[var(--color-text)] border border-[var(--color-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            >
              <option value="all">{t('store.allSources')}</option>
              {facets.sourceFilter.map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.count != null ? ` (${s.count})` : ''}</option>
              ))}
            </select>
          </>
        )}

        {hasActiveFilters && (
          <button
            onClick={onClearFilters}
            className="ms-auto text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-accent)] transition-colors"
          >
            {t('store.clearFilters')}
          </button>
        )}
      </div>
    </div>
  );
}
