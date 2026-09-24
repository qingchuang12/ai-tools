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

## 登记表（外部阻塞，非编码项）

- 真实后端端到端冒烟：`fetchRedeem` / `unbind` / `activate` / 登录+MFA 走真实私钥/账号链路（**阻塞**：需真实后端实例 + 可登录账号；activate 另需先具备客户端激活端点接入与登录 UI）。
- 打包产物运行时验证：electron-builder 产物 GUI 冒烟（**阻塞**：需打包 + GUI 环境）。
- `qa-first-run-audit.test.ts` A1/A2 历史 flaky（5s 性能阈值断言）：与广告接入无关，待单独放宽阈值或改相对断言（属 license 域）。
- 其余 7 个语言包（除 en/zh）未补换绑/账号文案，i18next 回退默认语言（**可选**，不影响功能）。
