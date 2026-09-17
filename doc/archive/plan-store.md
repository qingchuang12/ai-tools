## 来源 `plan-store.md`（原 plan-1.4.md） · 商店模块（Store）优化任务清单 v1.4

扫描范围（已逐行读源码确认）：

| 文件 | 行数 |
|---|---|
| `src/renderer/src/pages/Store.tsx` | 257 |
| `src/renderer/src/pages/StoreToolbar.tsx` | 187 |
| `src/renderer/src/pages/StoreFilterBar.tsx` | 125 |
| `src/renderer/src/pages/StoreGrid.tsx` | 64 |
| `src/renderer/src/pages/StoreEmptyState.tsx` | 115 |
| `src/renderer/src/pages/StoreErrorState.tsx` | 23 |
| `src/renderer/src/components/ServerCard.tsx` | 256 |
| `src/renderer/src/components/SkillCard.tsx` | 193 |
| `src/renderer/src/components/Pagination.tsx` | 111 |
| `src/renderer/src/hooks/{useStoreData,useMcpData,useSkillsData,useStoreFacets,useStoreSourceSelection,useStoreAttribution,storeTypes}` | 660 |
| 关联：`lib/search.ts`、`store/useStore.ts`、`main/index.ts` 平台 IPC | — |



## 验证护栏

## 来源 `plan-1.0.md` · 商店问题修复计划 - Plan 1.0

> 版本：v1.1（2026-08-21）
> 依据：doc 目录下各平台对接文档 + 探针 HTML 示例（实测验证），非猜测。

---

## 问题根因分析（基于文档 vs 代码对比）

### 问题 5：Official 内置源分类过滤依赖关键词推断

**根因**：search.ts 的 ilterServersByCategory 使用 inferSkillCategoryId(displayName) 做关键词推断，而非使用 categories 字段。

## TODOS

- [x] **T1**：修复问题 3（Skill ModelScope 描述为空）— 重写 RawMS 接口、mapSkill、分类枚举
- [x] **T2**：修复问题 1（MCP ModelScope 查询不到数据）— PUT 请求 + RawMCP 接口 + locateArray/extractPageInfo 增强
- [x] **T3**：修复问题 2（Smithery 分类/排序无效）— 补齐过滤/排序调用
- [x] **T4**：修复问题 4（ClawHub 分类/排序无效）— 客户端过滤排序
- [x] **T5**：修复问题 5（Official 分类过滤关键词推断）— 优先 categories 字段
- [x] **T6**：修复问题 6（Smithery 缺少 categories）— 字段映射
- [x] **T7**：全量编译验证 + 回归测试

---

## 来源 `plan-1.1.md` · 商店数据源优化计划 - Plan 1.1

> 版本：v1.1（2026-08-21）
> 依据：doc 目录下各平台对接文档 + 探针 HTML 示例 + 源码对比分析
> 范围：ClawHub / SkillHub / SkillsMP 的 Skill 列表查询 + ModelScope 的 Skill 详情

---

## 问题根因分析（基于文档 vs 代码对比）

### 补充 B4（问题3 SkillsMP）：结果不含分类字段 + 默认词校验（P1）

对照 `skillsmp对接说明文档.md` §三、§〇：

1. **单条结果无分类字段**：文档明确"分类只作搜索范围过滤，不进结果"。当前 `RawSkillsmp` 的 `category` 字段与 `mapEntry` 的 `category: raw.category` 取不到值——应改为**用请求时的 category 回填**（或置空由客户端补充），避免展示错乱。
2. **`q` 默认词不能是 `*` 或纯符号**：`*`→400 INVALID_QUERY，需保证默认兜底词含字母/数字（如 `a`），并拦截纯符号。
3. **组级 slug 必须排除**：分类枚举只收 62 个叶子 slug（文档表格 #14–#75），组级 #1–#13（blockchain/business/...）实测恒 0，枚举里必须剔除。
4. **total 不可信 + 窗口封顶 1000**：前端计数/分页展示应标注"约数"，遇 `isCapped` 提示窗口封顶。

