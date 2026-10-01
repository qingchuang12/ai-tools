/**
 * ClawHub 平台适配器。
 * 接口形态：Convex RPC，POST https://wry-manatee-359.convex.cloud/api/action。
 * 离线回退：若联网失败，读取运行时累积的离线索引（在线结果动态累积，非写死静态索引）。
 */
import type {
    CategoryNode,
    PlatformAdapter,
    PlatformPageInfo,
    PlatformSearchPage,
    PlatformSearchParams,
    PlatformSkillDownload,
    PlatformSkillDownloadParams,
    PlatformSkillListItem,
    SortOption,
} from './types';
import {CLAWHUB_DOWNLOAD_BASE} from '../../shared/platform-constants';
import {buildHint, setDiagnostics} from './shared';
import * as path from 'path';
import * as fs from 'fs';

// 文档 14 类分类（integrations/automation/research 等）
const CLAWHUB_CATEGORIES: CategoryNode[] = [
    {id: 'integrations', name: '集成'},
    {id: 'automation', name: '自动化'},
    {id: 'research', name: '研究'},
    {id: 'development', name: '开发'},
    {id: 'productivity', name: '效率'},
    {id: 'communication', name: '沟通'},
    {id: 'creative', name: '创意'},
    {id: 'knowledge', name: '知识'},
    {id: 'agents', name: '智能体'},
    {id: 'operations', name: '运维'},
    {id: 'security', name: '安全'},
    {id: 'finance', name: '金融'},
    {id: 'lifestyle', name: '生活'},
    {id: 'other', name: '其他'},
];

// API 不支持服务端排序，仅保留客户端排序选项（按 score / downloads）
const CLAWHUB_SORTS: SortOption[] = [
    {id: 'relevance', name: '相关度', field: 'relevance', order: 'desc'},
    {id: 'downloads', name: '下载最多', field: 'downloads', order: 'desc'},
    {id: 'updated', name: '最近更新', field: 'updatedAt', order: 'desc'},
];

// Convex 部署地址（标准域名，非 api.clawhub.ai）
const CLAWHUB_BASE = 'https://wry-manatee-359.convex.cloud';
// 真实可用 RPC 方法名（其余猜测路径一律 500）
const CLAWHUB_RPC_PATH = 'search:searchSkills';
const CLAWHUB_PAGE_LIMIT = 100;

interface RawClawhub {
    _id?: string;
    id?: string;
    slug?: string;
    name?: string;
    title?: string;
    displayName?: string;
    description?: string;
    summary?: string;
    // ClawHub/Convex 真实结构中用于消歧义的发布者句柄（P0 修复依赖此字段）
    ownerHandle?: string;
    publisher?: {handle?: string};
    // 站内详情页规范地址，含 owner 路径，优于拼接猜测（P2-2）
    canonicalUrl?: string;
    links?: {canonical?: string};
    native?: {
        ownerHandle?: string;
        skill?: {summary?: string; categories?: string[]; stats?: {stars?: number}};
        categories?: string[];
    };
    /** 注意：Convex 真实结构里 tags 是对象 {latest: <versionId>}，不是分类数组，不可当分类用。 */
    tags?: Record<string, unknown>;
    score?: number;
    stars?: number;
    downloads?: number;
    iconUrl?: string;
    repoUrl?: string;
    repo?: string;
    author?: string;
    updatedAt?: string;
    createdAt?: string;
    categories?: string[];
}

/**
 * 把任意候选值收敛为「非空字符串数组」。
 * Convex 真实结构里 `tags` 是对象（{latest: versionId}）、部分条目根本没有 categories，
 * 若直接 `a || b || c` 取值会拿到对象或 undefined，并一路透传到渲染层变成空标签 / 过滤报错。
 */
function toCatArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/** 取条目的分类（优先 native.skill.categories，逐级回退；tags 对象不参与）。 */
function pickCategories(raw: RawClawhub): string[] {
    return toCatArray(raw.native?.skill?.categories ?? raw.native?.categories ?? raw.categories);
}

