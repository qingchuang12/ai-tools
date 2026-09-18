/**
 * npm Registry 平台适配器（MCP 服务器发现源）。
 *
 * npm 没有「安装 RPC」，本适配器只做「发现层」：
 *   - 列表：GET https://registry.npmjs.org/-/v1/search?text=keywords:mcp <q>&size=&from=
 *   - 详情：GET https://registry.npmjs.org/<pkg>（dist-tags + 全版本 + readme）
 * 安装形态固定返回 { command:'npx', args:['-y','<pkg>@<ver>'], env:{} }，与 modelscope 同构，
 * 直接复用 ConfigManager.installServer + McpClient.connectStdio，安装/运行链路零改动。
 *
 * 本文件完全独立实现，不依赖也不修改 modelscope.ts；所有改动均为「新增文件 + 联合类型增成员」。
 *
 * 增强（Phase 3 / Phase 4，本次新增）：
 *   - Phase 3 官方 MCP Registry 可信层：构建期聚合快照（mcp-registry-snapshot.json），按仓库地址
 *     归一化匹配 npm 包，命中者打「已收录于官方 Registry」徽章（isVerified）并回填真实子分类。
 *   - Phase 4 轻量运行确定性：live 拉取失败时回退到构建期预缓存（precache-npm-servers.json，离线可用）；
 *     详情附宿主 Node 运行时可用性（extra.hostNode）。
 */
import fs from 'fs';
import path from 'path';
import type {
    PlatformAdapter,
    PlatformFacets,
    PlatformPageInfo,
    PlatformSearchParams,
    PlatformServerDetail,
    PlatformServerListItem,
    PlatformServerSearchPage,
} from './types';
import {UA} from './shared';
import {detectNodeRuntime} from './node-runtime';

/** npm Registry 基址（匿名公开，无需 baseUrl 覆盖）。 */
const NPM_REGISTRY = 'https://registry.npmjs.org';

/** 网络层失败哨兵串（复用 modelscope 的 `__FETCH_FAILED__` 语义，便于 UI 提示而非静默空列表）。 */
const FETCH_FAILED = '__FETCH_FAILED__';

/** 带分类筛选时的一次性候选池大小（npm 搜索单页上限内取值，见 searchServers 说明）。 */
const CATEGORY_POOL_SIZE = 100;

// ---------------------------------------------------------------------------
//  类型
// ---------------------------------------------------------------------------

/** npm 搜索响应里的单个对象（仅取关心的字段，保持解耦）。 */
interface NpmSearchObject {
    package: {
        name: string;
        version: string;
        description?: string;
        keywords?: string[];
        links?: Record<string, string>;
        publisher?: {username: string; email?: string};
        date?: string;
    };
    score?: {final?: number; quality?: number; popularity?: number; maintenance?: number};
    /** 下载量（npm 搜索对象可选字段；缺包/缺周期时相应字段缺失）。 */
    downloads?: {monthly?: number; weekly?: number};
}

/** npm 搜索响应包裹。 */
interface NpmSearchResponse {
    objects: NpmSearchObject[];
    total: number;
    time?: string;
}

/** 单版本元数据（取 dist-tags.latest 指向的版本）。 */
interface NpmVersionMeta {
    description?: string;
    keywords?: string[];
    bin?: string | Record<string, string>;
    engines?: Record<string, string | undefined>;
    license?: string;
}

/** 包详情（GET /<pkg>）。 */
interface NpmPackageMetadata {
    name: string;
    description?: string;
    keywords?: string[];
    'dist-tags'?: {latest?: string};
    versions?: Record<string, NpmVersionMeta>;
    license?: string;
    repository?: {url?: string; [k: string]: unknown};
    maintainers?: Array<{name?: string; email?: string}>;
    readme?: string;
}

/** 官方 MCP Registry 快照中的单条 server（构建期聚合产物）。 */
interface RegistryServer {
    name: string | null;
    description: string;
    repository: string | null;
    remotes: string[];
    categories: string[];
    packages: Array<{registryType?: string; version?: string}>;
    version: string | null;
}

