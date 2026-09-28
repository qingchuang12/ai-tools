# plan-4.1 · ai-tools 活跃开发总览（合并原 plan-3.1 / plan-4.2 / plan-4.3）

> 本文件现为本仓**唯一活动 plan**（已合并 `doc/plan-3.1` 广告接入主线）。已完成项一律不留存，正文只保留未完成项（TODOS / 待核实 / 登记表）。

## 背景与目标

### B. 广告接入与免费版编译开关（活跃主线）
在 `ai-tools`（Electron 43 桌面应用，React+Vite renderer / TS 主进程）中引入广告变现，并通过**编译期开关**产出两种免费版形态：
- **免费版1**：功能完整（含云同步）+ 广告
- **免费版2**：无云同步 + 无广告

**「激活版」不是第三种产物**：用户在免费版1 里输入激活码，`license` 权益链路判定通过后广告自动消失——这是**运行时状态**，不单独打包。故整体只出 **2 个安装包**（海外版另按地区出 1 个，共 3 条打包命令）。

### C. MCP 调试器连接——下载中智能等待（本会话新增）
MCP Inspector（调试器）点「连接」走 stdio：`mcp-client.ts` `connectStdio` spawn server 进程后立刻发 initialize 握手，握手固定等 30 秒（`sendRequest` 硬编码 30000），超时即 `disconnect()` 杀进程并回报失败，UI 标红「Connection failed」。当命令是 `npx -y <包>` 首次冷启动，npm 需联网下载/解压依赖，期间进程活着但未握手（stdout 无 JSON-RPC、仅 stderr 安装日志），30 秒到即判失败；二次因 npm 缓存命中而成功——与用户反馈「有时程序还在下载导致失败、过一阵就好」吻合。目标：识别「依赖下载/安装中」状态，不立即标红失败、自动持续等待握手，UI 显示「正在安装依赖，请稍候…」；仅进程退出或超总上限（5 分钟）方判失败。

### D. 整体界面 UI/UE 优化——设计 token 统一（本会话新增）
全站 UI 复查发现：设计系统（`index.css` 的 `--color-*` 令牌 + `tailwind.config.cjs` 的 `accent/success/danger/warning/info` + `.card`/`.btn-primary`/`.btn-danger`/`.tag-success`/`.status-dot` 工具类）已完整且带浅色主题覆盖，但大量组件绕过它们直接写死十六进制值，导致：① 分类徽章三套配色并存；② success/danger/warning/info 写死暗色值，浅色主题对比度差、品牌色偏移（真实 bug）；③ 主蓝 `#0a84ff` 等魔法值破坏 token 体系；④ 卡片 `h-[115px]` 固定高度裁切内容；⑤ 浅色主题残留破损（骨架屏分隔线、README 空态灰、默认图标深色文字压彩底）。目标：统一到既有 token / 工具类，全站主题感知一致。纯展示层改动，不涉及逻辑/状态/IPC。

## 广告渠道

- **海外：Overwolf（ow-electron）**。核实来源：npm registry、GitHub（overwolf/ow-electron-packages-sample）、官方文档站（overwolf.github.io/tools/ow-electron）。事实：
  - `@overwolf/ow-electron` 是 Electron 的 drop-in 替换（fork），**官方支持与普通 electron 并存**（加脚本变体，不强制全量换底座）；
  - 广告用 `<owadview/>` 标签（ow-electron 内置的自管理广告容器，自动拉取/刷新/静音，需放标准 IAB 尺寸容器）；
  - **版本风险：稳定版最新仅 42.7.1（无 43 线）**，项目锁定 electron 43.0.0——换底座须降至 42，属独立验证项；
  - 发布链要求：打包须换 `@overwolf/ow-electron-builder`（bin 名 `ow-electron-builder`，latest 26.9.3）；Overwolf Console 注册 App UID + 联系 Overwolf 开通广告；发布需 Overwolf 签名 + 开发者代码签名双签（上 Overwolf 商店则 DSC 强制）；测试可用 `ow-electron --test-ad` 免开通跑通。
- **国内：360联盟**。`union.360.cn` 直连/代理三次超时不可达；公开搜索仅见移动端（Android）广告 API 文档与广告主投放工具，**未见 PC 桌面软件广告 SDK 公开文档**——「桌面端支持未确认」成立。待商务对接拿到 SDK 文档后按 `AdProvider` 接口补齐实现。

