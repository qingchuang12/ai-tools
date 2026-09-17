## 来源 `plan-skill-install.md`（原 plan-7.1.md） · plan-7.1 · 商店 Skill 安装成功率修复（GitHub 枚举抗抖动 + zip 安装元数据 + zip 解压去外部进程）

> 版本：7.1（2026-09-10）· 前任：[archive/plan-6.1.md](archive/plan-6.1.md)（假成功修复 / 虾评下载安装 / 平台源磁盘缓存 / 已安装标识）
>
> 触发：用户报告「商店-skills 的虾评和 modelscope 安装 skill 都基本失败了」。
>
> **7.0 → 7.1 修订**：QA 证伪「332 用例全绿」后查出 zip 解压依赖外部进程（D8，~15% 偶发红）；
> 据此复用同一缺陷类排查，又查出 `resolveZipSkill` 的并发互毁（D9）与分支臆造（D10），
> 一并收口（T9/T10），并补独立复核（T11）。

## 背景与目标

### 一、ModelScope「基本失败」——根因已实证（本轮核心）

本机网络到 `api.github.com` **间歇性连接失败**，而目录枚举采用「多次串行请求 + 静默吞错」，
把网络抖动放大成安装失败。三轮真实网络实测：


| 指标 | 实测 |
|---|---|
| 成功 / 失败 | 8 / 4 → **失败率 33%** |
| 失败形态 | `TypeError: fetch failed` |
| 失败耗时 | 稳定 ~10.5s（10544–10572ms） |
| 耗时 min / 中位 / max | 122ms / **6277ms** / 10572ms |


| 轮次 | 结果 | 耗时 |
|---|---|---|
| #1 | 文件 **13** 个（应 18，缺 5） | 38406ms |
| #2 | 文件 18 个 ✅ | 4382ms |
| #3 | 文件 18 个 ✅ | 858ms |
| #4 | 文件 **8** 个（缺 10） | 852ms |
| #5 | resolve ✗ `No SKILL.md found in this repository` | 2865ms |
| #6 | resolve ✗ 同上 | 899ms |



## 范围与边界

**做**
- `github.ts` 目录/文件枚举改为**单请求取全树**（`GET /git/trees/{ref}?recursive=1`），替代 1+N 次串行
- GitHub 请求加**指数退避重试**（针对 `fetch failed` / 超时，瞬时抖动重试极有效）
- **失败与「空」必须区分**：不再静默 `return []`；错误信息如实（网络失败不得谎报「仓库无 SKILL.md」）
- `installSkillFromZip` 元数据修复（D4/D5/D6）+ 临时目录按安装隔离（D7）
- zip 解压改为**项目自带纯 Node 解包器**（修 D8），消除外部进程依赖与跨平台缺陷
- `resolveZipSkill` 同源收口：临时目录隔离（修 D9）+ 不再臆造分支（修 D10）

**暂不做**
- 不改渲染层 UI 结构（本轮零 UI 改动）
- 不引入新依赖
- 不重构 `resolveFilesViaRaw` 为 codeload zip 兜底（用户未选该方案，记入后续观察）

### 取舍
- **trees API 的代价**：大仓库 `recursive=1` 响应较大（该仓库 11MB，tree 响应可接受）；用 `truncated` 字段判定，截断时回退递归
- **不改成 codeload zip 兜底**：改动面大，本轮先做低风险高收益项
- **`resolveZipSkill` 的 `files: []` 不改**：zip 直链通道的「安装前文件清单」为空属既有限制，安装时 `installSkillFromZip` 会从磁盘重新枚举实际清单，不影响装出来的结果，故不扩大本轮范围

### 风险与回滚
- 风险：trees API 对超大仓库返回 `truncated:true` → 已设计回退路径
- 回滚：改动集中在 `github.ts` / `skills-manager.ts` / `archive.ts` / `resolvers/install-zip.ts` 四个文件，可按文件单独回退

## TODOS

