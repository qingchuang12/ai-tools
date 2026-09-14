/**
 * 测试2（第三批）：各平台 adapter 的映射函数单测。
 * 喂缺字段 / 空 payload / 畸形对象，断言不抛错且返回结构稳定（防 P2-13）。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {clawhubAdapter, mapEntry as mapClawhub} from '../main/platforms/clawhub';
import {mapEntry as mapSkillhub, skillhubAdapter} from '../main/platforms/skillhub';
import {mapEntry as mapSkillsmp, skillsmpAdapter} from '../main/platforms/skillsmp';
import {mapMCPServer, mapSkill, modelscopeAdapter} from '../main/platforms/modelscope';
import {bailianAdapter, mapServer} from '../main/platforms/bailian';
import {cozeAdapter, mapCozeSkill} from '../main/platforms/coze';
import {getAdapter, listAdapters} from '../main/platforms/registry';
import {toListItem} from '../main/resolvers/pagination';
import {
    OFFLINE_INDEX_PLATFORMS,
    PLATFORM_HEALTH_PATHS,
    PLATFORM_META,
    PLATFORM_SKILL_DOWNLOAD,
    SKILL_PLATFORM_TYPES,
} from '../shared/platform-constants';

// 各类缺字段 / 空 / 畸形的 raw 对象输入，均不应抛出
// （调用方始终传入对象，null/undefined 不在契约内，故不测）
const NASTY_INPUTS = [{}, {unknownField: 'x'}, {id: ''}, {slug: null}, {native: {skill: {categories: null}}}];

describe('clawhub.mapEntry', () => {
    it('缺字段不抛错，id 兜底为空串', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapClawhub(raw)).not.toThrow();
        }
        const item = mapClawhub({});
        expect(item.source).toBe('clawhub');
        expect(typeof item.id).toBe('string');
        expect(item.downloadUrl).toContain('clawhub');
    });

    it('正常字段映射', () => {
        const item = mapClawhub({slug: 'foo', displayName: 'Foo', summary: 'desc'});
        expect(item.id).toBe('foo');
        expect(item.name).toBe('Foo');
        expect(item.description).toBe('desc');
    });

    // E1（plan-9.0）：downloadUrl 对齐 D3 口径——GitHub 仓库保留，其余给站内 zip 直链
    it('downloadUrl：GitHub 仓库保留，平台页地址改给 zip 直链', () => {
        const gh = mapClawhub({slug: 'foo', repoUrl: 'https://github.com/o/r'});
        expect(gh.downloadUrl).toBe('https://github.com/o/r');
        const zip = mapClawhub({slug: 'planning-with-files'});
        expect(zip.downloadUrl).toBe('https://clawhub.ai/api/v1/download?slug=planning-with-files');
    });
});

describe('clawhub.fetchSkillDownload', () => {
    it('按实测契约生成 zip 直链', async () => {
        const res = await clawhubAdapter.fetchSkillDownload!({baseUrl: '', skillId: 'planning-with-files'});
        expect(res.downloadUrl).toBe('https://clawhub.ai/api/v1/download?slug=planning-with-files');
    });

    it('空 slug 明确报错，不产出无效直链', async () => {
        await expect(clawhubAdapter.fetchSkillDownload!({baseUrl: '', skillId: '  '})).rejects.toThrow(/slug/);
    });
});

describe('clawhub.mapEntry ownerHandle / stars / sourceUrl', () => {
    it('歧义 slug 编码为 ownerHandle/slug，downloadUrl 带 ownerHandle（P0 修复）', () => {
        const item = mapClawhub({slug: 'answeroverflow', ownerHandle: 'rhyssullivan', displayName: 'Answer Overflow'});
        expect(item.id).toBe('rhyssullivan/answeroverflow');
        expect(item.downloadUrl).toBe('https://clawhub.ai/api/v1/download?slug=answeroverflow&ownerHandle=rhyssullivan');
    });

    it('无 ownerHandle 时回退纯 slug（兼容旧行为）', () => {
        const item = mapClawhub({slug: 'planning-with-files'});
        expect(item.id).toBe('planning-with-files');
        expect(item.downloadUrl).toBe('https://clawhub.ai/api/v1/download?slug=planning-with-files');
    });

    it('stars 取自 native.skill.stats.stars（P2-1 修复）', () => {
        const item = mapClawhub({slug: 'foo', native: {skill: {stats: {stars: 42}}}});
        expect(item.stars).toBe(42);
    });

    it('sourceUrl 优先用 canonicalUrl（P2-2 修复）', () => {
        const item = mapClawhub({slug: 'foo', canonicalUrl: '/rhyssullivan/skills/foo'});
        expect(item.sourceUrl).toBe('https://clawhub.ai/rhyssullivan/skills/foo');
    });

    // D2b：Convex 顶层无 author 字段，旧实现只传 raw.author → 渲染层回退成 item.source
    // 使得每张卡片都显示 "@clawhub"。改用 ownerHandle 兜底，展示真实发布者。
    it('D2b: 无 raw.author 时 author 兜底为 ownerHandle（不再是 @clawhub）', () => {
        const item = mapClawhub({slug: 'answeroverflow', ownerHandle: 'rhyssullivan'});
        expect(item.extra?.author).toBe('rhyssullivan');
    });

    it('D2b: raw.author 存在时优先于 ownerHandle', () => {
        const item = mapClawhub({slug: 'foo', ownerHandle: 'rhyssullivan', author: 'explicit-author'});
        expect(item.extra?.author).toBe('explicit-author');
    });

    it('D2b: 两者都无时 author 为 undefined（交给渲染层回退，不产生假作者）', () => {
        const item = mapClawhub({slug: 'foo'});
        expect(item.extra?.author).toBeUndefined();
    });
});

describe('clawhub.fetchSkillDownload ownerHandle（P0 修复）', () => {
    it('ownerHandle/slug 解析出带 ownerHandle 的直链', async () => {
        const res = await clawhubAdapter.fetchSkillDownload!({baseUrl: '', skillId: 'rhyssullivan/answeroverflow'});
        expect(res.downloadUrl).toBe('https://clawhub.ai/api/v1/download?slug=answeroverflow&ownerHandle=rhyssullivan');
    });
});

describe('skillhub.mapEntry', () => {
    it('缺字段不抛错', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapSkillhub(raw)).not.toThrow();
        }
        const item = mapSkillhub({});
        expect(item.source).toBe('skillhub');
        expect(item.sourceUrl).toContain('skillhub.cn');
    });

    it('categoryName 映射官方中文名', () => {
        const item = mapSkillhub({slug: 'x', category: 'office-efficiency'});
        expect(item.categoryName).toBe('办公效率');
        // 未命中官方分类的 slug 回退为空，避免显示英文 slug
        expect(mapSkillhub({slug: 'y', category: 'not-a-cat'}).categoryName).toBeUndefined();
    });

    // E1（plan-9.0）：downloadUrl 对齐 D3 口径——GitHub upstream 保留，SPA 详情页改给 zip 直链
    it('downloadUrl：GitHub upstream 保留，详情页地址改给 zip 直链', () => {
        const gh = mapSkillhub({slug: 'foo', upstream_url: 'https://github.com/o/r'});
        expect(gh.downloadUrl).toBe('https://github.com/o/r');
        const zip = mapSkillhub({slug: 'tencent-docs'});
        expect(zip.downloadUrl).toBe('https://api.skillhub.cn/api/v1/download?slug=tencent-docs');
        // upstream 为非 GitHub 站点时同样走 zip 直链
        expect(mapSkillhub({slug: 'bar', upstream_url: 'https://example.com/a'}).downloadUrl).toBe(
            'https://api.skillhub.cn/api/v1/download?slug=bar'
        );
    });
});

describe('skillhub.fetchSkillDownload', () => {
    it('按实测契约生成 zip 直链（固定 API 域名，不拼站点 baseUrl）', async () => {
        const res = await skillhubAdapter.fetchSkillDownload!({
            baseUrl: 'https://skillhub.cn',
            skillId: 'tencent-docs',
        });
        expect(res.downloadUrl).toBe('https://api.skillhub.cn/api/v1/download?slug=tencent-docs');
    });

    it('空 slug 明确报错，不产出无效直链', async () => {
        await expect(skillhubAdapter.fetchSkillDownload!({baseUrl: '', skillId: ''})).rejects.toThrow(/slug/);
    });
});

describe('skillsmp.mapEntry', () => {
    it('缺字段不抛错，category 仅透传服务端字段', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapSkillsmp(raw)).not.toThrow();
        }
        const item = mapSkillsmp({});
        expect(item.source).toBe('skillsmp');
        expect(item.category).toBeUndefined();
    });

    // D7：真实响应里的安装源字段是 githubUrl，旧实现漏读导致可安装条目被拼成平台页地址。
    it('安装源优先取真实字段 githubUrl', () => {
        const item = mapSkillsmp({
            id: 'x',
            githubUrl: 'https://github.com/o/r',
            repoUrl: 'https://skillsmp.com/skills/x',
        });
        expect(item.sourceUrl).toBe('https://github.com/o/r');
        expect(item.downloadUrl).toBe('https://github.com/o/r');
    });

    it('无 githubUrl 时回退 repoUrl / repo / 平台详情页', () => {
        expect(mapSkillsmp({id: 'x', repoUrl: 'https://example.com/a'}).sourceUrl).toBe('https://example.com/a');
        expect(mapSkillsmp({id: 'x', repo: 'o/r'}).sourceUrl).toBe('o/r');
        expect(mapSkillsmp({id: 'x'}).sourceUrl).toBe('https://skillsmp.com/skills/x');
    });

    // plan-10.0：上游无 category 过滤（实测任何取值 400），旧实现把请求级 category
    // 回填到每条结果上，等于给未过滤结果贴分类标签——纯误导，已删除。
    it('不再用请求级 category 回填条目，仅透传服务端自带分类', () => {
        expect(mapSkillsmp({id: 'x'}).category).toBeUndefined();
        expect(mapSkillsmp({id: 'x', category: 'real-cat'}).category).toBe('real-cat');
    });

    describe('skillsmp.getFacets（F：上游真实支持叶子分类过滤）', () => {
        it('声明 12 父域 + 63 叶子分类，且每个父域都有叶子', () => {
            const f = skillsmpAdapter.getFacets!('skills');
            expect(f.supportsSubcategories).toBe(true);
            expect(f.categories).toHaveLength(12);
            const leaves = f.categories.flatMap(d => d.children ?? []);
            expect(leaves).toHaveLength(63);
            // 空分组的父域会渲染成「不可选又没有内容」的 optgroup，必须避免
            expect(f.categories.every(d => (d.children ?? []).length > 0)).toBe(true);
            // 叶子 id 既是 <option value> 也是上游过滤值，重复即歧义
            expect(new Set(leaves.map(l => l.id)).size).toBe(63);
        });

        it('父域 slug 不得混进叶子集合（上游对父域一律 400 INVALID_CATEGORY）', () => {
            const f = skillsmpAdapter.getFacets!('skills');
            const leafIds = new Set(f.categories.flatMap(d => (d.children ?? []).map(l => l.id)));
            for (const domainId of ['development', 'devops', 'tools', 'databases', 'research', 'business']) {
                expect(leafIds.has(domainId)).toBe(false);
            }
            // 反向抽查：真实叶子必须在内
            for (const leafId of ['backend', 'llm-ai', 'cicd', 'testing', 'defi']) {
                expect(leafIds.has(leafId)).toBe(true);
            }
        });

        it('排序只声明上游真做到的 stars / updated（假控件「相关度」已下线）', () => {
            const f = skillsmpAdapter.getFacets!('skills');
            expect(f.sortOptions.map(s => s.id)).toEqual(['stars', 'updated']);
            // updated 的上游 sortBy 值是 recent（实测有效），映射信息必须保留
            expect(f.sortOptions.find(s => s.id === 'updated')?.field).toBe('recent');
            expect(f.sortOptions.some(s => s.id === 'relevance')).toBe(false);
        });
    });
});

describe('skillsmp.searchSkills 参数透传（F：空值/非法值绝不发出，防上游 400）', () => {
    const realFetch = globalThis.fetch;
    let urls: string[];

    const jsonRes = (payload: unknown) =>
        ({
            ok: true,
            status: 200,
            headers: {get: () => 'application/json; charset=utf-8'},
            text: async () => JSON.stringify(payload),
        }) as unknown as Response;

    beforeEach(() => {
        urls = [];
        vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
            urls.push(String(url));
            return jsonRes({skills: [], pagination: {}});
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        globalThis.fetch = realFetch;
    });

    const run = (category?: string, sort?: string) =>
        skillsmpAdapter.searchSkills!({query: 'skill', page: 1, pageSize: 5, baseUrl: '', category, sort});

    it('未选分类时不带 category 参数（空占位会 400）', async () => {
        await run();
        expect(urls.length).toBeGreaterThan(0);
        for (const u of urls) expect(u).not.toContain('category=');
    });

    it('选中合法叶子分类时带上 category', async () => {
        await run('backend');
        expect(urls[0]).toContain('category=backend');
    });

    it('非法分类（应用层内置类目 / 父域 slug）一律不透传', async () => {
        for (const bad of ['coding', 'data-analytics', 'content-writing', 'development', 'devops', 'tools']) {
            urls = [];
            await run(bad);
            expect(urls.length).toBeGreaterThan(0);
            for (const u of urls) expect(u).not.toContain('category=');
        }
    });

    it('sort 映射：stars→stars、updated→recent，其余（含默认 relevance）省略参数', async () => {
        urls = [];
        await run('backend', 'stars');
        expect(urls[0]).toContain('sortBy=stars');

        urls = [];
        await run('backend', 'updated');
        expect(urls[0]).toContain('sortBy=recent');

        urls = [];
        await run('backend', 'relevance');
        expect(urls[0]).not.toContain('sortBy=');
    });

    it('选中分类后即使降级也不丢 category（绝不退回未过滤结果）', async () => {
        await run('backend');
        // 模板集降级只允许丢 sortBy，任何一次尝试都必须仍然带 category
        for (const u of urls) expect(u).toContain('category=backend');
    });
});

describe('modelscope.mapSkill / mapMCPServer', () => {
    it('mapSkill 缺字段不抛错', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapSkill(raw)).not.toThrow();
        }
        const item = mapSkill({});
        expect(item.source).toBe('modelscope');
        expect(item.sourceUrl).toContain('modelscope.cn');
    });

    it('mapMCPServer 缺字段不抛错', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapMCPServer(raw)).not.toThrow();
        }
        const item = mapMCPServer({});
        expect(item.source).toBe('modelscope');
        expect(item.categories).toEqual([]);
        expect(item.tags).toEqual([]);
    });
});

describe('bailian.mapServer', () => {
    it('缺字段不抛错，id 采用稳定编码且与下标无关', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapServer(raw, 0)).not.toThrow();
        }
        const item = mapServer({serverName: 'svc', source: 'ALIYUN'}, 3);
        expect(item.id).toBe('bailian:ALIYUN:svc');
        // id 不再依赖切片下标（翻页/排序/过滤后详情仍可回查）
        expect(mapServer({serverName: 'svc', source: 'ALIYUN'}, 0).id).toBe(item.id);
        expect(mapServer({serverName: 'svc', source: 'ALIYUN'}, 99).id).toBe(item.id);
        expect(item.isVerified).toBe(true);
        expect(item.source).toBe('bailian');
    });

    it('在线形态（含 serverCode）id 采用 serverCode，extra 透出 serverCode（2026-09-14 在线化）', () => {
        const withCode = mapServer({serverName: '快递100', serverCode: 'kuaidi100-mcp', source: 'PARTNER'}, 0);
        expect(withCode.id).toBe('bailian:kuaidi100-mcp');
        expect(withCode.extra?.serverCode).toBe('kuaidi100-mcp');
        expect(withCode.sourceUrl).toContain('kuaidi100-mcp');
        // 缺 serverCode 时回退旧稳定编码（不破坏既有 id 契约）
        const legacy = mapServer({serverName: 'svc', source: 'ALIYUN'}, 5);
        expect(legacy.id).toBe('bailian:ALIYUN:svc');
        expect(legacy.extra?.serverCode).toBeNull();
    });
});

/**
 * 百炼客户端排序回归（本次完善）。
 *
 * 缺陷：排序把 **sort 的 id** 当 **字段名** 取（`(a as any)['users']` → undefined → 0），
 * 比较器恒返回 0 → 排序静默失效；同时方向由 `sort==='users' ? -1 : 1` 硬编码，
 * 与 SortOption 里标注的 `order:'desc'` 相抵（即便取到字段也会反向）。
 * 这里驱动真实适配器 + 内置索引，断言每种排序都真正改变结果顺序。
 */
