/**
 * 百炼（阿里云 Model Studio）平台适配器。
 *
 * 数据源（2026-09-14 由「纯离线」改为「在线直连 + 运行时缓存」）：
 *   - 在线优先：匿名 POST `SquarePageList` 直拉真实广场数据（实测可匿名返回 code:200，
 *     无需控制台 Cookie / API Key；pageSize=500 一次全量，现全库 279 条且含 serverCode）。
 *   - 冷启动 SWR：首次请求先用本地缓存（内置种子 + 运行时累积缓存）立即返回，
 *     后台拉在线数据，成功后替换内存态并落盘（获取到新数据后再替换离线数据）。
 *   - 在线/缓存如实标注：message 附「在线直连（实时）」或「本地缓存 · 数据时间 <date>」。
 *
 * 运行期缓存目录由调用方注入（index.ts 提供 <home>/.ai-tools/cache/platforms），
 * 复用 clawhub 的「在线结果累积落盘为离线兜底」范式。
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
    CategoryNode,
    PlatformAdapter,
    PlatformSearchParams,
    PlatformServerDetail,
    PlatformServerListItem,
    PlatformServerSearchPage,
    SortOption,
    SourceFilter,
} from './types';
import {setDiagnostics, UA} from './shared';

/** SquarePageList 接口基址（匿名 POST，表单 `params=<URL编码JSON>&region=cn-beijing`）。 */
const BAILIAN_LIST_API =
    'https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway' +
    '&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.mcp-server.SquarePageList&_v=undefined';

/** 一次取回全库的 pageSize（实测无强制上限，500 可一次全量）。 */
const BAILIAN_PAGE_SIZE = 500;

/** 在线拉取超时（毫秒）。 */
const BAILIAN_FETCH_TIMEOUT_MS = 20000;

// 百炼 8 分类枚举（doc 第5节）+ 中文名
const BAILIAN_CLASSIFICATION: Record<string, string> = {
    CORPORATE_SERVICE: '企业服务',
    LIFE_SERVICE: '生活服务',
    DATA_SEARCH: '数据搜索',
    DEVELOPER_TOOL: '开发者工具',
    CONTENT_GENERATION: '内容生成',
    CLOUD_NATIVE: '云原生',
    SEARCH_TOOL: '搜索工具',
    UNCLASSIFIED: '未分类',
};

// 百炼 9 source 维度（doc 第6节）
const BAILIAN_SOURCES: SourceFilter[] = [
    {id: 'ALIYUN', name: '阿里云'},
    {id: 'TONGYI', name: '通义'},
    {id: 'AMAP', name: '高德'},
    {id: 'DINGTALK', name: '钉钉'},
    {id: 'PARTNER', name: '三方伙伴'},
    {id: 'OPEN_SOURCE_COMMUNITY', name: '开源社区'},
    {id: 'ALIYUN_MARKET', name: '云市场'},
    {id: 'ONEKEY', name: '一键接入'},
    {id: 'OFFICIAL', name: '官方'},
];

const BAILIAN_SORTS: SortOption[] = [
    {id: 'calls', name: '调用最多', field: 'callTotalCount', order: 'desc'},
    {id: 'users', name: '激活用户最多', field: 'activateUserCount', order: 'desc'},
    {id: 'name', name: '名称', field: 'serverName', order: 'asc'},
];

interface RawBailian {
    serverName: string;
    /** 在线接口返回的唯一标识（离线种子无此字段）。 */
    serverCode?: string | null;
    classification?: string | null;
    source?: string;
    sourceName?: string;
    callTotalCount?: number;
    activateUserCount?: number;
    icon?: string;
    deployEnv?: string;
    description?: string;
}

// ---------------------------------------------------------------------------
//  运行时离线索引：在线结果累积落盘为本地兜底，替代一次性静态快照
// ---------------------------------------------------------------------------

/** 最近一次搜索注入的运行时缓存目录（getFacets 无参数，用模块级变量回读）。 */
let runtimeCacheDir: string | undefined;