**涉及文件**：`skillsmp.ts` L22-L47（类别枚举剔除组级）、L58-L92（RawSkillsmp/mapEntry 分类处理）、L105（默认 q 兜底）。

### 补充 B8（范围说明：bailian 不在本轮范围，明确排除）（P0）

`doc/bailian/bailian对接说明文档.md` + `src/main/platforms/bailian.ts` + `src/main/platforms/bailian/data/bailian-index.json` 已存在且**与文档一致**（离线索引优先、8 分类 slug 正确、9 source、调用/用户/名称三档排序正确）。本次 `git status` 改动文件**不含 bailian 相关文件**，故：
- **bailian 不纳入本轮 T1–T6 范围**，不在本次修复清单内。
- 执行者切勿把 T3（SkillHub）的"子类/分类"改动误套到 bailian（两者结构不同：bailian 是 MCP Server 列表、8 分类；SkillHub 是 Skill 列表、12 类+子类）。

### 补充 B10（端到端验证 + 空参处理复核）（P1）

1. **SkillsMP 空 sort 省略参数**：`sortBy` 为空时模板应**省略该字段**（实测空值可能触发非法值回退），与 B4 的 q 兜底一起在 `fillTpl` 统一处理（并入 T2）。
2. **ClawHub 详情/下载端到端验证项**：fix 后必须实测 `GET /api/v1/skills/<slug>` 与 `GET /api/v1/download?slug=<slug>` 的返回结构与安装链路（问题 1 表第 6、7 行的"接入"不能只写代码，要有验证记录）。
3. **ModelScope 参数与分页复核**：`MS_SKILL_TPLS` 加 `filter.category` 后，`page_number`/`page_size` 参数名与响应 `data.pagination` 的字段映射需对照文档复核（`extractPageInfo` 已支持 `data.pagination`）。

---

## TODOS

- [x] **T0**：修复 ModelScope Skill 列表搜索端点，服务端分类过滤（合并 B7 锚点修正）
  - `MS_SKILL_TPLS`（L23-L25）模板直接带 `filter.category={category}`（当前缺该参数，靠 msSearchImpl 二次请求补过滤）→ 去掉二次请求，一次到位
  - 端点基址 `/openapi/v1/skills`（列表非 `/api/v1/`，后者仅用于详情）

- [x] **T1**：修复问题 1（ClawHub API 端点格式）— 合并 B1+B2+B7
  - 重写 `convexQuery` 为 Convex RPC，补齐必需请求头（Convex-Client / Origin / Referer）
  - 替换 4 个猜测 endpoints（L127-L132）为单一真实 RPC URL：base=`https://wry-manatee-359.convex.cloud/api/action`（Convex 标准路径），**RPC 方法名写在 body 的 `path` 字段，仅 `search:searchSkills` 可用**，不是 URL 路径段
  - `query` 永远非空（分类浏览传默认 `a`），全分类时**省略** `categorySlug` 字段（传空串=0 条）
  - args 仅放四件套 `query/categorySlug/limit/highlightedOnly`，剔除多余字段
  - `mapEntry` 补 `score` 字段映射（raw.score → extra.score），relevance 排序按 score 降序
  - `getFacets`（L255-L279）现会优先聚合离线索引 tags 作为分类（9 类兜底失效），需改为以 14 类 CLAWHUB_CATEGORIES 为准，离线 tags 仅作补充/合并，避免分类过滤与列表结果不一致

