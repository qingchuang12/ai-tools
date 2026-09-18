/**
 * ModelScope 平台适配器。
 * Skill 接口形态：GET /openapi/v1/skills，服务端过滤/排序缺失，靠客户端本地做。
 * MCP 接口形态：PUT /openapi/v1/mcp/servers，支持 search/category/is_hosted 过滤。
 * 两类资源走不同端点，各自独立实现。
 */
import type {
    CategoryNode,
    PlatformAdapter,
    PlatformPageInfo,
    PlatformSearchPage,
    PlatformSearchParams,
    PlatformServerDetail,
    PlatformServerListItem,
    PlatformServerSearchPage,
    PlatformSkillDownload,
    PlatformSkillDownloadParams,
    PlatformSkillListItem,
} from './types';
import {
    buildHint,
    extractPageInfo,
    fetchJson,
    locateArray,
    MODELSCOPE_RETRY_DELAYS_MS,
    MODELSCOPE_ZIP_BASE,
    modelscopeSkillZipUrl,
    probeEndpoints,
    setDiagnostics,
    UA,
} from './shared';

const MS_BASE = 'https://modelscope.cn';

/**
 * 开放接口配额窗口：page_number × page_size 不得超过该值，超出时服务端直接返回
 * HTTP 403（code=QuotaLimitExceed），而不是 200 空数组。实测：
 * - Skill 端点：120×20=2400 正常，121×20=2420 报 403；
 * - MCP 端点：5×20=100 正常，6×20=120 报 403。
 * 分类与搜索都不重置窗口，只能靠缩小结果集查看更靠后的数据。
 */
const MS_SKILL_QUOTA_PRODUCT = 2400;
const MS_SERVER_QUOTA_PRODUCT = 100;

/**
 * 除深分页窗口外，该域名还有一层高频限流：连续无间隔翻页时，即使页码远在窗口内
 * （实测 2×20=40、4×20=80）也会被 403 拒绝；间隔 3s 后同样的页码全部 200。
 * 这与「页码越界」是两种完全不同的失败，必须区分提示，否则会把限流误报成越界。
 */
const PAGE_OUT_OF_RANGE = '__PAGE_OUT_OF_RANGE__';
const RATE_LIMITED = '__RATE_LIMITED__';
/** 网络层失败/超时或服务端 5xx：页码本身有效，只是这一次请求没成功。 */
const FETCH_FAILED = '__FETCH_FAILED__';

/**
 * 页码越界时回填的分页信息：给配额窗口内的 total/totalPages，
 * 这样前端分页器仍可用，用户能点回上一页，而不是卡在空页里出不来。
 */
function outOfRangePageInfo(page: number, pageSize: number, quotaProduct: number): PlatformPageInfo {
    const size = Math.max(1, pageSize);
    const maxPage = Math.max(1, Math.floor(quotaProduct / size));
    return {page, pageSize: size, total: maxPage * size, totalPages: maxPage, hasMore: false};
}

/**
 * 请求失败时判定原因，避免把限流/网络故障误报成「页码超出可查询范围」。
 * @param quotaExceeded 该页是否确实越过配额窗口（page × size > 窗口）
 * @param httpStatus HTTP 状态码；为 null 表示网络层失败/超时（根本没拿到响应）
 */
function failureMessage(page: number, quotaExceeded: boolean, httpStatus: number | null): string | undefined {
    if (page <= 1) return undefined; // 首页失败走原空态，诊断面板可查具体原因
    if (quotaExceeded) return PAGE_OUT_OF_RANGE;
    if (httpStatus === 403) return RATE_LIMITED;
    // 网络超时（httpStatus 为 null）或 5xx：不能静默返回空列表，否则渲染层只会显示
    // 「暂无匹配的 MCP Server」，用户既不知道失败、也无法重试。
    return FETCH_FAILED;
}

// Skill 搜索端点（实测：支持 search 搜索 + filter.category 分类过滤，一次到位）
const MS_SKILL_TPLS = [
    '/openapi/v1/skills?search={q}&page_number={page}&page_size={size}&filter.category={category}',
];

