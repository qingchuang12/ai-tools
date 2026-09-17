## 来源 `plan-platform-sources.md`（原 plan-5.0.md） · plan-5.0 · 新增商店 Skills 平台源：Coze（虾评 Skill）

> 版本：5.0（2026-09-10）· 前任：[archive/plan-4.0.md](archive/plan-4.0.md)（Official 源移除，已完成并归档）

## 背景与目标

商店 Skills 需新增数据源 `https://xiaping.coze.com`（站点名「虾评 Skill」，支持 OpenClaw 的 Skill 评测市场），作为**可添平台源**接入（与 SkillHub/ModelScope/SkillsMP 同构）。用户已确认：**仅列表浏览**，不涉及详情打开与安装下载。

已实测接口（2026-09-10，全部公开匿名可访问，无需凭证）：

- 列表：`GET /api/skills` → `{skills:[...], total, hasMore}`，全库 `total=2265`
- 分页：`page`（1-based）+ `limit`，服务端真分页，返回 `total` + `hasMore`
- 搜索：`?search=词`（匹配 name），`q`/`keyword` 无效
- 分类：`GET /api/categories` → 官方 **8 个中文分类**（效率工具/社交互动/学习教育/创意设计/数据分析/娱乐休闲/生活实用/其他），`?category=中文名` 服务端过滤（需 encodeURIComponent）
- 排序：pick **仅** `avg_stars` / `downloads` / `comment_count` 合法（实测 stars/rating/latest/hot/featured/trending/newest 等全部 500），服务端排序
- 字段：`id,name,description,trigger[],category[],tags[],owner_name,current_version,downloads,avg_stars(千分制,490=4.90),star_count,comment_count,requires_api_key,security_status,created_at,updated_at`
- 详情/下载需注册认证（POST /api/auth/register + Authorization），商城不实现

## 范围与边界

**做**

1. `shared/platform-constants.ts`：`PlatformType` 加 `'coze'`；`PLATFORM_META.coze`（label `虾评 Coze`、defaultBaseUrl `https://xiaping.coze.com`）；`SKILL_PLATFORM_TYPES` 加 `coze`；`PLATFORM_HEALTH_PATHS.coze`（`/api/skills?limit=1`、`/`）。
2. `main/platforms/types.ts`：`SupportedPlatform` 加 `'coze'`；`platformTypeToSupported` 加 `case 'coze'`。
3. `main/platforms/coze.ts`：`cozeAdapter`（searchSkills + getFacets），直连确定接口，无需候选探测。
4. `main/platforms/registry.ts`：注册 `coze: cozeAdapter`。
5. i18n zh/en 若有平台名引用补文案；测试；`pnpm typecheck` / `pnpm test`（280 基线）全绿。

**不做**（理由）

- 详情打开 / 安装下载：需注册认证，商城不做（用户确认）。
- 默认 seed 内置连接：以 SKILL_PLATFORM_TYPES 可添平台呈现（用户确认「可添平台源」）。
- MCP 端接入：该源为 Skill 平台源，仅 skills 商店。
- 排序其它候选值：实测均为 500，数据源不支持，仅暴露白名单三档。

## TODOS

- [x] ① platform-constants：type / meta / SKILL_PLATFORM_TYPES / health
- [x] ② platforms/types：SupportedPlatform + platformTypeToSupported
- [x] ③ platforms/coze.ts：adapter（searchSkills + getFacets + mapCozeSkill）
- [x] ④ registry 注册 coze
- [x] ⑤ i18n 文案（平台名直接取自 PLATFORM_META.label，无需额外 key）+ 测试（coze 3 例）
- [x] ⑥ typecheck + pnpm test 全绿（284/284；main+render 0 错）

---

## 来源 `plan-4.0.md` · plan-4.0 · 移除 Official Registry 数据源

> 版本：4.0（2026-09-09） · 前任：[archive/plan-3.1.md](archive/plan-3.1.md)（Skill 附属文件编辑，代码已完成并归档）

## 背景与目标

