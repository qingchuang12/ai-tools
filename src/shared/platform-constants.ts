/**
 * 平台与令牌的共享静态常量。
 *
 * 该文件不依赖任何 Node / Electron 运行时模块（无 fs/path/crypto/electron 导入），
 * 因此可以安全地被渲染进程（浏览器环境）与主进程同时导入，避免渲染端因引入
 * 主进程模块而连带加载 Node 内置模块导致 chunk 崩溃。
 */

export type TokenScope =
  | 'skills:read'
  | 'skills:download'
  | 'models:read'
  | 'models:download'
  | 'admin';

export const ALL_TOKEN_SCOPES: TokenScope[] = [
  'skills:read',
  'skills:download',
  'models:read',
  'models:download',
  'admin',
];

export type PlatformType =
  | 'modelscope'
  | 'safeskill'
  | 'skillhub'
  | 'skillsmp'
  | 'custom'
  // MCP 源平台类型：内置抓取实现，非通用 baseUrl 探测
  | 'smithery'
  // ClawHub：公开 API 直连，无凭证即可查询 skill 趋势榜单
  | 'clawhub'
  // npm Registry：MCP 服务器发现源（平台直连，匿名公开）
  | 'npm'
  // 虾评（Coze）Skill 平台源（直连公开分页接口，匿名可读 skill 列表）
  | 'coze'
  // 百炼（阿里云 Model Studio）MCP 服务器源：离线索引优先，内置 251 条，免 Cookie/配额（A10 接线启用）
  | 'bailian';

export const PLATFORM_META: Record<PlatformType, { label: string; defaultBaseUrl: string }> = {
  modelscope: { label: 'ModelScope', defaultBaseUrl: 'https://www.modelscope.cn' },
  safeskill: { label: 'SafeSkill', defaultBaseUrl: 'https://safeskill.cn' },
  skillhub: { label: 'SkillHub', defaultBaseUrl: 'https://api.skillhub.cn' },
  skillsmp: { label: 'SkillsMP', defaultBaseUrl: 'https://skillsmp.com' },
  custom: { label: '自定义', defaultBaseUrl: '' },
  smithery: { label: 'Smithery', defaultBaseUrl: 'https://registry.smithery.ai' },
  clawhub: { label: 'ClawHub', defaultBaseUrl: 'https://clawhub.ai' },
  npm: { label: 'npm Registry', defaultBaseUrl: 'https://registry.npmjs.org' },
  coze: { label: '虾评 Coze', defaultBaseUrl: 'https://xiaping.coze.com' },
  bailian: { label: '百炼', defaultBaseUrl: 'https://bailian.console.aliyun.com' },
};

/** 连接归属的资源类型：mcp 源 / skill 源 */
export type ConnectionKind = 'mcp' | 'skill';

/** MCP 源可选的平台类型（内置源 + 平台直连；自定义仅存量连接可编辑，不支持新建） */
export const MCP_PLATFORM_TYPES: PlatformType[] = ['smithery', 'modelscope', 'npm', 'bailian'];

/**
 * Skill 源可选的平台类型（自定义仅存量连接可编辑，不支持新建，故不在此列出）。
 *
 * 注意：`'custom'` 仍保留在 `PlatformType` 联合类型与 `PLATFORM_META` 中，
 * 因为 SourceManager 的 `unknownPlatformFallback` 需要用它把「已存在的自定义连接」
 * 以只读形式展示出来；但它不再作为「新建 Skill 源连接」的可选项出现。
 *
 * `'safeskill'` 同理已从本清单移除（2026-09-12 拍板）：该站点只有 SPA 壳页，
 * `/v1/search`、`/api/v1/search`、`/api/skills`、`/api/v1/skills` 实测全部 404，
 * 也无 adapter —— 留着只会让用户建出一个**永远不可能工作**的源。
 * 类型与 `PLATFORM_META` 条目保留，仅为让存量连接仍能以只读形式展示与删除。
 */
export const SKILL_PLATFORM_TYPES: PlatformType[] = [
  'modelscope',
  'skillhub',
  'skillsmp',
  'clawhub',
  'coze',
];

