## 来源 `plan-active-rounds.md`（原 plan-13.0.md） · plan-13.0 · 单一活动计划（A10 百炼接线 + E2 ModelScope 退避 + electron:dev 修复）

> 版本：14.2（2026-09-12 模块 G 实施：百炼「全部」哨兵值大小写修复——商店-MCP-百炼空列表）· 单一活动 plan：本仓库 `doc/` 同时仅保留此一份活动 plan。
> 前任归档：[archive/plan-10.0.md](archive/plan-10.0.md)、[archive/plan-11.0.md](archive/plan-11.0.md)、[archive/plan-12.0.md](archive/plan-12.0.md)。
> 合并来源：plan-14.0（electron:dev 诊断）已并入本 plan 后删除。

## 模块 A · A10 百炼接线 + E2 ModelScope 退避（已实施并验证）

决策（2026-09-11 拍板）：A10 = **接线启用**；E2 = **加连接级退避**。

### 验证证据
- `tsc -p tsconfig.main.json --noEmit` 与 `tsc -p tsconfig.json --noEmit` → **exit 0**（主进程 + 渲染进程均干净）。
- `vitest run`（全量）→ **28 文件 / 397 测试全绿，exit 0**。

- [x] A10 接线实施 + icon 404 修复
- [x] E2 ModelScope 连接级退避实施

---

## 模块 B · electron:dev 无窗口修复（已定位 → 修复 → 验证）

### B.2 根因（两处，均已确证）
本故障由**两个相互独立的环境问题**叠加造成，缺一不能修好。

**B.2.1 `ELECTRON_RUN_AS_NODE=1` 环境变量污染**
- `electron.exe` 退化为**纯 Node 运行时** → 不启动浏览器进程；
- `require('electron')` 不再被拦截，回退为 npm 包的 shim（返回可执行文件路径**字符串**）；
- `app` / `BrowserWindow` 全为 `undefined`。




### B.5 验证证据（父进程仍带 `ELECTRON_RUN_AS_NODE=1`）

| 场景 | 结果 |
|---|---|
| 包装器启动真实 app（生产分支） | `LAUNCHER_STATUS=ALIVE_AFTER_9000ms`、`GPU_FATAL=false`、`GETPATH_CRASH=false`；日志确认 `args=[".","--no-sandbox"]` 且已清理 `ELECTRON_RUN_AS_NODE` |
| 包装器启动（**dev 分支**：`VITE_DEV_SERVER_URL` 已设 → `loadURL()` + `openDevTools()`） | `ALIVE_AFTER_9000ms`、无 GPU 致命退出；stderr 仅 `ERR_CONNECTION_REFUSED`（因未启 Vite，属预期） |

- [x] B 修复（包装器清 `ELECTRON_RUN_AS_NODE` + 开发追加 `--no-sandbox`）并验证

## 模块 C · 「安装 MCP → 无需配置」空态美化（已实施并验证）

### C.3 验证证据
- `tsc -p tsconfig.json --noEmit` → **exit 0**；`tsc -p tsconfig.main.json --noEmit` → **exit 0**。
- `vite build`（renderer）→ **exit 0**（built in 27.67s）。
- **产物实证**（不只看「构建通过」）：
  - `dist/renderer/assets/*.css` 含 `.bg-success\/10{background-color:#34c7591a}` → 确认透明度变体真的产出 CSS，而非被 Tailwind 丢弃（`/10` 打在 CSS 变量上才容易失效，此处用的是 theme 里的 hex，安全）；
  - `dist/renderer/assets/*.js` 含新对勾路径 `9 12.75 11.25 15 15 9.75` → 图标已进产物。
- 说明：本机无显示会话，**视觉最终确认需川哥在窗口内过目**。

- [x] C 「无需配置」空态美化 + i18n 修正 + 消除上方矛盾文案