/** 归一化后的 Registry 索引条目。 */
interface RegistryEntry {
    name: string | null;
    categories: string[];
}

/** 预缓存中的单条 npm 包元数据（构建期聚合产物）。 */
interface PrecacheEntry {
    name: string;
    version: string;
    description: string;
    license: string | null;
    bin: string | null;
    engines: Record<string, string | undefined> | null;
    repository: string | null;
    publisher: string | null;
}

// ---------------------------------------------------------------------------
//  弱分类（npm 无原生分类：由 keywords + 包名/命名空间推断）
// ---------------------------------------------------------------------------

/**
 * 弱分类规则：按顺序匹配，命中即归入该类（可多命中）。
 * `mcp` 本身不做判别词——几乎所有包都带它，没有区分度。
 *
 * 三条硬性约束（违反即成死代码 / 不可达分类）：
 *   1. 英文判别词必须是「单词元」。`tokenize` 按非字母数字/非 CJK 切词，连字符会被切掉，
 *      因此 `'file-system'` 这类写法永远无法命中（词元集合里只有 file / system）。
 *      （搜索扇出时会跳过含连字符/中文的判别词，见 searchServers。）
 *   2. 每个分类必须包含与自身 id 相同的词元（如 system 分类含 'system'），
 *      否则该分类在自己的筛选下拉里选不中（分类 id 来自本表，items 里却不含它）。
 *   3. 中文判别词用于「分类判定」时走原始字符串子串匹配（中文无分词边界，
 *      `搜索引擎` 是单个词元，永远不等于 `搜索`）；它们只参与分类，绝不进入 npm 搜索查询。
 */
const NPM_CATEGORY_RULES: {id: string; keywords: string[]}[] = [
    {
        id: 'devtools',
        keywords: ['devtools', 'github', 'git', 'gitlab', 'bitbucket', 'vscode', 'ide', '开发工具', '开发'],
    },
    {
        id: 'database',
        keywords: [
            'database', 'db', 'sql', 'postgres', 'postgresql', 'sqlite', 'mysql', 'mongodb',
            '数据库', '数据',
        ],
    },
    {id: 'web-search', keywords: ['google', 'brave', 'search', 'fetch', 'web', '搜索', '检索']},
    {
        id: 'system',
        keywords: [
            'system', 'filesystem', 'terminal', 'os', 'local', 'shell', 'cli', 'desktop',
            '文件系统', '系统', '本地', '终端',
        ],
    },
    {
        id: 'office',
        keywords: ['office', 'slack', 'linear', 'notion', 'evernote', 'docs', 'calendar', '办公', '协同', '文档'],
    },
];

/** 判别词是否含 CJK 字符（中文判别词用子串匹配，英文判别词用词元集合相等）。 */
const CJK_RE = /[\u4e00-\u9fff]/;

/** 分类扇出搜索时的单分类最大英文判别词数（控制并行请求数上限）。 */
const MAX_CATEGORY_TERMS = 12;

/**
 * 分类展示名（主进程无 i18n，落盘用中文；下拉框名称由渲染层 i18n 覆盖）。
 * `mcp` 是兜底分类（无任何判别词命中时的归属），也是 getFacets 的第 6 个兜底面。
 */
export const NPM_CATEGORY_LABELS: Record<string, string> = {
    devtools: '开发工具',
    database: '数据库',
    'web-search': '生产力与搜索',
    system: '本地系统',
    office: '办公与协同',
    mcp: '其他 MCP',
};

/**
 * 分类 id → 服务端可直接检索的代表词（npm keywords 过滤词）。
 * npm 搜索单 query 只支持关键词 AND，无法表达「分类 = 多个判别词 OR」，故每个分类
 * 挑选一个语义最贴、实测可召回的代表词，走服务端真实分页（total 可信、能翻页）。
 * 实测 total：devtools=596 / database=1053 / search=1056 / system=13 / office=42。
 * `mcp` 兜底类是「不属于任何规则」的补集，无代表词、无法用关键词表达，保持候选池逻辑。
 */