// MCP server 搜索端点（doc：PUT /openapi/v1/mcp/servers）
// ModelScope Skill 分类（来自对接文档第五节：对可访问前 2400 条统计得到的真实 18 类，
// id 为 API 返回的英文 slug，name 为对应的中文展示名。注意：这是 ModelScope 真实分类，
// 与 MCP 的分类（MS_SERVER_CATEGORIES）是完全两套体系，不要混用）。
const MS_CATEGORIES: CategoryNode[] = [
    {id: 'developer-tools', name: '开发工具'},
    {id: 'ai-media', name: 'AI 多媒体'},
    {id: 'marketing-seo', name: '营销与 SEO'},
    {id: 'skill-management', name: '技能管理'},
    {id: 'code-quality-testing', name: '代码质量与测试'},
    {id: 'frontend-development', name: '前端开发'},
    {id: 'cloud-devops', name: '云与 DevOps'},
    {id: 'mobile-development', name: '移动开发'},
    {id: 'ai-automation', name: 'AI 自动化'},
    {id: 'content-strategy', name: '内容策略'},
    {id: 'analytics', name: '数据分析'},
    {id: 'doc-processing', name: '文档处理'},
    {id: 'skill-creation', name: '技能创建'},
    {id: 'ui-ux-design', name: 'UI/UX 设计'},
    {id: 'general-tools', name: '通用工具'},
    {id: 'api-design', name: 'API 设计'},
    {id: 'other', name: '其他'},
];

// ModelScope MCP server 分类（来源：用 filter.category 做 BFS 从全量数据发现，原始 153 类，
// 去前导空格归一化后 81 类；再删除 3 个实测等价的大小写变体（Search/Finance/AIGC）后为 78 类）。
// 注意：MCP 端点只认英文 slug，中文名仅用于展示；
// 与 Skill 的 18 类中文分类（MS_CATEGORIES）是两套完全不同的体系。
const MS_SERVER_CATEGORIES: CategoryNode[] = [
    {id: 'developer-tools', name: '开发工具'},
    {id: 'search', name: '搜索'},
    {id: 'app-automation', name: '应用自动化'},
    {id: 'databases', name: '数据库'},
    {id: 'knowledge-and-memory', name: '知识与记忆'},
    {id: 'browser-automation', name: '浏览器自动化'},
    {id: 'cloud-platforms', name: '云平台'},
    {id: 'file-systems', name: '文件系统'},
    {id: 'communication', name: '通讯工具'},
    {id: 'research-and-data', name: '研究与数据'},
    {id: 'os-automation', name: '操作系统自动化'},
    {id: 'image-and-video-processing', name: '图像与视频处理'},
    {id: 'entertainment-and-media', name: '娱乐与媒体'},
    {id: 'finance', name: '金融'},
    {id: 'rag-systems', name: 'RAG 检索增强生成系统'},
    {id: 'autonomous-agents', name: '自主智能体'},
    {id: 'monitoring', name: '监控'},
    {id: 'version-control', name: '版本控制'},
    {id: 'note-taking', name: '笔记'},
    {id: 'security-and-iam', name: '安全与身份认证(IAM)'},
    {id: 'agent-orchestration', name: '智能体编排'},
    {id: 'location-services', name: '位置服务'},
    {id: 'web-scraping', name: '网页抓取'},
    {id: 'code-execution', name: '代码执行'},
    {id: 'calendar-management', name: '日历管理'},
    {id: 'content-management-systems', name: '内容管理系统'},
    {id: 'documentation-access', name: '文档访问'},
    {id: 'social-media', name: '社交媒体'},
    {id: 'art-and-culture', name: '艺术与文化'},
    {id: 'virtualization', name: '虚拟化'},
    {id: 'project-management', name: '项目管理'},
    {id: 'code-analysis', name: '代码分析'},
    {id: 'ecommerce-and-retail', name: '电商与零售'},
    {id: 'multimedia-processing', name: '多媒体处理'},
    {id: 'travel-and-transportation', name: '旅行与交通'},
    {id: 'customer-data-platforms', name: '客户数据平台(CDP)'},
    {id: 'marketing', name: '营销'},
    {id: 'cloud-storage', name: '云存储'},
    {id: 'education-and-learning-tools', name: '教育与学习工具'},
    {id: 'testing-and-qa-tools', name: '测试与质量保障(QA)'},
    {id: 'home-automation-and-iot', name: '家庭自动化与物联网(IoT)'},
    {id: 'shell-access', name: 'Shell 访问'},
    {id: 'command-line', name: '命令行'},
    {id: 'workplace-and-productivity', name: '办公与生产力'},
    {id: 'api-testing', name: 'API 测试'},
    {id: 'ci-cd', name: '持续集成与交付(CI/CD)'},
    {id: 'vector-databases', name: '向量数据库'},
    {id: 'games-and-gamification', name: '游戏与游戏化'},
    {id: 'speech-processing', name: '语音处理'},
    {id: 'health-and-wellness', name: '健康与养生'},
    {id: 'text-summarization', name: '文本摘要'},
    {id: 'weather-services', name: '天气服务'},
    {id: 'observability', name: '可观测性'},
    {id: 'data-platforms', name: '数据平台'},
    {id: 'customer-support', name: '客户支持'},
    {id: 'open-data', name: '开放数据'},
    {id: 'blockchain', name: '区块链'},
    {id: 'government-data', name: '政府数据'},
    {id: 'coding-agents', name: '编码智能体'},
    {id: 'audio-processing', name: '音频处理'},
    {id: 'penetration-testing', name: '渗透测试'},
    {id: 'language-translation', name: '语言翻译'},
    {id: 'cryptocurrency', name: '加密货币'},
    {id: 'web3', name: 'Web3'},
    {id: 'text-to-speech', name: '文本转语音(TTS)'},
    {id: 'erp-systems', name: 'ERP 系统'},
    {id: 'fitness-tracking', name: '健身追踪'},
    {id: 'legal-and-compliance', name: '法律与合规'},
    {id: 'biology-and-medicine', name: '生物与医学'},
    // 以下为 BFS 枚举到的 count<10 稀有分类。数量虽少但实测均有数据（1~9 条），
    // 删除会让这部分服务无法被筛出，故保留。
    //
    // 注：原先还保留了 3 个「大小写变体」slug（Search/Finance/aigc），但实测它们与对应小写
    // 形式的命中数完全相同（search 1427=Search 1427、finance 425=Finance 425、aigc 7=AIGC 7），
    // 服务端实际不区分大小写。保留只会导致下拉出现两个「搜索」/「金融」/「AIGC」，已删除。
    // knowledge-and-memory(591) 与 Knowledge&Memory(1) 是不同写法而非大小写变体，两者均保留。
    {id: 'software-architecture', name: '软件架构'},
    {id: 'aigc', name: '生成式人工智能(AIGC)'},
    {id: 'bioinformatics', name: '生物信息学'},
    {id: 'transportation', name: '交通'},
    {id: 'sports', name: '体育'},
    {id: 'real-estate', name: '房地产'},
    {id: 'Knowledge&Memory', name: '知识与记忆'},
    {id: 'aerospace-and-astrodynamics', name: '航空航天与天体动力学'},
    {id: 'other', name: '其他'},
];