/** 运行时缓存文件路径：<cacheDir>/bailian/offline-index.json（未提供 cacheDir 时返回 null）。 */
function cacheFile(cacheDir?: string): string | null {
    const dir = cacheDir || runtimeCacheDir;
    if (!dir) return null;
    return path.join(dir, 'bailian', 'offline-index.json');
}

/** 从缓存文件读已累积条目（结构 `{version,updatedAt,items:[...]}` 或纯数组）。 */
function readCache(file: string): RawBailian[] {
    try {
        if (fs.existsSync(file)) {
            const json = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Array.isArray(json?.items)) return json.items;
            if (Array.isArray(json)) return json;
        }
    } catch {
        /* ignore */
    }
    return [];
}

/** 原始条目稳定键：优先 serverCode，其次 source|serverName。 */
function rawKey(r: RawBailian): string {
    return r.serverCode || `${r.source || 'unknown'}|${r.serverName}`;
}

/** 合并条目：incoming 覆盖 base 中同键旧条目（服务器端拉全量，在线为准）。 */
function mergeRaw(base: RawBailian[], incoming: RawBailian[]): RawBailian[] {
    const map = new Map<string, RawBailian>();
    for (const r of base) {
        const k = rawKey(r);
        if (k) map.set(k, r);
    }
    for (const r of incoming) {
        const k = rawKey(r);
        if (k) map.set(k, r);
    }
    return [...map.values()];
}

/** 将在线结果写入运行时缓存（原子替换：先写临时文件再 rename）。 */
function saveCache(cacheDir: string, incoming: RawBailian[], at: string): void {
    const file = cacheFile(cacheDir);
    if (!file) return;
    try {
        const merged = mergeRaw(readCache(file), incoming);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({version: 1, updatedAt: at, items: merged}, null, 2), 'utf8');
        fs.renameSync(tmp, file);
    } catch (e) {
        console.warn('[bailian] 运行时离线缓存写入失败：', (e as Error).message);
    }
}

/** 内置种子索引（交付自带，仅作首次无缓存时的 bootstrap，非权威源）。 */
function seedData(): {items: RawBailian[]; at: string | null} {
    const p = path.join(__dirname, 'bailian', 'data', 'bailian-index.json');
    try {
        if (fs.existsSync(p)) {
            const json = JSON.parse(fs.readFileSync(p, 'utf8'));
            return {
                items: Array.isArray(json?.items) ? json.items : [],
                at: typeof json?.updatedAt === 'string' ? json.updatedAt : null,
            };
        }
    } catch (e: any) {
        console.error('[bailian] 内置种子索引读取失败：', p, e?.message);
        return {items: [], at: null};
    }
    return {items: [], at: null};
}

/** 文件携带的更新时间：优先 updatedAt 字段，否则用 mtime。 */
function fileAt(file: string): string | null {
    try {
        if (fs.existsSync(file)) {
            const json = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (typeof json?.updatedAt === 'string') return json.updatedAt;
        }
    } catch {
        /* ignore */
    }
    try {
        if (fs.existsSync(file)) return new Date(fs.statSync(file).mtimeMs).toISOString();
    } catch {
        /* ignore */
    }
    return null;
}

/** 离线兜底数据：优先运行时累积缓存，其次内置种子；作者优先缓存。 */
function loadOffline(cacheDir?: string): {items: RawBailian[]; at: string | null} {
    const seed = seedData();
    const file = cacheFile(cacheDir);
    const cached = file ? readCache(file) : [];
    const items = mergeRaw(seed.items, cached);
    const at = file ? fileAt(file) : seed.at;
    return {items, at};
}

// ---------------------------------------------------------------------------
//  在线拉取 + 内存 SWR 态
// ---------------------------------------------------------------------------

/** 在线就绪数据（进程内缓存：在线成功后持有，替换离线）。 */
let liveItems: RawBailian[] | null = null;
let liveAt: string | null = null;
/** 去重并发刷新（同一时刻只允许一次在线拉取）。 */
let inflight: Promise<unknown> | null = null;