商店的「Official」MCP 数据源抓取 GitHub `modelcontextprotocol/servers` 仓库 `src/` 目录，当前上游仅维护 7 个参考服务器（everything / fetch / filesystem / git / memory / sequentialthinking / time），其余官方已归档，源价值过低（用户确认）。npm 数据源落地后，官方包可经 `@modelcontextprotocol` scope 从 npm 源覆盖，Official 源失去存在必要。

目标：**完整移除** Official 源的全部代码路径（用户已确认「完整移除」档位），不留死代码。

## 范围与边界

**做**

1. renderer：`api/registry.ts` 删 `fetchOfficialServers` / `fetchOfficialServerDetail` / `Official*` 类型与守卫、`DataSource` 收窄；`Detail.tsx` / `Library.tsx` / `Store.tsx` / `ServerCard.tsx` / `McpSourceManager.tsx` 的 official 分支；删除专用组件 `OfficialConfigForm.tsx`；`useMcpData` / `useStore*` 系列 official 处理与默认值。
2. shared/main：`platform-constants.ts`、`connections-store.ts` 种子连接、`index.ts`、`cache-manager.ts`、`platforms/types.ts` 的 official 触点。
3. i18n zh/en 移除 official 源文案；preload/electron.ts 类型面同步。
4. 测试同步 + `pnpm typecheck` / `pnpm test` 全绿。

**不做**（理由）

- 不动 npm / smithery / modelscope 等其余数据源。
- 已安装的官方旧条目不清理：安装配置是真实的 npx/uvx/docker 命令，继续可用；仅 Library 归属判定退化为通用显示（无法再对照已删除的官方列表）。

## TODOS

- [x] ① registry.ts：删 official 抓取/详情/类型/守卫，`DataSource` 收窄
- [x] ② renderer 页面与组件：Detail / Library / Store / ServerCard / McpSourceManager / OfficialConfigForm（删文件）
- [x] ③ renderer hooks 与 store：useMcpData / useStore* / useStoreFacets / useStoreSourceSelection / useStoreData / useStoreAttribution / electron.ts
- [x] ④ shared + main：platform-constants / connections-store / index.ts / cache-manager / platforms/types
- [x] ⑤ i18n zh/en + preload
- [x] ⑥ 测试同步；typecheck + pnpm test 全绿（280/280，与移除前基线一致）

## 跨版本遗留

- 来自 3.1：手动验证清单过一遍（对照弹窗 / banner / 云同步手动项）；P7 求证（cloud 是否保留技能安装目标）。
- 工作树累积未提交改动建议拆分提交：license / npm Phase1-2 / Phase3-6 / Phase7 / Official 源移除（本次）。

---

## 来源 `plan-9.0.md` · plan-9.0 · E1：放开 ClawHub / SkillHub 商店内安装

> 版本：9.0（2026-09-11）· 前任：[archive/plan-8.0.md](archive/plan-8.0.md)（商店全数据源查询/安装全量排查，已完结归档）

## 背景与目标

plan-8.0 实测确认 ClawHub / SkillHub 的 zip 下载直链可用，但安装通道未接线（用户拍板执行 backlog E1）。目标：两个平台的技能在商店详情页可一键安装。

## 范围与边界

**做**：
1. `clawhubAdapter` / `skillhubAdapter` 实现 `fetchSkillDownload`（zip 直链通道）。
2. `PLATFORM_SKILL_DOWNLOAD` 登记 `'clawhub'`、`'skillhub'`（双向守卫测试自动生效）。
3. 两个平台 `mapEntry` 的 `downloadUrl` 对齐（D3 同类）：GitHub 源优先保留，非 GitHub 源改用 zip 直链——与 plan-8.0 ModelScope D3 修法一致。

**不做**：
- skills.sh 镜像条目（ClawHub 榜单 `install.kind='skills-sh'`）沿用既有 skills.sh → GitHub 解析通道，不动。
- E2（ModelScope 连接级退避）、D16（百炼接线）不在本轮。

## TODOS

