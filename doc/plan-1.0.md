# plan-1.0 · antigravity Skills 支持 + main 进程加固 + 归档 plan 合并

> 状态：本 plan 含未完成任务（③），**按归档铁律停留在活动目录 `doc/`，不进 `archive/`**。
> 全部 TODOS 完成后才可归档为 `doc/archive/plan-v23.0.md`。

## 背景与目标

川哥提出的三项并行任务：
1. **① antigravity 支持 Skills** — antigravity 的 skills 目录为 `~/.gemini/config/skills/`，此前未纳入 `SKILL_SUPPORTED_CLIENTS`，导致 AI-Tools 无法管理它的 skill。
2. **② 需求 F 加固** — 授权为 main 进程加 `obfuscator + terser`（此前 renderer 已加固、main 裸编，逆向门槛极低）。
3. **③ 归档 plan 合并** — 清理「同一功能变来变去」的冗余 plan，以最终版为准。

同时确立归档铁律：**有未完成任务的 plan 不进归档；归档的 plan 必须任务全部处理完。**

## 范围与边界

**做**：antigravity 纳入 skill 客户端；main 产物混淆+压缩；归档 plan 去重合并；跨版本结转未完成任务。
**不做**：不修改 renderer 的混淆配置（已合规）；不代做 commit/push/PR（用户侧事项）；不删除任何仍含未完成任务的 plan。

## 实现思路

### ① antigravity Skills（已完成并验证）
`SKILL_SUPPORTED_CLIENTS` 是 `supportsSkills` 的单一真源（`config-manager` 据此派生，`PlatformConnectionBrowser.tsx` 注释确认已取代 renderer 硬编码列表）。故只需两处：
- `src/main/config/types.ts`：`SkillClientType` 联合 + `SKILL_SUPPORTED_CLIENTS` 数组加 `antigravity`。
- `src/main/client-paths.ts`：`computeDefaultSkillsPaths` 加 `antigravity: ~/.gemini/config/skills`。
- `src/__tests__/skills-manager.test.ts`：mock 列表同步（防漂移，沿用 plan-1.9 约定）。

验证：`tsc -p tsconfig.main.json --noEmit` 0 error；`client-probe` + `skills-manager` 共 **74 项测试全绿**。

### ② main 进程加固（已完成并验证）
新增 `scripts/obfuscate-main.mjs`，对 `dist/main/**/*.js` 做 **obfuscator → terser** 两段式加固，与 renderer（vite-plugin-electron-obfuscator + terser）口径一致。
- **安全约束**：`renameGlobals=false`（不碰 require/module/exports 与 IPC channel 字符串）、`controlFlowFlattening=false`、`deadCodeInjection=false`、`selfDefending=false`（避免干扰 Electron 模块初始化）、`disableConsoleOutput=false`（保留主进程诊断日志）。
- `build:main` 接入为 `tsc && copy-platform-data && obfuscate-main`，`package`→`build` 链路自动生效。
- 验证：**50 个文件全部混淆+压缩成功，0 失败**；`node --check` 通过；产物含 base64 字符串数组解码器（确认是真混淆而非仅压缩）。

⚠️ 依赖说明：`javascript-obfuscator` 当前由 `vite-plugin-electron-obfuscator@1.0.0` **传递提供**（同为 4.2.2），脚本用 `.pnpm` 版本通配回退解析。本环境无 pnpm/网络，未能提升为直接依赖 —— **建议联网后执行 `pnpm add -D javascript-obfuscator@4.2.2`** 使其显式化。
⚠️ 未做完整 Electron 启动验证（本环境无法拉起 GUI），需川哥 `pnpm run package:win` 或 `electron:dev` 实跑确认。

### ③ 归档 plan 合并（进行中，待确认删除范围）
全量扫描 36 份归档 plan，发现 **9 份仍含未完成任务**（违反归档铁律），已全部结转至下方 TODOS，确保不丢活。

## TODOS

