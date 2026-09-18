/**
 * npm 适配器单测：覆盖 searchServers 字段映射与 fetchServerDetail 的 install 形态。
 * 用 mock fetch 模拟 npm Registry 响应，避免真实网络依赖（参照 platform-adapters.test.ts 写法）。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    __setPrecacheForTest,
    __setRegistryIndexForTest,
    buildRegistryIndex,
    classifyNpmPackage,
    enrichWithRegistry,
    normalizeRepoUrl,
    NPM_CATEGORY_LABELS,
    npmAdapter,
} from '../main/platforms/npm';

const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search';
const NPM_PKG = 'https://registry.npmjs.org/';

describe('npmAdapter', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('id / name 标识正确', () => {
        expect(npmAdapter.id).toBe('npm');
        expect(npmAdapter.name).toBe('npm Registry');
    });

    it('searchServers 字段映射正确（默认带 keywords:mcp 降噪）', async () => {
        const params = {query: 'filesystem', page: 1, pageSize: 20, baseUrl: '', secret: null};
        const fakeResponse = {
            objects: [
                {
                    package: {
                        name: '@modelcontextprotocol/server-filesystem',
                        version: '1.0.0',
                        description: 'FileSystem MCP Server',
                        keywords: ['mcp', 'filesystem'],
                        links: {npm: 'https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem'},
                        publisher: {username: 'mcp'},
                        date: '2024-01-01T00:00:00.000Z',
                    },
                    score: {final: 0.9, quality: 0.8, popularity: 0.7, maintenance: 0.6},
                },
            ],
            total: 1,
        };
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            expect(url.startsWith(NPM_SEARCH)).toBe(true);
            expect(decodeURIComponent(url)).toContain('keywords:mcp');
            expect(decodeURIComponent(url)).toContain('filesystem');
            return {ok: true, status: 200, json: async () => fakeResponse};
        }));
        const page = await npmAdapter.searchServers!(params);
        expect(page.items).toHaveLength(1);
        const item = page.items[0];
        expect(item.id).toBe('npm-@modelcontextprotocol/server-filesystem');
        expect(item.name).toBe('@modelcontextprotocol/server-filesystem');
        expect(item.displayName).toBe('@modelcontextprotocol/server-filesystem');
        expect(item.description).toBe('FileSystem MCP Server');
        expect(item.source).toBe('npm');
        expect(item.sourceUrl).toBe('https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem');
        expect(item.author).toBe('mcp');
        expect(item.tags).toEqual(['mcp']);
        // 弱分类：keywords/filesystem + 包名含 filesystem → system
        expect(item.categories).toEqual(['system']);
        expect(item.categoryNames).toEqual(['本地系统']);
        expect(item.extra?.version).toBe('1.0.0');
        expect(item.extra?.score).toBe(0.9);
        expect(item.extra?.date).toBe('2024-01-01T00:00:00.000Z');
        expect(item.extra?.keywords).toEqual(['mcp', 'filesystem']);
        expect(page.pageInfo.total).toBe(1);
        expect(page.pageInfo.totalPages).toBe(1);
        expect(page.pageInfo.hasMore).toBe(false);
    });

    it('searchServers 分类+相关度走服务端真实分页：只发一次带代表词的查询，total 透传 npm', async () => {
        const params = {query: '', page: 1, pageSize: 2, baseUrl: '', secret: null, category: 'database'};
        const mk = (name: string, keywords: string[]) => ({
            package: {name, version: '1.0.0', description: name, keywords},
            score: {final: 0.5},
        });
        const urls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            // URLSearchParams 把空格编码为 '+'，decodeURIComponent 不会还原，需手动归一
            const decoded = decodeURIComponent(url).replace(/\+/g, ' ');
            urls.push(decoded);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    objects: [
                        mk('mcp-server-postgres', ['mcp', 'postgres']),
                        mk('mcp-server-mysql', ['mcp', 'mysql']),
                    ],
                    total: 99999,
                }),
            };
        }));
        const page = await npmAdapter.searchServers!(params);
        // 真实分页只发一次请求，query 为 mcp AND 分类代表词（NPM_FACET_TERM.database）
        expect(urls).toHaveLength(1);
        expect(urls[0]).toContain('keywords:mcp keywords:database');
        // 走服务端分页：按 pageSize 取、按页 offset，不再抓 top-100 候选池
        expect(urls[0]).toContain('from=0');
        expect(urls[0]).toContain('size=2');
        expect(urls[0]).not.toContain('size=100');
        // total/totalPages/hasMore 全部透传服务端计数（真实分页的关键）
        expect(page.pageInfo.total).toBe(99999);
        expect(page.pageInfo.totalPages).toBe(Math.ceil(99999 / 2));
        expect(page.pageInfo.hasMore).toBe(true);
    });

    it('searchServers 分类扇出全部失败时返回 __FETCH_FAILED__ 哨兵', async () => {
        const params = {query: '', page: 1, pageSize: 20, baseUrl: '', secret: null, category: 'database'};
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('network down');
        }));
        const page = await npmAdapter.searchServers!(params);
        expect(page.items).toEqual([]);
        expect(page.message).toBe('__FETCH_FAILED__');
        expect(page.pageInfo.total).toBeNull();
        expect(page.pageInfo.hasMore).toBe(false);
    });

    it('searchServers 分类分页的 total/totalPages/hasMore 由服务端 total 推导', async () => {
        const params = {query: '', page: 1, pageSize: 1, baseUrl: '', secret: null, category: 'database'};
        const mk = (name: string, keywords: string[]) => ({
            package: {name, version: '1.0.0', description: name, keywords},
            score: {final: 0.5},
        });
        const fakeResponse = {
            objects: [
                mk('mcp-server-postgres', ['mcp', 'postgres']),
                mk('mcp-server-mysql', ['mcp', 'mysql']),
            ],
            total: 71219,
        };
        vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, status: 200, json: async () => fakeResponse})));
        const page = await npmAdapter.searchServers!(params);
        // 无论本页 mock 返回多少条，分页边界一律由服务端 total 决定
        expect(page.items).toHaveLength(2);
        expect(page.pageInfo.total).toBe(71219);
        expect(page.pageInfo.totalPages).toBe(71219);
        expect(page.pageInfo.hasMore).toBe(true);
    });

    it('searchServers 无分类筛选时 total 仍透传服务端计数', async () => {
        const params = {query: '', page: 1, pageSize: 20, baseUrl: '', secret: null};
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({objects: [], total: 71219}),
        })));
        const page = await npmAdapter.searchServers!(params);
        expect(page.pageInfo.total).toBe(71219);
        expect(page.pageInfo.totalPages).toBe(3561);
    });

    it('searchServers sort=downloads（无分类）走 top-100 候选池并按月下载量降序重排，total 置 null', async () => {
        const params = {query: '', page: 1, pageSize: 20, baseUrl: '', secret: null, sort: 'downloads'};
        const mk = (name: string, monthly?: number) => ({
            package: {name, version: '1.0.0', description: name, keywords: ['mcp']},
            score: {final: 0.5},
            downloads: monthly === undefined ? undefined : {monthly, weekly: 1},
        });
        const fakeResponse = {
            objects: [mk('a-low', 10), mk('b-high', 9999), mk('c-none'), mk('d-mid', 500)],
            total: 4,
        };
        let captured = '';
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            captured = decodeURIComponent(url).replace(/\+/g, ' ');
            return {ok: true, status: 200, json: async () => fakeResponse};
        }));
        const page = await npmAdapter.searchServers!(params);
        // 下载量排序走池：from=0, size=100（而非只抓当前页 20 条再排那 20 条）
        expect(captured).toContain('from=0');
        expect(captured).toContain('size=100');
        // 缺失下载量按 0 处理，降序后 c-none 垫底
        expect(page.items.map(i => i.name)).toEqual(['b-high', 'd-mid', 'a-low', 'c-none']);
        expect(page.items[0].extra?.downloads).toEqual({monthly: 9999, weekly: 1});
        // 只重排相关度头部候选（top-100），全库计数未知：total/totalPages 置 null
        expect(page.pageInfo.total).toBeNull();
        expect(page.pageInfo.totalPages).toBeNull();
        expect(page.pageInfo.hasMore).toBe(false);
    });

    it('searchServers sort=relevance 保持 npm 原生顺序（不重排）', async () => {
        const params = {query: '', page: 1, pageSize: 20, baseUrl: '', secret: null, sort: 'relevance'};
        const mk = (name: string, monthly: number) => ({
            package: {name, version: '1.0.0', description: name, keywords: ['mcp']},
            score: {final: 0.5},
            downloads: {monthly, weekly: 1},
        });
        const fakeResponse = {objects: [mk('a-low', 10), mk('b-high', 9999)], total: 2};
        vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, status: 200, json: async () => fakeResponse})));
        const page = await npmAdapter.searchServers!(params);
        expect(page.items.map(i => i.name)).toEqual(['a-low', 'b-high']);
    });

    it('searchServers 网络失败返回 __FETCH_FAILED__ 哨兵（total 置 null）', async () => {
        const params = {query: '', page: 1, pageSize: 20, baseUrl: '', secret: null};
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('network down');
        }));
        const page = await npmAdapter.searchServers!(params);
        expect(page.items).toEqual([]);
        expect(page.message).toBe('__FETCH_FAILED__');
        expect(page.pageInfo.total).toBeNull();
        expect(page.pageInfo.hasMore).toBe(false);
    });

    it('fetchServerDetail 返回 npx -y <pkg>@<ver> 安装形态 + README + license', async () => {
        const fakeMeta = {
            name: '@modelcontextprotocol/server-filesystem',
            description: 'FileSystem MCP Server',
            'dist-tags': {latest: '1.2.3'},
            versions: {
                '1.2.3': {
                    description: 'FileSystem MCP Server',
                    bin: {'mcp-server-filesystem': 'bin/cli.js'},
                    engines: {node: '>=18'},
                    license: 'MIT',
                },
            },
            license: 'MIT',
            repository: {url: 'git+https://github.com/modelcontextprotocol/servers.git'},
            maintainers: [{name: 'mcp', email: 'mcp@example.com'}],
            readme: '# README',
        };
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            expect(url.startsWith(NPM_PKG)).toBe(true);
            expect(url).toContain('@modelcontextprotocol/server-filesystem');
            return {ok: true, status: 200, json: async () => fakeMeta};
        }));
        const detail = await npmAdapter.fetchServerDetail!(
            {query: '', page: 1, pageSize: 20, baseUrl: '', secret: null},
            'npm-@modelcontextprotocol/server-filesystem'
        );
        expect(detail.id).toBe('npm-@modelcontextprotocol/server-filesystem');
        expect(detail.name).toBe('@modelcontextprotocol/server-filesystem');
        expect(detail.source).toBe('npm');
        expect(detail.sourceUrl).toBe('https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem');
        expect(detail.author).toBe('mcp');
        expect(detail.install).toEqual({
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem@1.2.3'],
            env: {},
        });
        expect(detail.readme).toBe('# README');
        expect(detail.extra?.version).toBe('1.2.3');
        expect(detail.extra?.license).toBe('MIT');
        expect(detail.extra?.engines).toEqual({node: '>=18'});
        expect(detail.extra?.bin).toBe('bin/cli.js');
        expect(detail.extra?.repository).toEqual({url: 'git+https://github.com/modelcontextprotocol/servers.git'});
    });

    it('getFacets 返回 6 个扁平顶层弱分类（5 规则 + mcp 兜底）与排序选项', () => {
        const facets = npmAdapter.getFacets!('mcp');
        expect(facets.categories).toEqual([
            {id: 'devtools', name: '开发工具'},
            {id: 'database', name: '数据库'},
            {id: 'web-search', name: '生产力与搜索'},
            {id: 'system', name: '本地系统'},
            {id: 'office', name: '办公与协同'},
            {id: 'mcp', name: '其他 MCP'},
        ]);
        expect(facets.supportsSubcategories).toBe(true);
        expect(facets.sortOptions.map(s => s.id)).toEqual(['relevance', 'downloads']);
    });

    it('getFacets 的分类 id 不与其他平台冲突（search 为 modelscope/skillhub 共用）', () => {
        const ids = npmAdapter.getFacets!('mcp').categories.map(c => c.id);
        // ServerCard/SkillCard 对所有平台都用统一的 category.${cat} 解析，npm 不得复用 'search'
        expect(ids).not.toContain('search');
        expect(ids).toContain('web-search');
    });
});

describe('npm 弱分类 classifyNpmPackage', () => {
    it('filesystem 包（keywords + 命名空间）归入 system', () => {
        const r = classifyNpmPackage({
            name: '@modelcontextprotocol/server-filesystem',
            keywords: ['mcp', 'filesystem'],
        });
        expect(r).toEqual(['system']);
    });

    it('postgres 关键词归入 database', () => {
        expect(classifyNpmPackage({name: 'some-pkg', keywords: ['mcp', 'postgres']})).toEqual(['database']);
    });

    it('google/search 关键词命中 web-search（token search 仍生效，仅 id 改名）', () => {
        const r = classifyNpmPackage({name: 'some-pkg', keywords: ['mcp', 'google', 'search']});
        expect(r).toContain('web-search');
        expect(r).not.toContain('search');
    });

    it('slack 关键词归入 office', () => {
        expect(classifyNpmPackage({name: 'some-pkg', keywords: ['mcp', 'slack']})).toEqual(['office']);
    });

    it('github 关键词归入 devtools', () => {
        expect(classifyNpmPackage({name: 'some-pkg', keywords: ['mcp', 'github']})).toEqual(['devtools']);
    });

    it('仅有 mcp 关键词时回退到 mcp', () => {
        expect(classifyNpmPackage({name: 'some-pkg', keywords: ['mcp']})).toEqual(['mcp']);
    });

    it('中文判别词分类：搜索→web-search，数据库→database，办公→office', () => {
        expect(classifyNpmPackage({name: 'some-pkg', keywords: ['mcp', '搜索']})).toContain('web-search');
        expect(classifyNpmPackage({name: 'some-pkg', keywords: ['mcp', '数据库']})).toEqual(['database']);
        expect(classifyNpmPackage({name: 'some-pkg', keywords: ['mcp', '办公']})).toEqual(['office']);
    });

    it('未分词中文串按子串匹配：搜索引擎（单词元）→ web-search', () => {
        // 中文无分词边界：'搜索引擎' 在 CJK 感知 tokenize 下是单个词元，
        // 词元相等永远无法命中 '搜索'，必须走原始串子串匹配。
        expect(classifyNpmPackage({name: 'some-pkg', keywords: ['搜索引擎']})).toContain('web-search');
    });

    it('中文判别词也可由包名命中（子串匹配）', () => {
        expect(classifyNpmPackage({name: 'mcp-server-文件系统', keywords: ['mcp']})).toEqual(['system']);
    });

    it('英文分类行为不受中文规则影响：postgres → database，filesystem → system', () => {
        expect(classifyNpmPackage({name: 'some-pkg', keywords: ['mcp', 'postgres']})).toEqual(['database']);
        expect(classifyNpmPackage({name: 'some-pkg', keywords: ['mcp', 'filesystem']})).toEqual(['system']);
    });

    it('无 keywords 时按包名/命名空间判别（mcp-server-slack → office）', () => {
        expect(classifyNpmPackage({name: 'mcp-server-slack'})).toEqual(['office']);
    });

    it('每个分类 id 都有展示名', () => {
        expect(Object.keys(NPM_CATEGORY_LABELS).sort()).toEqual(
            ['database', 'devtools', 'mcp', 'office', 'system', 'web-search'].sort()
        );
    });

    it('file-system 连字符判别词是死代码：只有 file/system 词元，归入 system', () => {
        // tokenize 按非字母数字切词，'file-system' 不可能出现在词元集合里。
        // 旧实现里它是永假条件，导致 keywords:['mcp','file-system'] 错误回退到 ['mcp']。
        expect(classifyNpmPackage({name: 'some-pkg', keywords: ['mcp', 'file-system']})).toEqual(['system']);
    });

    it('每个分类对自身 id 自可达（选某分类时能命中自己）', () => {
        for (const id of ['devtools', 'database', 'web-search', 'system', 'office']) {
            expect(classifyNpmPackage({name: 'pkg', keywords: ['mcp', id]})).toContain(id);
        }
    });

    it('新增同义词提升召回：vscode/ide→devtools, mongodb/db→database, shell/cli/desktop→system, docs/calendar→office', () => {
        expect(classifyNpmPackage({name: 'pkg', keywords: ['mcp', 'vscode']})).toEqual(['devtools']);
        expect(classifyNpmPackage({name: 'pkg', keywords: ['mcp', 'ide']})).toEqual(['devtools']);
        expect(classifyNpmPackage({name: 'pkg', keywords: ['mcp', 'mongodb']})).toEqual(['database']);
        expect(classifyNpmPackage({name: 'pkg', keywords: ['mcp', 'db']})).toEqual(['database']);
        expect(classifyNpmPackage({name: 'pkg', keywords: ['mcp', 'shell']})).toEqual(['system']);
        expect(classifyNpmPackage({name: 'pkg', keywords: ['mcp', 'cli']})).toEqual(['system']);
        expect(classifyNpmPackage({name: 'pkg', keywords: ['mcp', 'desktop']})).toEqual(['system']);
        expect(classifyNpmPackage({name: 'pkg', keywords: ['mcp', 'docs']})).toEqual(['office']);
        expect(classifyNpmPackage({name: 'pkg', keywords: ['mcp', 'calendar']})).toEqual(['office']);
    });

    it('mcp 兜底类可被分类筛选项触达（getFacets 末尾有 mcp 面）', () => {
        const fallback = classifyNpmPackage({name: 'pkg', keywords: ['mcp']});
        expect(fallback).toEqual(['mcp']);
        expect(npmAdapter.getFacets!('mcp').categories.map(c => c.id)).toContain('mcp');
    });
});

describe('npmAdapter Phase 3/4 增强', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        __setRegistryIndexForTest(null);
        __setPrecacheForTest(null);
    });

    it('normalizeRepoUrl 归一化各种仓库地址形态', () => {
        expect(normalizeRepoUrl('https://github.com/user/repo.git')).toBe('github.com/user/repo');
        expect(normalizeRepoUrl('git+https://github.com/user/repo.git')).toBe('github.com/user/repo');
        expect(normalizeRepoUrl('GIT+https://www.GitHub.com/User/Repo/')).toBe('github.com/user/repo');
        expect(normalizeRepoUrl('github:user/repo')).toBe('github.com/user/repo');
        expect(normalizeRepoUrl('git@github.com:user/repo.git')).toBe('github.com/user/repo');
        expect(normalizeRepoUrl(null)).toBeNull();
        expect(normalizeRepoUrl('')).toBeNull();
    });

    it('buildRegistryIndex + enrichWithRegistry 命中回填徽章与真实子分类', () => {
        const servers = [{
            name: 'io.github.user/server',
            description: '',
            repository: 'https://github.com/user/repo',
            remotes: [],
            categories: ['filesystem', 'developer-tools'],
            packages: [],
            version: null,
        }];
        const index = buildRegistryIndex(servers as any);
        const detail = {
            id: 'npm-x', name: 'x', displayName: 'x', description: '', source: 'npm' as const,
            install: null, extra: {},
        } as any;
        enrichWithRegistry(detail, index, 'git+https://github.com/user/repo.git');
        expect(detail.isVerified).toBe(true);
        expect(detail.categories).toEqual(['filesystem', 'developer-tools']);
        expect(detail.categoryNames).toEqual(['filesystem', 'developer-tools']);
        expect(detail.extra.registryName).toBe('io.github.user/server');
    });

    it('enrichWithRegistry 未命中不设置 isVerified', () => {
        const index = buildRegistryIndex([{
            name: 'a', repository: 'https://github.com/x/y', categories: ['c'],
            remotes: [], packages: [], version: null, description: '',
        } as any]);
        const detail = {
            id: 'npm-x', name: 'x', displayName: 'x', description: '', source: 'npm' as const,
            install: null, extra: {},
        } as any;
        enrichWithRegistry(detail, index, 'https://github.com/z/w');
        expect(detail.isVerified).toBeUndefined();
        expect(detail.extra.registryName).toBeUndefined();
    });

    it('fetchServerDetail live 失败时回退预缓存（离线兜底）', async () => {
        __setPrecacheForTest({
            '@modelcontextprotocol/server-filesystem': {
                name: '@modelcontextprotocol/server-filesystem',
                version: '9.9.9',
                description: 'FS',
                license: 'MIT',
                bin: 'mcp-fs',
                engines: {node: '>=18'},
                repository: 'https://github.com/modelcontextprotocol/servers',
                publisher: 'mcp',
            },
        });
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('network down');
        }));
        const detail = await npmAdapter.fetchServerDetail!(
            {query: '', page: 1, pageSize: 20, baseUrl: '', secret: null},
            'npm-@modelcontextprotocol/server-filesystem'
        );
        expect(detail.install).toEqual({
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem@9.9.9'],
            env: {},
        });
        expect(detail.extra?.license).toBe('MIT');
        expect(detail.extra?.repository).toEqual({url: 'https://github.com/modelcontextprotocol/servers'});
    });

    it('fetchServerDetail 命中官方 Registry 打 verified 徽章并回填子分类', async () => {
        __setRegistryIndexForTest(new Map([
            ['github.com/modelcontextprotocol/servers', {name: 'io.github.modelcontextprotocol/servers', categories: ['filesystem']}],
        ]));
        const fakeMeta = {
            name: '@modelcontextprotocol/server-filesystem',
            description: 'FS',
            'dist-tags': {latest: '2.0.0'},
            versions: {
                '2.0.0': {
                    description: 'FS',
                    license: 'MIT',
                    repository: {url: 'https://github.com/modelcontextprotocol/servers'},
                },
            },
            repository: {url: 'git+https://github.com/modelcontextprotocol/servers.git'},
            readme: '# README',
        };
        vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, status: 200, json: async () => fakeMeta})));
        const detail = await npmAdapter.fetchServerDetail!(
            {query: '', page: 1, pageSize: 20, baseUrl: '', secret: null},
            'npm-@modelcontextprotocol/server-filesystem'
        );
        expect(detail.isVerified).toBe(true);
        expect(detail.categories).toEqual(['filesystem']);
        expect(detail.extra?.registryName).toBe('io.github.modelcontextprotocol/servers');
    });
});
