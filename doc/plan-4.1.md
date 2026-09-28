# plan-4.1 · ai-tools 未完成项（合并原 plan-3.1 / plan-4.2 / plan-4.3）

> 本文件为本仓**唯一活动 plan**。只登记未完成项（TODOS / 待核实 / 登记表）；已落地的批次与实现叙述一律不留存，需要看历史结论走 `git log` 与代码本身。

## 背景与目标（仅未完成线索）

- **底座与广告**：ow-electron 底座与打包链**尚未实机验证**（二进制未补齐、本机 `pnpm install` 报文件系统错误）；广告链路的 GUI 冒烟未跑。
- **外部对接**：360联盟 PC 桌面 SDK 是否存在**未确认**；Overwolf Console UID 与广告开通未申请。
- **客户端清单扩充（E）**：批次⑤ 异构/受阻客户端未做；E-1 核实出的路径/字段不符项已全部修完（JetBrains→`.junie`、Antigravity→`serverUrl`、OpenClaw→`transport`/`enabled`、TRAE 家族三处），仅剩下方 Codex 远程字段可选增量。

## 待核实与暂不做

- **仍未核实（官方无原文，本机也无从印证）**：Antigravity 的 Windows 路径与 Skills 目录（`~/.gemini/config/skills` 官方未确认，issue #686 仍在问；实测生效的是 `~/.gemini/skills/`）；TRAE 国际版三平台绝对路径（docs.trae.ai 抓取失败）；ZCode 远程条目的 JSON 字段名（官方只给 stdio 示例，远程仅 GUI 说明）；JetBrains 产品目录前缀全集（RustRover 等是否支持无官方表）。

## 广告渠道事实（服务于上述未完成项）

- **海外：Overwolf（ow-electron）**。核实来源：npm registry、GitHub（overwolf/ow-electron-packages-sample）、官方文档站（overwolf.github.io/tools/ow-electron）。事实：
  - `@overwolf/ow-electron` 是 Electron 的 drop-in 替换（fork），**官方支持与普通 electron 并存**（加脚本变体，不强制全量换底座）；
  - 广告用 `<owadview/>` 标签（内置自管理广告容器，自动拉取/刷新/静音，需标准 IAB 尺寸容器）；
  - **版本风险：稳定版最新仅 42.7.1（无 43 线）**，项目锁定 electron 43.0.0——换底座须降至 42；
  - 发布链要求：打包须换 `@overwolf/ow-electron-builder`（bin 名 `ow-electron-builder`，latest 26.9.3）；Console 注册 App UID + 联系 Overwolf 开通广告；发布需 Overwolf 签名 + 开发者代码签名双签（上商店则 DSC 强制）；测试可用 `ow-electron --test-ad` 免开通跑通。
- **国内：360联盟**。`union.360.cn` 直连/代理三次超时不可达；公开渠道仅见移动端（Android）广告 API 文档，**未见 PC 桌面软件广告 SDK 公开文档**——「桌面端支持未确认」成立。拿到 SDK 文档后按 `AdProvider` 接口补齐实现。

> 地区判定：编译期 flag（`AI_TOOLS_AD_REGION=overseas|cn`），与免费版编译开关同一套 env 机制，产物明确、不做运行时网络探测。

## 产品形态（共 2 个编译变体，GUI 冒烟按此核对）

| 变体 | 云同步 | 广告 |
|---|---|---|
| **免费版1**（默认变体） | ✅ 有 | ✅ 有，按地区加载对应渠道 |
| **免费版2** | ❌ 默认砍（激活且有 cloud_sync 权益后恢复） | ❌ 无（显式开启也被压掉） |

「免费版2 激活后云同步是否解锁」默认=解锁（`cloudSyncActivationUnlocks=true` 软模式）；若要硬砍（激活也不开放），打包时传 `AI_TOOLS_CLOUD_SYNC_ACTIVATION_UNLOCKS=0`，UI 入口与主进程 IPC 同一 flag 短路，无死路入口。

## 阶段小结（滚动覆盖）