> 地区判定：编译期 flag（`AI_TOOLS_AD_REGION=overseas|cn`），与免费版编译开关同一套 env 机制，产物明确、不做运行时网络探测。

## 产品形态（共 2 个编译变体）

| 变体 | 云同步 | 广告 |
|---|---|---|
| **免费版1**（默认变体） | ✅ 有 | ✅ 有，按地区加载对应渠道 |
| **免费版2** | ❌ 默认砍（激活且有 cloud_sync 权益后恢复） | ❌ 无（显式开启也被压掉） |

「免费版2 激活后云同步是否解锁」默认=解锁（`cloudSyncActivationUnlocks=true` 软模式）；若要硬砍（激活也不开放），打包时传 `AI_TOOLS_CLOUD_SYNC_ACTIVATION_UNLOCKS=0`，UI 入口与主进程 IPC 同一 flag 短路，无死路入口。

## 范围与边界

- 做：广告接入、免费版编译开关、ow-electron 底座与打包链验证、授权客户端跨仓对齐；以及 **C. MCP Inspector 连接下载中智能等待修复**（见 TODOS）。
- 暂不做：`packageManager: pnpm@12.4.1` 与全局 pnpm 11.24.0 的版本口径对齐（项目内已按 manage-package-manager-versions 自动切 12.4.1，行为一致）；360联盟 SDK 实现（待商务文档）；Overwolf 发布链双签（待 Console 开通）；HTTP/SSE 传输的类似等待（本次仅改 stdio，远程 server 无「下载」语义）。


## TODOS（仅未完成）

> **核查结论（2026-09-24）**：广告 `AdSlot` 已落地（`src/renderer/src/components/ads/*` + `Layout.tsx:128` 挂载 + `build-flags.test.ts` 覆盖），原「trial/AdSlot 落地」开发项已完成，仅剩 GUI 冒烟（转下「验证」项）。授权客户端两条开发项（统一激活端点切换、登录后自动到账 A9）均已于本会话完成：`redeem.ts` 改走 `POST /api/licenses/activate`（请求体 `code`→`credential`）、新增 `claim.ts` + `account:claim-licenses` IPC、preload/renderer/store 三层接线，登录成功即自动触发；仅剩真实后端 E2E 验证（见登记表）。

### 底座与广告
- [ ] **【验证】ow-electron 底座实机验证 + 打包链实跑（含二进制补齐）** — 前置：手动补齐 `@overwolf/ow-electron` 42.7.1 Electron 二进制（2026-09-22 外网 DNS 全部不可达，`node install.js` 报 fetch failed；网络恢复后在项目根执行 `node node_modules/electron/install.js`，幂等约 100MB，完成后 `node_modules/electron/dist/electron.exe` 应存在；仍失败先确认代理/VPN，勿改包版本）。待做：① `webviewTag:true` + `--test-ad` 实机跑通 owadview（需 GUI）；② 打包链实跑——`@overwolf/ow-electron-builder` 已写入 package.json，但本机 `pnpm install` 反复报 `os error 2/5/183`（符号链接/文件已存在/拒绝访问），`7zip-bin` 等打包传递依赖未装齐，**须先修本机文件系统/安全软件环境再重跑 install**。
- [ ] **【验证】** trial/AdSlot 实机冒烟（dev 下 free1/free2 组合的广告位与云同步入口显隐、激活态切换）——AdSlot/selectAdProvider/Overwolf/Union360/Noop 三 provider 已落地，仅剩 GUI 冒烟。

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

## 登记表（外部阻塞，非编码项）

- 真实后端端到端冒烟：`fetchRedeem` / `unbind` / `activate` / 登录+MFA 走真实私钥/账号链路（**阻塞**：需真实后端实例 + 可登录账号；activate 另需先具备客户端激活端点接入与登录 UI）。
- 打包产物运行时验证：electron-builder 产物 GUI 冒烟（**阻塞**：需打包 + GUI 环境）。
- `qa-first-run-audit.test.ts` A1/A2 历史 flaky（5s 性能阈值断言）：与广告接入无关，待单独放宽阈值或改相对断言（属 license 域）。
- 其余 7 个语言包（除 en/zh）未补换绑/账号文案，i18next 回退默认语言（**可选**，不影响功能）。