- [x] T1 `githubFetchWithRetry`：指数退避重试（仅网络类错误）
- [x] T2 `fetchGitHubTree`：trees API 单请求取全树 + `truncated` 回退
- [x] T3 `listDirFiles`：改用 trees 优先；失败**传播**而非静默返回 `[]`（修 D1/D2）
- [x] T4 `findSkillDirs`：同上接入；错误信息区分「网络失败」与「确实无 SKILL.md」（修 D3）
- [x] T5 `installSkillFromZip`：branch 不硬编码 / files 写实际清单 / rawBaseUrl 不存过期直链 / tmpRoot 隔离（修 D4–D7）
> **已结转至 `doc/plan-1.0.md`**（归档不得留存未完成任务）： T6 **待用户补证**：虾评失败的具体报错文案或触点（当前实测链路全通，无法复现）
- [x] T7 自检：`tsc -p tsconfig.main.json` + `tsc -p tsconfig.json` + 全量 vitest
- [x] T8 QA 回归：新增单测覆盖「枚举失败必须抛错」「重试生效」「trees 截断回退」
- [x] T9 zip 解压去外部进程：新增 `archive.ts:extractZipToDir`，两条 zip 通道改用纯 Node 解包（修 D8，消除 ~15% 偶发红）
- [x] T10 `resolveZipSkill` 同源收口：`finally` 只删私有 `extractDir`（修 D9）+ `branch` 不再臆造（修 D10）+ 确定性回归用例
- [x] T11 独立复核：变异测试证伪回归用例有效性 + vitest 连跑 3 轮（340/340）+ 双 tsc exit 0

> **T6 仍开放**：虾评链路所有环节均已实测通过（余额 28 / token 有效 / 下载 200 / zip 完好 / 根目录定位正确），
> 反向证据亦有（`Agent自我进化` 15:16 经该通道装成）。**无用户侧报错文案则无法定位，不做推测归因。**

---

## 来源 `plan-6.1.md` · plan-6.1 · 修复 Skill 安装「假成功」/ 虾评下载安装 / 平台源列表磁盘缓存

> 版本：6.1（2026-09-10）· 前任：[archive/plan-5.0.md](archive/plan-5.0.md)（新增 Coze Skill 平台源，已归档）
>
> 6.1 追加两个主题：T9 平台源列表加载慢（磁盘缓存 + SWR）、T10 商店安装后未显示已安装。

## 背景与目标

商店 → Skills → 虾评，点详情 → 安装 → 提示「安装成功」，实际没装上。

根因链（已定位并实证）：

1. **渲染层丢弃结果**（直接致因）：`SkillDetail.tsx:403` `await api.skills.install(...)` 未校验返回的
2. **主进程空清单不拦截**（假成功源头）：`skills-manager.ts:320` 判据
3. **虾评本无下载通道**：coze 列表项无 `repository/authorUrl` → `srcUrl` 为空 → resolve / 远程详情 /

- 任何来源安装失败都必须如实报错，不再出现「假成功」与空壳目录。
- 虾评支持在 mcp-dock 内一键安装（绑定 API Key 后）。
- 清理历史遗留空壳目录。

## 范围与边界

**做**

- P0 两处假成功修复（主进程 + 渲染层）。
- 平台安装能力标志：`PlatformAdapter.fetchSkillDownload` 是否实现 = 唯一事实源，
  渲染层据此决定是否可安装，避免 UI 堆 `if (source === 'xxx')`。
- 虾评下载安装通道：coze adapter 实现下载 → 复用既有 `installSkillFromZip`。
- 添加源时虾评的 key 栏提示。
- 清理 5 个历史空壳目录（先备份 → 移入回收站，可恢复）。

- 其他 SPA 源（SkillHub / ClawHub / SkillsMP）的下载安装实现——本轮仅通过能力标志正确禁用并提示。
- 虾评注册流程自动化：`POST /api/auth/register` 属创建外部账号 + 消耗 IP 配额，
- 虾评正式版下载扣 2 虾米的二次确认弹窗——本轮在 UI 文案提示「正式版将消耗虾米」。

