/**
 * SkillsMP 平台适配器。
 * 接口形态：GET https://skillsmp.com/api/skills?search=<q>&page=<page>&limit=<size>[&sortBy=][&category=]
 * （返回 {skills,pagination,filters}）。q 为必填（空 q 返回 400 INVALID_QUERY），存在限流。
 *
 * 分类过滤（2026-09-12 修正）：上游**真实支持** `category=<叶子 slug>`。
 * 此前「上游不支持分类」的结论是三处误判叠加所致，与上游能力无关：
 *   ① `?search=&category=X` 报 400 —— 元凶是**空 search**（INVALID_QUERY），category 无辜；
 *   ② 用了错参数名 `categorySlug` —— 被静默忽略（200 但结果不变）；
 *   ③ 拿站点上的**父域** slug（development/devops/tools…）去试 —— 上游只认叶子，故 400。
 * 完整取证原登于 `doc/plan-13.0.md` 模块 F（该文件已不在仓内、git 历史亦无）；现行结论以下方端点模板注释为准。
 */
import type {
    CategoryNode,
    PlatformAdapter,
    PlatformSearchPage,
    PlatformSearchParams,
    PlatformSkillListItem,
    SortOption,
} from './types';
import {buildHint, extractPageInfo, probeEndpoints, setDiagnostics} from './shared';

// 主机必须为 skillsmp.com：api.skillsmp.com 域名不存在（ENOTFOUND），旧基址导致本平台搜索恒失败。
const SKILLSMP_BASE = 'https://skillsmp.com';

// 搜索端点模板：按 (sortBy?, category?) 四种组合**显式枚举**。
// ⚠️ 不能靠「把空值填进模板」来省略参数：fillTpl 会把空值替换成**空字符串**，于是
// `&sortBy={sort}` 在 sort 为空时产出 `sortBy=`、`&category={category}` 产出 `category=`。
// 上游对空 `category=` 直接 400 INVALID_CATEGORY；空 `sortBy=` 目前虽被容忍（回退默认序），
// 但属同一类隐患，故统一「有值才带」。每组第二条为降级项（去掉 limit），仅在首条不可用时兜底；
// **带 category 的两组绝不降级掉 category** —— 否则会退回未过滤结果，与工具栏显示的分类不符（假象）。
const SKILLSMP_TPLS = {
    plain: [
        '/api/skills?search={q}&page={page}&limit={size}',
        '/api/skills?search={q}&page={page}',
    ],
    sort: [
        '/api/skills?search={q}&page={page}&limit={size}&sortBy={sort}',
        '/api/skills?search={q}&page={page}&sortBy={sort}',
    ],
    category: [
        '/api/skills?search={q}&page={page}&limit={size}&category={category}',
        '/api/skills?search={q}&page={page}&category={category}',
    ],
    sortCategory: [
        '/api/skills?search={q}&page={page}&limit={size}&sortBy={sort}&category={category}',
        '/api/skills?search={q}&page={page}&sortBy={sort}&category={category}',
    ],
} as const;

/**
 * SkillsMP 分类树：12 个父域 + 63 个叶子分类。
 *
 * **来源**：上游 MCP `list_categories`（`POST https://skillsmp.com/mcp`，无状态、无每日配额）
 * 于 2026-09-12 的快照；并与站点 `/categories` 页锚文本交叉验证一致
 * （锚文本 `Browse X` = 父域、`X N skills` = 叶子，两条独立路径给出的集合完全相同）。
 * `count` 为该快照时点的条目数，仅作展示。
 *
 * ⚠️ 上游 `category` **只接受叶子 slug**，父域 slug 一律 400 `INVALID_CATEGORY`
 * —— 故父节点仅作分组标签（UI 以 optgroup 渲染、不可选），其 id 不参与过滤。
 */