/** 匿名 POST SquarePageList，一次全量；失败（网络/非 2xx/列表畸形）返回 null。 */
async function fetchLive(): Promise<RawBailian[] | null> {
    const params = {
        Api: 'zeldaEasy.broadscope-bailian.mcp-server.SquarePageList',
        V: '1.0',
        Data: {
            reqDTO: {
                type: 'OFFICIAL',
                displayTools: false,
                activated: 2,
                pageNo: 1,
                pageSize: BAILIAN_PAGE_SIZE,
                classification: 'ALL',
                serverName: '',
            },
            cornerstoneParam: {
                protocol: 'V2',
                console: 'ONE_CONSOLE',
                productCode: 'p_efm',
                switchUserType: 3,
                domain: 'bailian.console.aliyun.com',
                consoleSite: 'BAILIAN_ALIYUN',
                xsp_lang: 'zh-CN',
                'X-Anonymous-Id': 'anon',
            },
        },
    };
    const body = `params=${encodeURIComponent(JSON.stringify(params))}&region=cn-beijing`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BAILIAN_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(BAILIAN_LIST_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': UA,
                'Accept': 'application/json',
            },
            body,
            signal: controller.signal,
            redirect: 'follow',
        });
        if (!res.ok) return null;
        const json = await res.json();
        const list: unknown = json?.data?.DataV2?.data?.data?.mcpServerDetailList;
        if (!Array.isArray(list)) return null;
        return list as RawBailian[];
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 后台刷新：仅当存在在线数据才启用（cacheDir 非空即应用运行态）。
 * 去重并发；成功后替换内存态并落盘（缓存覆盖旧的离线快照）。
 */
function refreshAsync(cacheDir: string): void {
    if (inflight) return;
    inflight = Promise.resolve()
        .then(() => fetchLive())
        .then(fresh => {
            if (fresh && fresh.length > 0) {
                liveItems = fresh;
                liveAt = new Date().toISOString();
                saveCache(cacheDir, fresh, liveAt);
            }
        })
        .catch(e => console.warn('[bailian] 在线拉取失败：', e))
        .finally(() => {
            inflight = null;
        });
}

/** 取当前可用数据源（在线优先，否则本地缓存）。 */
function currentSource(cacheDir?: string): {items: RawBailian[]; at: string | null; isLive: boolean} {
    if (liveItems && liveItems.length > 0) {
        return {items: liveItems, at: liveAt, isLive: true};
    }
    const off = loadOffline(cacheDir);
    return {items: off.items, at: off.at, isLive: false};
}

// ---------------------------------------------------------------------------
//  映射
// ---------------------------------------------------------------------------

export function mapServer(raw: RawBailian, _idx?: number): PlatformServerListItem {
    // id 优先采用唯一的 serverCode（在线形态 `bailian:<serverCode>`）；
    // 离线种子无 serverCode 时回退稳定编码（source + serverName），保证翻页/过滤后详情可回查。
    const id = raw.serverCode
        ? `bailian:${encodeURIComponent(raw.serverCode)}`
        : `bailian:${raw.source || 'unknown'}:${encodeURIComponent(raw.serverName)}`;
    return {
        id,
        name: raw.serverName,
        displayName: raw.serverName,
        description: raw.description || '',
        // 离线/在线索引里的 icon 字段常为占位死链（实测 HTTP 404），不传，由 UI 回退首字母头像。
        iconUrl: undefined,
        categories: raw.classification ? [raw.classification] : [],
        // 中文展示名：与分类下拉（BAILIAN_CLASSIFICATION）保持一致，否则卡片 tag 显英文 slug
        categoryNames: raw.classification
            ? [BAILIAN_CLASSIFICATION[raw.classification] ?? raw.classification]
            : [],
        stars: typeof raw.callTotalCount === 'number' ? raw.callTotalCount : undefined,
        sourceUrl: `https://bailian.console.aliyun.com/#/mcp/server/${encodeURIComponent(raw.serverCode || raw.serverName)}`,
        author: raw.sourceName,
        publisher: raw.sourceName,
        isHosted: raw.deployEnv === 'REMOTE',
        isVerified: raw.source === 'ALIYUN' || raw.source === 'TONGYI',
        tags: raw.classification ? [raw.classification] : [],
        source: 'bailian',
        extra: {
            callTotalCount: raw.callTotalCount,
            activateUserCount: raw.activateUserCount,
            deployEnv: raw.deployEnv,
            source: raw.source,
            sourceName: raw.sourceName,
            serverCode: raw.serverCode ?? null,
        },
    };
}

