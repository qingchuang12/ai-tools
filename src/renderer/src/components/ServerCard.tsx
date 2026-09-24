/**
 * 服务器卡片组件 - 网格布局卡片
 * 支持多数据源 (Smithery / 平台源)
 * 紧凑高度设计
 */

import {type KeyboardEvent, memo} from 'react';
import {useNavigate} from 'react-router-dom';
import {useTranslation} from 'react-i18next';
import type {DataSource, ServerListItem} from '../api/registry';
import {isSmitheryListItem} from '../api/registry';
import {DownloadIcon, EyeIcon, VerifiedIcon} from './Icons';
import {formatCompactNumber} from '../lib/format';
import {localizeCategoryList} from '../lib/categoryAlias';
import EntityAvatar from './store/EntityAvatar';

interface ServerCardProps {
  server: ServerListItem;
  dataSource: DataSource;
  isInstalled?: boolean;
  /** 平台源（如 ModelScope）连接 ID，用于跳转到平台详情页 */
  platformConnId?: string | null;
}

function ServerCard({ server, dataSource, isInstalled, platformConnId }: ServerCardProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  // safeskill 已于 2026-09-12 下线（无 adapter、上游无公开接口），永不会产出条目，故不在本清单内
  const isPlatformSource =
    server.source === 'platform' ||
    ['modelscope', 'skillhub', 'skillsmp', 'clawhub', 'bailian', 'npm'].includes(server.source ?? '');

  const handleClick = () => {
    // 平台源（如 ModelScope）走独立的详情页路由，附带连接 ID；同时透传列表项以便详情页展示分类/浏览量
    if (isPlatformSource && platformConnId) {
      navigate(`/detail/platform/${encodeURIComponent(server.id)}?conn=${encodeURIComponent(platformConnId)}`, {state: {server}});
      return;
    }
    navigate(`/detail/${dataSource}/${encodeURIComponent(server.id)}`);
  };

  // S1-7: 卡片需键盘可达（Enter / Space 触发跳转）
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  // 分类徽章：直接取当前语言的译文。
  // categories（slug）优先以便命中翻译，未命中时按同索引回退到中文展示名（二者一一对应）；
  // server.categories 的原始 slug 未被改写，分类过滤仍用它精确匹配。
  const catList: string[] = isPlatformSource
    ? localizeCategoryList({ categories: server.categories, categoryNames: server.categoryNames, tags: server.tags }, t, i18n)
    : server.tags ?? [];

  return (
    <div
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      className="card p-3 cursor-pointer hover:bg-[var(--color-surface-hover)]/30 transition-colors flex flex-col min-h-[115px]"
    >
      {/* 顶部内容区域 */}
      <div className="flex items-start gap-2.5 flex-1 min-h-0">
        {/* 图标 */}
        <div className="flex-shrink-0">
          <EntityAvatar name={server.displayName} iconUrl={server.iconUrl} />
        </div>

        {/* 内容 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-[13px] font-medium text-[var(--color-text)] truncate min-w-0 flex-1">
              {server.displayName}
            </h3>
            {catList.slice(0, 3).map(cat => (
              <span key={cat} className="px-1.5 py-0 rounded-full text-[9px] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)] border border-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] flex-shrink-0 whitespace-nowrap">
                {cat}
              </span>
            ))}
            {catList.length > 3 && (
              <span className="px-1.5 py-0 rounded-full text-[9px] text-[var(--color-muted2)] border border-[var(--color-border)] flex-shrink-0 whitespace-nowrap">
                +{catList.length - 3}
              </span>
            )}
            {isInstalled && (
              <span className="tag tag-success text-[9px] px-1 py-0 flex-shrink-0">
                {t('detail.installed')}
              </span>
            )}
          </div>
          <p className="text-[12px] text-[var(--color-muted2)] line-clamp-2 mt-0.5 leading-relaxed">
            {server.description || 'No description'}
          </p>
        </div>
      </div>

      {/* 底部信息 - 紧凑设计 */}
      <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-[color-mix(in_srgb,var(--color-border)_50%,transparent)]">
        {isSmitheryListItem(server) ? (
          // Smithery 数据源
          <>
            {typeof server.downloads === 'number' && server.downloads > 0 && (
              <span className="text-[12px] text-[var(--color-muted)] flex items-center gap-1">
                <DownloadIcon className="w-3 h-3" />
                {formatCompactNumber(server.downloads)}
              </span>
            )}
            {server.verified && (
              <VerifiedIcon className="w-3.5 h-3.5 text-[var(--color-accent)]" />
            )}
          </>
        ) : isPlatformSource ? (
          // 平台源（modelscope / skillhub / bailian 等）
          <>
            <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
              {server.author && (
                <span>@{server.author}</span>
              )}
              {server.stars != null && server.stars > 0 && (
                <span className="flex items-center gap-0.5">
                  <svg className="w-3 h-3 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  {formatCompactNumber(server.stars)}
                </span>
              )}
              {typeof server.viewCount === 'number' && server.viewCount > 0 && (
                <span className="flex items-center gap-0.5">
                  <EyeIcon className="w-3 h-3" />
                  {formatCompactNumber(server.viewCount)}
                </span>
              )}
              {server.extra?.callTotalCount != null && (
                <span>{formatCompactNumber(server.extra.callTotalCount as number)} {t('store.callCount')}</span>
              )}
            </div>
            {server.verified && (
              <VerifiedIcon className="w-3.5 h-3.5 text-[var(--color-accent)] flex-shrink-0" />
            )}
            {(server.extra?.isHosted === true || server.isHosted === true) ? (
              <span className="text-[10px] text-[var(--color-accent)] flex-shrink-0">{t('store.cloudHosted')}</span>
            ) : (
              <span className="text-[10px] text-[var(--color-muted2)] flex-shrink-0">{server.source}</span>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

export default memo(ServerCard);