export function mapEntry(raw: RawClawhub): PlatformSkillListItem {
    const slug = raw.slug || raw.id || raw._id || raw.name || '';
    const ownerHandle = raw.ownerHandle || raw.native?.ownerHandle || raw.publisher?.handle || '';
    // id 编码为 ownerHandle/slug：ClawHub 上 slug 可被多发布者占用（如 answeroverflow），
    // 单独 slug 无法唯一定位，安装直链会 409；带上 ownerHandle 才能消解歧义（P0 修复）。
    const id = ownerHandle ? `${ownerHandle}/${slug}` : slug;
    const desc = raw.summary || raw.native?.skill?.summary || raw.description || '';
    const cats: string[] = pickCategories(raw);
    const repo = raw.repoUrl || raw.repo || `https://clawhub.ai/skills/${slug}`;
    // downloadUrl 对齐 D3 口径：repo 是真 GitHub 仓库时保留（走 GitHub 解析通道），
    // 否则给站内 zip 直链——不再把平台详情页地址当下载地址（点开必失败）。
    // zip 通道只服务 clawhub 原生技能（skills-sh 镜像 slug 实测 404），
    // 这类条目的 repo 字段指向其 GitHub 仓库，恰好由上面的 GitHub 分支接管。
    // 歧义 slug 必须带 ownerHandle 才能拿到 zip（否则 409），故 downloadUrl 一并拼上。
    const isGithubRepo = /^https?:\/\/(?:www\.)?github\.com\//i.test(repo);
    const downloadUrl = isGithubRepo
        ? repo
        : `${CLAWHUB_DOWNLOAD_BASE}?slug=${encodeURIComponent(slug)}${ownerHandle ? `&ownerHandle=${encodeURIComponent(ownerHandle)}` : ''}`;
    // 详情页地址优先用 canonicalUrl（含 owner 路径，如 /rhyssullivan/skills/answeroverflow）
    const canonical = raw.canonicalUrl || raw.links?.canonical;
    const sourceUrl = isGithubRepo ? repo : (canonical ? `https://clawhub.ai${canonical}` : repo);
    return {
        id,
        name: raw.displayName || raw.name || raw.title || id,
        description: desc,
        source: 'clawhub',
        sourceUrl,
        downloadUrl,
        // stars 在 Convex 真实结构里是 native.skill.stats.stars（顶层无 stars 字段），需从这里取（P2-1）
        stars: typeof raw.native?.skill?.stats?.stars === 'number'
            ? raw.native.skill.stats.stars
            : (typeof raw.stars === 'number' ? raw.stars : undefined),
        updatedAt: raw.updatedAt || raw.createdAt,
        category: Array.isArray(cats) && cats.length > 0 ? cats[0] : undefined,
        extra: {
            iconUrl: raw.iconUrl,
            // Convex 真实结构顶层**没有** author 字段：原先只传 raw.author，
            // 渲染层 useSkillsData 取不到便回退成 item.source → 每张卡片都显示 "@clawhub"。
            // 改用 ownerHandle 兜底（已由上两行算出，是真实发布者，如 rhyssullivan）。
            author: raw.author || ownerHandle || undefined,
            downloads: raw.downloads,
            score: raw.score,
            ownerHandle,
            categories: cats,
        },
    };
}

// ---------------------------------------------------------------------------
//  运行时离线索引：累积在线结果作为离线缓存，替代写死的静态索引 (data/clawhub.json)
// ---------------------------------------------------------------------------

/** 最近一次搜索注入的运行时缓存目录（getFacets 无参数，用模块级变量回读）。 */
let runtimeCacheDir: string | undefined;

/** 运行时缓存文件路径：<cacheDir>/clawhub/offline-index.json（未提供 cacheDir 时返回 null）。 */
function cacheFile(cacheDir?: string): string | null {
    const dir = cacheDir || runtimeCacheDir;
    if (!dir) return null;
    return path.join(dir, 'clawhub', 'offline-index.json');
}