describe('bailian.fetchServerDetail', () => {
    it('使用列表稳定 ID 回查离线索引，并返回远程托管详情', async () => {
        const page = await bailianAdapter.searchServers({query: '', page: 1, pageSize: 1, baseUrl: ''});
        const listItem = page.items[0];
        const detail = await bailianAdapter.fetchServerDetail!({query: '', page: 1, pageSize: 1, baseUrl: ''}, listItem.id);

        expect(detail.id).toBe(listItem.id);
        expect(detail.source).toBe('bailian');
        expect(detail.sourceUrl).toContain('bailian.console.aliyun.com/#/mcp/server/');
        // 远程托管型安装：返回 URL 接入点（SSE）而非 null，详情页据此放通安装
        const install = detail.install as {url: string; type: string; headersTemplate?: Record<string, string>} | null;
        expect(install).not.toBeNull();
        expect(install!.url).toMatch(/^https:\/\/dashscope\.aliyuncs\.com\/api\/v1\/mcps\/[^/]+\/sse$/);
        expect(install!.type).toBe('sse');
        // 鉴权头模板化：${KEY} 占位符由安装模态的环境变量输入填充（不硬编码键名于 UI）
        expect(install!.headersTemplate).toEqual({Authorization: 'Bearer ${DASHSCOPE_API_KEY}'});
        // envSchema 要求填写百炼 API Key
        const envSchema = detail.envSchema as {required?: string[]};
        expect(envSchema.required).toContain('DASHSCOPE_API_KEY');
        // readme 附带接入说明（slug 可能与显示名不同，需提示以控制台「接入地址」为准）
        expect(detail.readme).toContain('接入地址');
        expect(detail.extra?.mode).toBe('remote');
    });

    it('不存在的稳定 ID 返回明确错误', async () => {
        await expect(
            bailianAdapter.fetchServerDetail!({query: '', page: 1, pageSize: 1, baseUrl: ''}, 'bailian:ALIYUN:not-found')
        ).rejects.toThrow('本地缓存中不存在');
    });
});