/**
 * 支持「在 mcp-dock 内下载安装 Skill」的平台。
 *
 * 唯一事实源是各平台适配器是否实现 `PlatformAdapter.fetchSkillDownload`；
 * 因渲染层无法直接 import 主进程适配器，此处以常量镜像，由
 * `src/__tests__/platform-adapters.test.ts` 的用例双向守卫两者同步。
 * 当前已接线：coze（需 API Key）、modelscope（匿名 zip 直链）、clawhub / skillhub（E1，匿名 zip 直链）。
 * 未列出的平台详情页应禁用安装并说明原因，避免点击后产出只含 .source.json 的空壳目录。
 *
 * - coze：下载需绑定 API Key，由适配器换取 zip 直链；
 * - modelscope：原生 Skill 走匿名 zip 直链
 *   `/skills/<owner>/<slug>/archive/zip/master`（source_url 为空的技能只有这一条通道）；
 * - clawhub / skillhub：站内 zip 直链 `?slug=<slug>`（clawhub 的 zip 通道只服务其原生技能，见 `src/main/platforms/clawhub.ts:113`）。
 */
export const PLATFORM_SKILL_DOWNLOAD: PlatformType[] = ['coze', 'modelscope', 'clawhub', 'skillhub'];

/** 内置 MCP 源的固定 id，用于 seed 与内置抓取逻辑分发 */
export const BUILTIN_MCP_SOURCE_IDS = {
  smithery: 'mcpsrc_smithery',
  npm: 'mcpsrc_npm',
  bailian: 'mcpsrc_bailian',
} as const;

/** 内置 Skill 源的固定 id（ClawHub），用于 seed 与商店下拉内置抓取分发 */
export const BUILTIN_SKILL_SOURCE_IDS = {
  clawhub: 'src_clawhub',
} as const;

/**
 * ClawHub 公开趋势榜单接口（无凭证即可查询 skill 列表）。
 * 该源为只读的「skills 趋势」列表，不支持关键词搜索，故前端走本地分页/分类。
 *
 * 该接口用 `cursor` 做游标翻页（响应里的 `nextCursor` 传回即为下一页），
 * `limit` 实测上限为 100（>100 返回 400），总量由响应的 `totalItems` 给出。
 * 因此主进程会按游标连续拉取，而不是只取首屏 20 条。
 */
export const CLAWHUB_TRENDING_URL = 'https://clawhub.ai/api/v1/trending?kind=skills&limit=100';

/** ClawHub 趋势榜单基址（不含分页参数），供游标翻页拼装使用 */
export const CLAWHUB_TRENDING_BASE = 'https://clawhub.ai/api/v1/trending?kind=skills';

/** ClawHub 单次请求条数上限（实测 >100 返回 400） */
export const CLAWHUB_PAGE_LIMIT = 100;

/**
 * ClawHub 原生技能的 zip 下载直链（`?slug=<slug>`，无凭证，实测返回 application/zip）。
 *
 * 榜单里 `install.kind === 'clawhub'` 的条目（实测约占 60%）只有
 * `install.reference = "<owner>/<slug>"`，既不是 GitHub 仓库也没有 `sourceUrl`；
 * 若按 owner/repo 拼成 github.com 链接会 404（如 plato-1/fable-method 无此仓库）。
 * 这些技能必须走本直链下载 zip（包内含 SKILL.md）。
 */
export const CLAWHUB_DOWNLOAD_BASE = 'https://clawhub.ai/api/v1/download';

/**
 * SkillHub 技能包 zip 下载直链（`?slug=<slug>`，无凭证，实测返回 application/zip）。
 *
 * 列表接口的 `upstream_url` 绝大多数为 null，回退的站内详情页
 * `https://skillhub.cn/skills/<slug>` 是 Next.js SPA 壳，抓 HTML 提取不到任何源。
 * 该直链取自官方前端的 getSkillDownloadUrl，zip 内含完整的 SKILL.md + scripts/ + references/。
 *
 * 注意：
 * - 不要附带 `namespace` 参数——实测带上会 404，仅传 slug 才能命中；
 * - 下载端点只在 API 域名（api.skillhub.cn）存在：实测站点域名
 *   `https://skillhub.cn/api/v1/download?slug=…` 返回 200 但内容是 HTML（SPA 壳），
 *   故拼直链时固定用本常量，不要用用户配置的 baseUrl。
 */
