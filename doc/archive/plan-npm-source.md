## 来源 `plan-npm-source.md`（原 plan-npm-source-impl.md） · 实施计划：为「商店 → MCP 服务器」新增内置 NPM 数据源

> 设计者：架构师 高见远（software-architect）
> 关联前置调研：`doc/plan-npm-mcp-marketplace.md`
> 目标：在「商店 → MCP 服务器」中新增一个**内置 npm 数据源**，**参照 `modelscope` 适配器**实现，**绝对不能影响现有 modelscope 数据源的功能**。
> 本文档仅为**实施计划**，不含任何实现代码。

---

## 0. TL;DR（一句话结论）

新增一个**完全独立**的主进程平台适配器 `src/main/platforms/npm.ts`（实现现有 `PlatformAdapter` 契约），注册进 `registry.ts`，并把 `'npm'` 作为**新增成员**加入 `SupportedPlatform` / `PlatformType` 两个联合类型；npm 通过现有的「统一平台适配器通道」（`platforms:search-servers` / `platforms:server-detail`）对外暴露，渲染层 `useMcpData` 已经具备调用能力，**无需改动渲染层数据通路**；UI 上通过「seed 一个内置 npm 连接（`kind:'mcp'`）」让 npm 作为**内置源**出现在源下拉里，复用 `McpSourceManager`/`SourceManager`，**无需新增选项卡组件**；安装环节 npm 详情返回 `install:{command:'npx', args:['-y','<pkg>@<ver>'], env:{}}`，与 modelscope 同构，直接复用 `ConfigManager.installServer` + `McpClient.connectStdio`，**零改动**。

**隔离策略核心**：所有改动均为「新增文件 + 联合类型增成员 + 枚举数组/Record 增项 + 一处只增不减的早返回分支」，`modelscope.ts` 与其注册、调用方**一律不动**。


### 1.3 详情通道存在「只允许 modelscope」的硬编码（关键风险点）

`src/main/resolvers/servers.ts` 的 `fetchPlatformServerDetail`（`L284`）：


- 渲染层 `PlatformServerDetail.tsx`（`L105`）调用 `api.apiConnections.getServerDetail(connId, serverId)` → 旧通道 `api-connections:get-server-detail` → `fetchPlatformServerDetail`。
- **结论**：npm 详情必须在此函数增加一段 `sp === 'npm'` 的**早返回分支**（委托给 `npmAdapter.fetchServerDetail`），且 modelscope 旧分支**字节级不动**（§3-T4）。
- 注：新通道 `platforms:server-detail`（`main/index.ts` L990）本身已是泛型，但为了不改动 `PlatformServerDetail.tsx` 的调用通道（避免影响 modelscope），统一在 `fetchPlatformServerDetail` 处补 npm 分支最稳妥。

## 6. 有序任务列表（按依赖，编号 T1–T6）

> 依赖关系：T1 是所有后续任务的基础；T2/T3/T4/T5 在 T1 完成后可**并行**；T6 串行最后做联调与回归。

### T6 · 联调、验证与回归（P0）
- **源文件**：无新增；运行验证
- **验证清单**：
  1. 商店 MCP 源下拉出现「npm Registry」内置源；
  2. 搜索返回 `keywords:mcp` 包、分页 `total` 正确；
  3. 点详情拿到 `npx -y <pkg>@<ver>` 安装指令 + README + license；
  4. 安装后 `ConfigManager` 写入、`McpClient` 拉起 npx 成功；
  5. **回归**：modelscope 源搜索/详情/安装**行为完全不变**（重点对比 T 前后）。
- **依赖**：T2、T3、T4、T5

---

## 7. 依赖包列表

- **无需新增任何第三方包。**
- 仅使用 Node 内置 `fetch`（主进程 undici）、`AbortController`。
- 复用既有辅助：`src/main/platforms/shared.ts` 的 `UA` 常量（可选 `fetchText`）。
> （……本节省略后续明细条目，按需查阅 git 历史中的原始 plan）

---

## 9.1 已确认决策（2026-09-09，主理人 + 产品对齐）

| 项 | 决策 | 影响 |
|---|---|---|
| Q1 数据源通道 | **走 PlatformAdapter 通道（不接渲染层 DataSource）** | 与 modelscope 一致，改动最小、隔离最稳 |
| Q2 搜索降噪 | **默认拼接 `keywords:mcp`** | 搜索 `text` 默认前缀 `keywords:mcp`；用户输入为空/有输入均拼接（覆盖全场景降噪） |
| Q5 内置源默认 | **默认 seed 启用（kind:'mcp', enabled:true, id=BUILTIN_MCP_SOURCE_IDS.npm）** | 启动即在源下拉出现 npm Registry；误删可经「恢复内置源」找回 |
| Q3 安装参数 | 采用 best-effort：`npx -y <pkg>@<ver>`，Phase 1 不解析包内 mcp.json/README | 后续 Phase 2+ 增强 |
| Q4 分类展示 | `categories:['mcp']` + `categoryNames:['MCP']` | 统一归类便于筛选 |
| Q6 verified 徽章 | 本次不做，仅 `getFacets`/详情预留 `isVerified` 字段位 | 依赖官方 MCP Registry 构建期聚合，属增强项 |
| Q7 自带 Node / license 汇总 | 本次不做，仅路线备忘 | Phase 4 / Phase 6 范围 |