// ModelScope 分类 slug → 中文名映射（Skill 用 MS_CATEGORIES，MCP 用 MS_SERVER_CATEGORIES）。
// 适配器在归一化列表项时把原始英文 slug 转成中文展示名，避免卡片直接显示 developer-tools 这类 slug。
const MS_SKILL_CAT_NAME = new Map(MS_CATEGORIES.map(c => [c.id, c.name]));
const MS_SERVER_CAT_NAME = new Map(MS_SERVER_CATEGORIES.map(c => [c.id, c.name]));

// Skill 详情端点（仓库 README 探测）

interface RawMS {
    _id?: string;
    id?: string;
    display_name?: string;
    description?: string;
    category?: string;
    tags?: string[];
    custom_tag?: string[];
    developer?: string;
    owner?: string;
    license?: string;
    source_url?: string;
    /** 服务端直接给出的下载直链（存在则优先使用）。 */
    download_url?: string;
    view_count?: number;
    downloads?: number;
    logo_url?: string;
    private?: boolean;
    last_modified?: string;
    file_last_modified?: string;
    locales?: string[];
}
export function mapSkill(raw: RawMS): PlatformSkillListItem {
    const id = raw.id || raw._id || '';
    const repoUrl = raw.source_url || `${MS_BASE}/${id}`;
    // downloadUrl 与 resolvers/pagination.ts 的 toListItem 同逻辑：
    //  1) 服务端返回 download_url 则优先；
    //  2) 否则对 ModelScope 非 GitHub 源，按 /skills/<owner>/<slug>/archive/zip/master 合成 zip 直链。
    // 这里**不能**把 downloadUrl 回退成 repoUrl（平台页面地址）：大量技能的 source_url 就是空串、
    // 只有平台页地址，它们恰恰只能靠 zip 直链安装，旧实现回退成页面地址导致安装必然失败。
    const isGithubSource = /(^|\.)github\.com\//.test(repoUrl);
    let downloadUrl: string | undefined;
    if (raw.download_url) {
        downloadUrl = String(raw.download_url);
    } else if (!isGithubSource) {
        downloadUrl = modelscopeSkillZipUrl(id) ?? undefined;
    }
    return {
        id,
        name: raw.display_name || id,
        description: raw.description || '',
        source: 'modelscope',
        sourceUrl: repoUrl,
        downloadUrl,
        // 浏览量 / 下载量（商店卡片与详情展示用，不再误当成 stars）
        viewCount: raw.view_count,
        downloads: raw.downloads,
        updatedAt: raw.last_modified,
        // 原始 category 为英文 slug（如 cloud-devops）；空值（源数据未标注）归到 other
        category: raw.category?.trim() || 'other',
        // 附带中文展示名，卡片/详情优先展示它；未知 slug 回退原 slug
        categoryName: (() => {
            const cat = raw.category?.trim() || 'other';
            return MS_SKILL_CAT_NAME.get(cat) ?? cat;
        })(),
        extra: {
            author: raw.developer || raw.owner,
            downloads: raw.downloads,
            coverUrl: raw.logo_url,
            repoUrl,
            license: raw.license,
            customTags: raw.custom_tag,
        },
    };
}