- [x] ① `types.ts`：`SkillClientType` + `SKILL_SUPPORTED_CLIENTS` 加 `antigravity`
- [x] ① `client-paths.ts`：`computeDefaultSkillsPaths` 加 `antigravity` 路径
- [x] ① `skills-manager.test.ts`：mock 列表同步防漂移
- [x] ① 验证：main tsc 0 error + 74 项测试全绿
- [x] ② 新增 `scripts/obfuscate-main.mjs`（obfuscator + terser 两段式）
- [x] ② `build:main` 接入混淆步骤
- [x] ② 验证：50 文件混淆成功、`node --check` 通过
- [x] ③ 关闭 plan-22.0 遗留项（antigravity 已由 ① 完成）
- [x] ③ 归档 plan 合并：36 → 10 份（功能域归并 + 只留核心信息，227.8KB → 91.9KB）
- [x] ④ plan 版本号重置：活动 plan → `plan-1.0.md`；归档 10 份改功能命名；`plan-23.0` 引用全量同步
- [x] ⑤ 历史记录去除恢复功能：删 `restore()` / `restoreSkillSnapshots()` / `skillPathFor()` + IPC + preload + UI + i18n
- [x] ⑥ 语言切换扩到 9 种（G8 + 联合国官方）：`i18n.ts` 语言清单 / 惰性加载 / 系统语言探测 / 阿拉伯语 RTL
- [x] ⑥ 新增 7 个 locale 文件，结构与 en 完全一致（841 键，0 缺失）
- [x] ⑥ 法语 fr、西班牙语 es 全量翻译完成并校验
- [ ] ⑥ 德语 de / 意大利语 it / 日语 ja / 俄语 ru / 阿拉伯语 ar **尚未翻译**（当前为英文占位，运行时回退英文）
- [ ] ② 遗留（用户侧）：联网后 `pnpm add -D javascript-obfuscator@4.2.2` 显式化依赖
- [ ] ② 遗留（用户侧）：`pnpm run package:win` 实跑确认混淆后主进程正常启动

### 跨版本结转（2026-09-17 复核：逐条对照代码现状评估）
> 结论：原结转 26 项中**绝大多数已在后续迭代落地**，仅 1 项仍待做。已实现项与僵尸待办一律删除，不留无意义清单。
> 复核方式：按条目 grep 代码实证（文件路径:行号），不凭印象判断。

**【plan-1.2】ModelScope 数据源修复 —— 已实现，整批关闭**（原 0 完成/26 项，实为后续迭代做完但没回勾）：
- ✅ `selectedMcpConn`：`Store.tsx:57` 已 `source.mcpSources.find(c => c.id === source.mcpConnId) || null`；`:85`/`:103` 取 `selectedMcpConn?.platformType`；`:169`/`:194` 下传给 `StoreToolbar`、`useStoreAttribution`（两处已接收该字段）
- ✅ 配额保护：`modelscope.ts:42-43` 已拆 `MS_SKILL_QUOTA_PRODUCT=2400` / `MS_SERVER_QUOTA_PRODUCT=100`，配 `outOfRangePageInfo()`(`:59`) + `failureMessage()`(`:70`)；`:317`/`:411` 已判 `safePage*pageSize > 配额`。比原计划的单一常量更完善
- ✅ 客户端二次过滤已删：`modelscope.ts:377` 注释「分类过滤已通过 filter.category 直接走服务端（T0：去掉二次请求）」
- ✅ `category` 归一化：`modelscope.ts:325` 已处理 `'all'`/空 时不传 `filter.category`
- ✅ Skill/MCP 分类分离：`MS_SERVER_CATEGORIES` 已建(`:112`)；`:617-620` 已按 `resourceType === 'mcp'` 分流
- ✅ `getFacets(resourceType?)` 签名扩展：`types.ts:310` 声明 → `registry.ts:58` 透传 → `modelscope.ts:615` 实现 → `index.ts:1131` `getFacets(sp, resourceType)` 传参
- ✅ 假排序已移除：`MS_SORTS` 常量已不存在

**【plan-2.0 / plan-3.1】P7「cloud 是否保留为技能安装目标」—— 已决策并落地，关闭**：
- 代码已显式排除 cloud：`Library.tsx:333`、`PlatformConnectionBrowser.tsx:107` 均为 `c.id !== 'cloud'`。求证项无需再挂。

**【plan-7.1】虾评失败补证 —— 关闭（僵尸待办）**：
- 实测链路全通、长期无法复现，无证据可补。若日后再现，另开 plan 处理。

**【plan-20.0 / plan-20.1】Release 正式版 / CI Node LTS 24 确认 —— 关闭**：
- 用户侧一次性动作，v1.3.0 已发布；CI 现状以实际仓库为准，不再作为待办挂着。

### 仍待做（结转复核后仅剩 1 项，低优先级）
- [ ] `msSearchImpl` 分页模式：`modelscope.ts:395-396` 仍为 `pagingMode: 'client'` + `complete: false`。Skill 端点有真实 total，理论上可改 `'server'` 并去掉 `complete: false`。**属可选优化**——当前 client 模式功能正常，仅无法预知总页数，不影响使用。

> 说明：plan-13.0 唯一未完成项为「统一提交」，按其自身约定属用户侧事项、不计入 AI 归档判定；plan-19.0 未完成项为「归档本 plan」自指项，已满足。