const SKILLSMP_CATEGORIES: CategoryNode[] = [
    {
        id: 'blockchain', name: '区块链', children: [
            {id: 'defi', name: 'DeFi', count: 1572},
            {id: 'smart-contracts', name: '智能合约', count: 12019},
            {id: 'web3-tools', name: 'Web3 工具', count: 8978},
        ],
    },
    {
        id: 'business', name: '商业', children: [
            {id: 'business-apps', name: '商业应用', count: 3649},
            {id: 'ecommerce', name: '电商', count: 11529},
            {id: 'finance-investment', name: '金融投资', count: 86661},
            {id: 'health-fitness', name: '健康健身', count: 9490},
            {id: 'payment', name: '支付', count: 9717},
            {id: 'project-management', name: '项目管理', count: 103819},
            {id: 'real-estate-legal', name: '房产与法务', count: 54746},
            {id: 'sales-marketing', name: '销售与营销', count: 307101},
        ],
    },
    {
        id: 'content-media', name: '内容与媒体', children: [
            {id: 'content-creation', name: '内容创作', count: 36677},
            {id: 'design', name: '设计', count: 22273},
            {id: 'documents', name: '文档处理', count: 112245},
            {id: 'media', name: '媒体', count: 19317},
        ],
    },
    {
        id: 'data-ai', name: '数据与 AI', children: [
            {id: 'data-analysis', name: '数据分析', count: 19601},
            {id: 'data-engineering', name: '数据工程', count: 46883},
            {id: 'llm-ai', name: '大模型与 AI', count: 133618},
            {id: 'machine-learning', name: '机器学习', count: 64081},
        ],
    },
    {
        id: 'databases', name: '数据库', children: [
            {id: 'database-tools', name: '数据库工具', count: 17811},
            {id: 'nosql-databases', name: 'NoSQL 数据库', count: 2035},
            {id: 'sql-databases', name: 'SQL 数据库', count: 13728},
        ],
    },
    {
        id: 'development', name: '开发', children: [
            {id: 'architecture-patterns', name: '架构模式', count: 111317},
            {id: 'backend', name: '后端', count: 68569},
            {id: 'cms-platforms', name: 'CMS 与平台', count: 19089},
            {id: 'ecommerce-development', name: '电商开发', count: 10058},
            {id: 'framework-internals', name: '框架内幕', count: 21991},
            {id: 'frontend', name: '前端', count: 57179},
            {id: 'full-stack', name: '全栈', count: 16824},
            {id: 'gaming', name: '游戏开发', count: 36486},
            {id: 'mobile', name: '移动端', count: 33567},
            {id: 'package-distribution', name: '包管理与分发', count: 23172},
            {id: 'scripting', name: '脚本', count: 26315},
        ],
    },
    {
        id: 'devops', name: 'DevOps', children: [
            {id: 'cicd', name: 'CI/CD', count: 57417},
            {id: 'cloud', name: '云', count: 22655},
            {id: 'containers', name: '容器', count: 19431},
            {id: 'git-workflows', name: 'Git 工作流', count: 138776},
            {id: 'monitoring', name: '监控', count: 12225},
        ],
    },
    {
        id: 'documentation', name: '文档', children: [
            {id: 'education', name: '教育', count: 63696},
            {id: 'knowledge-base', name: '知识库', count: 81337},
            {id: 'technical-docs', name: '技术文档', count: 70619},
        ],
    },
    {
        id: 'lifestyle', name: '生活', children: [
            {id: 'arts-crafts', name: '手工艺术', count: 8299},
            {id: 'culinary-arts', name: '烹饪', count: 2507},
            {id: 'divination-mysticism', name: '玄学命理', count: 7183},
            {id: 'literature-writing', name: '文学写作', count: 9907},
            {id: 'philosophy-ethics', name: '哲学伦理', count: 10007},
            {id: 'wellness-health', name: '养生健康', count: 7997},
        ],
    },
    {
        id: 'research', name: '科研', children: [
            {id: 'academic', name: '学术', count: 35551},
            {id: 'astronomy-physics', name: '天文物理', count: 8696},
            {id: 'bioinformatics', name: '生物信息', count: 22570},
            {id: 'computational-chemistry', name: '计算化学', count: 21388},
            {id: 'lab-tools', name: '实验工具', count: 25568},
            {id: 'scientific-computing', name: '科学计算', count: 8494},
        ],
    },
    {
        id: 'testing-security', name: '测试与安全', children: [
            {id: 'code-quality', name: '代码质量', count: 150407},
            {id: 'security', name: '安全', count: 88733},
            {id: 'testing', name: '测试', count: 100341},
        ],
    },
    {
        id: 'tools', name: '工具', children: [
            {id: 'automation-tools', name: '自动化工具', count: 32317},
            {id: 'cli-tools', name: '命令行工具', count: 17274},
            {id: 'debugging', name: '调试', count: 390603},
            {id: 'domain-utilities', name: '域名与 DNS 工具', count: 12438},
            {id: 'ide-plugins', name: 'IDE 插件', count: 29086},
            {id: 'productivity-tools', name: '效率与集成', count: 104691},
            {id: 'system-admin', name: '系统管理', count: 153477},
        ],
    },
];