### D.2 问题 2 · ClawHub 列表标签显示不正常（**已修复并验证**）
**现象**：ClawHub 卡片上的分类标签**几乎全部显示为原始英文小写 id（research/other/finance…）且一律灰底**，与其它源的中文彩色标签格格不入；个别无分类条目还会渲染出一个**没有文字的空标签**。
**根因（实测 100 条真实数据 + 渲染链路复现）**：
1. **缺翻译**：ClawHub 下发 14 类分类 id（integrations/automation/research/development/productivity/communication/creative/knowledge/agents/operations/security/finance/lifestyle/other），而 `skillCategory` 只有内置 8 类；`localizeKey(t, i18n, 'skillCategory.'+id, id)` 找不到键 → **回退成原始 id**。实测 40 条中 100% 的标签全部回退（finance 26 / other 8 / research 4 / development 3 / communication 2 / automation / integrations / operations 各 1）。
2. **缺配色**：`getCategoryColor` 只覆盖内置 8 类 → ClawHub 分类全部落 `colors[id]` 未命中 → 走灰底兜底。
3. **空标签**：`SkillCard` 旧逻辑 `rawCategories.length ? [...] : [skill.category]`，而 `skill.category` 为 `undefined` 时 → `catList = [undefined]` → 渲染出**无文字的标签**。实测 100 条中有 1 条（`a-b-test-design` 无任何分类）命中。
4. **潜在类型坑**：`clawhub.ts` 的 `raw.native?.skill?.categories || … || raw.tags` 回退链，而 Convex 真实结构里 **`tags` 是对象**（`{latest: <versionId>}`）而非数组 → 一旦上游某条缺 `categories`，`extra.categories` 会变成对象，客户端分类过滤 `cats.includes(...)` 将**直接抛 TypeError**，`getFacets` 统计也会误处理。
- `locales/zh.json` + `en.json`：`skillCategory` 补齐 12 个 ClawHub 分类（productivity/security 已有，不重复）。
- `SkillCard.tsx`：`getCategoryColor` 增加 11 个 ClawHub 分类配色（other 保留灰底兜底）；`catList` 改为**仅收非空字符串**，无分类时不再产出空标签。
- `clawhub.ts`：新增 `toCatArray` / `pickCategories`，把分类收敛为「非空字符串数组」，并**彻底移除 `raw.tags` 回退**（`tags` 是对象，不是分类）；`mapEntry` / `getFacets` / 两处客户端过滤统一走它。
- 真实数据终验（60 条）：修复前 `[research]`/`[other]`/`[finance]` → 修复后 `[研究🎨]`/`[其他▫️]`/`[金融🎨]`；未本地化标签 **0**，空标签 **0**。
- `tsc -p tsconfig.json --noEmit` → exit 0；`tsc -p tsconfig.main.json --noEmit` → exit 0。
- `vitest run` 全量 → **397 passed，exit 0**（含 `clawhub.mapEntry` / 离线缓存 / NASTY_INPUTS 全部通过）。
- `vite build`（renderer）→ exit 0；产物 CSS 实证 9 个新色类全部产出（`bg-indigo-500\/15` … `bg-amber-500\/15` 均 FOUND）。
- 说明：本机无显示会话，**最终视觉需川哥在窗口内过目**。


- [x] D2 ClawHub 标签本地化 + 配色 + 空标签/类型坑加固（实施 + 验证）
- [x] D2b ClawHub 卡片作者改真实 ownerHandle（2026-09-12 实施 + 验证）


