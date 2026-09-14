# plan-18.0 · 百炼 MCP 数据源离线→在线直连改造

> 版本：1.0（2026-09-14 新建）· 单一活动 plan：`doc/` 同时仅保留此一份。
> 前任归档：[archive/plan-17.0.md](archive/plan-17.0.md)。

## 规则（plan 管理铁律）
- `doc/` 下同一时刻只保留一个活动 plan（本文件）；新任务合并进本 plan。
- 执行完结 → 归档到 `doc/archive/`（plan 与 audit 一并归档）。
- 每次软件调整：细化进 plan → 确认 → 执行 → 归档检查。

---

## 背景与目标
商店-MCP-百炼数据源**此前 100% 依赖内置离线快照**（[bailian-index.json](src/main/platforms/bailian/data/bailian-index.json)，251 条），从未真正请求在线接口，数据过期（快照 251 条 vs 在线实测 total=279）且缺 `serverCode`。用户判定「纯离线 = 自我欺骗」，要求接入真实在线数据。

**实测取证**（非推测）：`SquarePageList` 接口**匿名可直拉真实在线数据**——纯匿名 POST（无 Cookie、无 Authorization 头）返回 `code:200`、`total:279`、完整 `mcpServerDetailList`（含 `serverCode` 唯一 id）。

目标：百炼源改为「在线直接拉取 + 运行时缓存」，离线快照仅作冷启动/断网兜底；在线数据就绪后**替换**离线快照，并如实标注数据来源与时间。

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

### 触点
- 主改：`src/main/platforms/bailian.ts`。
- 复用范式：`clawhub.ts` 的 `runtimeCacheDir / cacheFile / readCache / saveCache / mergeRaw / loadOffline`（在线结果累积落盘为本地兜底）。
- 接口：`POST https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&...&api=zeldaEasy.broadscope-bailian.mcp-server.SquarePageList&_v=undefined`，`x-www-form-urlencoded` 正文 `params=<URL编码JSON>&region=cn-beijing`，`pageSize=500` 一次全量；列表路径 `data.DataV2.data.data.mcpServerDetailList`，总数 `...total`。

### 步骤
1. **常量**：新增 `BAILIAN_LIST_API`、`BAILIAN_PAGE_SIZE=500`；`RawBailian` 增加 `serverCode?`。
2. **运行时缓存**（仿 clawhub）：`runtimeCacheDir`、`cacheFile()`→`<cacheDir>/bailian/offline-index.json`、`readCache/saveCache/mergeRaw/loadOffline`（种子 `bailian/data/bailian-index.json` 与运行时缓存按 `serverCode||source:name` 去重合并）。
3. **内存 SWR 态**：模块级 `liveItems / liveAt / inflight`——冷启动先以 `loadOffline` 兜底立即返回，同时后台发起在线拉取并在成功后 `liveItems=…` + `saveCache` 落盘替换；并发去重（共享 `inflight` Promise）。
4. **在线拉取**：本地 `postFormJson()`（URL 编码 POST、UA、20s 超时、一次重试）；失败返回 `null`，保持离线兜底并带消息「网络不可用·使用本地缓存」。
5. **searchServers**：`current = liveItems ?? loadOffline()`；后台刷新（去重）；客户端过滤/排序/分页口径不变；`message` 如实标注：在线=「在线直连（实时）」/ 兜底=「本地缓存 · 更新时间 <yyyy-mm-dd>」；`setDiagnostics` 的 attempt.url 改为真实接口。
6. **mapServer**：id 优先 `bailian:<serverCode>`，缺省回退原 `source:serverName`；extra 增加 `serverCode`。
7. **fetchServerDetail**：从 `current`（在线合并离线）按 id 查原始记录；查不到抛错；安装 URL 仍用 serverName 派生 slug（`serverCode` 未实测为合法 slug，不改行为、不编造）。
8. **getFacets**：计数改为基于 `current` 合并数据。

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