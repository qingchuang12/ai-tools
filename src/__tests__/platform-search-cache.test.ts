/**
 * 平台源搜索缓存单测：验证缓存 key 与 SWR 语义。
 * 重点守卫两条：① 凭证不进 key（不落盘）② 失败/空结果不写缓存（避免把异常固化一个 TTL）。
 */
import {describe, expect, it, vi} from 'vitest';
import {
    buildPlatformSearchKey,
    type PlatformSearchCacheKey,
    withPlatformSearchCache
} from '../main/platforms/search-cache';
import type {CacheManager} from '../main/cache-manager';
import type {PlatformSearchPage} from '../main/platforms/types';

function okPage(n: number): PlatformSearchPage {
    return {
        items: Array.from({length: n}, (_, i) => ({
            id: `s${i}`,
            name: `skill-${i}`,
            description: '',
            source: 'modelscope',
            sourceUrl: `https://example.test/s${i}`,
        })),
        pageInfo: {page: 1, pageSize: 20, total: n, totalPages: 1, hasMore: false},
    };
}

/** 内存版 CacheManager 替身，只实现缓存模块用到的三个方法 */
function fakeCache(opts?: {expired?: boolean; seed?: PlatformSearchPage}) {
    const store = new Map<string, unknown>();
    const set = vi.fn(async (k: string, v: unknown) => void store.set(k, v));
    const cache = {
        get: vi.fn(async (k: string) =>
            store.has(k) ? {data: store.get(k), cachedAt: 0, expiresAt: 0, version: '1.1.0'} : null
        ),
        isExpired: vi.fn(async () => opts?.expired ?? false),
        set,
    } as unknown as CacheManager;
    if (opts?.seed) store.set('k', opts.seed);
    return {cache, set, store};
}

describe('buildPlatformSearchKey', () => {
    it('查询条件相同则 key 相同，任一条件变化则不同', () => {
        const base = {platformType: 'modelscope', baseUrl: 'https://modelscope.cn', query: '', page: 1, pageSize: 20};
        expect(buildPlatformSearchKey(base)).toBe(buildPlatformSearchKey({...base}));
        expect(buildPlatformSearchKey(base)).not.toBe(buildPlatformSearchKey({...base, page: 2}));
        expect(buildPlatformSearchKey(base)).not.toBe(buildPlatformSearchKey({...base, category: 'cloud-devops'}));
    });

    it('key 短且不含中文/空格（会用作缓存文件名）', () => {
        const key = buildPlatformSearchKey({
            platformType: 'modelscope',
            query: '数据分析 与 可视化',
            category: '开发工具',
            page: 1,
            pageSize: 20,
        });
        expect(key).toMatch(/^platform-search-modelscope-[0-9a-f]{16}$/);
    });

    // D11：鉴权态参与 key——先匿名搜索落缓存、再绑定 Token 搜同一条件，
    // 必须能拿到带鉴权的结果，不能命中匿名旧缓存。
    it('D11: 鉴权态不同则 key 不同', () => {
        const base = {platformType: 'coze', baseUrl: 'https://xiaping.coze.com', query: 'rag', page: 1};
        const anon = buildPlatformSearchKey({...base, authorized: false});
        const auth = buildPlatformSearchKey({...base, authorized: true});
        expect(anon).not.toBe(auth);
        // 缺省视为匿名，与显式 false 一致（向后兼容存量调用）
        expect(buildPlatformSearchKey(base)).toBe(anon);
    });

    it('D11: key 仍是短摘要格式（secret 与原文都不落盘）', () => {
        const key = buildPlatformSearchKey({
            platformType: 'coze',
            query: 'secret-token-should-never-appear',
            authorized: true,
        });
        // sha1 摘要格式保证 query/凭证原文不会被拼进文件名
        expect(key).toMatch(/^platform-search-coze-[0-9a-f]{16}$/);
        expect(key).not.toContain('secret-token');
    });
});

describe('withPlatformSearchCache', () => {
    it('未命中时走网络并写入缓存', async () => {
        const {cache, set} = fakeCache();
        const page = await withPlatformSearchCache(cache, 'platform-search-x' as PlatformSearchCacheKey, async () => okPage(3));
        expect(page.items).toHaveLength(3);
        expect(set).toHaveBeenCalledTimes(1);
    });

    it('命中未过期时直接返回缓存，不发起网络请求', async () => {
        const {cache} = fakeCache({expired: false, seed: okPage(2)});
        const fetcher = vi.fn(async () => okPage(9));
        const page = await withPlatformSearchCache(cache, 'k' as PlatformSearchCacheKey, fetcher);
        expect(page.items).toHaveLength(2);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('命中已过期时返回旧值并在后台刷新', async () => {
        const {cache, set} = fakeCache({expired: true, seed: okPage(2)});
        const page = await withPlatformSearchCache(cache, 'k' as PlatformSearchCacheKey, async () => okPage(5));
        expect(page.items).toHaveLength(2); // 本次仍返回旧值，不阻塞
        // 后台刷新异步写回，等一个微任务周期
        await new Promise(r => setTimeout(r, 0));
        expect(set).toHaveBeenCalledTimes(1);
    });

    it('失败结果（带 message）不写缓存', async () => {
        const {cache, set} = fakeCache();
        const failed: PlatformSearchPage = {
            items: [],
            pageInfo: {page: 1, pageSize: 20, total: null, totalPages: null, hasMore: false},
            message: '__RATE_LIMITED__',
        };
        await withPlatformSearchCache(cache, 'platform-search-x' as PlatformSearchCacheKey, async () => failed);
        expect(set).not.toHaveBeenCalled();
    });

    it('空结果不写缓存，避免偶然空响应被长期固化', async () => {
        const {cache, set} = fakeCache();
        await withPlatformSearchCache(cache, 'platform-search-x' as PlatformSearchCacheKey, async () => okPage(0));
        expect(set).not.toHaveBeenCalled();
    });
});