### 验证证据
| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.main.json --noEmit` | exit 0 |
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `vitest run` 全量 | **28 文件 / 406 用例通过**，exit 0（含 E5 新增 3 条守卫） |
| 百炼排序前后对照（真实 251 条索引） | OLD `users` == 原始顺序（失效）→ NEW == 正确降序 ✓ |
| 探活决策树对照 | bailian / safeskill 均为「未配路径」：OLD 探首页（假绿）→ NEW 不探测（`active` / `error`） |
| `platform-adapters.test.ts` 单文件 | 56 passed |

> 注：全量套件曾出现 1 例偶发失败，复跑即 406/406 全绿 —— 与既往记录过的 `env-manager > checkNpx` 并行负载抖动同源，非本次改动引入。

- [x] E1 ClawHub 排序核查（结论：可用，保留）
- [x] E2 百炼排序静默失效修复 + 探活假绿修复
- [x] E3 SafeSkill 可修复性核查（源不可修 → 退化为如实空态）+ 探活死代码修复
- [x] E4 schemas/ 删除（零引用）
- [x] E5 SafeSkill 从 `SKILL_PLATFORM_TYPES` 下线（保留类型/META 以兼容存量连接；实施 + 验证）

---

### F.1 结论：**旧结论「SkillsMP 不支持分类」是错的，上游真实支持**

之前（plan-8.0 U4 / plan-10.0）判定「无分类能力」，是**三次踩坑叠加**，并非上游没这功能：

| 旧测法 | 真实原因 |
|---|---|
| `?search=&category=<slug>` → 400 | **`search` 空串本身就会 400**（`INVALID_QUERY`），与 category 无关，属误伤 |
| `?categorySlug=development` → 200 但结果不变 | **参数名错了**，正确名是 `category`；错名被静默忽略 |
| 站点 75 个 slug 里 `development`/`tools` 等 → 400 | 这些是**父级分组**，API **只认叶子分类** |

### F.7 验证证据

**F.7-1 测试抓出实现 bug（这正是补测试的价值）**：初版模板写死 `&category={category}` 并靠「空值替换为空串」省略参数，回归用例立刻抓到真实请求是 `...&sortBy=&category=backend` —— `fillTpl` 对空值产出**空串**而非删除参数，`sortBy=` 属与 `category=` 同类的空参数隐患（上游目前容忍空 sortBy，但不可依赖）。已改为**按 (sortBy?, category?) 四组合显式枚举模板**（`SKILLSMP_TPLS.plain / sort / category / sortCategory`，各带一条去 `limit` 的降级项），空值 = 参数**根本不出现**；带 category 的组合降级时**绝不丢 category**（否则静默退回未过滤结果 = 假象）。

| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.main.json --noEmit` | exit 0 |
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `vitest run` 全量 | **28 文件 / 416 用例通过**，exit 0（基线 406 + D2b 3 + F 净增 7：getFacets 3 条 + 参数透传 5 条，替换 1 条过时断言） |
| zh/en locale JSON 解析 | OK，`skillCategory` 嵌套 `skillsmp` 键已移除（21 个扁平键保留） |
| 分类树静态抽查 | 63 叶去重一致、12 父域齐全、父域未混入叶子 |
| **真实上游端到端**（4 组合 + 2 降级形态，节流 1.1s） | 全部 **HTTP 200**；`category=backend` 结果序列与不带分类**不同**（过滤生效 ✓）；`sortBy=recent` 与 `stars` **不同**（排序生效 ✓）；`filters` 回显不含 category（上游本就不回显，以结果序列为准） |
| 新增守卫 | 未选分类不发 `category=`；合法分类必带；非法值（`coding`/`data-analytics`/父域 slug）不透传；带分类后任何降级都不丢 category；假控件 `relevance` 不再出现在 sortOptions |

**遗留说明（未修，非本次范围）**：`StoreFilterBar.hasActiveFilters` 硬编码 `sort !== 'relevance'` 为「未筛选」基准，对无 `relevance` 排序的源（Coze/百炼）恒判「有筛选」。属既有问题、与本次改动无关，如需收敛可另开任务。

### G.1 排查结论：数据与链路全部正常，唯一根因是哨兵值大小写

排查覆盖全链路（均有实证）：

| 环节 | 结论 |
|---|---|
| 离线索引产物 `dist/main/platforms/bailian/data/bailian-index.json` | 存在且有效（251 条，mtime 2026-08-19；`copy-platform-data.mjs` 拷贝链路正常） |
| `dist/main/platforms/bailian.js` | 2026-09-12 00:50 编译，与源码同步 |
| `registry.ts` 注册 / `platformTypeToSupported('bailian')` 映射 / `builtinMcpSeeds()` seed | 均在 |
| 渲染层查询 `useMcpData.ts:77` → IPC `platforms:search-servers` → `bailianAdapter.searchServers` | 通 |

**根因**：`bailian.ts:134-135` 把「全部」哨兵值写成**大写 `'ALL'`**，而渲染层契约是**小写 `'all'`**——`useMcpData.ts:78` 固定传 `category || 'all'` / `source || 'all'`，下拉框「全部」的 value 也是 `'all'`（`StoreToolbar.tsx:168`、`StoreFilterBar.tsx:73`）。两个匹配条件对 'all' 永假 → **251 条全被过滤 → 列表恒为空**（连选具体分类也无效，因 `source='all'` 仍全灭）。ModelScope（`modelscope.ts:326/425/460`）与 npm（`npm.ts:534`）均为小写 `'all'`，百炼是唯一写错的 adapter。