export const SKILLHUB_DOWNLOAD_BASE = 'https://api.skillhub.cn/api/v1/download';

/**
 * 各平台「测试连接」使用的探活路径（相对 baseUrl，按顺序尝试，任一成功即视为连通）。
 *
 * 为什么不直接请求 baseUrl：部分站点首页对非浏览器请求不响应（实测
 * `https://skillsmp.com` 直接超时 12s），但其 API 端点 398ms 正常返回 200。
 * 若拿首页当探活目标，会把可用连接误判为「连接失败」。
 *
 * 因此优先探测与实际功能一致的 API 端点；平台无公开 API 时再回退首页。
 */
export const PLATFORM_HEALTH_PATHS: Partial<Record<PlatformType, string[]>> = {
  // 实测可用：返回 {success,data:{skills,...}}
  modelscope: ['/openapi/v1/skills?page_number=1&page_size=1', '/'],
  // 实测可用：返回 {skills,pagination,filters}。search 必须非空（空 search 返回 400 INVALID_QUERY）
  skillsmp: ['/api/skills?search=skill&page=1&limit=1', '/'],
  // safeskill 不配置探活路径：该站点无公开列表接口（官方文档声明的 /v1/search 线上未部署）、
  // 也无 adapter。若探首页（/ 恒 200）会被误判为「连接成功…搜索时将回退页面解析」，
  // 承诺了一个不存在的能力——这就是探活假绿。未配置时由 connections-store 给出如实结论。
  // 该源已于 2026-09-12 从 SKILL_PLATFORM_TYPES 下线；此注释与下面连接层分支保留，
  // 用于存量连接（仍会如实报「无法验证」而非假绿）。
  // 实测 /（api.skillhub.cn）返回 405，必须探与功能一致的 API 端点才判定连通
  skillhub: ['/api/skills?page=1&pageSize=1', '/'],
  // 自定义连接由用户填写完整 baseUrl，直接探该地址
  custom: ['/'],
  // MCP 内置源：探测各自真实的 registry 端点
  smithery: ['/servers?page=1&pageSize=1', '/'],
  // ClawHub：公开趋势榜单接口，无凭证即可 200
  clawhub: ['/api/v1/trending?kind=skills&limit=1', '/'],
  // npm Registry：探测搜索端点是否可达，回退首页
  npm: ['/-/v1/search?text=keywords:mcp&size=1', '/'],
  // 虾评（Coze）：探测公开分页接口是否可达，回退首页
  coze: ['/api/skills?limit=1', '/'],
};

/**
 * 使用**内置离线索引**、无需网络即可工作的平台源。
 *
 * 这类源的关键特征：数据随应用分发（不依赖任何上游接口），因此**不该做网络探活**——
 * 探它的控制台首页只会得到误导性结论：200 即「假绿」（承诺了并不存在的在线能力），
 * 需要登录时又是「假红」（明明离线可用却报连接失败）。
 * 「测试连接」遇到本清单内的平台时直接如实说明其离线可用性，不发起任何请求。
 *
 * 当前仅 `bailian`（离线索引 251 条，见 src/main/platforms/bailian/data/）。
 */
export const OFFLINE_INDEX_PLATFORMS: PlatformType[] = ['bailian'];

// 说明：曾有的 SKILLSMP_CATEGORIES 常量已删除（D15）——当时是全库零消费方的孤儿，且 slug 取自
// 站点**父域**。2026-09-12（plan-13.0 模块 F）复测证明上游**真实支持** `category=<叶子 slug>`
// 过滤，原先「不支持分类」的判定系空 search 400 / 参数名误用 / 拿父域去试 三处误判叠加。
// 分类树现以**模块私有常量**形式落在 platforms/skillsmp.ts（平台专属数据不入 shared 常量层）。