/** 合法叶子分类 slug 白名单：用于过滤值校验（非法/空值一律不透传，避免上游 400）。 */
const SKILLSMP_CATEGORY_IDS = new Set(
    SKILLSMP_CATEGORIES.flatMap(d => (d.children ?? []).map(c => c.id))
);

/**
 * 排序选项：上游**只有两种**真实排序（2026-09-12 穷举 6 种取值实测）。
 * - `stars`：星标降序 —— 真实生效，且是**省略 sortBy 时的默认序**（响应 filters.sortBy 回显 "stars"）；
 * - `recent`：最近更新降序 —— 真实生效（对应前端 id `updated`）。
 * - `relevance` / `downloads` / `updated` / `newest` **均被上游静默忽略**（回显仍是 "stars"、
 *   结果与 stars 完全同序）—— 旧实现暴露的「相关度」正属此类**假控件**，本次已下线。
 * 不再暴露上游无法做到的排序，避免「选了没反应」（plan-10.0「不挂假控件」原则）。
 */
const SKILLSMP_SORTS: SortOption[] = [
    {id: 'stars', name: '星标最多', field: 'stars', order: 'desc'},
    {id: 'updated', name: '最近更新', field: 'recent', order: 'desc'},
];

const SKILLSMP_PAGE_LIMIT = 50; // API 上限 50，超限返回 400

interface RawSkillsmp {
    id?: string;
    uuid?: string;
    name?: string;
    title?: string;
    description?: string;
    summary?: string;
    tags?: string[];
    category?: string;
    stars?: number;
    downloads?: number;
    iconUrl?: string;
    /** 真实响应中的安装源（GitHub 仓库地址），优先于 repoUrl/repo。 */
    githubUrl?: string;
    repoUrl?: string;
    repo?: string;
    author?: string;
    updatedAt?: string;
}

export function mapEntry(raw: RawSkillsmp): PlatformSkillListItem {
    const id = raw.id || raw.uuid || raw.name || '';
    const desc = raw.summary || raw.description || '';
    // 安装源优先级：githubUrl（实测真实字段）> repoUrl > repo > 平台详情页。
    // 旧实现漏掉 githubUrl，导致可安装的条目被拼成不可安装的平台页地址。
    const repo = raw.githubUrl || raw.repoUrl || raw.repo || `https://skillsmp.com/skills/${id}`;
    return {
        id,
        name: raw.name || raw.title || id,
        description: desc,
        source: 'skillsmp',
        sourceUrl: repo,
        downloadUrl: repo,
        stars: typeof raw.stars === 'number' ? raw.stars : undefined,
        updatedAt: raw.updatedAt,
        // 只透传服务端自带分类。即便分类过滤现已真实生效（见文件头注释），也**不回填**用户所选的
        // category —— 上游条目本身没有分类字段，回填等于凭空给每条结果贴标签（沿用 plan-10.0 原则）。
        category: raw.category,
        extra: {iconUrl: raw.iconUrl, author: raw.author, downloads: raw.downloads},
    };
}