> 结论：T1–T6 计划现已**基本确认**，可进入实现排期。

## 10. 影响面与回归保障（总结）

- **新增文件**：仅 `src/main/platforms/npm.ts`。
- **修改文件**：`types.ts`、`registry.ts`、`platform-constants.ts`、`connections-store.ts`、`servers.ts`、`ServerCard.tsx`——全部为**增量/早返回/数组增项**，无对 modelscope 既有逻辑的条件分支改动。
- **不触碰**：`modelscope.ts`、其注册行、所有 modelscope 调用方、`useMcpData.ts`、`PlatformServerDetail.tsx`、`mcp-client.ts`、`config-manager.ts` 安装写入逻辑、渲染层 `api/registry.ts`。
- **回归验证**：T6 必须对比改动前后 modelscope 源的搜索/详情/安装结果一致；建议补一条 `npmAdapter` 单测（参照既有 `src/__tests__/platform-adapters.test.ts` 中 `mapMCPServer` 的写法），不影响 modelscope 既有用例。

---

## 来源 `plan-npm-mcp-marketplace.md` · npm/MCP 桌面端接入 · 技术可执行方案

> 目标：回答三个问题——(1) npm 生态/MCP 是否有「列表查询 / 详情查看 / 安装」接口；(2) 你提出的 `Electron/Tauri + Node.js + child_process 拉起 npx + JSON-RPC(STDIO)` 架构是否可行；(3) 有没有更好的方案。最终整理成一个可在本仓库直接落地的可执行方案。

---

## 0. 结论先行（Verdict）

| 你的提问 | 结论 |
|---|---|
| npm/MCP 有「列表 / 详情 / 安装」接口吗？ | **有，但三者形态不同**：列表=Registry Search API；详情=包元数据 API；「安装」= `npx -y <pkg>`（npm 没有 install RPC，靠拉起 npx 进程完成）。另有一个官方 **MCP Registry**（仅元数据索引，不是包仓库）。 |
| 你提的架构可行吗？ | **不仅可行，而且本仓库已经把它实现了一半**。`src/main/mcp-client.ts` 已经在用 `child_process.spawn` 拉起 `npx` 类命令、走 JSON-RPC 2.0 over STDIO；`src/main/platforms/` 已经有 `PlatformAdapter` 商店抽象（ModelScope / ClawHub / Smithery）。**缺的就是一个 npm Registry 适配器 + 把 npm 接到现有商店 UI。** |
| 有更好的方案吗？ | 有，且都是**增量增强**，不推翻现有架构：① 官方 MCP Registry 做「可信发现」层；② 支持 **DXT**（Desktop Extensions，内嵌运行时、自带权限清单，最契合闭源桌面产品）；③ 自带 Node 运行时（extraResources）替代「依赖宿主 npx 联网拉取」；④ 给第三方 server 加 OS 级沙箱 + 网络出口策略。 |

**一句话路线**：保留你现有的 `npx + JSON-RPC STDIO` 主干，新增 `npm` 平台适配器补齐「发现层」，把 npm 作为**权威包元数据/下载源**，把官方 MCP Registry 作为**可信增强层**，并视产品成熟度逐步引入 DXT 与沙箱。

---

## 5. 推荐目标架构（最终形态）


---

## 来源 `plan-npm-phase3-6.md` · 实施计划（Phase 3–6）：npm 数据源增强 · 可信层 / 运行确定性 / 许可汇总

> 版本：v1.0 (2026-09-09)
> 关联前置：`doc/plan-npm-mcp-marketplace.md`（Phase 1–6 总览）、`doc/plan-npm-source-impl.md`（Phase 1–2 实施，已落地未提交）
> 执行范围（已与产品确认）：**Phase 3 + Phase 4（轻量方案）+ Phase 6**。Phase 5 已借 seed 内置源完成，本次无新增。
> 隔离前提不变：所有改动增量/早返回/数组增项，绝不触碰 `modelscope.ts` 及其调用链。

---

## 3. 待确认/风险
- 官方 Registry 无 npm 包名字段 → 匹配覆盖率取决于「npm 包与 Registry 条目是否都填了可对齐的 repository.url」，覆盖率非 100%（已如实说明）。
- 预缓存为离线兜底，版本以构建期为准；live 优先，命中失败才用缓存，避免长期陈旧。
- 工作树现含 Phase 1–2（npm 适配器）与先前「许可合规」两组未提交改动；建议本次 Phase 3–6 也独立提交（或三者合并视评审而定）。

---

## 来源 `plan-npm-phase7.md` · plan-1.1 · npm 数据源弱分类（keywords + 命名空间）