interface RawMCP {
    id?: string;
    name?: string;
    chinese_name?: string;
    description?: string;
    categories?: string[];
    tags?: string[];
    publisher?: string;
    view_count?: number;
    logo_url?: string;
}

export function mapMCPServer(raw: RawMCP): PlatformServerListItem {
    const repoUrl = `https://modelscope.cn/${raw.id || ''}`;
    return {
        id: raw.id || '',
        name: raw.name || raw.id || '',
        displayName: raw.chinese_name || raw.name || raw.id || '',
        description: raw.description || '',
        iconUrl: raw.logo_url,
        categories: raw.categories || [],
        // 中文展示名（与 categories 一一对应）；categories 保留原始 slug 用于分类过滤匹配
        categoryNames: (raw.categories || []).map(c => MS_SERVER_CAT_NAME.get(c) ?? c),
        tags: raw.tags || [],
        publisher: raw.publisher,
        // 浏览量（ModelScope 列表字段 view_count）
        viewCount: raw.view_count,
        sourceUrl: repoUrl,
        source: 'modelscope',
        isHosted: false,
        isVerified: false,
        extra: {repoUrl},
    };
}

/** 核心搜索（skill 与 server 复用同一列表端点）。服务端真分页：响应返回 data.total / page_number / page_size，按需取指定页；仅 sort 在客户端做（API 不支持服务端排序），category 已通过 filter.category 走服务端过滤。 */
async function msSearchImpl(params: PlatformSearchParams): Promise<PlatformSearchPage> {
    const {query, page, pageSize, baseUrl, category, sort} = params;
    const safePage = Math.max(1, page);
    const base = baseUrl || MS_BASE;
    const started = Date.now();

    // 配额窗口预判：page_number × page_size 超限时服务端必返 403，直接给提示，省掉一次必然失败的请求。
    // 第 1 页 1 × pageSize 恒在窗口内，不受影响，保证首页数据正常展示。
    if (safePage > 1 && safePage * pageSize > MS_SKILL_QUOTA_PRODUCT) {
        return {
            items: [],
            pageInfo: outOfRangePageInfo(safePage, pageSize, MS_SKILL_QUOTA_PRODUCT),
            message: PAGE_OUT_OF_RANGE,
        };
    }

    // category 为 'all' 或空时不传 filter.category 参数，否则 ModelScope 会按字面量 "all" 过滤导致无结果
    const effectiveCategory = (category && category !== 'all') ? category : '';
    const tpls = effectiveCategory
        ? MS_SKILL_TPLS
        : ['/openapi/v1/skills?search={q}&page_number={page}&page_size={size}'];

    const probe = await probeEndpoints(
        'modelscope',
        base,
        tpls,
        query,
        safePage,
        pageSize,
        effectiveCategory,
        '',
        undefined,
        '',
        MODELSCOPE_RETRY_DELAYS_MS
    );

    setDiagnostics('modelscope', {
        platform: 'modelscope',
        baseUrl: base,
        query,
        page: safePage,
        authorized: false,
        attempts: probe.attempts,
        matchedUrl: probe.matchedUrl,
        totalDurationMs: Date.now() - started,
        hint: probe.matchedUrl
            ? undefined
            : buildHint('modelscope', probe.attempts, safePage),
    });

    if (!probe.matchedUrl) {
        // 区分两种失败：页码真越过配额窗口 vs 被高频限流（403 但页码在窗口内）/网络故障。
        // 越界时回填配额内的分页信息，让用户能点分页器回到有效页；限流则保持原分页信息，
        // 因为页码本身是有效的，稍后重试即可成功。
        const quotaExceeded = safePage > 1 && safePage * pageSize > MS_SKILL_QUOTA_PRODUCT;
        const httpStatus = probe.attempts.find(a => typeof a.status === 'number')?.status ?? null;
        return {
            items: [],
            pageInfo: quotaExceeded
                ? outOfRangePageInfo(safePage, pageSize, MS_SKILL_QUOTA_PRODUCT)
                : {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
            unsupported: probe.attempts.length > 0 && probe.attempts.every(a => a.reason === 'non-json'),
            message: failureMessage(safePage, quotaExceeded, httpStatus),
        };
    }

    let items = probe.items.map(r => mapSkill(r as RawMS));

    // 分类过滤已通过 MS_SKILL_TPLS 的 filter.category 直接走服务端（T0：去掉二次请求）
    // 客户端排序（API 不支持服务端排序）
    if (sort && sort !== 'relevance') {
        if (sort === 'downloads') {
            items.sort((a, b) => ((b.extra?.downloads as number) || 0) - ((a.extra?.downloads as number) || 0));
        } else if (sort === 'updated') {
            items.sort((a, b) => {
                const da = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                const db = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                return db - da;
            });
        }
    }

    const pageInfo = extractPageInfo(probe.json, safePage, pageSize, items.length);
    return {
        items,
        pageInfo,
        pagingMode: 'server',
        // 请求成功但没有数据：仅非首页提示「页码超出可查询范围」，首页无结果属正常空态
        message: safePage > 1 && items.length === 0 ? PAGE_OUT_OF_RANGE : undefined,
    };
}

/** MCP server 搜索（PUT /openapi/v1/mcp/servers，JSON Body 传参）。 */
async function msServerSearchImpl(params: PlatformSearchParams): Promise<PlatformServerSearchPage> {
    const {query, page, pageSize, baseUrl, category} = params;
    const safePage = Math.max(1, page);
    const base = baseUrl || MS_BASE;
    const url = `${base}/openapi/v1/mcp/servers`;
    const started = Date.now();

    // 配额窗口预判（与 Skill 端点同理）：超限必返 403，直接给提示，避免一次必然失败的请求。
    if (safePage > 1 && safePage * pageSize > MS_SERVER_QUOTA_PRODUCT) {
        return {
            items: [],
            pageInfo: outOfRangePageInfo(safePage, pageSize, MS_SERVER_QUOTA_PRODUCT),
            message: PAGE_OUT_OF_RANGE,
        };
    }

    const body: Record<string, unknown> = {
        page_number: safePage,
        page_size: pageSize,
        search: query || '',
        filter: {},
    };
    if (category && category !== 'all') {
        (body.filter as Record<string, unknown>).category = category;
    }

    const result = await fetchJson(url, body, 20000, {}, MODELSCOPE_RETRY_DELAYS_MS);

    setDiagnostics('modelscope', {
        platform: 'modelscope',
        baseUrl: base,
        query,
        page: safePage,
        category,
        authorized: false,
        attempts: result ? [{url, ok: true, durationMs: Date.now() - started}] : [{url, ok: false, durationMs: Date.now() - started, reason: 'http'}],
        matchedUrl: result ? url : null,
        totalDurationMs: Date.now() - started,
        hint: result ? undefined : buildHint('modelscope', [], safePage),
    });

    if (!result || !result.json) {
        // 区分两种失败：页码真越过配额窗口 vs 被高频限流（403 但页码在窗口内）/网络故障。
        // 越界时回填配额内的分页信息，让用户能点回上一页；限流保持原分页信息，稍后重试即可成功。
        const quotaExceeded = safePage > 1 && safePage * pageSize > MS_SERVER_QUOTA_PRODUCT;
        return {
            items: [],
            pageInfo: quotaExceeded
                ? outOfRangePageInfo(safePage, pageSize, MS_SERVER_QUOTA_PRODUCT)
                : {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
            message: failureMessage(safePage, quotaExceeded, result?.status ?? null),
        };
    }

    const list = locateArray(result.json);
    let items = (list as RawMCP[]).map(r => mapMCPServer(r));

    if (category && category !== 'all') {
        const cat = category;
        items = items.filter(i => (i.categories && i.categories.includes(cat)) || (i.tags && i.tags.includes(cat)));
    }

    const pageInfo = extractPageInfo(result.json, safePage, pageSize, items.length);
    return {
        items,
        pageInfo,
        // 请求成功但无数据：仅非首页提示（首页无结果属正常空态）
        message: safePage > 1 && items.length === 0 ? PAGE_OUT_OF_RANGE : undefined,
    };
}

export const modelscopeAdapter: PlatformAdapter = {
    id: 'modelscope',
    name: 'ModelScope',

    async searchSkills(params: PlatformSearchParams): Promise<PlatformSearchPage> {
        return msSearchImpl(params);
    },

    async searchServers(params: PlatformSearchParams): Promise<PlatformServerSearchPage> {
        return msServerSearchImpl(params);
    },

    /**
     * 获取 ModelScope MCP server 详情（含安装配置 / README）。
     *
     * 与 resolvers/servers.ts 的 fetchPlatformServerDetail 对齐，契约：
     *   GET {baseUrl}/openapi/v1/mcp/servers/{id}
     *   - server_config[].mcpServers[name] = { command, args, env? }  ← 安装所需配置（真实包名）
     *   - readme：顶层或 locales.{zh,en}.readme
     *   - source_url / categories / view_count / is_hosted / is_verified / tags 等元信息
     *
     * 旧实现硬编码 `npx -y @modelscope/mcp-server --repo <id>`（该包名不存在，安装必 404），
     * 现改为读取平台返回的真实 server_config，不再编造安装命令。
     */
    async fetchServerDetail(params: PlatformSearchParams, serverId: string): Promise<PlatformServerDetail> {
        const base = params.baseUrl || MS_BASE;
        const id = serverId;
        const url = `${base.replace(/\/+$/, '')}/openapi/v1/mcp/servers/${encodeURIComponent(id)}`;

        const headers: Record<string, string> = {
            'User-Agent': UA,
            'Accept': 'application/json',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        };
        // 详情接口无需令牌即可访问；有令牌才附带 Bearer（与列表端点一致）
        if (params.secret) headers['Authorization'] = `Bearer ${params.secret}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const res = await fetch(url, {headers, redirect: 'follow', signal: controller.signal});
            const text = await res.text();
            if (!res.ok) throw new Error(`获取详情失败（HTTP ${res.status}）`);
            if (!text.trimStart().startsWith('{')) throw new Error('详情接口返回了非 JSON 内容');

            let json: any;
            try {
                json = JSON.parse(text);
            } catch {
                throw new Error('详情接口返回无法解析的 JSON');
            }

            const d = json?.data;
            if (!d || typeof d !== 'object') throw new Error('详情接口未返回数据');

            // 安装配置：server_config[].mcpServers[name] = { command, args, env }
            let install: PlatformServerDetail['install'] = null;
            const cfgList: unknown[] = Array.isArray(d.server_config) ? d.server_config : [];
            for (const entry of cfgList) {
                const mcp = (entry as {mcpServers?: Record<string, any>})?.mcpServers;
                if (mcp && typeof mcp === 'object') {
                    const key = Object.keys(mcp)[0];
                    if (key) {
                        const c = mcp[key] || {};
                        install = {
                            command: String(c.command || ''),
                            args: Array.isArray(c.args) ? c.args.map(String) : [],
                            env: c.env && typeof c.env === 'object' ? c.env : undefined,
                        };
                        break;
                    }
                }
            }

            const readme: string = d.locales?.zh?.readme || d.locales?.en?.readme || d.readme || '';

            const categories = Array.isArray(d.categories)
                ? (d.categories as unknown[]).map(String)
                : typeof d.category === 'string' && d.category
                    ? [d.category]
                    : [];

            const stars =
                typeof d.view_count === 'number'
                    ? d.view_count
                    : typeof d.github_stars === 'number'
                        ? d.github_stars
                        : undefined;

            const repoUrl = typeof d.source_url === 'string' && d.source_url ? d.source_url : `${MS_BASE}/${id}`;

            return {
                id: String(d.id || id),
                name: String(d.name || id),
                displayName: String(d.chinese_name || d.name || d.id || id),
                description: String(d.description || ''),
                iconUrl: typeof d.logo_url === 'string' && d.logo_url ? d.logo_url : undefined,
                categories,
                categoryNames: categories.map(c => MS_SERVER_CAT_NAME.get(c) ?? c),
                stars,
                sourceUrl: repoUrl,
                author: typeof d.author === 'string' && d.author ? d.author : undefined,
                publisher: typeof d.publisher === 'string' && d.publisher ? d.publisher : undefined,
                isHosted: typeof d.is_hosted === 'boolean' ? d.is_hosted : undefined,
                isVerified: typeof d.is_verified === 'boolean' ? d.is_verified : undefined,
                tags: Array.isArray(d.tags) ? (d.tags as unknown[]).map(String) : [],
                readme,
                install,
                envSchema: d.env_schema,
                source: 'modelscope',
                extra: d,
            };
        } catch (e) {
            const err = e as Error & {name?: string};
            if (err.name === 'AbortError') throw new Error('获取详情超时，请检查网络或连接配置');
            throw e;
        } finally {
            clearTimeout(timer);
        }
    },

    /**
     * 取 ModelScope 原生 Skill 的 zip 下载直链（匿名、无需凭证）。
     *
     * 实测契约：`https://www.modelscope.cn/skills/<owner>/<slug>/archive/zip/master`
     * 返回 application/zip；`source_url` 为空的技能只有这一条安装通道。
     * skillId 为空（或缺 owner/slug 结构）时明确报错，避免产出下载 404 的无效链接。
     */
    async fetchSkillDownload({baseUrl, skillId}: PlatformSkillDownloadParams): Promise<PlatformSkillDownload> {
        const id = (skillId || '').trim();
        if (!id) {
            throw new Error('缺少技能 ID，无法生成 ModelScope 下载直链。');
        }
        const base = (baseUrl || '').trim() || MODELSCOPE_ZIP_BASE;
        const downloadUrl = modelscopeSkillZipUrl(id, base);
        if (!downloadUrl) {
            throw new Error('缺少技能 ID，无法生成 ModelScope 下载直链。');
        }
        return {downloadUrl};
    },

    getFacets(resourceType?: 'mcp' | 'skills') {
        // MCP 与 Skill 在 ModelScope 是两套完全不同的分类体系：
        // - MCP 端点（PUT /openapi/v1/mcp/servers）使用英文 slug 分类（MS_SERVER_CATEGORIES）
        // - Skill 端点（/openapi/v1/skills）使用 18 类中文分类（MS_CATEGORIES）
        // 之前两者共用 MS_CATEGORIES，导致 MCP 浏览器选「技能管理」等 Skill 分类时过滤无结果。
        const categories = resourceType === 'mcp' ? MS_SERVER_CATEGORIES : MS_CATEGORIES;
        return {
            categories,
            // ModelScope 接口不支持排序（MCP 端点无 sort 参数；Skill 端点亦不支持），
            // 故不返回排序选项，前端第二栏据此隐藏排序控件。
            sortOptions: [],
            supportsSubcategories: false,
        };
    },
};

/**
 * Skill 详情：GET /api/v1/skills/<id>（注意非 /openapi/v1/，后者仅用于列表）。
 * 安装通道有两条：
 *  - source_url 指向 GitHub 时，走 skills:get-remote-detail（GitHub 解析）消费 sourceUrl；
 *  - source_url 为空（或非 GitHub）时，靠 mapSkill/fetchSkillDownload 合成的 zip 直链下载安装。
 */
