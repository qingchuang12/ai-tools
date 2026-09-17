## 来源 `plan-skills.md`（原 plan-3.1.md） · plan-3.1 · Skill 附属文件编辑

> 版本：3.1（2026-09-07） · 前任：[doc/archive/plan-3.0.md](../archive/plan-3.0.md)（云端一致性，代码已完成并归档）
> 遗留随迁（来自 3.0）：P7 —— cloud 出现在技能详情页安装目标是否设计意图，待用户求证。

## 背景与目标

创建/导入已支持附属文件（plan-3.0「Skill 附属文件完整支持」：zip 导入 files 通道 + createCustomSkill 落盘），但**编辑模式**仍只能改 SKILL.md 正文，附属脚本/相关文件无法查看、修改、新建、删除。

本版目标：编辑模式下提供「附属文件」面板，覆盖查看/编辑/新建/删除四项能力。

## 范围与边界

**做**

1. main：`listSkillFiles`（递归扫描 skill 目录 → 相对路径 + 大小 + 文本/二进制标记；排除 `.source.json`；`SKILL.md` 标记受保护）与 `readSkillFile`（UTF-8 解码探测，二进制或 >512KB 标记只读）+ IPC。
2. main：`updateCustomSkill` 输入扩展 `files`（新建/覆盖）+ `removedFiles`（删除），沿用 zip 导入的路径预检与 `assertWithin` 防穿越；受保护文件（SKILL.md / .source.json）禁止新建与删除；`save-with-cloud-sync` 透传。
3. renderer：electron.ts 类型 + preload API。
4. renderer：CreateSkillModal 编辑模式「附属文件」面板（列表 / 文本编辑区 / 新建文本 / 删除确认 / 暂存态，随「保存」与 SKILL.md 统一提交；以首个已安装客户端为读取基准）。
5. i18n（zh/en）+ 单测 + typecheck/test 全绿。

**不做**（理由）

- 创建模式的面板——zip 导入通道已覆盖归档文件，无需求驱动。
- 二进制/超大文件的在线编辑——损坏风险大于收益，只读可删（用户已确认）。
- 独立写 IPC（write/delete）——保存必须与 SKILL.md 原子一致，避免状态分裂（用户已确认「随保存统一提交」）。
- 新建方式支持「从本地选文件复制」——仅新建文本文件（用户已确认）。

### 关键取舍

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 保存时机 | 变更（改/新建/删除）暂存于弹窗，随「保存」与 SKILL.md 一并提交 | 与 isDirty 联动，取消/关闭不落盘，语义统一（用户确认） |
| 多客户端基准 | 以首个已安装客户端为读取基准，保存写入所有已选客户端 | 与现有 SKILL.md 编辑回填同口径（用户确认） |
| 二进制/大文件 | `readSkillFile` UTF-8 探测失败或 >512KB → 标记只读 | 防乱码写坏文件、防 UI 卡顿（用户确认） |
| 写入通道 | 复用 `updateCustomSkill`（扩展 files/removedFiles），不另设写 IPC | 复用既有预检/`assertWithin`/逐客户端落盘与历史备份链路 |
| 受保护文件 | SKILL.md（正文区编辑）、.source.json（隐藏）禁止新建/删除 | 与 plan-3.0「.source.json 跳过」约定一致 |

### 风险与回滚

- **风险 1**：多客户端同名文件内容不一致 → 以首个客户端为基准整体覆盖（与 SKILL.md 编辑同口径，用户已确认）。
- **风险 2**：files/removedFiles 路径穿越 / 删除越界 → 复用 createCustomSkill 全量预检 + `assertWithin` 双保险；删除路径同样先校验再执行。
- **风险 3**：编辑大文件卡顿 → 读取 >512KB 标记只读，不加载内容。
- **回滚**：全部 additive（新方法/新 IPC/新面板），既有保存行为不变；逐文件 revert 即可。

### 验证

