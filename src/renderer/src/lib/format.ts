import type {i18n as I18nType, TFunction} from 'i18next';

/** 紧凑数字：1234 → 1.2K，2500000 → 2.5M；null/NaN → 空串 */
export function formatCompactNumber(count?: number | null): string {
  if (count == null || isNaN(count)) return '';
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}

/**
 * 相对时间：今天 / 昨天 / N 天前 … 接 i18n，随界面语言切换。
 * 旧实现返回硬编码英文（today/yesterday/3d ago），中文界面会漏英文。
 */
export function formatRelativeTime(t: TFunction, dateStr: string): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '';
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) return t('store.timeToday', {defaultValue: 'today'});
    if (diffDays === 1) return t('store.timeYesterday', {defaultValue: 'yesterday'});
    if (diffDays < 7) return t('store.timeDaysAgo', {count: diffDays, defaultValue: `${diffDays}d ago`});
    if (diffDays < 30) return t('store.timeWeeksAgo', {count: Math.floor(diffDays / 7), defaultValue: `${Math.floor(diffDays / 7)}w ago`});
    if (diffDays < 365) return t('store.timeMonthsAgo', {count: Math.floor(diffDays / 30), defaultValue: `${Math.floor(diffDays / 30)}mo ago`});
    return t('store.timeYearsAgo', {count: Math.floor(diffDays / 365), defaultValue: `${Math.floor(diffDays / 365)}y ago`});
  } catch {
    return '';
  }
}

/**
 * 紧凑剩余时长（用于激活/试用徽标）：自动取最大单位，避免过长影响排版。
 * 例：30天 / 2年 / 12小时 / 45分；过期返回 i18n「已过期」；expiresAt 为 null 返回空串（调用方省略时间段）。
 */
export function formatCompactDuration(t: TFunction, expiresAt: number | null): string {
  if (expiresAt == null) return '';
  const diff = expiresAt - Date.now();
  if (diff <= 0) return t('license.modal.expired');
  const days = Math.floor(diff / 86400000);
  if (days >= 365) return `${Math.floor(days / 365)}${t('license.badge.unitYear')}`;
  if (days >= 1) return `${days}${t('license.badge.unitDay')}`;
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) return `${hours}${t('license.badge.unitHour')}`;
  const mins = Math.max(1, Math.floor(diff / 60000));
  return `${mins}${t('license.badge.unitMin')}`;
}

/**
 * i18next key 缺失时回退到原始文案（而非漏出 key 原文）。
 * 同 kev 缺失返回 key 字符串本身（非空），所以 `t(key) || fallback` 永不回退，必须用 exists 判断。
 */
export function localizeKey(t: TFunction, i18n: I18nType, key: string, fallback: string): string {
  return i18n.exists(key) ? t(key) : fallback;
}