- 当前状态：E-3 四项客户端路径/字段修正已落地（vitest 696 全绿 + typecheck 通过）；剩余全部属【验证】（需 GUI/打包环境就绪）、【外部】（需第三方开通/商务文档）与 E 批次⑤ / Codex 可选增量三类。
- 下一步：先解底座前置（补 Electron 二进制 + 修本机 `pnpm install` 文件系统报错），之后一次性跑完 GUI 冒烟与打包链实跑；E 批次⑤ 动手前需先决（YAML 依赖 / 未文档化目录）。

## TODOS（仅未完成）

### 底座与广告
- [ ] **【验证】ow-electron 底座实机验证 + 打包链实跑（含二进制补齐）** — 前置：手动补齐 `@overwolf/ow-electron` 42.7.1 Electron 二进制（2026-09-22 外网 DNS 全部不可达，`node install.js` 报 fetch failed；网络恢复后在项目根执行 `node node_modules/electron/install.js`，幂等约 100MB，完成后 `node_modules/electron/dist/electron.exe` 应存在；仍失败先确认代理/VPN，勿改包版本）。待做：① `webviewTag:true` + `--test-ad` 实机跑通 owadview（需 GUI）；② 打包链实跑——`@overwolf/ow-electron-builder` 已写入 package.json，但本机 `pnpm install` 反复报 `os error 2/5/183`（符号链接/文件已存在/拒绝访问），`7zip-bin` 等打包传递依赖未装齐，**须先修本机文件系统/安全软件环境再重跑 install**。
- [ ] **【验证】** 免费版1/2 的 GUI 冒烟（dev 下按 `AI_TOOLS_EDITION` 组合核对广告位与云同步入口显隐、激活态切换）。

> 实现提示：客户端对外文案已统一收敛为 `license.errors.generic`（`license/errors.ts` 明确「绝不回传错误码」），服务端新增/改名错误码（如 `CREDENTIAL_NOT_FOUND`/`LOGIN_REQUIRED`）**无需客户端 i18n 改动**。

### 外部对接
- [ ] **【外部】** 360联盟商务对接：确认 PC 桌面 SDK 是否存在并取文档 → 补齐 `AdProvider` 实现（官网三次超时，公开渠道无桌面文档）。
- [ ] **【外部】** Overwolf Console 注册 App UID + 申请广告开通（发布另需开发者代码签名证书）。

### 客户端删除（设置-支持的客户端：删数据 + 可选删整目录，列表完全由探测驱动）
- **最终设计（2026-09-28 第四轮定稿）**：
  - **不做任何手动隐藏**，`hiddenClients` 已全链路拆除。列表 100% 由探测驱动。
  - **删除按钮对所有客户端可见**（唯一排除 cloud 虚拟客户端）——不再按"专属配置文件"白名单过滤，消除"有的有删除有的没有"的不一致。
  - 确认弹窗勾选项（默认不勾）：**「同时删除整个配置目录」**。
  - **默认动作（不勾选）**：只清本应用写入的内容——① 技能文件：仅删带 `.source.json` 标记的 skill 目录（用户手动放入的不动，与 scanSkillsDir 同口径）；② MCP 配置信息：专属 MCP 配置文件（basename ∈ mcp.json/.mcp.json/mcp_config.json/opencode.json）整文件删除；共享配置文件（~/.claude.json、settings.json、config.toml、openclaw.json 等）**就地只清 MCP 键**（zed→context_servers、opencode/openclaw/zcode→mcp、其余→mcpServers；codex-cli 走 TOML mcp_servers），保留登录态等其他内容。不走 writeConfig（其默认 stringify 分支会丢无分支客户端的其他键，如 gemini-cli/marscode）。
  - **勾选后**：连配置根目录一并递归删除。根目录按客户端映射（不能一刀切 dirname）：claude-code→~/.claude（配置在 ~/.claude.json，dirname 是主目录）；`<root>/User/mcp.json`（vscode/trae 系）→剥 User；kiro 剥 settings；zcode 剥 cli；agent-skills 的 configPath 本身是目录。守卫：必须位于主目录内、不得是主目录本身、不得是 ~/.ai-tools。
  - 自定义客户端：确认删除时移除定义（探测恒为已安装）；先 deleteClientData 再 removeCustom（定义移除后路径无法解析）。
  - 内置客户端删除后 getAll(true) 重探测刷新；残留配置清除后，误判「已安装」的自然落回「未安装」区。
