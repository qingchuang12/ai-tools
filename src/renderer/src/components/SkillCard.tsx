/**
 * Skill 卡片组件 - 网格布局卡片
 * 显示：名称、作者、分类、star数、更新时间
 * 紧凑高度设计，与 ServerCard 一致
 */

import {type KeyboardEvent, memo} from 'react';
import {useNavigate} from 'react-router-dom';
import {useTranslation} from 'react-i18next';
import type {SkillListItem} from '../api/registry';
import {pickSkillDescription} from '../lib/localizedText';
import {ClockIcon, DownloadIcon, EyeIcon, StarIcon} from './Icons';
import {formatCompactNumber, formatRelativeTime} from '../lib/format';
import {localizeCategoryList} from '../lib/categoryAlias';
import EntityAvatar from './store/EntityAvatar';

interface SkillCardProps {
    skill: SkillListItem;
    isInstalled?: boolean;
    /** 来自 API 直连来源时的连接 ID，用于详情页走 resolveSkill 安装链路 */
    connectionId?: string;
    /** 直连来源的源 URL，配合 connectionId 用于详情页解析与安装 */
    sourceUrl?: string;
}

// 获取分类颜色
// 覆盖各源实际下发的分类 id：内置 8 类 + ClawHub 14 类（含 docs taxonomy）。
// 未命中的分类统一走末尾灰底兜底，避免「有标签但没配色」看起来像坏了。
function getCategoryColor(categoryId: string): { bg: string; text: string } {
    const colors: Record<string, { bg: string; text: string }> = {
        coding: {bg: 'bg-blue-500/15', text: 'text-blue-400'},
        testing: {bg: 'bg-green-500/15', text: 'text-green-400'},
        devops: {bg: 'bg-orange-500/15', text: 'text-orange-400'},
        'data-analytics': {bg: 'bg-purple-500/15', text: 'text-purple-400'},
        security: {bg: 'bg-red-500/15', text: 'text-red-400'},
        'content-writing': {bg: 'bg-cyan-500/15', text: 'text-cyan-400'},
        productivity: {bg: 'bg-yellow-500/15', text: 'text-yellow-400'},
        design: {bg: 'bg-pink-500/15', text: 'text-pink-400'},
        // ClawHub 分类（adapter 的 CLAWHUB_CATEGORIES）；other 走灰底兜底，不单列
        integrations: {bg: 'bg-indigo-500/15', text: 'text-indigo-400'},
        automation: {bg: 'bg-teal-500/15', text: 'text-teal-400'},
        research: {bg: 'bg-violet-500/15', text: 'text-violet-400'},
        development: {bg: 'bg-sky-500/15', text: 'text-sky-400'},
        communication: {bg: 'bg-emerald-500/15', text: 'text-emerald-400'},
        creative: {bg: 'bg-fuchsia-500/15', text: 'text-fuchsia-400'},
        knowledge: {bg: 'bg-lime-500/15', text: 'text-lime-400'},
        agents: {bg: 'bg-rose-500/15', text: 'text-rose-400'},
        operations: {bg: 'bg-amber-500/15', text: 'text-amber-400'},
        finance: {bg: 'bg-emerald-500/15', text: 'text-emerald-400'},
        lifestyle: {bg: 'bg-fuchsia-500/15', text: 'text-fuchsia-400'},
    };
    return colors[categoryId] || {bg: 'bg-[var(--color-surface-hover)]', text: 'text-[var(--color-muted2)]'};
}

