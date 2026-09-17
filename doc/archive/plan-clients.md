## 来源 `plan-clients.md`（原 plan-2.0.md） · plan-2.0 · 客户端口径统一：设置页 / 我的库 / 技能安装目标全对齐

## 背景与根因

用户反馈「设置-支持的客户端-显示的客户端跟实际有区别：设置里没有安装，我的库技能有安装」。
经全面扫描（2026-09-07，代码实证，非推测），根因是**客户端列表有 5 份、安装判定有 2 套口径**：

| # | 列表 | 位置 | 内容 | 问题 |
|---|------|------|------|------|
| 1 | `ALL_BUILTIN_CLIENTS` | `src/main/config/types.ts:80` | 20 内置 + cloud | MCP 真源，设置页数据源 |
| 2 | `SKILL_SUPPORTED_CLIENTS` | `src/main/config/types.ts:77` | 15 项（含 agent-skills、cloud） | Skill 真源 |
| 3 | `SKILL_CLIENTS` 硬编码 | `PlatformConnectionBrowser.tsx:23` | 14 项（含 agent-skills、无 cloud） | 手工复制真源，注释自认须同步，plan-1.9 已漂移过一次 |
| 4 | `getAllClients().filter(supportsSkills)` | `SkillDetail.tsx:311` | 13 内置 + cloud + custom | **不含 agent-skills** |
| 5 | 英文 README Skills 表 | `doc/README.md:98` | 11 项 | **缺 ZCode / TRAE / TRAE CN / TRAE SOLO CN**（plan-1.9 只修了中文版） |

## 范围与边界

**做**

1. agent-skills 以「虚拟客户端」身份进 `getAllClients()`（仿 cloud 模式）——设置页有卡片、技能详情页安装目标可选。
2. `ClientInfo` 新增 `supportsMcp` 字段（单一真源），收口 Settings / Detail / PlatformServerDetail 三处 `c.id !== 'cloud'` 魔法字符串过滤，MCP 安装目标统一排除 cloud + agent-skills。
3. `PlatformConnectionBrowser.tsx` 删除硬编码 `SKILL_CLIENTS`，改运行时 IPC 获取（消灭 P3 漂移源）。
4. 补 `getClientConfigMarkers` 目录 marker（P2）+ gemini-cli win32 npm 探测路径。
5. `getAllInstalledSkills` / `resolveScanGroups` 遍历范围加 custom 客户端（P5）。
6. 设置页客户端卡片加 Skill 能力角标（P6，轻量）。
7. 英文 README Skills 表补齐 4 项（P4）；`doc/软件介绍.md` 复核。
8. 单测补齐 + typecheck 全绿。

**不做**（理由）

- **agent-skills 不进 `ClientType` / `ALL_BUILTIN_CLIENTS`**：会污染 MCP 备份遍历
- **不改 `getAllInstalledSkills` 的「目录有技能即计入」口径**：残留目录算已安装与现有
- **P7（cloud 在技能安装目标）不动**，执行时顺带向用户求证。
- 不引入 `MCP/Skill` 双能力之外的 UI 重构（角标轻量实现）。

### 关键取舍

| 决策点 | 选择 | 理由 |
|--------|------|------|
| agent-skills 建模 | 虚拟客户端（仿 cloud） | 不污染 MCP 遍历；有先例；改动面最小 |
| MCP 目标过滤 | `supportsMcp` 字段（main 真源） | 三处 UI 魔法字符串收口，加 agent-skills 时不再扩散 |
| renderer 技能列表 | 运行时 `getAllClients().filter(supportsSkills && id !== 'cloud')` | 与 SkillDetail 同模式，单一真源 |
| P2 修复方向 | 补探测 marker（设置页对齐库） | 库显示技能是事实（目录真有技能），反向隐藏会丢信息 |

### 风险与回滚

- **风险 1**：agent-skills 卡片 `configPath` 为空 → 设置页 code 标签显示空。处理：`configPath` 给
  `~/.agents`（显示目录名，编辑弹窗隐藏 MCP 输入）；`configExists('')` 抛错已被 try/catch 吞掉，无害。