/** 从缓存文件中读出已累积的原始条目（兼容数组与 {skills:[...]} 两种结构）。 */
function readCache(file: string): RawClawhub[] {
    try {
        if (fs.existsSync(file)) {
            const json = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Array.isArray(json)) return json;
            if (Array.isArray(json?.skills)) return json.skills;
        }
    } catch {
        /* ignore */
    }
    return [];
}

/** 原始条目稳定 id（与 mapEntry 的 id 选择一致，用于去重）。 */
function rawId(raw: RawClawhub): string {
    return raw.slug || raw.id || raw._id || raw.name || '';
}

/** 合并累积条目：incoming 覆盖 base 中同 id 的旧条目。 */
function mergeRaw(base: RawClawhub[], incoming: RawClawhub[]): RawClawhub[] {
    const map = new Map<string, RawClawhub>();
    for (const r of base) {
        const id = rawId(r);
        if (id) map.set(id, r);
    }
    for (const r of incoming) {
        const id = rawId(r);
        if (id) map.set(id, r);
    }
    return [...map.values()];
}

/** 将在线结果累积写入运行时缓存（原子替换：先写临时文件再 rename）。 */
function saveCache(cacheDir: string, incoming: RawClawhub[]): void {
    const file = cacheFile(cacheDir);
    if (!file) return;
    try {
        const merged = mergeRaw(readCache(file), incoming);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        const tmp = `${file}.tmp`;
        fs.writeFileSync(
            tmp,
            JSON.stringify({version: 1, updatedAt: new Date().toISOString(), skills: merged}, null, 2),
            'utf8'
        );
        fs.renameSync(tmp, file);
    } catch (e) {
        console.warn('[clawhub] 运行时离线缓存写入失败：', (e as Error).message);
    }
}

/** 内置种子索引路径（可选 bootstrap，目前为空集；运行时缓存为权威源）。 */
function seedFile(): string {
    return path.join(__dirname, 'clawhub', 'data', 'clawhub.json');
}

/**
 * 离线回退：优先读取运行时累积缓存，其次合并内置种子索引（按 id 去重，缓存优先）。
 * 离线索引不再写死为静态快照，而是随在线搜索不断累积更新。
 */
async function loadOffline(cacheDir?: string): Promise<RawClawhub[]> {
    const file = cacheFile(cacheDir);
    const cached = file ? readCache(file) : [];
    return mergeRaw(readCache(seedFile()), cached);
}

/** Convex RPC 调用：POST /api/action，body 含 path/format/args。 */
async function convexQuery(
    base: string,
    body: Record<string, unknown>,
    timeoutMs = 15000
): Promise<{ok: boolean; json?: any; reason?: string}> {
    const controller = new AbortController();
    const t = setTimeout(() => (controller as any).abort(), timeoutMs);
    try {
        const res = await fetch(`${base}/api/action`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Convex-Client': 'npm-1.43.0',
                'Origin': 'https://clawhub.ai',
                'Referer': 'https://clawhub.ai/',
                'User-Agent': 'Mozilla/5.0',
            },
            body: JSON.stringify(body),
            signal: (controller as any).signal,
        });
        if (!res.ok) return {ok: false, reason: `HTTP ${res.status}`};
        const json = await res.json();
        // 响应结构：{ status:"success", value:[...] }，value 可能是 { skills:[...] }
        const value = json?.status === 'success' ? json.value : json;
        const arr: unknown[] = Array.isArray(value)
            ? value
            : (Array.isArray(value?.skills) ? value.skills : []);
        return {ok: true, json: arr};
    } catch (e) {
        const err = e as Error;
        return {ok: false, reason: err.name === 'AbortError' ? 'timeout' : err.message};
    } finally {
        clearTimeout(t);
    }
}