- [x] **T2**：修复问题 3（SkillsMP q 必填 + 端点精简）— 合并 B4
  - 空 q 传默认词（含字母数字，非 `*`/纯符号，避免 400 INVALID_QUERY），兜底统一落在 `probeEndpoints`/`fillTpl`（shared.ts）
  - 精简端点模板为 `https://skillsmp.com/api/v1/skills/search?q={q}&page={page}&limit={limit}&category={category}`（域名 `skillsmp.com`，路径 `/api/v1/skills/search`，非 `skillsmp.ai`）
  - **limit 钳制在 `probeEndpoints`/`fillTpl` 处 `Math.min(pageSize, 50)`**（API 上限 50，当前透传 pageSize 会超限）
  - 空 sort 时**省略 `sortBy` 参数**，避免非法值回退
  - 更新 62 叶子分类枚举（剔除组级 #1–#13 slug，仅收 #14–#75）
  - 修正 `mapEntry`：单条结果无分类字段，改用请求时 category 回填；total 不可信时标"约数"、isCapped 提示窗口封顶

- [x] **T3**：修复问题 2（SkillHub 分类枚举 + 排序档位）— 合并 B3+B9
  - 重写 12 类（id 用文档 slug：ai-agent/business-ops/...）
  - 子类从 API 返回 `subCategories[{key,name}]` 提取（剔除硬编码虚构 id），`mapEntry` 映射 subCategories
  - 排序补齐：`SKILLHUB_SORTS` 按文档 5 档对齐（score/stars/downloads/installs/updated_at），增补 `installs` 与 `stars` 档、删除 `name` 档；`SORT_MAP` 补 `installs: 'installs'`、校准 `newest → updated_at`（现映射 created_at 与文档不符）；子类筛选保持客户端行为

- [x] **T4**：修复问题 4（ModelScope 详情接口）— 合并 B5，补调用链
  - 新增 `fetchSkillDetail` 方法，路径 `GET /api/v1/skills/<id>`（非 `/openapi/v1/`）
  - 安装 SKILL.md 走 `source_url` → GitHub raw，`source_url` 为空时兜底
  - **调用链**：现有 `platforms:server-detail` IPC 只调 `adapter.fetchServerDetail`（MCP 详情）；skill 详情渲染层实际走 `skills:get-remote-detail`（GitHub 解析通道）。`fetchSkillDetail` 需明确：返回值结构（对齐 `PlatformSkillDetail`）、复用 `skills:get-remote-detail` 通道或新增 IPC handler + 渲染层 SkillDetail.tsx 消费点，二选一并写明

- [x] **T5**：修复问题 5（数据源能力分配策略）— 合并 B6，补渲染层落点
  - ClawHub 不走 `probeEndpoints`（Convex RPC 独立实现），标"不走 probe"
  - pagingMode 语义校正：ClawHub 单页上限100无分页（total=null/hasMore=false）；SkillsMP 窗口1000（serverTotal 标约数）
  - 统一策略新增：total 不可信平台前端分页器禁用跳页/总页数，仅保留上/下一页
  - **渲染层落点**：`src/renderer/src/hooks/useSkillsData.ts` / `useMcpData.ts` 的 `total = pageInfo.total ?? serverTotal ?? items.length` 处，total=null 时 `hasMore=false` 并透出"约数"标记；`Store.tsx` + `Pagination` 组件按标记禁用跳页/总页数展示；`useStore.ts` 的 pagingMode 硬编码 'server' 分支需按平台修正
  - 统一各平台服务端/客户端过滤排序策略

- [x] **T6**：全量编译验证 + 回归测试（tsc --noEmit + vitest）

---

## 来源 `plan-1.2.md` · 计划 1.2：ModelScope 数据源修复（商店 MCP 列表为空 + Skill「全部/部分分类」为空）

> 目标：修复商店中 ModelScope 两个数据源的查询缺陷——(1) MCP server 列表查不出数据；(2) Skill 列表「全部」及部分分类查不出数据。
> 范围：`src/main/platforms/modelscope.ts`、`src/main/index.ts`（facets IPC）、`src/preload/index.ts`、渲染层 `useStoreData` / `useStoreFacets` / `useStoreSourceSelection` / `Store.tsx`。不改动其它平台适配器。
> 状态：仅规划，未执行。
> 结论性质：以下 4 个根因均已由真实网络探针 + 源码逐行走读确认，**不含推测项**。

---

## 一、四个确定根因