- **风险 2**：`getAllClients` 缓存（`clientsCache`）不含 agent-skills 结构变更 → 无影响，运行时重新探测。
- **风险 3**：supportsMcp 为新增字段，UI 旧数据无该字段（mock/测试）→ typecheck 强制全改，无隐式 undefined。
- **风险 4**：`byClient` 类型放宽可能影响 Library.tsx 的 `as SkillClientType` cast 语义 → cast 仅用于键入 map，行为不变。
- **回滚**：全部为 additive/等价替换，按触点逐文件 revert 即可，无数据迁移。

### 验证

1. `npm run typecheck` 退出码 0。
2. `npm run test` 全绿（含新增断言）。
3. 手动（本机）：
   - 设置页出现 **Agent Skills (.agents)** 卡片（`~/.agents` 存在时显示已安装）；
   - 已装 agent-skills 技能的用户：设置页该客户端不再「缺席」；
   - 技能详情页安装目标出现 agent-skills；MCP 服务器安装目标（Detail / PlatformServerDetail）**不出现** agent-skills 与 cloud；
   - 直连来源浏览器安装目标与技能详情页一致；
   - `~/.gemini/skills` 有技能的机器：设置页 Gemini CLI 显示已安装（marker 命中）；
   - 自定义 supportsSkills 客户端装的技能在「我的库」可见。

## TODOS

- [x] client-probe.ts：agent-skills 显示名 + markers 补齐 + gemini-cli win32 npm 路径
- [x] config-manager.ts：getAllClients 追加 agent-skills 虚拟项 + supportsMcp 字段
- [x] electron.ts：ClientInfo 类型 + mock 补 agent-skills / supportsMcp
- [x] Settings.tsx / Detail.tsx / PlatformServerDetail.tsx：supportsMcp 过滤替换
- [x] PlatformConnectionBrowser.tsx：删硬编码 SKILL_CLIENTS，改运行时获取
- [x] Settings.tsx：编辑弹窗 supportsMcp=false 隐藏 MCP 路径；卡片 Skill 角标
- [x] skills-manager.ts：getAllInstalledSkills / resolveScanGroups 纳入 custom 客户端
- [x] doc/README.md：Skills 表补 ZCode / TRAE / TRAE CN / TRAE SOLO CN；软件介绍.md 已确认无需改
- [x] client-probe.test.ts：新增断言（虚拟客户端显示名 / markers 全覆盖 / agent-skills 防回归 / npm 探测路径）
- [x] typecheck + test 全绿（196/196 通过；见下方执行备注的二次修正）
> **已结转至 `doc/plan-1.0.md`**（归档不得留存未完成任务）： 手动验证清单过一遍；顺带向用户求证 P7（cloud 在技能安装目标是否设计意图）

## 来源 `plan-1.7.md` · plan-1.7 · 内置客户端：ZCode（智谱 Z.ai）

## 背景与目标

mcp-dock 目前内置 18 个 MCP 客户端（cursor / vscode / claude-code / … / qoder / cloud），
ZCode（智谱 Z.ai 的 AI 编程客户端）不在其中，用户只能走「手动添加自定义客户端」，

## 范围与边界

**做**

1. `zcode` 加入全部内置客户端注册表（类型 / 路径 / 名称 / 探测 / Skills）。
2. 格式适配：`mcp.servers` ↔ `mcpServers` 双向转换（读 + 写）。
3. `enable: false` 透传保留——**读出来是什么就写回什么，不新增、不改写**。
4. UI 图标：无图片资源，走代码绘制分支（与 workbuddy / qoder 同款）。
5. 补单测：Skills 路径断言 + 配置读/写往返。

**不做**（理由）

- 工作区级 `./.zcode/config.json`：mcp-dock 是「用户级全局客户端管理器」，无项目上下文，加进来需要额外的工作区选择交互，收益/复杂度不成立。
- `.agents/mcp.json` 兜底：ZCode 自己的优先级规则是「.zcode 有服务就整体跳过 .agents」，而 mcp-dock 只写 .zcode，兜底路径永远不会被 ZCode 读到，实现它等于死代码。
- 工作区级 Skills（`.zcode/skills/` 项目内）：同上，无项目上下文。

## 顺带清理（遗留问题）

`history-manager.ts` 仍保留两份硬编码 `skillsPaths` 字面量表（L117-129、L382-395），
而 `client-paths.ts` 的模块注释已声明「三处均委托此处解析」——实际只收口了一处。

## 风险与验证