export const bailianAdapter: PlatformAdapter = {
    id: 'bailian',
    name: '百炼',

    async searchServers(params: PlatformSearchParams): Promise<PlatformServerSearchPage> {
        const {query, page, pageSize, category, sort, source, cacheDir, baseUrl} = params;
        if (cacheDir) runtimeCacheDir = cacheDir;
        const safePage = Math.max(1, page);
        const safeSize = Math.max(1, pageSize || 20);
        const started = Date.now();

        // 数据源：在线就绪用在线；否则用本地缓存（内置种子 + 运行时累积），并后台刷新。
        const src = currentSource(cacheDir);
        if (src.isLive) {
            // 在线数据新鲜，不用刷新
        } else if (cacheDir) {
            refreshAsync(cacheDir);
        }

        const q = (query || '').trim().toLowerCase();
        // 「全部」哨兵值必须是小写 'all'（渲染层 useMcpData 固定传 `category || 'all'` / `source || 'all'`）。
        let filtered = src.items.filter(r => {
            const matchCat = !category || category === 'all' || r.classification === category;
            const matchSource = !source || source === 'all' || r.source === source;
            const matchQ =
                !q ||
                (r.serverName || '').toLowerCase().includes(q) ||
                (r.description || '').toLowerCase().includes(q);
            return matchCat && matchSource && matchQ;
        });

        // 客户端排序（以 BAILIAN_SORTS 为唯一事实源，field/order 解释排序 id）。
        const sortDef = sort ? BAILIAN_SORTS.find(s => s.id === sort) : undefined;
        const field = sortDef?.field ?? 'callTotalCount';
        const asc = sortDef?.order === 'asc';
        filtered.sort((a, b) => {
            if (field === 'serverName') {
                const c = (a.serverName || '').localeCompare(b.serverName || '');
                return asc ? c : -c;
            }
            const av = field === 'activateUserCount' ? a.activateUserCount || 0 : a.callTotalCount || 0;
            const bv = field === 'activateUserCount' ? b.activateUserCount || 0 : b.callTotalCount || 0;
            return asc ? av - bv : bv - av;
        });

        const total = filtered.length;
        const start = (safePage - 1) * safeSize;
        const slice = filtered.slice(start, start + safeSize);

        const dataAt = src.at ? new Date(src.at).toISOString().slice(0, 10) : '';
        const message = src.isLive
            ? `在线直连（实时${dataAt ? '·更新 ' + dataAt : ''}）`
            : `本地缓存${dataAt ? ' · 数据时间 ' + dataAt : ''}${cacheDir ? '，已后台刷新' : ''}`;

        setDiagnostics('bailian', {
            platform: 'bailian',
            baseUrl: baseUrl || 'bailian-square-api',
            query,
            page: safePage,
            category,
            authorized: false,
            attempts: [
                {
                    url: src.isLive ? BAILIAN_LIST_API : 'offline-index://bailian-index.json',
                    ok: true,
                    durationMs: Date.now() - started,
                    itemCount: total,
                },
            ],
            matchedUrl: src.isLive ? BAILIAN_LIST_API : 'offline-index://bailian-index.json',
            totalDurationMs: Date.now() - started,
        });

        return {
            items: slice.map(mapServer),
            pageInfo: {
                page: safePage,
                pageSize: safeSize,
                total,
                totalPages: Math.max(1, Math.ceil(total / safeSize)),
                hasMore: start + safeSize < total,
            },
            message,
        };
    },

    async fetchServerDetail(
        params: PlatformSearchParams,
        serverId: string
    ): Promise<PlatformServerDetail> {
        const m = serverId.match(/^bailian:(.+)$/);
        if (!m) throw new Error('未找到该百炼服务（本地缓存中不存在）');
        const token = m[1];
        const src = currentSource(params.cacheDir);
        const items = src.items;

        let raw: RawBailian | undefined;
        // 优先 serverCode（在线 id 形态 `bailian:<serverCode>`）
        raw = items.find(r => r.serverCode && `bailian:${encodeURIComponent(r.serverCode)}` === serverId);
        if (!raw) {
            // 兼容离线 id 形态 `bailian:<source>:<encodedName>`
            const decoded = decodeURIComponent(token);
            const sep = decoded.indexOf(':');
            if (sep > 0) {
                const srcName = decoded.slice(0, sep);
                const name = decoded.slice(sep + 1);
                raw = items.find(r => (r.source || 'unknown') === srcName && r.serverName === name);
            }
        }
        if (!raw) {
            throw new Error('未找到该百炼服务（本地缓存中不存在）');
        }
        const item = mapServer(raw);
        // 百炼为远程托管 MCP：「安装」= 写入 URL 接入点（SSE）而非本地命令。
        // slug 由 serverName 生成仅作预填默认值——离线/在线条目名与控制台接入 slug 并非同一标识，
        // 详情页允许编辑，最终以百炼控制台该服务的「接入地址」为准。
        const slug = encodeURIComponent(raw.serverCode || raw.serverName);
        const readme = [
            raw.description || '',
            '',
            '## 百炼远程托管 MCP 接入说明',
            '',
            '- 该服务为阿里云百炼远程托管 MCP，无需本地安装命令，客户端通过 URL 直连。',
            `- 默认接入地址（SSE）：https://dashscope.aliyuncs.com/api/v1/mcps/${slug}/sse`,
            '- 鉴权：需配置请求头 Authorization: Bearer <DASHSCOPE_API_KEY>（百炼 API Key，sk- 开头，在百炼控制台 API-KEY 页面获取）。',
            '- 注意：接入地址中的 slug 可能与服务显示名不同，请以百炼控制台该服务的「接入地址」为准。',
        ].join('\n');
        return {
            ...item,
            readme,
            install: {
                url: `https://dashscope.aliyuncs.com/api/v1/mcps/${slug}/sse`,
                type: 'sse' as const,
                headersTemplate: {Authorization: 'Bearer ${DASHSCOPE_API_KEY}'},
            },
            envSchema: {
                properties: {
                    DASHSCOPE_API_KEY: {
                        type: 'string',
                        description: '阿里云百炼 API Key（sk-…），在百炼控制台 API-KEY 页面获取',
                    },
                },
                required: ['DASHSCOPE_API_KEY'],
            },
            extra: {...item.extra, mode: 'remote'},
        };
    },

    getFacets() {
        // 计数基于当前可用数据（在线优先，否则运行时缓存/种子）
        const all = currentSource(runtimeCacheDir).items;
        const clsCount = new Map<string, number>();
        const srcCount = new Map<string, number>();
        for (const r of all) {
            const c = r.classification || 'UNCLASSIFIED';
            clsCount.set(c, (clsCount.get(c) || 0) + 1);
            if (r.source) srcCount.set(r.source, (srcCount.get(r.source) || 0) + 1);
        }
        const categories: CategoryNode[] = Object.entries(BAILIAN_CLASSIFICATION).map(([id, name]) => ({
            id,
            name,
            count: clsCount.get(id) || 0,
        }));
        const sourceFilter: SourceFilter[] = BAILIAN_SOURCES.map(s => ({
            ...s,
            count: srcCount.get(s.id) || 0,
        })).filter(s => (s.count || 0) > 0);
        return {
            categories,
            sourceFilter,
            sortOptions: BAILIAN_SORTS,
            supportsSubcategories: false,
        };
    },
};