### T2：删除 MCP 冗余二次过滤（已证不是根因，但属死逻辑）
> **已结转至 `doc/plan-1.0.md`**（归档不得留存未完成任务）： 删除 `msServerSearchImpl` L236-239 的客户端 `categories/tags` 二次过滤（服务端 `filter.category` 已生效，实测条目 `categories` 必含该分类）。

## 四、风险
- T4 改 `getFacets` 签名会触及 `types.ts` / `registry.ts` / `index.ts` / `preload` / `useStoreFacets` 五处，为本计划改动面最大项；因新增参数可选，其它适配器与调用点保持兼容。
- T6 移除两个排序档属功能收敛，UI 排序下拉将只剩「相关度」一项，需确认 `StoreFilterBar` 在单选项时的渲染不异常。
- Skill 真实分类清单来自 3 页 × 50 条抽样，长尾分类可能未被覆盖；T4 已规定新增须先实测，避免再次出现「枚举里有、查出来 0 条」。

---

## 来源 `plan-1.3.md` · 计划 1.3：全功能扫描与工程优化计划

> 目标：对 AI-Tools（MCP Dock）主进程、渲染层、平台适配层与工程化配置做一次完整审计，产出可落地的优化清单。
> 范围：`src/main/**`、`src/renderer/src/**`、`src/main/platforms/**`、根目录工程配置。
> 状态：仅规划，未执行。
> 证据性质：以下每条均经**实际读源码或执行命令确认**，不含推测项。已核验的关键结论在文末「验证记录」列出复现命令。
> 生成时间：2026-08-25

---

## 〇、审计范围与代码规模

| 层 | 文件数 | 行数 | 测试覆盖 |
|---|---|---|---|
| `src/main/`（核心） | 14 | 9890 | 5/14 有测试 |
| `src/main/platforms/` | 8 | 1964 | **0** |
| `src/renderer/src/pages/` | 13 | 7224 | **0** |
| `src/renderer/src/components/` | 22 | 5604 | **0** |
| 合计 | — | ~25000 | 7 个测试文件 / 76 例 |

最大三个文件：`platform-skill-resolver.ts`(2274)、`pages/Library.tsx`(1905)、`skills-manager.ts`(1774)。

---

## 六、验证记录

以下结论均由命令实测确认，可复现：

> （代码块已省略）

# 第五批重构（P2-1~P2-6）验证（2026-08-25）
## 来源 `plan-8.0.md` · plan-8.0 · 商店全数据源查询与安装全量排查

> 版本：8.0（2026-09-10）· 前任：[archive/plan-7.1.md](archive/plan-7.1.md)（GitHub 枚举抗抖动 / zip 安装元数据 / zip 解压去外部进程）
>
> 触发：用户要求「对商店所有数据源查询安装都检查一下，能修复的问题尽量修复，不能修复的问题给出问题报告清单」。

## 背景与目标

### 目标

对商店**全部数据源**的**查询链**（列表 / 搜索 / 详情 / 分类 / 分页）与**安装链**（解析 → 下载 → 落盘 → 元数据）逐条实测排查：

1. **能修的修** —— 代码写错、映射错误、判定错配、缺通道登记等，本轮修复并补测。
2. **不能修的列清单** —— 上游限制（平台无公开接口 / 已下线 / 需付费鉴权 / 域名不可达）如实归档，附确证证据，绝不编造理由。

## 实测结论矩阵

> 全部结论基于对上游接口的真实请求取证；关键项由我独立二次复核（见「复核」列）。