### 触点与实测结论（2026-09-10）

| 端点 | 实测结果 |
|---|---|
| `GET /api/skills?page=1&limit=3` | 200，匿名可读列表 |
| `GET /api/skills/{id}` | **200，匿名可读详情** |
| `GET /api/skills/{id}/download` | **401**，错误体指向 `https://xiaping.coze.com/skill.md` |
| 同上 + `Authorization: Bearer sk_invalid` | 401 `Invalid API key` |

成功响应体 `{success, data:{download_url, version, coins_spent}}` **来自官方文档，未实测**（缺真实 key），
故运行时做防御式解析（`success` + `data.download_url` 双重校验），不假定结构。

### 取舍与风险

- **成功率 vs 安全**：下载成功路径未实测，故解析做防御式校验，失败给出平台返回的原始错误信息，
  便于用户自查 key / 虾米余额；不猜测成功结构。
- **扣费**：正式版下载扣 2 虾米属消耗用户资产，UI 明确提示，失败不自动重试。
- **回滚**：改动集中在 `SkillDetail.tsx` / `skills-manager.ts` / `coze.ts` / `SourceManager.tsx`
  与新增 IPC，均为增量；空壳清理有备份且走回收站，可完整恢复。

## TODOS

- [x] T1 P0-B：`installSkill` 空文件清单拦截 + 修正错误注释
- [x] T2 P0-A：`SkillDetail` 安装结果统一校验，去掉乐观更新
- [x] T3 能力标志：`fetchSkillDownload` + `PLATFORM_SKILL_DOWNLOAD` + 单测守卫
- [x] T4 虾评下载通道：coze adapter / IPC / preload / SkillDetail 接入
- [x] T5 添加源虾评 key 提示文案
- [x] T6 清理 5 个历史空壳目录（备份 → 删除；回收站 API 被沙箱禁用，已 md5 校验备份）
- [x] T7 自检：tsc 编译通过；单测 286 通过 / 1 失败（`env-manager` npx 探测，改动前既有问题）
- [x] T8 虾评下载安装端到端验证（2026-09-10 19:5x，用本机已绑定 key 实测，全链路通过）
      实测：`GET /api/users/coins` 200 余额 28；`GET /api/auth/me` 200 token 有效；

- [x] T9 平台源（ModelScope 等）列表加载慢：主进程侧加磁盘缓存 + SWR
- [x] T10 商店 ModelScope 安装后列表未显示「已安装」（我的库可见）：已定位并修复（详见下方 T10 段）

### T9 背景与实测（2026-09-10）

**结论：非 ModelScope 官方问题，是软件可优化。**

| 项目 | 实测 |
|---|---|
| `GET /openapi/v1/skills` 响应 | 首字节 0.36–0.49s，总计 0.36–0.63s |
| page_size 20/50/100 | 0.38 / 0.51 / 0.63s |
| 响应体 | 31KB / 86KB / 183KB（小，非瓶颈） |
| 连续 5 次快速请求 | 全 200，未触发限流 |
| 分类接口 | `getFacets` 返回硬编码 18 类常量，同步、零网络 |

**主因**：内置 GitHub 源走磁盘缓存 + SWR（`api/registry.ts:433-440`，首屏秒开）；

- key = `platform-search:<platformType>:<baseUrl>:<query>:<page>:<pageSize>:<category>:<sort>`，**不含 secret**（不落盘凭证）
- 命中未过期 → 直接返回；命中已过期 → 返回 stale + 后台刷新；未命中 → 请求后写缓存
- **失败结果不写缓存**（403/网络错误），避免把失败固化

### T10 背景与修复（2026-09-10）

**现象**：商店 → Skills → ModelScope 源，装完技能后列表卡片不显示「已安装」，但「我的库」里能看到。