const NPM_FACET_TERM: Record<string, string> = {
    devtools: 'devtools',
    database: 'database',
    'web-search': 'search',
    system: 'system',
    office: 'office',
};

/**
 * 归一化：小写 + 按非字母数字/非 CJK 切词（`@scope/pkg-name` → ['scope','pkg','name']；
 * 中文串保持连续，如 `搜索引擎` → ['搜索引擎']——因此中文判别词用子串匹配而非词元相等）。
 */
function tokenize(s: string): string[] {
    return s
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/)
        .filter(Boolean);
}

/**
 * 依据 keywords + 包名/命名空间做中英双语弱分类；无命中返回 ['mcp']。
 * 英文判别词：归一化词元集合相等；中文判别词：对原始小写 keyword 串与包名做子串匹配
 * （未分词的中文如 `搜索引擎` 才能命中 `搜索`）。
 * 说明：故意不喂 description——噪声过大，会把无关包误分。
 */
export function classifyNpmPackage(input: {name?: string; keywords?: string[]}): string[] {
    const tokens = new Set<string>();
    const rawKeywords: string[] = [];
    for (const kw of input.keywords || []) {
        rawKeywords.push(kw.toLowerCase());
        for (const t of tokenize(kw)) tokens.add(t);
    }
    const rawName = (input.name || '').toLowerCase();
    for (const t of tokenize(input.name || '')) tokens.add(t);
    const hits = NPM_CATEGORY_RULES.filter(r =>
        r.keywords.some(k => {
            if (CJK_RE.test(k)) {
                // 中文判别词：子串匹配原始小写串（中文无分词边界，词元相等永远不成立）
                return rawKeywords.some(kw => kw.includes(k)) || rawName.includes(k);
            }
            return tokens.has(k);
        })
    ).map(r => r.id);
    return hits.length > 0 ? hits : ['mcp'];
}

/** 分类 id → 展示名（未登记 id 原样返回，避免丢信息）。 */
function categoryNamesOf(ids: string[]): string[] {
    return ids.map(id => NPM_CATEGORY_LABELS[id] || id);
}

// ---------------------------------------------------------------------------
//  仓库地址归一化（Phase 3 多键匹配的唯一可行键）
// ---------------------------------------------------------------------------

/**
 * 把任意形态的仓库地址归一化为可比对字符串：
 *   - 去除 git+ 前缀、.git 后缀、末尾斜杠
 *   - github:user/repo 简写 → github.com/user/repo
 *   - 小写 host + path，去除 www.
 * 返回 null 表示无法归一化。
 */
export function normalizeRepoUrl(raw: string | undefined | null): string | null {
    if (!raw) return null;
    let s = raw.trim();
    if (!s) return null;

    // github:user/repo 简写
    const gh = s.match(/^github:([^/]+)\/(.+)$/i);
    if (gh) s = `https://github.com/${gh[1]}/${gh[2]}`;

    s = s.replace(/^git\+/, '');
    s = s.replace(/\.git$/, '');
    s = s.replace(/[/]+$/, '');

    try {
        const u = new URL(s);
        const host = u.host.replace(/^www\./, '').toLowerCase();
        const pathPart = u.pathname.toLowerCase().replace(/[/]+$/, '');
        return `${host}${pathPart}`;
    } catch {
        // 非标准 URL（如 ssh git@github.com:user/repo.git）→ 直接规整
        const cleaned = s
            .replace(/^[^@]+@/, '')
            .replace(/:/, '/')
            .replace(/[/]+$/, '')
            .toLowerCase();
        return cleaned || null;
    }
}

// ---------------------------------------------------------------------------
//  Registry 索引构建与富化（纯函数，便于单测）
// ---------------------------------------------------------------------------