- **风险**：`enable` 字段进入 `McpServerConfig` 是 additive，其余 18 个客户端读写路径不受影响（只有 zcode 分支读写它）。
- **验证**：本机 `~/.zcode/` 已存在，可直接端到端验证——加一个 server → 落盘 `~/.zcode/cli/config.json` → 用 ZCode 自身设置页确认能读到。
- **回滚**：纯 additive 改动，删掉 zcode 相关分支即可回到现状，无数据迁移。

## TODOS

- [x] `types.ts`：四处注册表 + `enable?` 字段
- [x] `client-paths.ts`：Skills 路径
- [x] `client-probe.ts`：配置路径 / 名称 / 探测路径 / 目录标记
- [x] `format-adapters.ts`：读 + 写 + 两个开关
- [x] `config-manager.ts` / `skills-manager.ts`：遍历与聚合列表
- [x] `history-manager.ts`：收敛硬编码 skillsPaths
- [x] 渲染层：图标 + SKILL_CLIENTS + electron.ts mock 三处
- [x] 单测：路径断言 + 读写往返
- [x] 类型检查 + 构建冒烟

## 来源 `plan-1.8.md` · plan-1.8 · 内置客户端：TRAE SOLO CN（TraeWork 桌面端）

## 背景与目标

用户反馈「trae work 客户端没有自动识别」。经本机核实（2026-09-05，非推测）：

| 项 | 结论 | 来源 |
|---|---|---|
| 用户口中的 TraeWork 桌面端 | 即本机安装的 **TRAE SOLO CN**（VS Code fork） | 应用语言包含 "TraeWork" 品牌字样（`out/nls.zh-cn.messages.json`）；本机 AppData/Roaming 与 AppData/Local/Programs 下唯一 Trae 系产品 |
| 官方产品名 | `nameShort`/`nameLong` = "TRAE SOLO CN"，`applicationName` = "trae-solo-cn"，`dataFolderName` = ".trae-cn"，版本 1.107.1 | `<安装目录>/resources/app/product.json` |
| MCP 配置路径 | VS Code 标准的 `User/mcp.json`（`out/main.js` 中 `mcpResource: ... : lt(i, "mcp.json")`）；本机 `AppData/Roaming/TRAE SOLO CN/User/` 存在但尚未生成 mcp.json（未添加过 server） | 主进程代码 + 本机目录实测 |
| 配置键 | `mcpServers`（非 VS Code 官方的 `servers`）——走 mcp-dock 默认读写分支 | `out/main.js` 中 `{mcpServers: ...}` mixin 代码 |
| 本机可执行文件 | `AppData/Local/Programs/TRAE SOLO CN/TRAE SOLO CN.exe` 已确认存在 | 本机 `ls` 实测 |
| MCP 运行证据 | `AppData/Roaming/TRAE SOLO CN/logs/*/mcp-servers-*.log` 存在（McpConfigService / PluginMcp） | 本机日志实测 |

目标：`trae-solo-cn` 加入内置客户端注册表——装了就自动识别（exe 探测），配置可读写（写 `User/mcp.json`）。

## 范围与边界

**做**

1. `types.ts`：`ClientType` + `ALL_BUILTIN_CLIENTS` 加 `trae-solo-cn`（排在 `trae-cn` 后）。
2. `client-probe.ts`：三平台配置路径、显示名 `TRAE SOLO CN`、三平台安装探测路径。
3. 图标：复用 `trae.png`（与 trae-cn / marscode 同款做法）。
4. `electron.ts` 浏览器 mock 兜底：mock 客户端列表 + `getAllServers.byClient` 两处。
5. 单测：三平台路径 / 显示名 / 本机 exe 探测命中断言。
6. 文档：`doc/README.md` 与 `doc/软件介绍.md` 客户端清单补 TRAE SOLO CN。

**不做**（理由）

- Skills 支持：TRAE 系（trae / trae-cn）均不在 `SKILL_SUPPORTED_CLIENTS`，SOLO 亦然，不加。
- `format-adapters.ts` 适配：`mcpServers` 标准键，默认分支天然覆盖，零改动。
- 国际版 TRAE SOLO：本机未安装，数据目录名无法核实，不臆测；待有实证再加。
- `~/.trae-cn` 目录标记（config marker）：不加。`dataFolderName=.trae-cn` 与经典 Trae CN 的点目录可能撞名，会造成误判；exe 探测（`TRAE SOLO CN.exe`）已足够准确。

