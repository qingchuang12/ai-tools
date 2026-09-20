import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router-dom';
import WindowControls from '../WindowControls';
import type {ApiConnection, CategoryNode} from '../../lib/electron';
import type {DataSource} from '../../api/registry';
import type {StoreResourceType} from '../../hooks/storeTypes';

interface StoreToolbarProps {
  isMac: boolean;
  resourceType: StoreResourceType;
  displayTotal: number;
  searchQuery: string;
  dataSource: DataSource;
  mcpSources: ApiConnection[];
  selectedMcpSourceId: string | null;
  selectedMcpConn: ApiConnection | null;
  connections: ApiConnection[];
  selectedSkillSourceId: string | null;
  isForceRefreshing: boolean;
  isLoading: boolean;
  isFetching: boolean;
  categories: CategoryNode[];
  category: string;
  onCategoryChange: (id: string) => void;
  onResourceTypeChange: (type: StoreResourceType) => void;
  onSearchQueryChange: (query: string) => void;
  onMcpSourceChange: (sourceId: string) => void;
  onSkillSourceChange: (sourceId: string | null) => void;
  onForceRefresh: () => void;
  onPageReset: () => void;
}

export default function StoreToolbar({
  isMac,
  resourceType,
  displayTotal,
  searchQuery,
  mcpSources,
  selectedMcpSourceId,
  connections,
  selectedSkillSourceId,
  isForceRefreshing,
  isLoading,
  isFetching,
  categories,
  category,
  onCategoryChange,
  onResourceTypeChange,
  onSearchQueryChange,
  onMcpSourceChange,
  onSkillSourceChange,
  onForceRefresh,
  onPageReset,
}: StoreToolbarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div
      className={`flex items-center justify-between gap-3 px-4 h-[38px] drag-region border-b border-[var(--color-border)] bg-[var(--color-bg)] sticky top-0 z-10 ${isMac ? 'ps-20' : 'pe-[140px]'}`}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden no-drag">
        <div className="flex items-center bg-[var(--color-surface-hover)] rounded-lg p-0.5 shrink-0">
          <button
            onClick={() => onResourceTypeChange('mcp')}
            className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
              resourceType === 'mcp'
                ? 'bg-[var(--color-surface-active)] text-[var(--color-text)]'
                : 'text-[var(--color-muted2)] hover:text-[var(--color-text)]'
            }`}
          >
            {t('store.mcpTab')}
          </button>
          <button
            onClick={() => onResourceTypeChange('skills')}
            className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
              resourceType === 'skills'
                ? 'bg-[var(--color-surface-active)] text-[var(--color-text)]'
                : 'text-[var(--color-muted2)] hover:text-[var(--color-text)]'
            }`}
          >
            {t('store.skillsTab')}
          </button>
        </div>

        <span className="text-[12px] text-[var(--color-muted2)] whitespace-nowrap shrink-0 tabular-nums">
          {displayTotal} {resourceType === 'mcp' ? (t('store.servers', {defaultValue: 'servers'})) : (t('store.skills', {defaultValue: 'skills'}))}
        </span>

        {resourceType === 'mcp' && (
          <select
            value={selectedMcpSourceId || ''}
            onChange={e => {
              const v = e.target.value;
              if (v === '__add__') {
                navigate('/settings');
                return;
              }
              onMcpSourceChange(v);
              onPageReset();
            }}
            className="px-2.5 py-1 rounded-full text-[12px] font-medium bg-[var(--color-accent)]/15 text-[var(--color-accent)] border border-[var(--color-accent)]/40 focus:outline-none whitespace-nowrap shrink-0"
            title={t('store.selectMcpSource')}
            aria-label={t('store.mcpSourceSelectLabel', {defaultValue: 'Select MCP source'})}
          >
            {mcpSources.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
            {mcpSources.length === 0 && (
              <option value="__add__">{t('store.addMcpSource')}</option>
            )}
          </select>
        )}

        {resourceType === 'skills' && (
          <select
            value={selectedSkillSourceId || ''}
            onChange={e => {
              const v = e.target.value;
              if (v === '__add__') {
                navigate('/settings');
                return;
              }
              onSkillSourceChange(v || null);
              onPageReset();
            }}
            className="px-2.5 py-1 rounded-full text-[12px] font-medium bg-[var(--color-accent)]/15 text-[var(--color-accent)] border border-[var(--color-accent)]/40 focus:outline-none whitespace-nowrap shrink-0"
            title={t('store.selectSkillSource')}
            aria-label={t('store.skillSourceSelectLabel', {defaultValue: 'Select Skills source'})}
          >
            {connections.map(c => (
              <option key={c.id} value={c.id}>{c.name}{c.isDefault ? t('store.defaultLabel') : ''}</option>
            ))}
            {connections.length === 0 && (
              <option value="__add__">{t('store.addSkillSource')}</option>
            )}
          </select>
        )}

        <button
          onClick={onForceRefresh}
          disabled={isForceRefreshing || isLoading || isFetching}
          className="p-1.5 rounded-md text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50 shrink-0"
          title={t('store.forceRefresh', {defaultValue: 'Force refresh data'})}
        >
          <svg
            className={`w-3.5 h-3.5 ${isForceRefreshing ? 'animate-spin' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
        </button>
      </div>

      <div className="flex items-center gap-2 shrink-0 no-drag">
        {categories.length > 0 && (
          <select
            value={category}
            onChange={e => onCategoryChange(e.target.value)}
            aria-label={t('store.categoryLabel', {defaultValue: 'Category'})}
            title={t('store.categoryLabel', {defaultValue: 'Category'})}
            className="px-2.5 py-1.5 rounded-lg text-[13px] bg-[var(--color-surface-hover)] text-[var(--color-text)] border border-[var(--color-border)] focus:outline-none focus:ring-1 focus:ring-[#0a84ff] max-w-[180px] truncate"
          >
            <option value="all">{t('store.allCategories')}</option>
            {categories.map(c =>
              /* 两级分类（如 SkillsMP 的 12 父域 + 63 叶）：父节点只作分组标签，用 <optgroup> 呈现、
                 自身不可选中 —— 上游只接受叶子 slug，把父域值发出去会 400（plan-13.0 F-d）。 */
              c.children && c.children.length > 0 ? (
                <optgroup key={c.id} label={c.name}>
                  {c.children.map(s => (
                    <option key={s.id} value={s.id}>{s.name}{s.count != null ? ` (${s.count})` : ''}</option>
                  ))}
                </optgroup>
              ) : (
                <option key={c.id} value={c.id}>{c.name}{c.count != null ? ` (${c.count})` : ''}</option>
              )
            )}
          </select>
        )}

        <div className="relative w-[200px]">
          <svg
            className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-muted)]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
            />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={e => onSearchQueryChange(e.target.value)}
            placeholder={resourceType === 'mcp' ? t('store.search') : (t('store.searchSkills', {defaultValue: 'Search skills...'}))}
            className={`w-full ps-9 ${searchQuery ? 'pe-8' : 'pe-3'} py-1.5 rounded-lg bg-[var(--color-surface-hover)] text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-muted)] border-none focus:ring-1 focus:ring-[#0a84ff] text-ellipsis`}
          />
          {searchQuery && (
            <button
              onClick={() => onSearchQueryChange('')}
              className="absolute end-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--color-muted)] hover:text-[var(--color-text)] cursor-pointer transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        <WindowControls />
      </div>
    </div>
  );
}