/** 从快照 server 列表构建「归一化仓库地址 → 条目」索引。 */
export function buildRegistryIndex(servers: RegistryServer[]): Map<string, RegistryEntry> {
    const map = new Map<string, RegistryEntry>();
    for (const s of servers || []) {
        const key = normalizeRepoUrl(s.repository);
        if (key) {
            map.set(key, {name: s.name, categories: s.categories || []});
        }
    }
    return map;
}

/**
 * 用 Registry 索引富化详情：命中则打「已收录于官方 Registry」徽章并回填真实子分类。
 * 直接修改传入的 detail（extra 追加 registryName / registryCategories）。
 */
export function enrichWithRegistry(
    detail: PlatformServerDetail,
    index: Map<string, RegistryEntry>,
    repoUrl?: string
): void {
    const key = normalizeRepoUrl(repoUrl);
    if (!key) return;
    const entry = index.get(key);
    if (!entry) return;

    detail.isVerified = true;
    if (entry.categories.length > 0) {
        detail.categories = entry.categories;
        detail.categoryNames = entry.categories;
    }
    detail.extra = {
        ...detail.extra,
        registryName: entry.name,
        registryCategories: entry.categories,
    };
}

// ---------------------------------------------------------------------------
//  运行期懒加载（快照 / 预缓存；测试可经注入函数覆盖）
// ---------------------------------------------------------------------------

function dataFilePath(name: string): string | null {
    // 编译后 __dirname 指向 dist/main/platforms；测试环境可能无 __dirname，直接降级为空。
    if (typeof __dirname === 'undefined') return null;
    return path.join(__dirname, 'data', name);
}

let registryIndex: Map<string, RegistryEntry> | null = null;
let registryLoaded = false;
let precacheMap: Record<string, PrecacheEntry> | null = null;
let precacheLoaded = false;

async function getRegistryIndex(): Promise<Map<string, RegistryEntry> | null> {
    if (registryLoaded) return registryIndex;
    registryLoaded = true;
    const file = dataFilePath('mcp-registry-snapshot.json');
    if (file) {
        try {
            if (fs.existsSync(file)) {
                const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
                registryIndex = buildRegistryIndex(json.servers || []);
            }
        } catch {
            registryIndex = null;
        }
    }
    return registryIndex;
}

function getPrecacheEntry(name: string): PrecacheEntry | null {
    if (!precacheLoaded) {
        precacheLoaded = true;
        const file = dataFilePath('precache-npm-servers.json');
        if (file) {
            try {
                if (fs.existsSync(file)) {
                    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
                    precacheMap = json.servers || {};
                }
            } catch {
                precacheMap = null;
            }
        }
    }
    return (precacheMap && precacheMap[name]) || null;
}

/** 把预缓存条目还原成 NpmPackageMetadata，供现有 mapDetail 复用。 */
function fromPrecache(e: PrecacheEntry): NpmPackageMetadata {
    const bin = e.bin ? {[e.name]: e.bin} : undefined;
    return {
        name: e.name,
        description: e.description,
        'dist-tags': {latest: e.version},
        versions: {
            [e.version]: {
                description: e.description,
                bin: e.bin ? (bin as Record<string, string>) : undefined,
                engines: e.engines || undefined,
                license: e.license || undefined,
            },
        },
        license: e.license || undefined,
        repository: e.repository ? {url: e.repository} : undefined,
        maintainers: e.publisher ? [{name: e.publisher}] : undefined,
    };
}

// 仅测试用：直接注入索引/预缓存，绕过文件读取。
export function __setRegistryIndexForTest(map: Map<string, RegistryEntry> | null): void {
    registryIndex = map;
    registryLoaded = true;
}
export function __setPrecacheForTest(map: Record<string, PrecacheEntry> | null): void {
    precacheMap = map;
    precacheLoaded = true;
}

// ---------------------------------------------------------------------------
//  HTTP 工具
// ---------------------------------------------------------------------------

/** 构造搜索 URL（from/size 分页，text 默认带 keywords:mcp 降噪）。 */
function buildSearchUrl(text: string, size: number, from: number): string {
    const qs = new URLSearchParams();
    qs.set('text', text);
    qs.set('size', String(size));
    qs.set('from', String(from));
    return `${NPM_REGISTRY}/-/v1/search?${qs.toString()}`;
}