export const clawhubAdapter: PlatformAdapter = {
    id: 'clawhub',
    name: 'ClawHub',

    async searchSkills(params: PlatformSearchParams): Promise<PlatformSearchPage> {
        const {query, page, pageSize, baseUrl, category, sort, cacheDir} = params;
        if (cacheDir) runtimeCacheDir = cacheDir;
        const safePage = Math.max(1, page);
        // 单一真实 RPC 地址（不走 probeEndpoints，不依赖 baseUrl）。
        // 注意：seed 的 baseUrl 是 clawhub.ai 主站，但搜索走 Convex RPC 域名；
        // 若用 baseUrl 会 POST 到错误主机导致空结果，故这里固定用 CLAWHUB_BASE（P3-3）。
        const base = CLAWHUB_BASE;
        const started = Date.now();

        // query 永远非空（空串静默返回空数组）；分类浏览传默认 a
        const q = query && query.trim() ? query.trim() : 'a';
        // 全分类时省略 categorySlug（传空串恒返回 0 条）
        const args: Record<string, unknown> = {
            query: q,
            limit: CLAWHUB_PAGE_LIMIT,
            highlightedOnly: false,
        };
        if (category && category !== 'all') {
            args.categorySlug = category;
        }

        const attempts: any[] = [];
        const r = await convexQuery(base, {
            path: CLAWHUB_RPC_PATH,
            format: 'convex_encoded_json',
            args: [args],
        });
        attempts.push({
            url: `${base}/api/action`,
            ok: r.ok,
            durationMs: Date.now() - started,
            reason: r.ok ? undefined : r.reason,
            message: r.ok ? undefined : r.reason,
        });

        if (r.ok && Array.isArray(r.json)) {
            let items = r.json.map(mapEntry);
            // 在线成功：将本次结果累积进运行时缓存，作为后续离线回退索引
            if (cacheDir) saveCache(cacheDir, r.json);
            // 客户端分类过滤（categorySlug 已带，兜底再筛一遍）；
            // 用 Array.isArray 兜底：非数组（历史缓存里的对象）会让 .includes 直接抛错
            if (category && category !== 'all') {
                items = items.filter(i => {
                    const cats = (i.extra as any)?.categories;
                    return Array.isArray(cats) && cats.includes(category);
                });
            }
            // 客户端排序（relevance 为默认，无需处理；原 sort==='relevance' 分支不可达，已删除 P3-2）
            if (sort && sort !== 'relevance') {
                if (sort === 'downloads') {
                    items.sort((a, b) => ((b.extra as any)?.downloads || 0) - ((a.extra as any)?.downloads || 0));
                } else if (sort === 'updated') {
                    items.sort((a, b) => {
                        const da = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                        const db = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                        return db - da;
                    });
                }
            }
            // Convex RPC 无游标分页：已一次性拉取最多 CLAWHUB_PAGE_LIMIT 条（窗口），
            // 在此按 (page,pageSize) 做客户端切片，保证翻页不重复、total/hasMore 准确（P1 修复）。
            const total = items.length;
            const start = (safePage - 1) * pageSize;
            const paged = items.slice(start, start + pageSize);
            const pageInfo: PlatformPageInfo = {
                page: safePage,
                pageSize,
                total,
                totalPages: total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1,
                hasMore: start + pageSize < total,
            };
            setDiagnostics('clawhub', {
                platform: 'clawhub',
                baseUrl: CLAWHUB_BASE,
                query,
                page: safePage,
                authorized: false,
                attempts,
                matchedUrl: `${base}/api/action`,
                totalDurationMs: Date.now() - started,
            });
            return {items: paged, pageInfo, pagingMode: 'client', complete: true};
        }

        // 联网失败：回退运行时累积的离线索引
        const offline = await loadOffline(cacheDir);
        if (offline.length > 0) {
            const ql = q.toLowerCase();
            const filtered = ql === 'a'
                ? offline
                : offline.filter(
                      s =>
                          (s.name || s.displayName || '').toLowerCase().includes(ql) ||
                          (s.title || '').toLowerCase().includes(ql) ||
                          (s.description || s.summary || '').toLowerCase().includes(ql)
                  );
            const start = (safePage - 1) * pageSize;
            const slice = filtered.slice(start, start + pageSize);
            setDiagnostics('clawhub', {
                platform: 'clawhub',
                baseUrl,
                query,
                page: safePage,
                authorized: false,
                attempts,
                matchedUrl: null,
                totalDurationMs: Date.now() - started,
                hint: '在线接口不可达，已回退内置离线索引。',
            });
            let offlineItems = slice.map(mapEntry);
                if (category && category !== 'all') {
                    offlineItems = offlineItems.filter(i => {
                        const cats = (i.extra as any)?.categories;
                        return Array.isArray(cats) && cats.includes(category);
                    });
                }
                if (sort && sort !== 'relevance') {
                    if (sort === 'downloads') {
                        offlineItems.sort((a, b) => ((b.extra as any)?.downloads || 0) - ((a.extra as any)?.downloads || 0));
                    } else if (sort === 'updated') {
                        offlineItems.sort((a, b) => {
                            const da = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                            const db = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                            return db - da;
                        });
                    }
                }
                return {
                items: offlineItems,
                pageInfo: {
                    page: safePage,
                    pageSize,
                    total: filtered.length,
                    totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
                    hasMore: start + pageSize < filtered.length,
                },
                pagingMode: 'client',
                complete: true,
            };
        }

        setDiagnostics('clawhub', {
            platform: 'clawhub',
            baseUrl,
            query,
            page: safePage,
            authorized: false,
            attempts,
            matchedUrl: null,
            totalDurationMs: Date.now() - started,
            hint: buildHint('clawhub', attempts, safePage),
        });
        return {items: [], pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false}};
    },

    /**
     * 取 ClawHub 技能的 zip 下载直链（匿名、无需凭证）。
     *
     * 实测契约：`https://clawhub.ai/api/v1/download?slug=<slug>` 直接返回 zip（包内含 SKILL.md）。
     * 该端点只服务 clawhub 原生技能——skills-sh 镜像 slug 实测 404（plan-9.0），
     * 镜像条目的安装走其 GitHub 仓库（mapEntry 的 downloadUrl 已按此分流）。
     * 下载端点固定在 clawhub.ai 主站，与搜索用的 Convex RPC 域名无关，故不拼用户 baseUrl。
     */
    async fetchSkillDownload({skillId}: PlatformSkillDownloadParams): Promise<PlatformSkillDownload> {
        const raw = (skillId || '').trim();
        if (!raw) {
            throw new Error('缺少技能 slug，无法生成 ClawHub 下载直链。');
        }
        // id 由 mapEntry 编码为 ownerHandle/slug；歧义 slug 必须拆回 slug + ownerHandle，
        // 否则直接下载会 409（P0 修复）。无斜杠则视为纯 slug，回退旧行为。
        const slash = raw.lastIndexOf('/');
        const slug = slash >= 0 ? raw.slice(slash + 1) : raw;
        const ownerHandle = slash >= 0 ? raw.slice(0, slash) : '';
        return {downloadUrl: `${CLAWHUB_DOWNLOAD_BASE}?slug=${encodeURIComponent(slug)}${ownerHandle ? `&ownerHandle=${encodeURIComponent(ownerHandle)}` : ''}`};
    },

    getFacets() {
        // 以文档 14 类为准；若运行时累积的离线索引存在，将其 tags 作为补充合并（避免分类过滤与列表结果不一致）
        try {
            const file = cacheFile();
            const raw = mergeRaw(readCache(seedFile()), file ? readCache(file) : []);
            const tagCount = new Map<string, number>();
            for (const r of raw) {
                // Convex 真实结构无顶层 tags，分类在 native.skill.categories / native.categories / categories（P2-3）
                for (const t of pickCategories(r)) {
                    tagCount.set(t, (tagCount.get(t) || 0) + 1);
                }
            }
            if (tagCount.size > 0) {
                const baseMap = new Map(CLAWHUB_CATEGORIES.map(c => [c.id, c]));
                for (const [id, count] of tagCount) {
                    if (baseMap.has(id)) {
                        baseMap.get(id)!.count = (baseMap.get(id)!.count || 0) + count;
                    }
                }
                return {categories: [...baseMap.values()], sortOptions: CLAWHUB_SORTS, supportsSubcategories: false};
            }
        } catch {
            /* ignore */
        }
        return {categories: CLAWHUB_CATEGORIES, sortOptions: CLAWHUB_SORTS, supportsSubcategories: false};
    },
};