| source | category | total |
|---|---|---|
| `''` | `''` | 251 ✓ |
| `''` | `'all'`（渲染层实际传值） | **0 ✗** |
| `'all'` | 任意 | **0 ✗** |
| `'ALIYUN'` | `''` | 35 ✓（真实筛选本身正常） |

### G.3 验证证据

| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.main.json --noEmit` | exit 0 |
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `vitest run` 全量 | 28 文件 / 420 用例通过，exit 0（基线 416 + G 新增 4） |
| 修复后 dist 直跑矩阵 | `source='all',category='all'` → **251**（修复前 0）；`ALIYUN` → 35 不变 |

- [x] G 百炼「全部」哨兵值大小写修复（实施 + 验证）

---

## TODOS（汇总）
- [x] A10 百炼接线启用（实施 + 验证）
- [x] E2 ModelScope 连接级退避（实施 + 验证）
- [x] B electron:dev 无窗口修复（三根因全修：环境变量污染 + Chromium 沙箱 + wait-on 地址族错配；实施 + 验证）
- [x] C 「安装 MCP → 无需配置」空态美化（实施 + 验证）
- [x] D2 ClawHub 列表标签本地化 + 配色 + 空标签加固（实施 + 验证）
- [x] E1 ClawHub 排序核查（结论：可用，保留）
- [x] E2 百炼源完善（排序静默失效修复 + 探活假绿修复，实施 + 验证）
- [x] E3 SafeSkill 核查（源不可修；探活死代码 + 商店错误态修复，实施 + 验证）
- [x] E4 schemas/ 删除（零引用）
- [x] E5 SafeSkill 从 `SKILL_PLATFORM_TYPES` 下线（保留类型/META 兼容存量连接；实施 + 验证）
- [x] D1 SkillsMP 分类筛选 → 定案「接入上游真实分类」（探查取证见模块 F）
- [x] D2b ClawHub 卡片作者改真实 ownerHandle（实施 + 验证）
- [x] F.5-a~f SkillsMP 真实分类接入实施（分类树 + 白名单四组合模板 + optgroup + 排序修正 + 清死配置；实施 + 验证）
- [x] G 百炼「全部」哨兵值大小写修复——商店-MCP-百炼空列表（实施 + 验证）
> **已结转至 `doc/plan-1.0.md`**（归档不得留存未完成任务）： **统一提交**【用户侧事项，不计入 AI 的归档判定】（A10/E2/B/C/D/E/F 改动 + plan-8.0~12.0 遗留未提交改动；由川哥执行，AI 不代做、不催促——2026-09-12 新边界，见 code-assistant 技能 v1.1）

---

## 来源 `plan-14.0.md` · plan-14.0 · 单一活动计划（百炼远程 MCP 安装 + 遗留项承接）

> 版本：2.0（2026-09-12 模块 A：百炼「不能安装」修复——远程 MCP 安装形态）· 单一活动 plan：本仓库 `doc/` 同时仅保留此一份活动 plan。
> 前任归档：[archive/plan-13.0.md](archive/plan-13.0.md)（A10 百炼接线 + E2 退避 + electron:dev 修复 + C 空态美化 + D/E/F 商店源完善 + G 百炼哨兵值修复，AI 任务全绿后归档；遗留用户侧事项：统一提交，由川哥执行）。

## 跨版本遗留项

- [x] StoreFilterBar `hasActiveFilters` 硬编码 `sort !== 'relevance'` 为「未筛选」基准 → **已收敛（2026-09-12 实施 + 验证）**：提炼 `src/renderer/src/lib/store-filters.ts` 纯函数（`resolveSortDisplayValue` + `hasActiveStoreFilters`），基准改为「排序处于该源默认选项（sortOptions[0]，与下拉显示值一致）」。误判场景：用户在无 relevance 的源（百炼=calls/SkillsMP=stars）上选回首选项（= 回到该源默认序）被旧逻辑判为「有筛选」，清除按钮常驻；且点清除后 sort 变成下拉不存在的 'relevance'，显示又兜底回首选项——视觉矛盾。新逻辑与显示值一致；空选项集退化为旧语义；`Store.tsx` 的切源重置/清除行为（`setSort('relevance')`）不动（relevance 是跨源中立值，显示层兜底语义不变）。测试：`store-search.test.ts` 补 9 条（百炼/SkillsMP/smithery 三形态矩阵 + 空选项集退化）；全量 29 文件 / **433 passed**，双 tsc exit 0。

## 模块 A · 商店-MCP-百炼「不能安装」（2026-09-12，川哥反馈；已实施并验证，QA 放行）

### A.1 诊断结论（主理人已完成取证）
- **直接原因**：`bailian.ts` `fetchServerDetail` 返回 `install: null`（当初按「远程托管无需本地命令」处理）→ `PlatformServerDetail.tsx:284` `canInstall = !!detail.install` 为 false → 详情页显示灰色「无可用安装配置」，无安装入口。详情链路本身已通（`servers.ts:297-299` 委派 adapter）。
- **本质**：百炼是**远程托管 MCP**，安装 = 向客户端配置写入 `{url, type:'sse'|'streamable-http', headers:{Authorization: Bearer <DASHSCOPE_API_KEY>}}`，与本地 command/args 形态不同。
- **主进程能力已齐备（零改动）**：`McpServerConfig`（`electron.ts:59`、`config/types.ts:15`）含 `url`/`type`/`headers`；`config-manager.installServer` 纯透传；`format-adapters.ts` 对 openclaw/zcode/opencode 有显式 remote 分支，其余客户端整对象透传；`mcp:connect`（Inspector）支持 URL 连接。
- **上游事实（实测 + 官方文档，2026-09-12）**：
  - 接入 URL：`https://dashscope.aliyuncs.com/api/v1/mcps/{slug}/sse`（SSE）或 `/mcp`（Streamable HTTP），鉴权 Header `Authorization: Bearer ${DASHSCOPE_API_KEY}`（来源：help.aliyun.com《web-search-for-coding-plan》《official-and-third-party-mcp》）。
  - **slug ≠ 中文服务名**：官方示例 slug 为英文（`amap-maps`/`WebSearch`）；索引 251 条 serverName **全部含中文、0 条纯 ASCII**，且索引无 slug 字段 → 无法自动生成确定可用的 URL；匿名探测全 401（`InvalidApiKey`，鉴权先于路由），无法验证 slug 存在性。