/** 构造包详情 URL（包名含 @scope/，原样拼装，npm 已处理）。 */
function buildPkgUrl(name: string): string {
    return `${NPM_REGISTRY}/${name}`;
}

/** 带超时与 UA 的 JSON GET。失败（非 2xx / 网络错误 / 非 JSON）返回 null，由调用方决定如何上报。 */
async function fetchNpmJson(url: string, timeoutMs = 20000): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => (controller as any).abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: {'User-Agent': UA, 'Accept': 'application/json'},
            redirect: 'follow',
            signal: (controller as any).signal,
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** 失败分页信息（total/totalPages 置 null，与 modelscope 哨兵语义一致）。 */
function failedPageInfo(page: number, pageSize: number): PlatformPageInfo {
    return {page, pageSize, total: null, totalPages: null, hasMore: false};
}

/** 把 npm 搜索对象映射为归一化 PlatformServerListItem。 */
function mapListItem(o: NpmSearchObject): PlatformServerListItem {
    const pkg = o.package || ({} as NpmSearchObject['package']);
    const name = pkg.name || '';
    // 弱分类：npm 无原生分类，由 keywords + 包名/命名空间推断（可多命中）
    const cats = classifyNpmPackage({name, keywords: pkg.keywords});
    return {
        id: `npm-${name}`,
        name,
        displayName: name,
        description: pkg.description || '',
        source: 'npm',
        sourceUrl: pkg.links?.npm || `https://www.npmjs.com/package/${name}`,
        author: pkg.publisher?.username,
        tags: ['mcp'],
        categories: cats,
        categoryNames: categoryNamesOf(cats),
        extra: {
            version: pkg.version,
            score: o.score?.final,
            date: pkg.date,
            keywords: pkg.keywords,
            downloads: o.downloads,
        },
    };
}

/** 把 npm 包详情映射为归一化 PlatformServerDetail。 */
function mapDetail(meta: NpmPackageMetadata, serverId: string): PlatformServerDetail {
    const name = meta.name || '';
    const latest = meta['dist-tags']?.latest || '';
    const ver = (latest && meta.versions?.[latest]) || {};
    const bin = ver.bin
        ? typeof ver.bin === 'string'
            ? ver.bin
            : Object.values(ver.bin)[0]
        : undefined;
    return {
        id: serverId,
        name,
        displayName: name,
        description: ver.description || meta.description || '',
        source: 'npm',
        sourceUrl: `https://www.npmjs.com/package/${name}`,
        author: meta.maintainers?.[0]?.name,
        install: {
            command: 'npx',
            args: ['-y', `${name}@${latest}`],
            env: {},
        },
        readme: meta.readme,
        extra: {
            version: latest,
            license: ver.license || meta.license,
            engines: ver.engines,
            bin,
            repository: meta.repository,
        },
    };
}

// ---------------------------------------------------------------------------
//  Adapter
// ---------------------------------------------------------------------------