describe('bailian 客户端排序', () => {
    type MaybeExtra = {extra?: Record<string, unknown>};
    const params = (sort: string) => ({query: '', page: 1, pageSize: 50, sort, baseUrl: ''});
    const nums = (items: MaybeExtra[], key: string) => items.map(i => Number(i.extra?.[key] ?? 0));
    const isDesc = (a: number[]) => a.every((v, i) => i === 0 || a[i - 1] >= v);

    it('users 按 activateUserCount 降序（修复前恒等于原始序）', async () => {
        const r = await bailianAdapter.searchServers(params('users'));
        const v = nums(r.items, 'activateUserCount');
        expect(v.length).toBeGreaterThan(1);
        expect(isDesc(v)).toBe(true);
    });

    it('calls（默认）按 callTotalCount 降序', async () => {
        const r = await bailianAdapter.searchServers(params('calls'));
        expect(isDesc(nums(r.items, 'callTotalCount'))).toBe(true);
    });

    it('name 按名称升序', async () => {
        const r = await bailianAdapter.searchServers(params('name'));
        const names = r.items.map(i => i.name);
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it('sortOptions 的 field 被真实消费（id 不再被当字段名）', async () => {
        const facets = await bailianAdapter.getFacets!();
        expect(facets.sortOptions.find(s => s.id === 'users')?.field).toBe('activateUserCount');
        const r = await bailianAdapter.searchServers(params('users'));
        expect(nums(r.items, 'activateUserCount')).toEqual(
            [...nums(r.items, 'activateUserCount')].sort((a, b) => b - a)
        );
    });
});

/**
 * 「全部」哨兵值回归（2026-09-12 商店-MCP-百炼空列表修复）。
 *
 * 缺陷：searchServers 把哨兵值写成大写 'ALL'，而渲染层 useMcpData 固定传
 * `category || 'all'` / `source || 'all'`（小写），下拉框「全部」的 value 同为 'all'
 * → 默认筛选永不命中 → 251 条全被过滤 → 列表恒为空（选具体分类也无效，source 仍为 'all'）。
 * 契约：与 modelscope/npm 一致，哨兵值一律小写 'all'。
 */
describe('bailian 「全部」哨兵值（渲染层契约）', () => {
    it("渲染层默认值 category='all' 不过滤任何条目", async () => {
        const baseline = await bailianAdapter.searchServers({query: '', page: 1, pageSize: 20, baseUrl: ''});
        const r = await bailianAdapter.searchServers({query: '', page: 1, pageSize: 20, category: 'all', baseUrl: ''});
        expect(baseline.pageInfo.total).toBeGreaterThan(0);
        expect(r.pageInfo.total).toBe(baseline.pageInfo.total);
    });

    it("渲染层默认值 source='all' 不过滤任何条目", async () => {
        const baseline = await bailianAdapter.searchServers({query: '', page: 1, pageSize: 20, baseUrl: ''});
        const r = await bailianAdapter.searchServers({query: '', page: 1, pageSize: 20, source: 'all', baseUrl: ''});
        expect(r.pageInfo.total).toBe(baseline.pageInfo.total);
    });

    it("category 与 source 同时为 'all'（商店默认请求形态）返回全量", async () => {
        const r = await bailianAdapter.searchServers({query: '', page: 1, pageSize: 20, category: 'all', source: 'all', baseUrl: ''});
        expect(r.pageInfo.total).toBeGreaterThan(0);
    });

    it('具体值仍真实过滤（哨兵修复不得破坏筛选）', async () => {
        const all = await bailianAdapter.searchServers({query: '', page: 1, pageSize: 20, category: 'all', source: 'all', baseUrl: ''});
        const aliyun = await bailianAdapter.searchServers({query: '', page: 1, pageSize: 20, category: 'all', source: 'ALIYUN', baseUrl: ''});
        expect(aliyun.pageInfo.total).toBeGreaterThan(0);
        expect(aliyun.pageInfo.total).toBeLessThan(all.pageInfo.total);
    });
});

/** 模拟一次成功的 Convex RPC 响应（path=search:searchSkills，value 为数组）。 */
function convexResponse(items: unknown[]) {
    return {
        ok: true,
        status: 200,
        json: async () => ({status: 'success', value: items}),
    };
}

describe('clawhub 运行时离线缓存（替代写死静态索引）', () => {
    let tmp: string;
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawhub-cache-'));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        globalThis.fetch = realFetch;
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('在线成功累积缓存，断网后回退到累积的离线索引', async () => {
        const params = {query: 'a', page: 1, pageSize: 20, baseUrl: '', cacheDir: tmp};

        vi.stubGlobal('fetch', vi.fn(async () => convexResponse([
            {slug: 's1', name: 'S1', summary: 'desc1'},
            {slug: 's2', name: 'S2', summary: 'desc2'},
        ])));
        const online = await clawhubAdapter.searchSkills!(params);
        expect(online.items).toHaveLength(2);

        // 缓存文件已写入，条目按 id 去重
        const cacheFile = path.join(tmp, 'clawhub', 'offline-index.json');
        expect(fs.existsSync(cacheFile)).toBe(true);
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        expect(cached.skills).toHaveLength(2);

        // 断网后回退到累积缓存
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const offline = await clawhubAdapter.searchSkills!(params);
        expect(offline.items.map(i => i.id).sort()).toEqual(['s1', 's2']);
        expect(offline.complete).toBe(true);
    });

    it('重复累积按 id 去重，新条目覆盖旧条目', async () => {
        const cacheDir = path.join(tmp, 'clawhub');
        fs.mkdirSync(cacheDir, {recursive: true});
        fs.writeFileSync(path.join(cacheDir, 'offline-index.json'), JSON.stringify({
            skills: [{slug: 's1', name: 'Old', summary: 'old-desc'}],
        }), 'utf8');

        vi.stubGlobal('fetch', vi.fn(async () => convexResponse([
            {slug: 's1', name: 'S1', summary: 'new-desc'},
            {slug: 's2', name: 'S2', summary: 'desc2'},
        ])));
        await clawhubAdapter.searchSkills!({query: 'a', page: 1, pageSize: 20, baseUrl: '', cacheDir: tmp});

        const cached = JSON.parse(fs.readFileSync(path.join(tmp, 'clawhub', 'offline-index.json'), 'utf8'));
        expect(cached.skills).toHaveLength(2);
        const s1 = cached.skills.find((s: {slug: string}) => s.slug === 's1');
        expect(s1.summary).toBe('new-desc');
    });
});

describe('coze.mapCozeSkill', () => {
    it('缺字段不抛错，id 兜底', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapCozeSkill(raw)).not.toThrow();
        }
        const item = mapCozeSkill({});
        expect(item.source).toBe('coze');
        expect(item.sourceUrl).toContain('coze.com');
        expect(typeof item.id).toBe('string');
    });

    it('分类中文与榜单数值字段映射', () => {
        const item = mapCozeSkill({
            id: 'a', name: 'n', category: ['数据分析'], owner_name: '虾', current_version: '1.0.0',
            downloads: 100, avg_stars: 490, star_count: 8, comment_count: 3, requires_api_key: true,
        });
        expect(item.category).toBe('数据分析');
        expect(item.categoryName).toBe('数据分析');
        expect(item.downloads).toBe(100);
        expect(item.stars).toBe(490);
        expect(item.extra?.author).toBe('虾');
        expect(item.extra?.version).toBe('1.0.0');
        expect(item.extra?.commentCount).toBe(3);
        expect(item.extra?.requiresApiKey).toBe(true);
        expect(item.extra?.categories).toEqual(['数据分析']);
    });

    it('多分类完整透传且去重去空，主分类取第一个', () => {
        const item = mapCozeSkill({id: 'a', name: 'n', category: ['开发辅助', ' 办公与效率 ', '开发辅助', '', null as unknown as string]});
        expect(item.extra?.categories).toEqual(['开发辅助', '办公与效率']);
        expect(item.category).toBe('开发辅助');
        expect(mapCozeSkill({id: 'b', name: 'm'}).extra?.categories).toEqual([]);
    });
});