**根因（方向 A 确认，方向 B 排除）**：`StoreGrid.tsx:48` 用 `installedSkillIds.has(skill.name)` 直接比对。
- 商店列表项 `skill.name` 取的是 **展示名**（`display_name`，如 `高德地图综合服务Skill`）；
- `installedSkillIds` 里存的却是 **物理目录名**（`id.split('/').pop()`，如 `amap-lbs-skill`）。

| 函数 | 作用 |
|---|---|
| `skillMatchKeys(value)` | 拆出 `full` + `tail` 两段小写键（`a/b` → `a/b`、`b`） |
| `skillSourceUrlKeys(url)` | 仅当 URL 含 `/tree/` 或 `/blob/` 时贡献 tail，避免普通仓库 URL 误命中 |
| `skillItemKeys(skill)` | 汇总 `name` + `id` + `sourceUrl` 的全部键 |
| `buildInstalledSkillKeys(names)` | 由物理目录名构建已安装键集 |
| `isSkillInstalled(set, itemKeys)` | 任一键命中即视为已安装 |

### T8 说明（跨版本遗留）

T4 的成功路径缺少真实 key 无法实测：实测只覆盖了「无鉴权 401 / 无效 key 401 / 详情 200」。
需用户在「编辑源 → 绑定 Token」填入虾评 API Key 后，装一个**试用版**技能验证（`coins_spent` 应为 0）。

## 来源 `plan-10.0.md` · plan-10.0 · SkillsMP 分类/排序修复

> 版本：10.0（2026-09-11）· 前任：[archive/plan-9.0.md](archive/plan-9.0.md)（E1：放开 ClawHub / SkillHub 商店内安装，已完结归档）

## 背景与目标

川哥要求：「商店 skillsmp 的分类排序检查一下，有问题就修复」。实测复核（plan-8.0 U4 结论依旧成立）：

- 上游 `filters` 仅支持 `search` / `sortBy`，**没有** category 过滤（任何 category 取值均 HTTP 400）。
- `sortBy=recent`（对应前端"最近更新"）实测有效改变结果顺序；stars/downloads/relevance/newest 均静默回退默认序。

由此确认三个真实缺陷：

1. **排序静默失效**：`sortBy` 计算了但 `SEARCH_TPLS` 无 `{sort}` 占位符 → 用户选任何排序都被丢弃。
2. **分类错标**：`mapEntry(raw, category?)` 把请求级 category 回填进每条结果 → 未过滤的结果被贴上分类标签，纯误导。
3. **假分类面板**：`getFacets` 声明了 62 项分类（上游根本不支持），UI 出现「选了分类但结果不过滤还被错标」的假筛选项。

## 范围与边界

- 仅 `src/main/platforms/skillsmp.ts` 与其测试；不动其它平台。

## TODOS

- [x] T1 SEARCH_TPLS 接线 sortBy，排序真实生效
- [x] T2 删除分类回填与假分类面板（mapEntry / getFacets / 常量）
- [x] T3 测试：no-refill 断言 + getFacets 如实断言（+2 用例，全量 392 绿）
- [x] T4 变异测试 M1（getFacets 复发）M2（category 回填复发）均 RED_OK，md5 恢复
- [x] T5 双 tsc 通过；测试执行备注见下

### 结论
列表查询本身已可用；本轮唯一的实质完善是**剔除假排序 `stars`**。分类筛选因上游零支持、且 item 无分类字段，客观上无法在本源实现，已维持如实空声明。若未来想给该源加分类，需 SkillsMP 上游提供分类 API 或分类字段。

## 待用户决策的候选任务（未确认前不执行）

| # | 事项 | 性质 | 说明 |
|---|---|---|---|
| A10 | 百炼 Bailian 接线或删除 | 产品决策 | 适配器已写已注册但类型/配置层未接线（D16 死代码）；接线属启用新源，删除属移除资产。接线需一并修复 icon URL 404 |
| E2 | 为 ModelScope 域名增加连接级退避 | 可选增强 | 上游新建连接超时率 33–50%，现有 2 次重试可缓解但首次等待可达 ~10s |

---