- [x] T1 实测复核两平台下载直链与 slug 字段（见上表）
- [x] T2 常量上移 + `PLATFORM_SKILL_DOWNLOAD` 登记
- [x] T3 两 adapter 实现 `fetchSkillDownload` + `mapEntry.downloadUrl` 对齐
- [x] T4 回归测试（含守卫转红验证）+ 双 tsc + 全量 vitest 多轮
- [x] T5 plan 收尾与日志

---

## 来源 `plan-11.0.md` · (无标题)

### 范围（两件事）
1. **移除 GitHub Registry 内置 Skill 列表数据源**：所有 Skill 源改走平台直连 `api.platforms.searchSkills`。
   - `registry.ts`：删 `fetchGithubSkills`/`fetchSkillsList`/`revalidateSkillsList`/`forceRefreshSkillsList`/`clearSkillsCache` + `SKILLS_*` 常量 + `GithubContentEntry`；清理因此产生的未用 import。
   - `useSkillsData.ts`：删 `github` useQuery、`builtinPaginated` memo、`noCacheRef`；兜底 return 改用 `platform` 查询态；`forceRefresh` 保留于接口但从解构移除。
   - `useStoreSourceSelection.ts`：去 `BUILTIN_SKILL_SOURCE_IDS` 导入、`gh` 回退；`isDirectSkillSource = !!selectedConn`。
   - `connections-store.ts`：`builtinSkillSeeds()` 去 github seed（留 clawhub）。
   - `platform-constants.ts`：`PlatformType`/`PLATFORM_META`/`BUILTIN_SKILL_SOURCE_IDS`/`PLATFORM_HEALTH_PATHS` 全去 `github`。
   - `ConnectionManager.tsx`：`builtinIds=[BUILTIN_SKILL_SOURCE_IDS.clawhub]`。
   - 注释/文案：`useStoreFacets.ts`、`electron.ts`(注释)、`zh.json`/`en.json`、`StoreEmptyState.tsx`。
2. **新建 Skill 源连接移除「自定义」选项**：仅 `SKILL_PLATFORM_TYPES` 删末位 `'custom'`；`custom` 仍留 `PlatformType`/`PLATFORM_META`（存量自定义连接经 `unknownPlatformFallback` 只读展示），与 MCP 现有「仅存量可编辑」模式一致。

### 验证（我独立执行，非采信子代理）
- 双 tsc：`tsconfig.main.json`、`tsconfig.json` 均 **exit 0**。
- `vitest --pool=vmForks --no-cache`：用 node 直拉 `vitest.mjs` → **28 files / 392 passed (392)**。
- 残留 grep：`fetchGithubSkills|fetchSkillsList|...|GithubContentEntry`、`BUILTIN_SKILL_SOURCE_IDS.github` 均 **无匹配**。
- 保留项 grep：`getRemoteDetail`/`inferSkillCategoryId`/`fetchReadmeFromGitHub` 均在。
- 说明：子代理某次经 `npx` 报「391/392，1 个 env-manager 失败」系该沙箱 PATH 无 npx 的**假失败**；直跑 node 为 392/0。

---

## 来源 `plan-18.0.md` · plan-18.0 · 百炼 MCP 数据源离线→在线直连改造

> 版本：1.0（2026-09-14 新建）· 单一活动 plan：`doc/` 同时仅保留此一份。
> 前任归档：[archive/plan-17.0.md](archive/plan-17.0.md)。

## 背景与目标
商店-MCP-百炼数据源**此前 100% 依赖内置离线快照**（[bailian-index.json](src/main/platforms/bailian/data/bailian-index.json)，251 条），从未真正请求在线接口，数据过期（快照 251 条 vs 在线实测 total=279）且缺 `serverCode`。用户判定「纯离线 = 自我欺骗」，要求接入真实在线数据。

**实测取证**（非推测）：`SquarePageList` 接口**匿名可直拉真实在线数据**——纯匿名 POST（无 Cookie、无 Authorization 头）返回 `code:200`、`total:279`、完整 `mcpServerDetailList`（含 `serverCode` 唯一 id）。