| 源 | 查询 | 安装 | 判定 | 主要问题 |
|---|---|---|---|---|
| GitHub Registry（内置） | ✅ | ✅ | 非缺陷 | 仅环境网络抖动；上轮 trees+重试修复经端到端复现有效 |
| ClawHub 榜单 | ✅ | ⚠️ 多数可用 | 上游限制 | 个别条目 409；`install.kind='github'` 当前数据中为 0（注释陈旧） |
| ModelScope Skill | ✅ | ❌ | **可修复缺陷** | **安装通道未登记**（D1/D2/D3）；配额常量张冠李戴（D4） |
| ModelScope MCP | ⚠️ 抖动 | ✅ | 上游限制 | 新建连接超时率 33–50%；适配器硬编码死包（D5，低触达） |
| 虾评 Coze | ✅ | ⚠️ 需 Key | 上游限制/凭证 | 代码路径正确；无有效 Bearer Key 即 401（实测） |
| SkillHub | ✅ | ✅ | 非缺陷 | 直连 API 可用；`dispatch.ts:139-140` 注释陈旧（D10） |
| SkillsMP | ❌ | ❌ | **可修复缺陷** | **基址 DNS 不可达**（D6）；忽略 `githubUrl`（D7） |
| SafeSkill | ❌ | ❌ | **上游限制 + 可修复缺陷** | 文档声明的 search 接口线上未部署；占位源映射错配（D8/D9） |
| 百炼 Bailian | ❌ 不可达 | N/A | **死代码（未接线）** | 适配器已写已注册，但连接配置层从未接线 → 运行时永不可达（D16） |
| skills.sh | N/A（仅详情） | ✅ | 非缺陷 | `HEAD` 作 ref 用法经实测有效 |
| Smithery（MCP） | ✅ | ✅ | 非缺陷 | 匿名可读；`@smithery/cli` 实测存在 |
| npm Registry（MCP） | ✅ | ✅ | 非缺陷 | 字段映射吻合；关键词编码正确 |
| 共享层 分页/分类/排序 | ✅ | — | 非缺陷 | 无除零/NaN；`sortOptions` 声明与消费一致 |
| 共享层 搜索缓存 | — | — | 可修复缺陷 | 缓存键缺鉴权态（D11）；磁盘无容量上限（D12） |

### 验证方式（沿用前序轮次已生效的做法）

- 变异测试：临时把守卫还原为缺陷实现，跑定向用例断言必红，再按 md5 逐字节还原。
- 全量套件连跑 ≥3 轮，排除偶发。
- 双 tsc：`tsc --noEmit -p tsconfig.main.json` 与 `-p tsconfig.json`。
- 代码来源核对：用文件时间戳 / `git diff` 判定改动归属，防止把历史未提交改动误算到本轮。

## 待决策项（已按「只修缺陷、不做功能扩张」定案）

> 这两项曾标记为「待川哥决策」，现已自行收口：只修**缺陷**，不扩张**功能范围**。理由记录如下，如不认可可随时推翻。

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| A7-1 | SafeSkill | **保留类型，修掉两个缺陷**（解除 `registry.ts:25` 的 `skillhubAdapter` 映射 + 探活不再假绿） | 「空 baseUrl 串出 SkillHub 数据」与「探活恒 200」是**缺陷**，必须修；而「下线整个源」是产品范围变更，会动到存量连接，不属本轮。改完效果：该源查询会诚实报「不支持」，不再假装可用、不再串别家数据 |
| A7-2 | ClawHub / SkillHub 安装 | **维持禁用，只把被证伪的注释改成事实** | 二者 zip 直链虽实测可用，但「放开安装」是**新增能力**而非修缺陷。按「不做功能扩张」原则不在此轮做。已记为可选增强（见下方 backlog），需要时单独立项 |
| A10 | 百炼 Bailian（D16） | **本轮不改，仅记录**。接线（补 `PlatformType` / `PLATFORM_META` / 平台类型清单三处）或删除适配器，均属产品范围决策 | 适配器逻辑自洽且已注册，改接线是「启用新源」（新能力），删除则是移除已有资产；两者都不属于「修缺陷」。若要接线，另需先修复其 icon URL 404 的数据缺陷 |

### 实施与验证记录（2026-09-11）

> 团队两名成员（engineer / qa）因平台 429 限流未能执行，B2 与端到端验证由主理人直接实施并自行验证，全过程证据如下，可独立复核。