- **诚实边界**：预填 URL 为**生成值**（dashscope 格式 + 中文名 URL 编码），部分服务 slug 不同 → UI 必须**可编辑**并明示「以百炼控制台接入地址为准」；codex-cli（TOML）读写均只支持 command 型，远程配置会被丢弃（既有局限，本次不扩，如实记录）。

### A.3 实施（工程师）与验证（QA 放行，2026-09-12）
实施落点（与 A.2 方案的差异：类型扩展落在 `src/main/platforms/types.ts` 而非渲染层——`PlatformServerDetail` 类型由该处 re-export，单一事实源）：
| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/main/platforms/types.ts` | 新增 `LocalInstall`/`RemoteInstall` 联合，`install?: LocalInstall \| RemoteInstall \| null`（旧 `args: string[]` 必征求窄为可选） |
| 2 | `src/main/platforms/bailian.ts` | `fetchServerDetail` 返回远程 install（`{url: dashscope 格式生成, type:'sse'}`）+ `envSchema.required: ['DASHSCOPE_API_KEY']` + readme 接入说明 |
| 3 | `src/renderer/src/pages/PlatformServerDetail.tsx` | 远程分支：跳过 runtime 检测、可编辑 URL 输入框、handleInstall 构造 `{url,type,headers:{Authorization:'Bearer '+key}}`、openInspector 远程传 URL 配置；本地命令型（ModelScope/npm）逐行保留 |
| 4 | `zh/en locale` | `detail.remoteUrlLabel` / `detail.remoteUrlHint` 成对新增 |
| 5 | 测试 | `platform-adapters.test.ts` bailian 详情断言（url 格式/type/envSchema）；`server-detail-resolver.test.ts` 过时断言同步（原断言 install:null） |

**验证证据**（QA 独立复跑，1 轮通过、零修复）：
- 双 `tsc --noEmit` exit 0；`vitest run` 全量 **29 文件 / 424 passed**，exit 0。
- **dist 产物级验证 15/15**：编译 dist 后直跑 `bailian.js` 的 `fetchServerDetail`，抽样「企业知识库」（纯中文）+「OA审批 2」（含空格数字）+ 未知 ID 异常路径——url 格式/type/envSchema/readme/异常文案全对（脚本 `.zcode/qa-dist-bailian-verify.cjs` 可复跑）。
- 回归走查：modelscope/npm/clawhub/servers.ts 的 install 赋值点 args 均有值（类型收窄不破坏）；渲染层 `detail.install.*` 访问全部在 `'url' in`/`'command' in` 收窄守卫内；本地分支 diff 核对逐行保留；i18n JSON 双语成对；落盘链路（installServer 透传 → mcpServers[serverId]）无 command 强校验。

1. ✅ **preload 类型同步**：`src/preload/index.ts` 本地旧形态 `McpServerConfig`（command 必填、缺 url/type/headers）删除，改为 re-export 主进程 `config/types.ts` 单一事实源，消除三端类型漂移。
2. ✅ **首帧状态稳定**：`PlatformServerDetail.tsx` 渲染期对远程型直接视为 `runtimeAvailable`（`isRemoteInstall || runtimeInfo?.available`）——runtimeInfo 由 effect 异步置位、首帧为 null，此前安装按钮晚一帧出现、警告横幅闪现一帧。
3. ✅ **远程 headers 通用化**：`RemoteInstall` 新增 `headersTemplate?: Record<string,string>`（`${KEY}` 占位符），百炼声明 `{'Authorization': 'Bearer ${DASHSCOPE_API_KEY}'}`；详情页 `buildRemoteHeaders` 按模板填充 `envInputs`（空值键值对剔除、全空不写 headers），`handleInstall`/`openInspector` 不再硬编码键名——未来接入其他远程平台由各源自行声明。
   - 测试同步：`platform-adapters.test.ts` 补 headersTemplate 断言；`server-detail-resolver.test.ts` 过时 toEqual 断言同步（新增字段使精确匹配失败）。
4. （已随本模块落地，报备）ModelScope 专属外链改为 `detail.source === 'modelscope'` 条件渲染，修复百炼详情页误显示 ModelScope 入口。

- [x] A 百炼远程 MCP 安装（类型扩展 + 详情远程分支 + 测试；实施 + 验证，QA 放行；建议级遗留 1~3 已收敛）

## TODOS（汇总）
- [x] A 百炼远程 MCP 安装（类型扩展 + 详情远程分支 + 测试；实施 + 验证，QA 放行；建议级遗留 1~3 已收敛）
- [x] StoreFilterBar hasActiveFilters 的 'relevance' 硬编码基准收敛（实施 + 验证，见跨版本遗留项）
- [x] 百炼 MCP 详情接线与外链纠正（本次确认任务）

---

## 来源 `plan-17.0.md` · plan-17.0 · 单一活动计划（承接）

> 版本：1.0（2026-09-12 新建 / 本次任务细化同日）· 单一活动 plan：本仓库 `doc/` 同时仅保留此一份活动 plan。
> 前任归档：[archive/plan-16.0.md](archive/plan-16.0.md)（修复打包产物缺失传递依赖 `cannot find module concat-stream`——SFTP 传递闭包真实化 + 真实 electron-builder 出包验证；`release/` 与临时残留清理；`node-linker=hoisted` 已取证、决定不根治）。

## 跨版本遗留项

（暂无。已知能力边界：codex-cli 上游不支持远程 MCP 接入，UI 已明示拦截，上游支持后可移除。）

### 三、根因（通用缺陷，非虾评个案）
> 本地详情查询用**目录名**做唯一键，导航键却是 `.source.json` 的**平台 id**；两者只在「id 末段 == 目录名」时巧合一致。

- GitHub / Registry 通道：目录名与 id 同源派生（`skillId.split('/').pop()`）→ **自洽，不触发**。
- zip / 平台通道（`PLATFORM_SKILL_DOWNLOAD = coze / modelscope / clawhub / skillhub`）：id 是平台侧标识，目录名是展示名 → **不同源**：
  - coze：UUID → **必挂**（实测确认）；
  - clawhub：id = `ownerHandle/slug`，name = `displayName || name || title || id` → displayName 与 slug 不同时**必挂**；
  - skillhub：name = `display_name || name || title || slug` → 同上，取决于平台是否给展示名；
  - modelscope：id 形态随条目变化，命中与否靠运气。
- 结论：**通道级缺陷**，「其他数据源是否有类似问题」= 是（上述 4 个平台共用同一通道，只是是否触发取决于 id 与展示名是否恰好同名）。

### 五、风险与取舍
- R1 反查需遍历目录读 `.source.json`：仅在**目录名未命中时**触发，目录数通常为几十，开销可忽略。
- R3 与 R1 互为双保险：R3 让新建导航语义正确，R1 兜住历史深链 / 其它入口。
- 不改动 `.source.json` 的写入语义（id 仍保留平台 id，溯源与更新依赖它），避免影响更新/重装链路。

## TODOS（汇总）
- [x] R1 `getLocalSkillDetail` 按来源 id 反查目录（含返回真实目录名）
- [x] R2 标识口径下沉 `src/shared/skill-identity.ts` + renderer 改为直接引用 shared（旧文件删除）
- [x] R3 Library 导航键改用物理目录名
- [x] R4 详情页作者名不再显示 UUID（含空作者隐藏 `by @`）
- [x] R5 新增单测守卫并跑通 vitest + tsc
- [x] 清理临时取证脚本（`.tmp-probe-*.cjs/.log`）

## 验收结果（2026-09-12）
- 新增 `src/__tests__/skill-local-detail-resolve.test.ts`（5 项，含虾评 UUID 形态 V1）全绿；相关既有 28 项全绿。
- 全量 `vitest run`：437 passed / 1 failed —— 失败项为 `env-manager.test.ts > checkNpx`（沙箱环境 `npx` 解析问题，改动清单不含该文件，属既有环境性失败，非本次引入）。
- `tsc -p tsconfig.main.json --noEmit` 与 `tsc -p tsconfig.json --noEmit` 均 0 错误。
- 待川哥本机复验：我的库 → 点击「AI情感咨询与治愈助手」应能打开详情页（标题为中文名，作者行不再显示 UUID）。

## 其他问题·结论
- 虾评 `sourceUrl` 为站点根（`https://xiaping.coze.com`），无稳定详情直链——本次不处理（不影响打开）。