## 范围与边界
**做**
- `bailian.ts` 适配器改造：在线拉取、运行时缓存、离线兜底、来源/时间标签。
- 在线结果持久化到运行时缓存目录（`<home>/.ai-tools/cache/platforms/bailian/offline-index.json`），冷启动优先读它；内置 `bailian-index.json` 降级为种子。
- 详情页保持远程托管 MCP（SSE URL）安装形态不变，仅数据来源从离线索引改为合并数据。

**暂不做**
- 不改渲染层 UI/新增徽章（沿用现状 `message` 文案透出）。
- 不改 categories/sources 枚举与排序规则口径。
- 不引入任何 token/Cookie 配置（已证实在线无需凭证）。

## 实现思路（触点 → 步骤 → 取舍 → 风险回滚）

### 取舍
- 全量拉取 + 内存 SWR：首屏（冷启动）可能短暂显示兜底数据，刷新完成后自动切换在线——符合用户明确的「获取到新数据后再替换」语义。
- 复用 clawhub 落盘方案，不另造缓存文件约定。

### 风险与回滚
- 在线接口偶发失败/变动 → 自动回退本地缓存，不阻断；消息如实标注。
- 改动集中在单一 adapter 文件，回滚 = 还原 `bailian.ts` 及其单测，风险低。

## TODOS
- [x] 归档已完结 plan-17.0 至 `doc/archive/plan-17.0.md`
- [x] `bailian.ts`：常量 + `RawBailian.serverCode`
- [x] `bailian.ts`：运行时缓存（仿 clawhub `cacheFile/readCache/saveCache/mergeRaw/loadOffline`）
- [x] `bailian.ts`：在线拉取 `postFormJson` + 内存 SWR 态（`liveItems/liveAt/inflight`，后台刷新落盘替换）
- [x] `bailian.ts`：`searchServers` 改在线优先、客户端过滤排序口径不变、`message` 如实标注在线/缓存与时间
- [x] `bailian.ts`：`mapServer` id 优先 serverCode、extra+serverCode；`fetchServerDetail` 从合并数据反查
- [x] `bailian.ts`：`getFacets` 计数基于合并数据
- [x] 单测：更新 `platform-adapters.test.ts`（not-found 报错文案、新增 serverCode id 形态用例），跑通 vitest + tsc（main 0 错、全量 0 错）
- [x] 归档检查：完成后归档本 plan 至 `doc/archive/plan-18.0.md`

## 验收结果（2026-09-14）
- 实测确认 `SquarePageList` 匿名可直拉真实在线数据（`code:200`、`total:279`，大于离线快照 251，含 `serverCode`）。
- `bailian.ts` 由纯离线改为：在线优先 + 运行时缓存（`<home>/.ai-tools/cache/platforms/bailian/offline-index.json`）作为本地兜底，后台刷新成功后替换；`message` 如实标注「在线直连（实时）」或「本地缓存 · 数据时间 <date>」。
- `mapServer` id 优先 `serverCode`（在线形态 `bailian:<serverCode>`），缺省回退旧 `source:serverName` 编码；`fetchServerDetail` 兼容两种 id 形态反查。
- 测试：bailian 相关 14 项全绿；`tsc -p tsconfig.main.json` 与 `tsc -p tsconfig.json` 均 0 错。
- 待川哥本机复验：商店 → MCP → 百炼，进入后应显示「在线直连（实时）」及全新 279 条数据；断网时显示「本地缓存 · 数据时间 …」。

---

> **已省略的过程性章节**（11 节，按需查 git 历史）：商店平台源接入与治理 / 实现思路 / 实现思路 / 实测依据（2026-09-11 复核） / 实现思路（触点 → 步骤） / plan-11.0 · 移除 GitHub Registry 内置源 + 新建连接移除「自定义」(2026-09-11) / 请求 / 必须保留（与本次无关，误删会塌） / 规则（plan 管理铁律） / 触点 / 步骤