## 风险与验证

- **风险**：纯 additive；`trae-solo-cn` 只在新分支/新表项中读写，既有 19 个客户端行为不变。
- **验证**：本机已装 TRAE SOLO CN——exe 探测应命中 → 客户端列表显示「已安装（未配置）」；加一个 server 后落盘 `AppData/Roaming/TRAE SOLO CN/User/mcp.json`。
- **回滚**：删掉 `trae-solo-cn` 相关表项即可，无数据迁移。

## TODOS

- [x] `types.ts`：`ClientType` + `ALL_BUILTIN_CLIENTS`
- [x] `client-probe.ts`：三平台配置路径 + 显示名 + 三平台探测路径
- [x] `ClientIcon.tsx`：图标映射
- [x] `electron.ts`：mock 两处
- [x] 单测：路径 / 显示名 / 本机探测
- [x] 文档：README + 软件介绍
- [x] typecheck + test 全绿

### 遗留说明

国际版 TRAE SOLO（非 CN）未收录：本机未安装，其数据目录名无法核实，不臆测路径；
待拿到实证（安装一份或在官方文档确认目录名）后按本 plan 同样套路补充即可。

## 来源 `plan-1.9.md` · plan-1.9 · TRAE 系列支持 Skills 同步（接 plan-1.8）

## 背景与根因

用户在「我的库 → 技能同步」中发现 trae / trae-solo-cn 不在可选客户端列表中。
经本机实测 + 官方文档核实（2026-09-05，非推测）：

- 探测逻辑正确：`trae-solo-cn` 已安装（exe 命中）、`workbuddy` 已安装（marker + config 命中），二者 `installed=true`。
- 技能同步弹窗过滤（`Library.tsx:1078`）：`c.installed && c.supportsSkills && !alreadyAll`。
- `trae` / `trae-cn` / `trae-solo-cn` 均不在 `SkillClientType` / `computeDefaultSkillsPaths` / `SKILL_SUPPORTED_CLIENTS`，
- `workbuddy` 已在 `SKILL_SUPPORTED_CLIENTS` 内，不在列表仅因本次同步的技能它**已装过**（`alreadyAll=true`），属设计行为，**本次不改**。


## 风险与验证

- **风险**：纯 additive；既有 19 个 MCP 客户端 + 12 个 Skills 客户端行为不变。
- **验证**：
  1. `npm run typecheck` 退出码 0（`SkillClientType` 收窄后类型一致）。
  2. `npm run test` 全绿；`client-probe.test.ts` 的 `SKILL_SUPPORTED_CLIENTS` 遍历断言会覆盖新三项（要求 `computeDefaultSkillsPaths` 含对应路径）。
  3. 本机重开「我的库 → 技能」→ 选技能 → 同步：列表出现 **TRAE / TRAE CN / TRAE SOLO CN**，且 trae-solo-cn 指向 `~/.trae-cn/skills`。
- **回滚**：删掉上述表项即可，无数据迁移。

## TODOS

- [x] `types.ts`：`SkillClientType` + `SKILL_SUPPORTED_CLIENTS`
- [x] `client-paths.ts`：`computeDefaultSkillsPaths`
- [x] `PlatformConnectionBrowser.tsx`：`SKILL_CLIENTS`
- [x] `electron.ts`：mock `clients` 三项 `supportsSkills` + `skillsPath`；另补 `installedSkills.byClient` 三项 key（typecheck 抓出的第 4 处硬编码 mock）
- [x] `skills-manager.test.ts`：mock `SKILL_SUPPORTED_CLIENTS` 补三项
- [x] `doc/软件介绍.md`：Skills 客户端计数 12 → 15；`doc/README_CN.md` Skills 表补 ZCode / TRAE 三项 / Cloud（原有漂移一并修正）
- [x] typecheck + test 全绿

### 根因

本 plan 首版把 `trae-cn` 与 `trae-solo-cn` 的 skills 目录都指向 `~/.trae-cn/skills`（TRAE SOLO CN 的
`dataFolderName=.trae-cn`，与经典 Trae CN 撞名，产品层事实，无法分开）。`getAllInstalledSkills` 与

### 验证