> 版本：1.1（2026-09-09 追加：双语分类 / 分类召回修复 / 排序生效 / Official 源核查） · 1.0（2026-09-09） · 前任：[plan-npm-phase3-6.md](plan-npm-phase3-6.md)（可信层 / 预缓存 / 许可聚合）

## 背景与目标

npm 没有原生类目体系，Phase 1–6 落地后 npm 源在 UI 上只有一个扁平的「MCP」分类，无法按用途筛选。
用户要求：**用开发者在 package.json 里定义的 keywords 与组织命名空间做弱分类（轻量、动态）**——


## 范围与边界

**做**

1. `src/main/platforms/npm.ts`：内置 `NPM_CATEGORY_RULES` 关键词映射表 + 导出 `classifyNpmPackage()`（keywords + 包名/命名空间词元）。
2. `mapListItem` 输出真实 `categories` / `categoryNames`，替换硬编码 `['mcp']`。
3. `searchServers` 支持 `params.category` 过滤；支持 `sort === 'downloads'`。
4. `fetchServerDetail`：未命中官方 Registry 时用最新版本的 keywords 分类（Registry 结果优先）。
5. `getFacets` 返回 6 个**扁平**分类（5 个用途类 + 兜底 `mcp`）。
6. i18n（zh/en）：`platformCategory` + `mcpCategory` 新增键。
7. 单测覆盖分类规则、排序、分类筛选。

**不做**（理由）

- **不做服务端分类过滤**——npm 无此能力。实测：`keywords:mcp filesystem` 与 `keywords:mcp` 的 total 同为 71219（自由文本被忽略），`(filesystem OR terminal)` 同为 71219（OR 不支持），只有 `keywords:<term>` 生效且多个之间是 AND（`keywords:mcp keywords:filesystem` → 154），对多关键词分类而言过严，故只能内存分类 + 内存过滤。
- **不把 `description` 喂给分类器**——噪声过大，会把提到 database 的无关包误分。
- **不修改 `platformCategory.search`**——该键被 `modelscope.ts:101`、`skillhub.ts:54` 共用；npm 侧改用独立 id `web-search` 规避。
- 不引入 `children` 层级——`StoreToolbar.tsx:159-173` 只渲染顶层节点。

## TODOS

- [x] 实测 npm 搜索接口是否返回 `keywords`，以及查询语法（自由文本 / OR / 多 `keywords:`）
- [x] 分类引擎 `NPM_CATEGORY_RULES` + `classifyNpmPackage` + `NPM_CATEGORY_LABELS`
- [x] `mapListItem` / `fetchServerDetail` / `getFacets` 接线
- [x] `searchServers` 分类过滤 + `downloads` 排序
- [x] i18n zh/en 新增键（含规避 `search` 跨源冲突）
- [x] 单测 + `pnpm typecheck` / `pnpm test` 全绿
- [x] QA 独立复查，修复 4 个 Major 缺陷（跨源污染 / 召回不可达 / 排序失效 / 总数误导）
- [x] 清理仓库根目录 3 个 0 字节临时探针文件

## 跨版本遗留

- 来自本次：ModelScope / SkillHub 分类 id 为 `search` 的卡片在 `ServerCard.tsx:89` 仍只查 `mcpCategory`，会回落到原始 slug（删除 `mcpCategory.search` 后恢复为改动前行为）。已在总览中列为待确认项。

---

> **已省略的过程性章节**（47 节，按需查 git 历史）：内置 NPM 数据源 / 1. 现状与关键事实（已逐文件核实） / 1.1 仓库存在两套「MCP 源」体系（务必厘清） / 1.2 主进程统一调度（已读 `src/main/index.ts` L955–1015） / 1.4 内置源如何在 UI 出现（已读 `connections-store.ts` / `McpSourceManager.tsx` / `useStoreSourceSelection.ts`） / 1.5 安装链路已通用（已读 `PlatformServerDetail.tsx` + `mcp-client.ts` 设计） / 2. 实现方案 + 框架选型 / 3. 文件列表及相对路径（含改动点） / 4. 数据结构与接口 / 4.1 类图（Mermaid） / 4.2 `npmAdapter` 需实现的接口签名（与 `PlatformAdapter` 完全一致） / 4.3 `PlatformServerDetail.install` 的 npm 形态 / 4.4 字段映射表 / 5. 程序调用流程（Mermaid 时序图） / T1 · 类型与常量扩展（基础，P0） / T2 · 实现 npm 适配器（核心，P0） / T3 · 注册适配器（P0） / T4 · 详情通道补 npm 分支 + 健康探测（P0） / T5 · UI 内置源 seed + 卡片标记（P1） / 8. 共享知识（跨文件约定） / 9. 待明确事项（Open Questions，需主理人/产品确认） / 1. 接口事实核查（回答第一个问题） / 1.1 列表查询（List / Search）——✅ 有 / 1.2 详情查看（Detail）——✅ 有 / 1.3 安装（Install）——⚠️ 没有 RPC，靠「拉起进程」 …
