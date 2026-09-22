# plan-3.1 · 广告接入与免费版编译开关

## 背景与目标

在 `ai-tools`（Electron 43 桌面应用，React+Vite renderer / TS 主进程）中引入广告变现，并通过**编译期开关**产出两种免费版形态：

- **免费版1**：功能完整（含云同步）+ 广告
- **免费版2**：无云同步 + 无广告

**「激活版」不是第三种产物**：用户在免费版1 里输入激活码，`license` 权益链路判定通过后广告自动消失——这是**运行时状态**，不单独打包。故整体只出 **2 个安装包**（海外版另按地区出 1 个，共 3 条打包命令）。

## 广告渠道

- **海外：Overwolf（ow-electron）**。核实来源：npm registry（registry.npmjs.org/@overwolf/ow-electron）、GitHub（overwolf/ow-electron-packages-sample）、官方文档站（overwolf.github.io/tools/ow-electron）。事实：
  - `@overwolf/ow-electron` 是 Electron 的 drop-in 替换（fork），**官方支持与普通 electron 并存**（加脚本变体，不强制全量换底座）；
  - 广告用 `<owadview/>` 标签（ow-electron 内置的自管理广告容器，自动拉取/刷新/静音，需放标准 IAB 尺寸容器）；
  - **版本风险：稳定版最新仅 42.7.1（无 43 线）**，项目锁定 electron 43.0.0——换底座须降至 42，属独立验证项；
  - 发布链要求：打包须换 `@overwolf/ow-electron-builder`（bin 名 `ow-electron-builder`，latest 26.9.3）；Overwolf Console 注册 App UID + 联系 Overwolf 开通广告；发布需 Overwolf 签名 + 开发者代码签名双签（上 Overwolf 商店则 DSC 强制）；测试可用 `ow-electron --test-ad` 免开通跑通。
- **国内：360联盟**。`union.360.cn` 直连/代理三次超时不可达；公开搜索仅见移动端（Android）广告 API 文档与广告主投放工具，**未见 PC 桌面软件广告 SDK 公开文档**——「桌面端支持未确认」成立。待商务对接拿到 SDK 文档后按 `AdProvider` 接口补齐实现。

> 地区判定：编译期 flag（`AI_TOOLS_AD_REGION=overseas|cn`），与免费版编译开关同一套 env 机制，产物明确、不做运行时网络探测。

## 产品形态（按需求原文确定 — 共 2 个编译变体，不是 3 个包）

| 变体 | 云同步 | 广告 |
|---|---|---|
| **免费版1**（默认变体） | ✅ 有 | ✅ 有，按地区加载对应渠道 |
| **免费版2** | ❌ 默认砍（激活且有 cloud_sync 权益后恢复） | ❌ 无（显式开启也被压掉） |

「免费版2 激活后云同步是否解锁」默认=解锁（`cloudSyncActivationUnlocks=true` 软模式）；若要硬砍（激活也不开放），打包时传 `AI_TOOLS_CLOUD_SYNC_ACTIVATION_UNLOCKS=0`，UI 入口与主进程 IPC 同一 flag 短路，无死路入口。

## TODOS（仅未完成）

- [ ] **【验证】ow-electron 底座实机验证 + 打包链实跑** — 底座已切：`package.json` 用 pnpm alias `"electron": "npm:@overwolf/ow-electron@42.7.1"`（**代码 import 保持 `'electron'` 不变**，类型由 ow-electron 自带 `electron.d.ts` 提供）；二进制**不能自动下载**（`@electron/get` 对 149MB 包 fetch 超时），须手动下载 `https://content.overwolf.com/ow-electron/releases/download/v42.7.1/ow-electron-v42.7.1-win32-x64.zip` → 解压到 `node_modules/electron/dist` → 写 `path.txt=electron.exe`。已验证：**typecheck 0 错、单测 570/572（2 失败为 A1/A2 5s 阈值历史 flaky）、`build:main` 混淆链 66 文件 0 失败、ssh2/sftp/electron-updater 加载正常**。**待做**：① `webviewTag:true` + `--test-ad` 实机跑通 owadview（需 GUI）；② 打包链实跑——`@overwolf/ow-electron-builder` 已写入 package.json，但本机 `pnpm install` 反复报 `os error 2/5/183`（符号链接/文件已存在/拒绝访问），`7zip-bin` 等打包传递依赖未装齐，**须先修本机文件系统/安全软件环境再重跑 install**。
- [ ] **【开发】** trial/AdSlot 落地后实机冒烟（dev 下 free1/free2 组合的广告位与云同步入口显隐、激活态切换）。
- [ ] **【外部】** 360联盟商务对接：确认 PC 桌面 SDK 是否存在并取文档 → 补齐 `AdProvider` 实现（官网三次超时，公开渠道无桌面文档）。
- [ ] **【外部】** Overwolf Console 注册 App UID + 申请广告开通（发布另需开发者代码签名证书）。

## 登记表（外部阻塞，非编码项）

- 真实后端端到端冒烟：`fetchRedeem` / `unbind` 走真实私钥签发链路（**阻塞**：需真实后端实例）。
- 打包产物运行时验证：electron-builder 产物 GUI 冒烟（**阻塞**：需打包 + GUI 环境）。
- `qa-first-run-audit.test.ts` A1/A2 历史 flaky（5s 性能阈值断言）：与广告接入无关，待单独放宽阈值或改相对断言（属 license 域）。
- 其余 7 个语言包（除 en/zh）未补换绑文案，i18next 回退默认语言（**可选**，不影响功能）。