## 来源 `plan-12.0.md` · plan-12.0 · ClawHub 源「查询 + 安装」全面检查与修复

> 触发：用户要求对商店 Skills 的 ClawHub 源「查询/安装」功能全面检查并修复（@skill:code-assistant，先查后改）。
> 状态：**已实施（方案 A 安全修复）+ 验证通过**（tsc 0 error，47/47 测试通过）。

## 2. 关键结论：商店实际走适配器（Convex RPC），不是 trending 解析器
- `useSkillsData` 调 `api.platforms.searchSkills` → `index.ts:999` → `getAdapter('clawhub').searchSkills` = `clawhubAdapter`（`registry.ts:20`）。
- `resolvers/clawhub.ts` 的 `searchClawhubPaged` 仅由 legacy `searchPlatformDirectPaged`（`index.ts:939/951`、`platform-skill-resolver.ts`）调用，**未接入商店 skill 浏览**。两套实现字段契约不一致（一个读 `native.skill.stats.*`，一个读 `metrics.lifetimeInstalls`）。

### P3（清理，低风险）
- **P3-1** 两套 ClawHub 实现不一致（适配器 Convex vs 解析器 trending），建议收敛为单一实现（见决策）。
- **P3-2** 死代码：`clawhub.ts:283-285` `else if (sort==='relevance')` 不可达（外层已排除 relevance）。
- **P3-3** `baseUrl` 覆盖 footgun：`clawhub.ts:233` `base = baseUrl?...:CLAWHUB_BASE`，但注释称「不依赖 baseUrl」；用户若给 ClawHub 连接配自定义 baseUrl 会指向非 Convex 部署而失败。建议固定 `CLAWHUB_BASE`、忽略用户 baseUrl（或注释说明）。
- **P3-4** 离线 `getFacets` 读 `r.tags`，但 Convex 原始条目无顶层 `tags`（在 `native.skill.categories`）→ 分类计数永远为 0。

## 5. 待确认决策（翻页/浏览策略）
- **A 安全修复（推荐）**：保留 Convex 关键词搜索，修 P0 + P1（窗口≤100 正确切片）+ P2 + P3。低风险，不动网络契约。
- **B 切换 trending 端点**：用 `clawhub.ai/api/v1/trending` 游标翻页（与解析器一致，可深翻全部 ~2800 技能），关键词改客户端过滤。体验最佳但改动大、测试同步多。
- 说明：P0 安装 409 不论选 A/B 都修；仅翻页/浏览能力分叉。

### 验证结果
- `tsc -p tsconfig.main.json --noEmit`：**0 error**。
- `vitest run --pool=vmForks src/__tests__/platform-adapters.test.ts`：**47 passed / 47**（原 1 失败已修复）。
- 遗留探针/日志临时文件已清理（`clawhub_probe*.js`、`verify_*.log`）。

> **已省略的过程性章节**（26 节，按需查 git 历史）：商店 Skill 安装链路修复 / 三个放大缺陷 / 二、虾评——链路实测**完全正常**，未发现缺陷 / 三、附带查出的 zip 安装缺陷（用户已确认一并修） / 实现思路 / 触点 / 步骤 / 实现思路 / 步骤 / 实现思路 / 测试执行备注（环境异常，非本仓库问题） / 本轮：分类筛选 / 列表查询复核（2026-09-11 15:41） / 实测复核（真实请求取证，非凭推断） / 完善（仅做真实有效的，不造假） / 1. 调查方法 / 3. 问题清单（按严重度，均附真实证据） / P0 安装：歧义 slug 下载直链 409（必修） / P1 查询：翻页复读 + 无真实深翻页（必修） / P2（建议修） / 4. 测试同步 / 6. 实施步骤（确认后） / 7. 实施记录（方案 A · 2026-09-11） / 落地改动（`src/main/platforms/clawhub.ts`） / 同步改动（`src/main/resolvers/clawhub.ts`） / 测试（`src/__tests__/platform-adapters.test.ts`） …