---

> **已省略的过程性章节**（34 节，按需查 git 历史）：单一活动计划（历史承接） / 规则（plan 管理铁律） / A10 实施（接线启用） / E2 实施（ModelScope 连接级退避） / B.1 现象 / B.3 诊断证据链 / B.4 修复（已实施） / B.6 第三次定位：**真因 = `wait-on tcp:5173` 卡死（IPv6/IPv4 地址族错配）** / B.7 真因修复（已实施） / C.1 现状与问题 / C.2 改法（对齐既有空态范式） / 模块 D · 商店 Skills 标签/分类显示（ClawHub 已修，SkillsMP 待拍板） / D.1 问题 1 · SkillsMP 源没有分类筛选（**待川哥拍板**） / 模块 E · 源能力核查与完善（ClawHub 排序 / 百炼 / SafeSkill / schemas） / E1 · ClawHub 排序 → **可用，保留**（不修不删） / E2 · 百炼 MCP 源 → **补齐两处缺陷**（已实施） / E3 · SafeSkill → **源本身不可修复；但暴露并修掉一个通用假绿 bug** / E5 · SafeSkill 从可选源清单下线（已实施） / 模块 F · SkillsMP 分类体系探查 → D1 定案（2026-09-12） / F.2 实测证据（本轮复测，200/400 均可复现） / F.3 权威分类清单（来源：上游 MCP `list_categories`，非猜测） / F.4 顺带查实的排序真相（推翻旧注释） / F.5 实施（川哥确认「开始实施」，2026-09-12 已全部完成） / F.6 本轮已实施（一行修复，已确认） / 模块 G · 商店-MCP-百炼列表恒为空（2026-09-12，川哥反馈「列表是空，检查下能不能用」） …