1. `npm run typecheck` 退出码 0；`npm run test` 全绿（含新增单测）。
2. 手动（本机）：
   - 编辑一个带 scripts/ 附属文件的 skill → 面板出现文件列表，SKILL.md 显示受保护；
   - 点击脚本 → 文本域加载，修改后点「保存」→ 所有已选客户端文件被更新；
   - 新建 `scripts/new.py` → 保存后目录出现该文件；删除某附属文件 → 保存后目录删除；
   - 改名保存 → 附属文件随目录迁移不丢失；新建/删除 SKILL.md、.source.json → 被拦截。

## TODOS

- [x] ① main 读取：`listSkillFiles`（递归扫描 → 相对路径+大小+文本/二进制标记；排除 `.source.json`；SKILL.md 标记受保护）/ `readSkillFile`（UTF-8 探测，二进制或 >512KB 只读）+ IPC
- [x] ② main 保存通道：`updateCustomSkill` 扩展 `files` / `removedFiles`（全量预检 + assertWithin + 逐客户端写/删；受保护文件拦截）；`save-with-cloud-sync` 透传
- [x] ③ main 单测：list/read/update 批量写、删除、穿越拒绝、受保护拦截（其余工作与单测同步推进）
- [x] ④ renderer：electron.ts 类型 + preload API + CreateSkillModal 编辑模式「附属文件」面板（列表 / 文本编辑区 / 新建文本 / 删除确认 / 暂存态，随「保存」统一提交，首个已安装客户端为基准）
- [x] ⑤ i18n zh/en 文案 + typecheck + test 全绿（244/244）
> **已结转至 `doc/plan-1.0.md`**（归档不得留存未完成任务）： 3.0 遗留：手动验证清单过一遍（对照弹窗 / banner / 云同步手动项）；P7 求证（cloud 是否保留技能安装目标）

---

## 来源 `plan-1.5.md` · plan-1.5 · 历史记录：补 Skill 内容变更（skillsModified）

> 追加：plan-1.6 已并入本文档（同一批改动，见文末「附录 · 清单计数口径与客户端图标」）。

## 背景与目标

历史记录此前**只比 Skill 名字、不比 Skill 内容**：

- `backupSignature` 含 `skillContents` → 内容变了会**新建**备份记录；
- `getDiff` 只做名字集合差分 → 点开该记录，差异弹窗显示「无变更」。

表现为：编辑一个已存在 Skill 的正文/描述（不改名、不增删）后，历史记录多出一条、却看不到改了什么。


## 范围与边界

**做**

- `getDiff` 增加 Skill 内容比较（名字未变、SKILL.md 变了 → modified）。
- 类型同步到三处声明方。
- 差异弹窗展示 modified（统计 + 按客户端详情）。
- 补单测。
- （plan-1.6）`listBackups` 计数口径统一 + 客户端图标收敛，见文末附录。

**暂不做**（已与用户确认）

- 正文级 diff 对照（方案 B）——用户选 A，仅列名字。
- 补 `skills:sync-batch` / `skills:sync-to-cloud-resolved` 的 `backup()`（原 4.C）。
- 引入 hash / content-addressed 存储——实测备份总量仅 2.51 MB（13 条，198 KB/条，上限 50 条 ≈ 10 MB），
- 修改 `backup()` 写入侧跳过空客户端（方案 C）——`restore()` 依赖 `data.clients` 覆盖全部客户端

### 核心取舍：保守比较，宁可不报也不错报

内容比较**仅当前后两条备份都采到该客户端的 `skillContents` 时才进行**：

- 旧备份（P1-3 之前产生）**没有** `skillContents` 字段 → 不比，否则 target 有内容 / prev 为 `undefined` 会被判成全量 modified；
- 某侧因自定义 Skills 路径或读取失败而缺失该客户端内容 → 不比（与 `restoreSkillSnapshots` 已有的「旧备份仅尽力回滚」策略一致）。

即：字段缺失 ≠ 内容变更。

### 风险与回滚

- 纯读路径改动，**不动 `backup()` 写入逻辑**，不影响任何已生成的备份文件。
- 新增字段均为 additive；`skillsModified` 与 `skillsAdded`/`skillsRemoved` 同为必选，构造点仅 `getDiff` 一处。
- `History.tsx` 对 `cc.modified` 用 `(cc.modified || [])` 兜底，兼容旧 IPC 数据。
- 回滚：`git checkout --` 上述 6 个文件即可，无数据迁移。