| 项 | 证据 |
|---|---|
| B1 修复（D1–D7） | 双 tsc exit 0；`npx vitest run` 连跑 3 轮全绿（26 文件 / 368 用例）；**5 个变异全部转红**（M1 抹掉 modelscope 登记 / M2 配额退回 100 / M3 忽略 githubUrl / M4 downloadUrl 退回页面地址 / M5 摘掉 fetchSkillDownload），均按 md5 逐字节还原 |
| B2 修复（D8–D12、D15） | 双 tsc exit 0（第一轮 tsc 抓到 `listAdapters` 的 `Partial` 缺键类型错误并已修复）；全量 3 轮 + 1 轮复核全绿（28 文件 / 384 用例）；**5 个变异全部转红**（M6 串回 skillhubAdapter / M7 恢复探活 `['/']` / M8 缓存键去鉴权态 / M9 关闭容量裁剪 / M10 恢复孤儿常量），均按 md5 逐字节还原 |
| 端到端安装链 | 新增 `src/__tests__/install-platform-chain.test.ts`：V1 直链→zip 安装→落盘真目录（SKILL.md + 3 文件清单）；V2 未接线平台主进程/渲染层双重拦截；V3 `owner/slug` 路由编解码往返；V4 空 ID 明确报错 |
| 数据复核 | ClawHub 榜单实测 100 条：`install.kind='clawhub'` 60 条（60%，注释准确）、`github` 0 条（旧注释证伪成立） |

## TODOS

- [x] A1 四路只读实测排查（W1–W4）回传并汇总
- [x] A2 汇总实测矩阵：每源 × 查询/详情/安装 的可用性判定
- [x] A3 可修复缺陷定级与排序，出最小改法（D1–D16）
- [x] A6 产出问题报告清单（上游限制 U1–U6 附确证证据与建议 UI 措辞）
- [x] A7 决策收口（按「只修缺陷、不做功能扩张」定案，见「待决策项」）
- [x] A4a **B1 实施**：D1–D7 修复 + 回归测试（ModelScope 安装接线 / 配额拆分 / SkillsMP 基址与字段）+ D14 反向守卫
- [x] A4b **B2 实施**：D8–D12、D15（SafeSkill 映射与探活 / 陈旧注释 / 缓存键鉴权态 / 缓存容量上限 / 孤儿常量与死模板）
- [x] A5 独立复核：变异测试证伪新用例有效性（B1 五连 + B2 五连全转红）+ 全量 vitest 多轮 + 双 tsc
- [x] A8 **B4**：百炼 Bailian 源审计（结论：死代码 D16，本轮不改，见 A10）
- [x] A9 ~~顺延自 plan-7.1 T6：待用户补证虾评报错文案~~ → **已结案：无法复现，不做推测归因**
  - 川哥明确表示他也没有报错文案。处置：该源记为「实测链路全通、未复现失败」，**不再作为阻塞项挂着**。
  - 已确证的事实（保留在案）：匿名列表 ✅ 200；`/api/categories` ✅ 与 `COZE_CATEGORIES` 一致；下载接口无 token → 401 `Authorization required`、无效 token → 401 `Invalid API key`；代码 `coze.ts:181-186` 无 secret 时直接抛明确错误、不发请求。**结论：代码路径正确，用户侧若遇失败，最可能是未绑定有效 API Key 或 Key 已失效。**

## 来源 `plan-15.0.md` · plan-15.0 · 单一活动计划（商店全流程发布前检查）

> 版本：1.1（2026-09-12 模块 P：商店所有源查询/安装全流程发布前检查——QA 全面回归 + 3 条建议级收尾，最终放行）· 单一活动 plan：本仓库 `doc/` 同时仅保留此一份活动 plan。
> 前任归档：[archive/plan-14.0.md](archive/plan-14.0.md)（A 百炼远程 MCP 安装 + 建议级遗留收敛 + StoreFilterBar 未筛选基准收敛 + 详情接线外链纠正；遗留用户侧事项：统一提交，由川哥执行）。