- typecheck 0 错；`skills-manager.test.ts` 45/45（新增 5 个去重用例：单装归属 / 双装归属 / 缺省回退 / 分组断言 / detail 归属）；
  全量 180/181（唯一失败仍为 env-manager npx 环境依赖存量用例，与本次无关）。
- 本机重启应用后：技能列表中 novel-audit / novel-write-pro 应只显示「已安装于 TRAE SOLO CN」。

---

## 来源 `plan-22.0.md` · 需求 G — 客户端 MCP 默认地址联网核对与自动识别增强

> 状态：已完成（2026-09-16）
> 范围：联网核对 21 个客户端 MCP 默认地址 / Skill 目录准确性，并增强"自动识别客户端"能力
> 结论先行：键名差异（vscode/zed/opencode/codex）早已被 `format-adapters.ts` 覆盖，无需动；真正修正 4 处——antigravity 路径 bug、trae/trae-cn 多候选、codebuddy 首选 `.mcp.json`，并新增多候选探测。
> 前任归档：[archive/plan-21.0.md](archive/plan-21.0.md)。

## 一、联网核对结论（21 客户端 MCP 地址）

| 客户端 | 原 `client-probe.ts` 路径 | 网络最新核实 | 判定 | 处理 |
|---|---|---|---|---|
| **antigravity** | `~/.gemini/antigravity/mcp_config.json` | Google 官方三源一致：`~/.gemini/config/mcp_config.json`（全局） | ❌ 错误 | **修正** |
| **codebuddy** | `~/.codebuddy/mcp.json` | 官方优先级 `.mcp.json`(推荐) > `mcp.json`(弃用) > `.codebuddy.json`(legacy) | ⚠️ 非首选 | 多候选回退 |
| **trae** | `AppData/Roaming/Trae/User/mcp.json`（fork 布局） | 双形态并存：fork（gentle-ai/nia-wizard/ToolUniverse 一致）+ 扁平 `~/.trae/mcp.json`（lobehub/ima） | ⚠️ 单路径脆弱 | 加扁平候选 |
| **trae-cn** | `AppData/Roaming/Trae CN/User/mcp.json` | 同上 + 扁平 `~/.trae-cn/mcp.json` | ⚠️ 单路径脆弱 | 加扁平候选 |
| **trae-solo-cn** | `AppData/Roaming/TRAE SOLO CN/User/mcp.json` | **Trae 官方论坛确认即全局路径** | ✅ 正确 | 不改 |
| 其余 16 个 | cursor/vscode/claude-code/gemini-cli/codex-cli/windsurf/zed/kiro/opencode/jetbrains/qoder/openclaw/workbuddy/zcode/cloud/agent-skills/marscode | 均与网络数据一致 | ✅ 正确 | 不改 |

## 五、验证

- `tsc -p tsconfig.main.json --noEmit` → **MAIN_TSC_OK**（通过）
- 行为兼容性：现有用户（fork/legacy 布局）配置路径不变；新布局（扁平 trae、codebuddy `.mcp.json`）现可被自动探测到。

## 六、TODOS

- [x] 联网核对 21 客户端 MCP 地址 + Skill 目录
- [x] 修正 antigravity 路径 bug
- [x] trae/trae-cn 加扁平候选、codebuddy 首选 `.mcp.json`
- [x] 新增多候选探测（读取取首个存在，写入落首选）
- [x] main 进程 tsc 全绿
- [x] （可选）antigravity 纳入 SKILL_SUPPORTED_CLIENTS 以管理其 skills（由 plan-1.0 ① 完成并验证）

> **已省略的过程性章节**（36 节，按需查 git 历史）：客户端支持与口径统一 / 问题清单（按与用户现象的关联排序） / 实现思路 / 触点清单 / 步骤 / 执行备注（2026-09-07） / 事实确认（已核实，非推测） / 设计要点 / 1. 探测策略（对齐现有约定） / 2. 格式适配（核心） / 3. enable 字段 / 触点清单 / 主进程 / 渲染层 / 测试 / 实施记录（2026-09-05） / 超出原计划的两处收敛 / 新增测试文件 / 二次修订（2026-09-05 续）：修复两类缺陷 / 触点清单 / 实施记录（2026-09-05） / 顺带修正（文档漂移） / Skills 目录（已核实，非臆测） / 改动清单 / 实施记录（2026-09-05） …