describe('coze.getFacets', () => {
    it('返回官方 8 分类与白名单排序', () => {
        const f = cozeAdapter.getFacets!('skills');
        expect(f.categories).toHaveLength(8);
        expect(f.categories[0].id).toBe('效率工具');
        expect(f.categories[0].name).toBe('效率工具');
        expect(f.sortOptions.map(s => s.id)).toEqual(['avg_stars', 'downloads', 'comment_count']);
        expect(f.supportsSubcategories).toBe(false);
    });
});

/**
 * PLATFORM_SKILL_DOWNLOAD 是渲染层判断「该源能否安装」的依据，而真正的事实源是
 * 适配器是否实现 fetchSkillDownload。两者一旦脱节，UI 会允许安装一个主进程装不了的源，
 * 正是此前「提示成功实际没装」的成因，故用测试**双向**守卫同步。
 */
describe('PLATFORM_SKILL_DOWNLOAD 与适配器实现同步', () => {
    it('正向：列表内的平台必须实现 fetchSkillDownload', () => {
        for (const p of PLATFORM_SKILL_DOWNLOAD) {
            const adapter = getAdapter(p);
            expect(adapter, `平台 ${p} 缺少适配器`).not.toBeNull();
            expect(typeof adapter!.fetchSkillDownload, `平台 ${p} 未实现 fetchSkillDownload`).toBe('function');
        }
    });

    it('反向：实现了 fetchSkillDownload 的平台必须登记在列表内', () => {
        for (const adapter of listAdapters()) {
            if (typeof adapter.fetchSkillDownload === 'function') {
                expect(PLATFORM_SKILL_DOWNLOAD, `平台 ${adapter.id} 实现了下载通道却未登记`).toContain(adapter.id);
            }
        }
    });

    // D1：ModelScope 有匿名 zip 直链通道，必须登记，否则其技能源在商店里无法安装
    //（正是川哥主诉「modelscope 安装基本失败」的其中一环）。
    it('ModelScope 已登记且实现下载通道', () => {
        expect(PLATFORM_SKILL_DOWNLOAD).toContain('modelscope');
        expect(typeof getAdapter('modelscope')!.fetchSkillDownload).toBe('function');
    });
});