export const npmAdapter: PlatformAdapter = {
    id: 'npm',
    name: 'npm Registry',

    /**
     * 分页搜索 MCP server 列表（默认拼 keywords:mcp 降噪）。
     * 映射每个 object → PlatformServerListItem；分页 total 取自响应 total 字段。
     *
     * 分类口径（npm 无原生分类、只有 keywords 过滤）分两种：
     *  - 分类 + 相关度（有代表词，见 NPM_FACET_TERM）：走服务端真实分页——
     *    query 拼 ` keywords:<代表词>`（mcp AND term），total / totalPages / hasMore 全取自
     *    npm 响应，总数可信、翻页正常。
     *  - downloads 排序 或 mcp 兜底类（无代表词）：维持「候选池」逻辑——
     *    下载排序需对全量候选本地重排（服务端无 sort），兜底类无法用关键词表达，
     *    二者都只能取候选池快照本地过滤，total 仍 null（未知总量，UI 显示「仅上/下一页」）。
     *
     * 旧分类扇出（判别词并行召回 + 本地弱分类过滤）的 total 永远无法合并出可信计数，
     * 新版已弃用；候选池大小见 CATEGORY_POOL_SIZE。
     */
    async searchServers(params: PlatformSearchParams): Promise<PlatformServerSearchPage> {
        const {query, page, pageSize, category, sort} = params;
        const safePage = Math.max(1, page);
        const safeSize = Math.max(1, pageSize || 20);
        // Q2 决策：默认拼接 keywords:mcp（用户输入为空/有输入均拼接，覆盖全场景降噪）
        const text = query ? `keywords:mcp ${query}` : 'keywords:mcp';
        const hasCategory = !!category && category !== 'all';
        const isDownloads = sort === 'downloads';
        // 分类是否有服务端代表词；仅当「有代表词且未要求下载排序」才可走真实分页。
        const facetTerm = hasCategory ? (NPM_FACET_TERM[category] || '') : '';
        const useServerCategorized = hasCategory && !!facetTerm && !isDownloads;
        // 候选池统一入口：下载排序、mcp 兜底类（无代表词）才需要；真实分页分类不在此。
        const usePool = !useServerCategorized && (hasCategory || isDownloads);

        try {
            if (useServerCategorized) {
                // 分类 + 相关度：服务端真实分页，total/hasMore 可信
                const url = buildSearchUrl(`${text} keywords:${facetTerm}`, safeSize, (safePage - 1) * safeSize);
                const json = (await fetchNpmJson(url)) as NpmSearchResponse | null;
                if (!json || !Array.isArray(json.objects)) {
                    return {items: [], pageInfo: failedPageInfo(safePage, safeSize), message: FETCH_FAILED};
                }
                const items = json.objects.map(mapListItem);
                const total: number | null = typeof json.total === 'number' ? json.total : items.length;
                const pageInfo: PlatformPageInfo = {
                    page: safePage,
                    pageSize: safeSize,
                    total,
                    totalPages: safeSize > 0 ? Math.ceil(total / safeSize) : null,
                    hasMore: safeSize > 0 && safePage * safeSize < total,
                };
                return {items, pageInfo};
            }

            if (usePool) {
                let pool: NpmSearchObject[];
                // 扇出合并集为 true：需按 score 确定性排序；单池路径保持 npm 原生顺序
                let fanoutMerged = false;
                if (hasCategory) {
                    const rule = NPM_CATEGORY_RULES.find(r => r.id === category);
                    // 只用英文单词判别词构造查询：中文判别词仅用于分类判定（npm 搜不到中文），
                    // 含连字符的词在 tokenize 下永不可能命中，也无查询意义。
                    const terms = (rule ? rule.keywords : [])
                        .filter(kw => !CJK_RE.test(kw) && !kw.includes('-'))
                        .slice(0, MAX_CATEGORY_TERMS);
                    if (terms.length > 0) {
                        // 按判别词并行扇出：每条 keywords:<kw> 服务端过滤，单条失败返回 null
                        const responses = (await Promise.all(
                            terms.map(kw => fetchNpmJson(buildSearchUrl(`${text} keywords:${kw}`, CATEGORY_POOL_SIZE, 0)))
                        )) as (NpmSearchResponse | null)[];
                        // 全部失败才走哨兵；部分失败用成功者，保证可用性
                        if (responses.every(r => !r || !Array.isArray(r.objects))) {
                            return {items: [], pageInfo: failedPageInfo(safePage, safeSize), message: FETCH_FAILED};
                        }
                        // 合并 + 按包名去重（保首次出现，跨判别词的重复包只留一条）
                        const seen = new Set<string>();
                        pool = [];
                        for (const res of responses) {
                            for (const o of res?.objects || []) {
                                const name = o?.package?.name || '';
                                if (!name || seen.has(name)) continue;
                                seen.add(name);
                                pool.push(o);
                            }
                        }
                        fanoutMerged = true;
                    } else {
                        // mcp 兜底类等无判别词分类：退回单池模式
                        const json = (await fetchNpmJson(buildSearchUrl(text, CATEGORY_POOL_SIZE, 0))) as
                            | NpmSearchResponse
                            | null;
                        if (!json || !Array.isArray(json.objects)) {
                            return {items: [], pageInfo: failedPageInfo(safePage, safeSize), message: FETCH_FAILED};
                        }
                        pool = json.objects;
                    }
                } else {
                    // 仅下载量排序（无分类）：取相关度头部候选池，再本地按下载量重排
                    const json = (await fetchNpmJson(buildSearchUrl(text, CATEGORY_POOL_SIZE, 0))) as
                        | NpmSearchResponse
                        | null;
                    if (!json || !Array.isArray(json.objects)) {
                        return {items: [], pageInfo: failedPageInfo(safePage, safeSize), message: FETCH_FAILED};
                    }
                    pool = json.objects;
                }

                const all = pool.map(mapListItem);

                // 排序（对已抓取的候选集本地排序）：
                //   - downloads：按月下载量降序。诚实范围：只重排 CATEGORY_POOL_SIZE 条
                //     相关度头部候选，并非全库按下载量排序。
                //   - 分类扇出（非 downloads）：按 extra.score 降序（npm 相关度信号，缺失按 0），
                //     消除并行合并带来的任意顺序，结果确定。
                //   - 单池 relevance：保持 npm 原生相关度顺序，不做改动。
                const scoreOf = (i: PlatformServerListItem): number =>
                    typeof i.extra?.score === 'number' ? i.extra.score : 0;
                const downloadsOf = (i: PlatformServerListItem): number => {
                    const d = i.extra?.downloads as {monthly?: number; weekly?: number} | undefined;
                    // 缺失周期数据按 0 处理；Array.prototype.sort 稳定，等值保持原相对顺序
                    return typeof d?.monthly === 'number' ? d.monthly : 0;
                };
                if (sort === 'downloads') {
                    all.sort((a, b) => downloadsOf(b) - downloadsOf(a));
                } else if (fanoutMerged) {
                    // 扇出合并集按 score 确定性排序；单池路径保持 npm 原生顺序（见上注释）
                    all.sort((a, b) => scoreOf(b) - scoreOf(a));
                }

                // 池模式一律「未知总量」：候选池/扇出并集之外还有海量命中，
                // 拿本地命中数冒充全库计数是假精确。total/totalPages 置 null 走约定。
                let items: PlatformServerListItem[];
                let hasMore: boolean;
                if (hasCategory) {
                    const matched = all.filter(i => (i.categories || []).includes(category as string));
                    items = matched.slice((safePage - 1) * safeSize, safePage * safeSize);
                    hasMore = safeSize > 0 && matched.length > safePage * safeSize;
                } else {
                    items = all.slice((safePage - 1) * safeSize, safePage * safeSize);
                    hasMore = safeSize > 0 && all.length > safePage * safeSize;
                }

                const pageInfo: PlatformPageInfo = {
                    page: safePage,
                    pageSize: safeSize,
                    total: null,
                    totalPages: null,
                    hasMore,
                };
                return {items, pageInfo};
            }

            // 无分类 + relevance：正常服务端分页，total 透传服务端计数
            const url = buildSearchUrl(text, safeSize, (safePage - 1) * safeSize);
            const json = (await fetchNpmJson(url)) as NpmSearchResponse | null;
            if (!json || !Array.isArray(json.objects)) {
                return {items: [], pageInfo: failedPageInfo(safePage, safeSize), message: FETCH_FAILED};
            }
            const items = json.objects.map(mapListItem);
            const total: number | null =
                typeof json.total === 'number' ? json.total : items.length;
            const pageInfo: PlatformPageInfo = {
                page: safePage,
                pageSize: safeSize,
                total,
                totalPages: safeSize > 0 ? Math.ceil(total / safeSize) : null,
                hasMore: safeSize > 0 && safePage * safeSize < total,
            };
            return {items, pageInfo};
        } catch {
            // 网络层失败/超时/JSON 解析异常：返回哨兵而非静默空列表，便于 UI 提示用户重试
            return {items: [], pageInfo: failedPageInfo(safePage, safeSize), message: FETCH_FAILED};
        }
    },

    /**
     * 获取单个 npm 包详情（含安装配置 / README）。
     * serverId 形如 `npm-<pkg>`，先去掉 `npm-` 前缀还原包名再请求。
     * Phase 4：live 拉取失败时回退预缓存（离线兜底）。
     * Phase 3：映射后用官方 Registry 快照富化（徽章 + 真实子分类）。
     * 失败（无响应/非包）抛错，与 modelscope 详情通道语义一致。
     */
    async fetchServerDetail(_params: PlatformSearchParams, serverId: string): Promise<PlatformServerDetail> {
        const name = serverId.replace(/^npm-/, '');

        let meta = (await fetchNpmJson(buildPkgUrl(name))) as NpmPackageMetadata | null;
        // Phase 4 离线兜底：live 失败则尝试构建期预缓存
        if (!meta || !meta.name) {
            const cached = getPrecacheEntry(name);
            if (cached) meta = fromPrecache(cached);
        }
        if (!meta || !meta.name) {
            throw new Error(`获取 npm 包详情失败：${name}`);
        }

        const detail = mapDetail(meta, serverId);

        // Phase 3：用官方 MCP Registry 快照富化（仓库地址归一化匹配）
        const index = await getRegistryIndex();
        if (index) {
            enrichWithRegistry(detail, index, meta.repository?.url as string | undefined);
        }
        // 未命中 Registry：退化为关键词弱分类（与搜索层同源，未命中则 ['mcp']）
        if (!detail.isVerified) {
            const latest = meta['dist-tags']?.latest || '';
            const keywords = (latest && meta.versions?.[latest]?.keywords) || meta.keywords;
            const cats = classifyNpmPackage({name, keywords});
            detail.categories = cats;
            detail.categoryNames = categoryNamesOf(cats);
        }

        // Phase 4：附宿主 Node 运行时可用性（供 UI / 诊断）
        try {
            const rt = await detectNodeRuntime();
            detail.extra = {
                ...detail.extra,
                hostNode: {available: rt.available, version: rt.version},
            };
        } catch {
            /* 探测失败不阻塞详情 */
        }

        return detail;
    },

    /**
     * 返回 npm 的分类/排序面元数据。
     * 分类为弱分类规则的 5 个顶层类（devtools/database/web-search/system/office）
     * + 末尾兜底类 mcp（未命中任何规则者，否则这些包无法通过分类筛选触达）。
     * 刻意返回扁平列表、不使用 children：StoreToolbar 只渲染顶层节点（见 StoreToolbar.tsx），
     * 嵌套子类在该下拉里不会显示。
     *
     * 注意：分类 id 会经渲染层 i18n（统一的 `category.*` 命名空间，见 renderer/src/lib/categoryAlias.ts）
     * 覆盖名称，且 ServerCard / SkillCard 对**所有平台**共用同一套解析，因此这里的 id 必须避开
     * 其他平台已在用的 id（如 modelscope / skillhub 的 'search'），否则会串台误标。
     */
    getFacets(_resourceType?: 'mcp' | 'skills'): PlatformFacets {
        const rules = NPM_CATEGORY_RULES.map(r => ({id: r.id, name: NPM_CATEGORY_LABELS[r.id] || r.id}));
        return {
            categories: [...rules, {id: 'mcp', name: NPM_CATEGORY_LABELS.mcp || 'mcp'}],
            sortOptions: [
                {id: 'relevance', name: '相关度', field: 'score', order: 'desc'},
                {id: 'downloads', name: '下载最多', field: 'downloads', order: 'desc'},
            ],
            supportsSubcategories: true,
        };
    },
};
