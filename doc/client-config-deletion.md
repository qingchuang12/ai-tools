# 客户端配置删除口径（设置 → 支持的客户端）

> 结转自原活动 plan（2026-10-01 搬家），**本文件是长期口径的唯一留存处**，plan 里不再重复。所有 `file:line` 为 2026-10-01 在 HEAD `a3819d3` 实测。

## 一、总原则

- **没有任何手动隐藏**：`hiddenClients` 已全链路拆除，「支持的客户端」列表 100% 由探测驱动。
- **删除按钮对所有客户端可见**，唯一排除 `cloud` 虚拟客户端（UI 判据 `src/renderer/src/pages/Settings.tsx:450,517` `client.id !== 'cloud'`；主进程兜底 `src/main/config-manager.ts:371` 抛 `UNSAFE_CONFIG_DELETE`）。不再按「有没有专属配置文件」白名单过滤，避免「有的能删有的不能」的不一致。
- 入口签名 `deleteClientData(id, deleteWholeDir)`（`src/main/config-manager.ts:369`）→ IPC（`src/preload/index.ts:241`、`src/renderer/src/store/electron.ts:296,747`、`Settings.tsx:258`）。
- 内置客户端删除后 `getAll(true)` 重探测刷新；残留配置被清掉后，此前误判「已安装」的自然落回「未安装」区。
- 自定义客户端：确认删除时**先 `deleteClientData` 再 `removeCustom`**（定义先移除会导致路径无法解析）；自定义客户端探测恒为已安装。

## 二、默认动作（不勾选「同时删除整个配置目录」）

只清**本应用写入的内容**，保留用户其他数据：

1. **技能文件**：删除条件＝目录内**同时存在** `SKILL.md` 与 `.source.json`（`src/main/config-manager.ts:323-324`）；缺任一即跳过（`:327`）。
   ⚠️ 口径精确性：该判据是 `scanSkillsDir` 的**真子集**——扫描对无 `.source.json` 的手动安装项也会收集（`source=null`，`src/main/skills-manager.ts:188-203`），删除侧刻意不碰它们，故「用户手动放入的技能不动」。
2. **专属 MCP 配置文件**：basename ∈ `DEDICATED_MCP_CONFIG_FILES`（`mcp.json` / `.mcp.json` / `mcp_config.json` / `opencode.json`，`config-manager.ts:118-122`）→ **整文件删除**。
3. **共享配置文件**（`~/.claude.json`、`settings.json`、`config.toml`、`openclaw.json` 等）：**就地只清 MCP 键**，保留登录态等其他内容。键名映射 `mcpStripKeys`（`config-manager.ts:275-279`）：zed→`context_servers`；opencode / openclaw / zcode→`mcp`；其余→`mcpServers`。codex-cli 走 TOML 的 `mcp_servers` 段（`:346-349`）。
   **刻意不走 `writeConfig`**：其默认 stringify 分支会把无保留分支的客户端（gemini-cli、marscode 等）文件里 MCP 之外的全部内容丢掉（该理由就地写在 `:360-362` 注释里，勿改回）。

## 三、勾选后（递归删除整个配置目录）

- 根目录**按客户端映射**取得，不能一刀切 `dirname`（`getClientConfigRootDir`，`config-manager.ts:285`）：claude-code→`~/.claude`（其配置在 `~/.claude.json`，`dirname` 会算成主目录，`:289`）；vscode / trae 系的 `<root>/User/mcp.json` → 剥掉 `User`（`:293`）；kiro 剥 `settings`（`:295`）；zcode 剥 `cli`（`:297`）；agent-skills 的 `configPath` 本身就是目录（`:288`）。
- **三道守卫**（`config-manager.ts:393-399`，违规抛 `UNSAFE_CONFIG_DELETE`）：必须位于用户主目录内（`path.relative` 为空 / 以 `..` 开头 / 仍是绝对路径均拒绝）、不得是主目录本身、不得是 `~/.ai-tools`（本应用自己的数据目录）。

## 四、UI 与文案

- 确认弹窗勾选项**默认不勾**（`Settings.tsx:61` `useState(false)`，每次打开弹窗重置 `:244`）。
- i18next 分隔符是**双花括号** `{{var}}`：单花括号 `{var}` 不插值、会原样显示在界面上（曾经的 bug：`removeClientConfirmTitle` 写 `{name}` → 弹窗显示「删除客户端「{name}」？」；同类 `cloudSync.desc` 的 `{dir}`，`CloudSyncManager.tsx:175` 传的是对象）。2026-10-01 实测全库单花括号插值为 **0**，现行写法见 `locales/en.json:670`（`{{name}}`）与 `:1039`（`{{dir}}`）。
- 文案 key：`removeClientConfirmTitle` / `removeClientConfirmDirOption` / `removeClientConfirmDirDanger` / `clientDataDeleted` / `clientDirDeleted` / `clientRemoved`（旧 `clientRemoved` 语义已改为「客户端已删除」）。**9 个语言包（en/zh/ar/de/es/fr/it/ja/ru）必须同时补齐**——本仓语言包是完整维护的，只加 zh/en 靠 `fallbackLng='en'` 兜底不是保护，只会让日/俄界面冒出英文。
- 缺 key 取证：`src/renderer/src/locales/_validate_locale.cjs` 按 `en.json` 逐层比对并报 `missingKeys`（2026-10-01 实跑 9 语言均 `leaves=1163 / missingKeys=0 / placeholderMismatch=0`）。**它的唯一缺陷是全脚本没有 `process.exit`**，缺多少 key 都 exit 0，因此**不能当 CI 门禁**，只能当取证输出（要做门禁者自行判 `missingKeys` 计数）。
