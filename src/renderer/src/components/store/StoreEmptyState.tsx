import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router-dom';
import type {StoreResourceType} from '../../hooks/storeTypes';

interface StoreEmptyStateProps {
  resourceType: StoreResourceType;
  friendlyMessage: string | null;
  isUnsupported: boolean;
  connectionsCount: number;
  mcpConnId: string | null;
  connName: string | null;
  /** 带提示的空态（限流/请求失败）需提供重试入口：失败结果会被查询缓存保留，不重试取不回来。 */
  onRetry?: () => void;
}

export default function StoreEmptyState({
  resourceType,
  friendlyMessage,
  isUnsupported,
  connectionsCount,
  mcpConnId,
  connName,
  onRetry,
}: StoreEmptyStateProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center h-full px-8">
      <div className="w-14 h-14 rounded-full bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] flex items-center justify-center mb-4">
        <svg className="w-7 h-7 text-[var(--color-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75" />
        </svg>
      </div>

      {friendlyMessage ? (
        renderFriendlyMessage(friendlyMessage, t)
      ) : (
        renderNormalEmpty(resourceType, isUnsupported, connectionsCount, mcpConnId, connName, t)
      )}

      {/* 限流 / 请求失败属于可恢复错误，优先给重试；「前往设置/库」对这类状态没有任何帮助 */}
      {friendlyMessage && onRetry ? (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_80%,transparent)] text-white text-[13px] font-medium rounded-lg transition-colors"
        >
          {t('store.retry', {defaultValue: '重试'})}
        </button>
      ) : ((resourceType === 'mcp') || (resourceType === 'skills' && connectionsCount === 0)) ? (
        <button
          onClick={() => navigate('/settings')}
          className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_80%,transparent)] text-white text-[13px] font-medium rounded-lg transition-colors"
        >
          {t('store.goToSettings')}
        </button>
      ) : (
        <button
          onClick={() => navigate('/library')}
          className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_80%,transparent)] text-white text-[13px] font-medium rounded-lg transition-colors"
        >
          {t('store.goToLibrary', 'Go to Library')}
        </button>
      )}
    </div>
  );
}

function renderFriendlyMessage(
  friendlyMessage: string,
  t: ReturnType<typeof useTranslation>['t']
) {
  const titleClass = 'text-[15px] text-[var(--color-text)] font-medium mb-2';
  const descClass = 'text-[13px] text-[var(--color-muted2)] text-center leading-relaxed mb-4';

  // 配额超限与页码越界是同一件事的两种叫法（都是「这一页查不到」），共用一条文案，避免重复维护。
  // 两个哨兵都保留：旧通道（resolvers/*）仍在发 __QUOTA_LIMIT_EXCEED__。
  if (friendlyMessage === '__QUOTA_LIMIT_EXCEED__' || friendlyMessage === '__PAGE_OUT_OF_RANGE__') {
    return (
      <p className={titleClass}>{t('store.pageOutOfRangeHint', '当前页码超出数据源可查询范围，建议增加查询条件（关键字或分类筛选）以缩小结果，或返回上一页。') as string}</p>
    );
  }

  if (friendlyMessage === '__RATE_LIMITED__') {
    return (
      <>
        <p className={titleClass}>{t('store.rateLimitedTitle', '请求过于频繁') as string}</p>
        <p className={descClass}>{t('store.rateLimitedHint', '该数据源暂时拒绝了请求（翻页过快会触发限流）。请稍等几秒后重试。') as string}</p>
      </>
    );
  }

  if (friendlyMessage === '__FETCH_FAILED__') {
    return (
      <>
        <p className={titleClass}>{t('store.fetchFailedTitle', '请求失败') as string}</p>
        <p className={descClass}>{t('store.fetchFailedHint', '未能从该数据源取回数据（网络超时或服务端异常）。请重试，或返回上一页。') as string}</p>
      </>
    );
  }

  return (
    <>
      <p className={titleClass}>{t('store.queryHintTitle', '无法完成查询') as string}</p>
      <p className={descClass}>{friendlyMessage}</p>
    </>
  );
}

function renderNormalEmpty(
  resourceType: StoreResourceType,
  isUnsupported: boolean,
  connectionsCount: number,
  mcpConnId: string | null,
  connName: string | null,
  t: ReturnType<typeof useTranslation>['t']
) {
  let title: string;
  let desc: string;

  if (resourceType === 'skills' && isUnsupported) {
    title = t('store.emptySkillUnsupported', '该 Skill 源未提供公开列表接口');
    desc = t('store.emptySkillUnsupportedDesc', '{{name}} is an SPA site...', { name: connName || t('store.emptySkillUnsupported') });
  } else if (resourceType === 'skills' && connectionsCount === 0) {
    title = t('store.emptySkillNoConnections', '添加 Skill 源管理以浏览平台 Skills');
    desc = t('store.emptySkillNoConnectionsDesc', '当前尚未配置 Skill 源。');
  } else if (resourceType === 'mcp' && mcpConnId) {
    title = t('store.emptyMcpPlatform', '该平台暂无匹配的 MCP Server');
    desc = t('store.emptyMcpPlatformDesc', '来自...', { name: connName || t('store.emptyMcpPlatform') });
  } else {
    title = t('store.emptyDefault', '暂无数据');
    desc = t('store.communityEditionDesc', 'No items found. Try switching the data source or adjusting your search.') as string;
  }

  return (
    <>
      <p className="text-[15px] text-[var(--color-text)] font-medium mb-2">{title}</p>
      <p className="text-[13px] text-[var(--color-muted2)] text-center leading-relaxed mb-4">{desc}</p>
    </>
  );
}