describe('modelscope.fetchSkillDownload', () => {
    it('按实测契约生成 zip 直链', async () => {
        const res = await modelscopeAdapter.fetchSkillDownload!({baseUrl: '', skillId: 'o/r'});
        expect(res.downloadUrl).toBe('https://www.modelscope.cn/skills/o/r/archive/zip/master');
        expect(res.downloadUrl).toContain('/archive/zip/master');
    });

    it('使用调用方传入的 baseUrl（忽略尾部斜杠）', async () => {
        const res = await modelscopeAdapter.fetchSkillDownload!({
            baseUrl: 'https://www.modelscope.cn/',
            skillId: 'o/r',
        });
        expect(res.downloadUrl).toBe('https://www.modelscope.cn/skills/o/r/archive/zip/master');
    });

    it('owner 含 @ 时保留 @（不编码成 %40）', async () => {
        const res = await modelscopeAdapter.fetchSkillDownload!({baseUrl: '', skillId: 'team@corp/tool'});
        expect(res.downloadUrl).toContain('/skills/team@corp/tool/archive/zip/master');
    });

    it('空 skillId 明确报错，不产出 404 直链', async () => {
        await expect(modelscopeAdapter.fetchSkillDownload!({baseUrl: '', skillId: '   '})).rejects.toThrow(/技能 ID/);
    });
});