## 验证

- `tsc -p tsconfig.main.json --noEmit`：`history-manager.ts` **0 错误**；
  其余报错（`Cannot find module 'electron'`、`jsonc-parser`）为**既有**依赖未装全，与本次改动无关。
- 逻辑验证 **20/20 通过**（含 4 组回归）：内容变更 / 内容未变 / 旧备份在上一条 / target 侧缺失 /
  纯新增 / 纯删除 / 混合。

> 环境限制：`vitest` 因缺间接依赖 `fdir` 无法启动（`ERR_MODULE_NOT_FOUND`，既有问题，非本次引入）。
> 故改用 `tsc` 转译 `history-manager.ts` + stub 掉 `config-manager`，以 Node 直接跑真实代码验证；
> 新增的 vitest 用例待依赖修复后由 `npm test` 覆盖。

## TODOS

- [x] 主进程 `getDiff` 补 Skill 内容变更比较（含旧备份兼容守卫）
- [x] 同步三处 `DiffResult` 类型（preload/index.ts、preload/index.d.ts、renderer/lib/electron.ts）
- [x] History.tsx 差异弹窗展示 Skill「已修改」统计与详情
- [x] 补单测并完成验证

---

## 背景与实测

用户反馈「历史记录清单数据是不是写死了？感觉不太对」「客户端 logo 不要全部显示出来」。

数据**不是写死的**——`listBackups` 纯读 `~/.ai-tools/backups/backup-*.json`。


| 指标 | 改前 | 改后 |
|---|---|---|
| 每条 `clients` 数 | **19**（18 内置 + `custom:trae-work`） | **3** |
| 其中空客户端 | 16（84.2%） | 0 |
| `serverCount` | 22（累加） | **11**（去重） |
| `skillCount` | 9（去重） | 9（不变） |

## 根因

1. **空客户端落盘**：`backup()` 无条件遍历 `getClientTypes()`（18 内置 + 自定义）；
   `readConfig` 遇 ENOENT **返回 `defaultConfigForMissing` 而非抛错**，
   故 `try/catch` 永不触发，未安装的客户端也以 `{config:{mcpServers:{}}, serverCount:0}` 落盘。
2. **`clientList` 不过滤**：把 `data.clients` 的全部 key 都 push，19 个图标全渲染。
3. **计数口径不一致**：`serverCount` 跨客户端**累加**、`skillCount` 跨客户端**去重**，

## 验证

- 转译真实代码 + Node 直跑：**13/13 通过**（3 条新口径 + 7 条既有用例回归 + 2 条真实数据断言）。
- 真实数据：最新一条 `clients` 19 → **3**，`serverCount` 22 → **11**。
- `tsc -p tsconfig.main.json --noEmit`：`history-manager.ts` 0 错误；测试文件独立检查 EXIT=0。
- IDE lint 无 ERROR（仅既有风格 WARNING）。

## TODOS

- [x] `listBackups`：clientList 过滤空客户端 + serverCount 改为跨客户端去重
- [x] History.tsx：图标上限 5 + `+N`；skillCount 恒显示
- [x] 补单测并完成验证

---

## 验证

转译真实 `client-icon-key.ts` + Node 直跑：**20/20 通过**。

覆盖：核心匹配（trae-work / my-cursor-2 / codebuddy-test / jetbrains-ultimate / workbuddy-pro）、


> 注：渲染层无组件测试环境（`vitest.config.ts` 为 `environment: 'node'`，无 jsdom），
> 故将匹配算法抽为零依赖纯函数以便独立验证，而非把断言写进组件测试。

## TODOS

- [x] 抽出 `resolveIconKey` 纯函数（最长匹配）
- [x] ClientIcon 接入，候选集含代码绘制客户端
- [x] 验证 20/20 + 类型检查

---

> **已省略的过程性章节**（13 节，按需查 git 历史）：Skills 管理与编辑 / 实现思路 / 触点清单 / 步骤 / 实现思路 / 触点 / 附录 · plan-1.6：清单计数口径与客户端图标 / 改动（方案 B） / 附录 · 自定义客户端图标：按名称关键字匹配 / 需求 / 关键事实 / 改动 / 两个设计要点