export const skillsmpAdapter: PlatformAdapter = {
    id: 'skillsmp',
    name: 'SkillsMP',

    async searchSkills(params: PlatformSearchParams): Promise<PlatformSearchPage> {
        const {query, page, pageSize, baseUrl, category, sort} = params;
        const safePage = Math.max(1, page);
        const base = baseUrl || SKILLSMP_BASE;
        const started = Date.now();

        // q 必填：空串或纯符号（如 *）会触发 400 INVALID_QUERY，兜底为含字母数字的默认词
        const isSymbolOnly = !query || !/[a-zA-Z0-9\u4e00-\u9fa5]/.test(query);
        const q = isSymbolOnly ? 'skill' : query.trim();

        // sortBy 映射：上游只有 stars / recent 两种真排序。
        // 应用层默认 sort id 是 'relevance'（见 useStore.storeSort 与 StoreFilterBar 的「未筛选」基准），
        // 它在上游无对应语义 → 省略参数即得到上游默认序（实测 = stars 降序），行为正确。
        const sortBy = sort === 'updated' ? 'recent' : (sort === 'stars' ? 'stars' : '');

        // category 白名单校验：只透传合法叶子 slug。
        // 空值会让上游 400（fillTpl 产出空串），非法值（如应用层 8 类内置分类中的 coding）同样 400，
        // 故一律降级为「不传分类」，而不是把脏值发出去。
        const validCategory = category && SKILLSMP_CATEGORY_IDS.has(category) ? category : '';

        // limit 钳制到 API 上限 50
        const limit = Math.min(pageSize, SKILLSMP_PAGE_LIMIT);

        // 模板选择：空值一律「不出现该参数」（见 SKILLSMP_TPLS 注释），避免 `sortBy=` / `category=`
        const tpls = sortBy
            ? (validCategory ? SKILLSMP_TPLS.sortCategory : SKILLSMP_TPLS.sort)
            : (validCategory ? SKILLSMP_TPLS.category : SKILLSMP_TPLS.plain);

        const probe = await probeEndpoints(
            'skillsmp',
            base,
            [...tpls],
            q,
            safePage,
            limit,
            validCategory,
            sortBy
        );

        setDiagnostics('skillsmp', {
            platform: 'skillsmp',
            baseUrl: base,
            query,
            page: safePage,
            category,
            authorized: false,
            attempts: probe.attempts,
            matchedUrl: probe.matchedUrl,
            totalDurationMs: Date.now() - started,
            hint: probe.matchedUrl
                ? undefined
                : buildHint('skillsmp', probe.attempts, safePage),
        });

        if (!probe.matchedUrl) {
            return {
                items: [],
                pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
                unsupported: probe.attempts.length > 0 && probe.attempts.every(a => a.reason === 'non-json'),
            };
        }

        const items = probe.items.map(r => mapEntry(r as RawSkillsmp));
        const pageInfo = extractPageInfo(probe.json, safePage, pageSize, items.length);
        return {items, pageInfo, pagingMode: 'client', complete: false};
    },

    getFacets() {
        // 分类：上游**真实支持**叶子分类过滤（白名单见 SKILLSMP_CATEGORY_IDS），故如实声明
        // 12 父域 + 63 叶；父域仅作分组标签，UI 依据 supportsSubcategories 以 optgroup 呈现且不可选
        // （父域 slug 传给上游会 400 INVALID_CATEGORY）。
        // 排序：仅 stars / updated 两种真实排序，其余取值被上游静默忽略，不再声明。
        return {
            categories: SKILLSMP_CATEGORIES,
            sortOptions: SKILLSMP_SORTS,
            supportsSubcategories: true,
        };
    },
};