describe('modelscope.mapSkill downloadUrl', () => {
    // D3：下载直链必须与 resolvers/pagination.ts 的合成逻辑一致；
    // 旧实现直接令 downloadUrl=sourceUrl（平台页地址），导致点安装后下载到 HTML。
    it('source_url 为空时合成 zip 直链', () => {
        const item = mapSkill({id: 'PantherAng/alipay-payment-integration'});
        expect(item.sourceUrl).toBe('https://modelscope.cn/PantherAng/alipay-payment-integration');
        expect(item.downloadUrl).toBe(
            'https://www.modelscope.cn/skills/PantherAng/alipay-payment-integration/archive/zip/master'
        );
    });

    it('downloadUrl 与 resolvers/pagination.ts 的 toListItem 完全一致（D3 同逻辑交叉验证）', () => {
        const inputs = [
            {id: 'o/r'},
            {id: 'o/r', source_url: 'https://github.com/o/r'},
            {id: 'o/r', source_url: 'https://modelscope.cn/o/r'},
            {id: 'o/r', download_url: 'https://cdn.example.com/x.zip'},
        ];
        for (const c of inputs) {
            expect(mapSkill(c).downloadUrl).toBe(toListItem(c, 'modelscope').downloadUrl);
        }
    });

    it('服务端返回 download_url 时优先使用', () => {
        const item = mapSkill({id: 'o/r', download_url: 'https://cdn.example.com/x.zip'});
        expect(item.downloadUrl).toBe('https://cdn.example.com/x.zip');
    });

    it('owner 含 @ 时保留 @', () => {
        const item = mapSkill({id: 'team@corp/tool'});
        expect(item.downloadUrl).toContain('/skills/team@corp/tool/archive/zip/master');
    });
});