function SkillCard({skill, isInstalled, connectionId, sourceUrl}: SkillCardProps) {
    const {t, i18n} = useTranslation();
    const navigate = useNavigate();

    // 按设置里的界面语言择优：中文界面优先中文简介，没有中文则英文，都没有则用现有的任意语言
    const description = pickSkillDescription(i18n.language, {
        locales: skill.descriptions,
        primary: skill.description,
    });

    const handleClick = () => {
        const params = new URLSearchParams();
        if (connectionId) params.set('conn', connectionId);
        if (sourceUrl) params.set('src', sourceUrl);
        // 携带列表项元数据，便于详情页在无法解析源（如 SPA 站点 SkillHub/ClawHub）时
        // 仍能打开预览页并展示与列表一致的信息，而不是硬报错。
        const meta = {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            // 语言变体一并带上，详情页才能按界面语言择优（而不是只能拿到列表已选定的那一份）
            descriptions: skill.descriptions,
            author: skill.author,
            categoryId: skill.categoryId,
            category: skill.category,
            // 完整分类标签透传给详情页，使详情分类 tag 与列表一致完整展示
            categories: skill.extra?.categories as string[] | undefined,
            stars: skill.stars ?? 0,
            viewCount: skill.viewCount ?? null,
            downloads: skill.downloads ?? null,
            sourceUrl: sourceUrl ?? null,
        };
        params.set('meta', encodeURIComponent(JSON.stringify(meta)));
        const q = params.toString() ? `?${params.toString()}` : '';
        navigate(`/skill/${encodeURIComponent(skill.id)}${q}`);
    };

    // S1-7: 卡片需键盘可达（Enter / Space 触发跳转）
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
        }
    };

    // 完整分类标签：透传源（如虾评多分类，extra.categories）时长于 1 则全量展示；
    // 缺省回退到单个主分类，保持其它源行为不变。
    // 仅收「非空字符串」：某些条目完全没有分类（如 ClawHub 的 a-b-test-design），
    // 旧逻辑会退化成 [undefined] 从而在卡片上渲染出一个没有文字的「空标签」。
    const rawCats = skill.extra?.categories as unknown;
    const rawCategories = (Array.isArray(rawCats) ? rawCats : []).filter(
        (c): c is string => typeof c === 'string' && c.trim().length > 0
    );
    // 分类原始值（slug 或中文名），保留用于取配色——getCategoryColor 按 id 精确匹配
    const rawCatList = rawCategories.length ? [...new Set(rawCategories)] : (skill.category ? [skill.category] : []);
    // 展示文案走 i18n：技能分类 id 各平台不统一（clawhub / modelscope 为 slug，coze / skillhub 为中文名），
    // 统一在 `category.*` 命名空间查译文，未命中才回退原文。
    // 返回数组与 rawCatList 一一对应，取色时用同索引的原始值。
    const catList = localizeCategoryList({categories: rawCatList}, t, i18n);

    // 平台直连源（如 ModelScope）的技能带真实封面图（extra.coverUrl），优先展示；
    // 加载失败由 EntityAvatar 兜底到首字母色块。
    const coverUrl = (skill.extra?.coverUrl as string | undefined) || null;
    // 需自备 API key（由 skillhub 等源经 labels.requires_api_key 透传）
    const requiresApiKey = (skill.extra?.requiresApiKey as boolean | undefined) === true;

    return (
        <div
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            role="button"
            tabIndex={0}
            className="card p-3 cursor-pointer hover:bg-[var(--color-surface-hover)]/30 transition-colors flex flex-col h-[115px]"
        >
            {/* 顶部内容区域 */}
            <div className="flex items-start gap-2.5 flex-1 min-h-0">
                {/* 图标 */}
                <div className="flex-shrink-0">
                    <EntityAvatar name={skill.name} iconUrl={coverUrl} githubUsername={skill.author} />
                </div>

                {/* 内容 */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <h3 className="text-[13px] font-medium text-[var(--color-text)] truncate">
                            {skill.name}
                        </h3>
                        {isInstalled && (
                            <span className="tag tag-success text-[9px] px-1 py-0 flex-shrink-0">
                {t('detail.installed')}
              </span>
                        )}
                        {requiresApiKey && (
                            <span className="rounded bg-amber-500/15 text-amber-400 text-[9px] px-1 py-0 flex-shrink-0">
                {t('store.requiresApiKey')}
              </span>
                        )}
                    </div>
                    <p className="text-[12px] text-[var(--color-muted2)] line-clamp-2 mt-0.5 leading-relaxed">
                        {description || t('detail.noDescription')}
                    </p>
                </div>
            </div>

            {/* 底部信息 - 紧凑设计 */}
            <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-[var(--color-border)]/50">
                <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--color-muted)] flex-1 min-w-0 me-2">
                    {/* 分类 tags - 完整展示多分类（flex-wrap 溢出换行，title 悬停看全名） */}
                    {catList.map((label, i) => {
                        const cc = getCategoryColor(rawCatList[i] ?? label);
                        return (
                            <span key={label} title={label}
                                  className={`px-1.5 py-0.5 rounded text-[9px] font-medium whitespace-nowrap ${cc.bg} ${cc.text}`}>
                                {label}
                            </span>
                        );
                    })}
                    {/* 作者 */}
                    <span className="truncate">@{skill.author}</span>
                </div>

                <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)] flex-shrink-0">
                    {/* Star 数：仅在有数据时展示（如 modelscope 源不提供 stars，避免显示无效的「★ 0」） */}
                    {typeof skill.stars === 'number' && skill.stars > 0 && (
                        <span className="flex items-center gap-0.5">
              <StarIcon className="w-3 h-3 text-yellow-400"/>
                            {formatCompactNumber(skill.stars)}
            </span>
                    )}
                    {/* 浏览量 */}
                    {typeof skill.viewCount === 'number' && skill.viewCount > 0 && (
                        <span className="flex items-center gap-0.5">
              <EyeIcon className="w-3 h-3"/>
                            {formatCompactNumber(skill.viewCount)}
            </span>
                    )}
                    {/* 下载量 */}
                    {typeof skill.downloads === 'number' && skill.downloads > 0 && (
                        <span className="flex items-center gap-0.5">
              <DownloadIcon className="w-3 h-3"/>
                            {formatCompactNumber(skill.downloads)}
            </span>
                    )}
                    {/* 更新时间 */}
                    <span className="flex items-center gap-0.5">
            <ClockIcon className="w-3 h-3"/>
                        {formatRelativeTime(t, skill.updatedAt)}
          </span>
                </div>
            </div>
        </div>
    );
}

export default memo(SkillCard);