### P.1 检查范围与结果（QA 严过关独立执行，一轮通过）
| 层面 | 结果 |
|---|---|
| 基线复跑 | 双 `tsc --noEmit` exit 0；vitest 全量 **29 文件 / 433 passed** |
| dist 产物直跑 | **15/15 PASS**：bailian 全参数矩阵（哨兵/分类/来源/双排序/分页零重复/远程详情+headersTemplate/getFacets/异常路径）；npm 离线快照（facets 6 类 + searchServers total=71841 + 详情 command 型 install）；clawhub 离线回退读码确认（有缓存本地过滤/无缓存空态不抛错） |
| 链路走查 | 查询参数透传与哨兵一致性（渲染层默认值 ↔ 各 adapter 判据全小写 'all'）；facets→StoreToolbar(optgroup)→StoreFilterBar→回写；hasActiveStoreFilters 新基准与清除回调交互正确；详情/安装双形态分支（远程 buildRemoteHeaders 模板替换正确 + 本地命令型行为不变）；安装落盘 4 类客户端序列化（cursor 透传/opencode remote/openclaw/zcode url 分支）；LocalInstall\|RemoteInstall 三端同源 |
| 静态一致性 | zh/en locale key 递归对比 **844=844 零差异**；死引用扫描干净（safeskill 仅存量兼容 / skillCategory.skillsmp 已删 / 'ALL' 无代码残留）；git 变更清单与已知改动吻合 |

在线源（skillsmp/skillhub/coze/modelscope）因限流不做真实调用，以链路走查替代——如实标注。

### P.3 验证
- 双 `tsc --noEmit` exit 0；vitest 全量 **29 文件 / 433 passed**；zh/en JSON.parse 合法；QA 复验 3/3 闭环无新增问题。
- **最终结论：放行**。无阻断/严重问题，建议级事项全部闭环。

- [x] P 商店全流程发布前检查（QA 全面回归 + 3 条建议级收尾 + 复验；最终放行）

---

## 跨版本遗留项

（暂无。codex-cli TOML 对远程 MCP 的支持属上游客户端能力边界，UI 已明示不支持；后续上游支持时可移除拦截。）

## TODOS（汇总）
- [x] P 商店全流程发布前检查（QA 全面回归 + 3 条建议级收尾 + 复验；最终放行）

---

> **已省略的过程性章节**（144 节，按需查 git 历史）：商店与数据源（Store） / P0 严重（功能性缺陷，用户可感知的错误行为） / S0-1 MCP 平台源的分类/排序面（facets）取错了 platformType / S0-2 平台源 queryKey 缺 `pageSize`，改「每页条数」不生效 / S0-3 Smithery 源的分类/搜索过滤只作用于当前页，计数完全错误 / S0-4 Skills 内置源「强制刷新」拿不到新数据 / S0-5 越界页产生荒谬的区间显示与空列表 / S0-6 主进程按 platformType 猜连接，多连接场景用错 token/baseUrl / S0-7 安装状态不刷新，「已安装」徽章长期失效 / S0-8 两个 `.then()` 没有 `.catch()` / P1 重要（可用性 / 性能 / i18n / 无障碍） / S1-1 `t('key') || '兜底'` 是永不生效的死代码（9 处） / S1-2 分类名缺失时显示 key 原文 / S1-3 卡片硬编码中文，英文界面漏中文 / S1-4 时间格式化硬编码英文，中文界面漏英文 / S1-5 归属说明栏硬编码英文 / S1-6 分页 aria-label 硬编码中文 / S1-7 卡片不可键盘操作 / S1-8 二级分类菜单键盘不可达 / S1-9 筛选下拉无可访问名称 / S1-10 内置源全量列表每次渲染重算，无 memo / S1-11 翻页闪全屏 Loading，无上一页占位 / S1-12 刷新按钮人为等待 1.5 秒 / S1-13 pageSize=100 与 ModelScope 配额直接冲突 / S1-14 内置源提供了「最近更新」排序但根本没实现 …