describe('coze.fetchSkillDownload', () => {
    it('未绑定 key 时给出明确指引，不发请求', async () => {
        await expect(
            cozeAdapter.fetchSkillDownload!({baseUrl: 'https://xiaping.coze.com', skillId: 'x', secret: null})
        ).rejects.toThrow(/API Key/);
    });
});

// ============ plan-8.0 B2：SafeSkill 收口 / 探活假绿 / 孤儿常量 ============

describe('SafeSkill 源收口（D8/D9）', () => {
    // D8：safeskill 站点未开放列表接口（文档声明的 /v1/search 线上未部署，实测 404），
    // 旧占位映射指向 skillhubAdapter，空 baseUrl 会静默回退 api.skillhub.cn 串出别家数据。
    it('D8: safeskill 不再注册 adapter（getAdapter 返回 null）', () => {
        expect(getAdapter('safeskill')).toBeNull();
    });

    it('D8: listAdapters 不含 safeskill，且 skillhub 只注册一次', () => {
        const ids = listAdapters().map(a => a.id);
        expect(ids).not.toContain('safeskill');
        expect(ids.filter(id => id === 'skillhub')).toHaveLength(1);
    });

    it('D8: 其余平台 adapter 不受影响', () => {
        expect(getAdapter('skillhub')).not.toBeNull();
        expect(getAdapter('modelscope')).not.toBeNull();
        expect(getAdapter('coze')).not.toBeNull();
    });

    // D9：探活 '/' 恒 200 → 连接被误判可用且提示「搜索时将回退页面解析」，
    // 而 SafeSkill 根本没有页面解析实现——探活假绿。未配置路径 → connections-store 如实报错。
    it('D9: safeskill 不再配置探活路径（不再假绿）', () => {
        expect(PLATFORM_HEALTH_PATHS.safeskill).toBeUndefined();
    });

    // 离线索引源同样不该有探活路径：bailian 的数据随应用分发，探它的控制台首页
    // 只会得到假绿（HTTP 200）或假红（需登录）。verify() 依据 OFFLINE_INDEX_PLATFORMS
    // 把它与「无公开接口」的 safeskill 区分开：前者如实报「离线可用」，后者报「无法验证」。
    it('D9: 离线索引源 bailian 不配置探活路径，且登记在 OFFLINE_INDEX_PLATFORMS', () => {
        expect(PLATFORM_HEALTH_PATHS.bailian).toBeUndefined();
        expect(OFFLINE_INDEX_PLATFORMS).toContain('bailian');
    });

    it('D9: safeskill 属于「无公开接口」而非「离线可用」，不得进离线清单', () => {
        expect(OFFLINE_INDEX_PLATFORMS).not.toContain('safeskill');
    });

    // E5（2026-09-12 拍板）：该源只有 SPA 壳页、永远不可能工作，从可选清单下线。
    // 但类型与 PLATFORM_META 必须保留 —— 存量连接靠 PLATFORM_META.label 渲染为只读项
    // （SourceManager 的 unknownPlatformFallback 分支），一并删除会让存量连接显示成原始 slug。
    it('E5: safeskill 已从 SKILL_PLATFORM_TYPES 下线（不可再新建该源）', () => {
        expect(SKILL_PLATFORM_TYPES).not.toContain('safeskill');
    });

    it('E5: safeskill 仍保留类型与 PLATFORM_META（存量连接只读展示依赖它）', () => {
        expect(PLATFORM_META.safeskill?.label).toBe('SafeSkill');
        expect(PLATFORM_META.safeskill?.defaultBaseUrl).toBe('https://safeskill.cn');
    });

    it('E5: 其余 Skill 源类型原样保留（防误删）', () => {
        for (const p of ['modelscope', 'skillhub', 'skillsmp', 'clawhub', 'coze'] as const) {
            expect(SKILL_PLATFORM_TYPES).toContain(p);
        }
    });

    it('D9: 其它平台的探活路径原样保留（防误删）', () => {
        expect(PLATFORM_HEALTH_PATHS.custom).toEqual(['/']);
        expect(PLATFORM_HEALTH_PATHS.skillhub).toContain('/api/skills?page=1&pageSize=1');
        expect(PLATFORM_HEALTH_PATHS.modelscope).toContain('/openapi/v1/skills?page_number=1&page_size=1');
    });
});

describe('导出面守卫（D15）', () => {
    // D15：旧的 SKILLSMP_CATEGORIES 是**孤儿常量**（零消费方）且 slug 取自站点父域（上游只认叶子，
    // 父域一律 400），故从 shared/platform-constants 删除。2026-09-12 模块 F 复测证明上游**支持**叶子
    // 分类过滤，分类树改以**模块私有常量**形式落在 platforms/skillsmp.ts（不导出），本守卫继续防止
    // 把这类平台专属数据重新塞回 shared 常量层。
    it('不再导出孤儿常量 SKILLSMP_CATEGORIES', async () => {
        const constants = await import('../shared/platform-constants');
        expect('SKILLSMP_CATEGORIES' in constants).toBe(false);
    });
});