- 落地：settings-store / config-manager / IPC / preload / electron.ts 移除 hiddenClients 全链路并新增 `deleteClientData(id, deleteWholeDir)`（deleteAppInstalledSkills + stripMcpConfigFromFile + getClientConfigRootDir 守卫删除，替换原 deleteClientConfig）；Settings.tsx 全客户端常驻删除按钮 + 「删除整个配置目录」勾选；话术定稿（removeClientConfirmDirOption/DirDanger、clientDataDeleted/clientDirDeleted，clientRemoved→客户端已删除），**9 个语言包（en/zh/ar/de/es/fr/it/ja/ru）全部补齐**——本仓语言包是完整维护的，新增/改名 key 不能只加 zh/en 靠 fallbackLng='en' 兜底（会让日/俄界面冒出英文）。
- 验证：`tsc -p tsconfig.main.json` + `tsc -p tsconfig.json` 全绿（TYPECHECK_OK）；9 个语言包 JSON 语法逐个 `JSON.parse` 校验通过。此前 recheck.ts 的两处报错系并行 license 改动所致，已由该工作流自行修复（markAttemptDone 已接入调用），本任务未改 license 域代码。GUI 冒烟待用户本机 pnpm dev 验证。
- **i18n 插值口径（踩坑根治）**：i18next 默认分隔符是**双花括号 `{{var}}`**，单花括号 `{var}` 不插值会原样显示。本功能 `removeClientConfirmTitle` 误用 `{name}` → 弹窗显示「删除客户端「{name}」？」；顺带发现既有同类 bug `cloudSync.desc`（`CloudSyncManager.tsx:175` 传 `{dir: CLOUD_ROOT_DIR}` 但文案为单花括号）。已把 11 处（zh/en 的 `{name}` + 9 个语言包的 `{dir}`）统一改为双花括号，并复查全库单花括号插值为 0。

### 客户端清单扩充（E）
- [ ] **批次⑤ 异构/受阻客户端（动手前需先决）**：Goose（YAML `extensions:` + `cmd/envs/uri`，**需新增 YAML 依赖**）；Kilo Code（顶层 `mcp`、`~/.config/kilo/kilo.jsonc`，**Windows 目录未文档化**）；Amazon Q Developer CLI（`cli-agents/` 与 `default.json` 与 legacy `mcp.json` 三套并存，官方推荐走 `q mcp` 子命令，本工具无 CLI 写入通道）；Roo Code（真实路径取决于宿主编辑器的扩展 globalStorage，**不可硬编码**，官方文档里的路径字符串甚至仍残留 Cline 旧路径）。

### 客户端路径与字段修正（E-3 剩余可选增量）

- [ ] **Codex CLI 远程/超时字段（可选，待定）**：stdio 字段已坐实无需改（`codex-rs/config/src/mcp_types.rs` 的 `RawMcpServerConfig`，`deny_unknown_fields` 含 `command/args/env/env_vars/cwd`；顶层 `mcp_servers` 见 `config_toml.rs:293`）。现分支只写 stdio 字段，远程 `url` + `bearer_token_env_var`/`http_headers` 与 `startup_timeout_sec`/`tool_timeout_sec`/`enabled` 未覆盖——是否补齐待用户拍板。
- [ ] **Antigravity 候选链未补**：`~/.gemini/antigravity-cli/mcp_config.json` 是否为用户级真实路径**无官方原文**（antigravity.google 本机不可达），且它更像是 CLI 的独立落点而非 IDE 的 `~/.gemini/config/mcp_config.json`；故本轮只在候选链保留旧的 `~/.gemini/antigravity/mcp_config.json` 读取回退，未新增该条。官方路径可访后再补。

## 登记表（外部阻塞，非编码项）

- 真实后端端到端冒烟：`fetchRedeem` / `unbind` / `activate` / 登录+MFA 走真实私钥/账号链路（**阻塞**：需真实后端实例 + 可登录账号）。
- 打包产物运行时验证：electron-builder 产物 GUI 冒烟（**阻塞**：需打包 + GUI 环境）。
- `qa-first-run-audit.test.ts` A1/A2 历史 flaky（5s 性能阈值断言）：待单独放宽阈值或改相对断言（属 license 域）。
- 其余 7 个语言包（除 en/zh）未补换绑/账号文案，i18next 回退默认语言（**可选**，不影响功能）。
