/**
 * 平台分类「中文显示名 → i18n slug」别名解析。
 *
 * 为什么需要这一层：
 * - `coze` 的分类标识本身就是中文名（coze.ts 注释：分类 id 本就是中文名，其余值返回空/非法）；
 * - `skillhub` adapter 内虽有英文 slug，但列表项只透出中文 `categoryName`（slug 在映射时被丢弃）。
 *
 * 而 locale 的分类键（统一在 `category.*` 命名空间下）使用英文 slug，故需把这两类平台的中文名归一到 slug。
 *
 * 硬约束：**只用于查翻译，绝不改写任何 id / 查询传值**——尤其 coze 的中文 id 是其 API 的过滤参数。
 */

/** 中文分类名 → 分类 slug（与 locale `category.*` 的键对齐） */
const NAME_TO_SLUG: Record<string, string> = {
    // ── coze（8 类，id 即中文名） ──
    效率工具: 'efficiency-tools',
    社交互动: 'social-interaction',
    学习教育: 'education',
    创意设计: 'creative-design',
    数据分析: 'data-analysis',
    娱乐休闲: 'entertainment',
    生活实用: 'life-practical',
    其他: 'other',
    // ── skillhub（13 类，列表项只透出中文 categoryName） ──
    付费技能: 'pay-skill',
    办公效率: 'office-efficiency',
    内容创作: 'content-creation',
    开发编程: 'dev-programming',
    设计多媒体: 'design-media',
    'AI Agent': 'ai-agent',
    知识管理: 'knowledge-management',
    商业运营: 'business-ops',
    教育学习: 'education',
    行业专业: 'professional',
    'IT 运维与安全': 'it-ops-security',
    生活服务: 'life-service',
};

/**
 * 把分类名（英文 slug 或中文名）归一到 i18n 查找用的 slug。
 * 已是 slug、或别名表中查不到的，原样返回。
 */
export function toCategorySlug(nameOrId: string): string {
    const key = (nameOrId || '').trim();
    if (!key) return key;
    return NAME_TO_SLUG[key] ?? key;
}

/** i18n 的最小依赖面（便于测试与调用方传入 react-i18next 的实例） */
interface I18nLike {
    exists: (key: string) => boolean;
}

/**
 * 把单个分类名翻成当前界面语言。
 * 项目所有分类统一在 `category.*` 命名空间下（2026-09-18 由 skillCategory /
 * mcpCategory / platformCategory 三者合并而来），命中即用，未命中回退原文。
 */
export function translateCategoryName(nameOrId: string, t: (key: string) => string, i18n: I18nLike): string {
    const slug = toCategorySlug(nameOrId);
    const key = `category.${slug}`;
    return i18n.exists(key) ? t(key) : nameOrId;
}

/** 分类字段的可能形态（各平台 adapter 透出的字段并不统一） */
export interface CategoryFields {
    /** 英文 slug 数组（部分平台有），与 categoryNames 一一对应 */
    categories?: string[];
    /** 中文展示名数组 */
    categoryNames?: string[];
    /** 中文展示名（单数，coze / skillhub 只有这个） */
    categoryName?: string;
    /** 兜底标签 */
    tags?: string[];
}

/**
 * 取列表项/详情项的分类展示名（已按当前语言翻译）。
 *
 * 取值优先级（以「能查到翻译」为准，而非单纯字段优先）：
 * 1. `categories`（slug）逐项翻译，查不到时按索引回退到同位的 `categoryNames`；
 * 2. 无 slug 时用 `categoryNames` / `categoryName`（中文）→ 别名归一后再翻译；
 * 3. 都没有则回退 `tags`。
 *
 * 返回数组与入参顺序、长度一一对应（调用方若要按原始值取色，可用同索引取源数组）。
 */
export function localizeCategoryList(
    fields: CategoryFields,
    t: (key: string) => string,
    i18n: I18nLike,
): string[] {
    const slugs = fields.categories ?? [];
    if (slugs.length) {
        const names = fields.categoryNames ?? [];
        return slugs.map((slug, i) => {
            const translated = translateCategoryName(slug, t, i18n);
            // 未命中翻译时返回的就是 slug 原文，此时优先用同位的可读中文名
            return translated === slug ? (names[i] ?? slug) : translated;
        });
    }
    const cn = fields.categoryNames?.length
        ? fields.categoryNames
        : fields.categoryName
          ? [fields.categoryName]
          : [];
    if (cn.length) return cn.map(name => translateCategoryName(name, t, i18n));
    return fields.tags ?? [];
}
