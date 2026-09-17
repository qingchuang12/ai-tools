## 来源 `plan-build-release.md`（原 plan-16.0.md） · plan-16.0 · 单一活动计划（打包产物缺失传递依赖 concat-stream）

> 版本：1.1（2026-09-12 完成并归档：修复 `cannot find module concat-stream`——SFTP 传递闭包真实化 + 真实 electron-builder 出包验证（含川哥本机出包复验）；release/ 与临时残留清理；`node-linker=hoisted` 已取证、决定不根治）· 单一活动 plan：本仓库 `doc/` 同时仅保留此一份活动 plan。
> 前任归档：[archive/plan-15.0.md](archive/plan-15.0.md)（P 商店全流程发布前检查：QA 四层矩阵回归 + 3 条建议级收尾 + 复验闭环，最终放行；遗留用户侧事项：统一提交，由川哥执行）。

## 跨版本遗留项

（暂无。已知能力边界：codex-cli 上游不支持远程 MCP 接入，UI 已明示拦截，上游支持后可移除。）

## 本次任务：打包产物缺失传递依赖（cannot find module concat-stream）

### 根因（已取证）
- pnpm 当前为 symlinked 模式（`.npmrc` 的 `node-linker=hoisted` 未生效）：直接依赖是 `SymbolicLink`，传递依赖藏于 `node_modules/.pnpm/<pkg>@x/node_modules/<pkg>`。
- 既有 `scripts/link-pnpm-deps.cjs` 用 `fs.symlinkSync(src, top, 'junction')` 把传递依赖以 **Windows junction** 补到顶层 `node_modules`。
- 取证 `release/win-unpacked/resources/app.asar`：直接依赖 `ssh2`（42 条）、`@modelcontextprotocol/sdk`（557 条）、`electron-store`（在）；但 `concat-stream`、`ssh2-streams`、`readable-stream`、`asn1`、`bcrypt-pbkdf`、`cpu-features` 等**全部为 0**。
- electron-builder 只 dereference 直接依赖的 `SymbolicLink`，不跟随 Windows junction，故 junction 补上的传递依赖整条丢失。

### 其他问题（顺带处置 / 验证）
1. 原生模块 `cpu-features@0.0.10` 在 `node_modules` 内**无 `.node` 二进制**（`npmRebuild:false`），打包后 `require('cpu-features')` 可能降级或报错，影响 SFTP 加密加速；重打包后需实测 SFTP 功能，必要时开启 `npmRebuild`。
2. 根因 `node-linker=hoisted` 未生效（依赖隔离靠 link 补丁兜底）；建议根治：确认 `.npmrc` 被 pnpm 读取 / 重装为 hoisted，消除补丁依赖。
3. `release/` 残留 1.2.4 版本 exe / Setup，非 bug，可清理。

## TODOS（汇总）

- [x] 诊断：asar 内 concat-stream 等传递依赖缺失根因（pnpm symlinked + electron-builder 不跟进特定嵌套符号链接；旧 junction 方案亦无效）
- [x] 修复 link-pnpm-deps.cjs：改为「仅真实化 SFTP 栈（ssh2/ssh2-sftp-client）生产传递闭包」的纯 Node 真实递归复制；含 realpath 校验（跳悬空链接）、visited 防环、深度上限 60、跳过非闭包符号链接（防复制 dev 包）
- [x] 重跑 link:deps，验证顶层 node_modules 下整条闭包（concat-stream/readable-stream/safe-buffer/bcrypt-pbkdf/string_decoder/inherits 等 17 个非直接包）均为真实目录且可 require
- [x] 验证打包机制含入闭包：用 `@electron/asar`（electron-builder 同款库）轻量打包已真实化的 12 个 SFTP 闭包顶层目录 → asar 内 concat-stream(4)/readable-stream(28)/safe-buffer(5)/… 全部 >0 条目
- [x] **真实 electron-builder 出包验证通过（端到端闭环）**：以「独立输出目录 `release-verify` + 本地 `electronDist` + `win.signAndEditExecutable=false`」绕过沙箱对 `release/` 旧 asar 的占用锁，`electron-builder --win --x64 --dir` **25s 出包** → `release-verify/win-unpacked/resources/app.asar`（5267 文件 / 28.6MB）内含 `concat-stream=3 / readable-stream=27 / safe-buffer=3 / bcrypt-pbkdf=4 / ssh2=33 / ssh2-sftp-client=7`（**修复前全为 0**）；再 `extractAll` 后实跑 `concat-stream` 收流成功（`hello world`, len=11）→ **`cannot find module concat-stream` 彻底闭环**
- [x] **川哥本机出包复验通过**：`release/win-unpacked/resources/app.asar`（5368 文件 / 29.0MB）内含 `concat-stream=3 / readable-stream=27 / safe-buffer=3 / bcrypt-pbkdf=4 / ssh2=33 / ssh2-sftp-client=7` → 修复在正式出包产物中生效
- [x] `release/` 清理：旧 1.2.4 exe/Setup **已不存在**（此前 electron-builder 的 `EnsureEmptyDir` 已清空 `release/` 根目录）；残缺的 `release/win-unpacked`（7 文件，含锁死 app.asar）已删除 → `release/` 现为空
- [x] 临时残留清理：`diag_asar_tmp.asar` 的 stale 锁已自行释放，连同残留脚本 `cleanup_tmp.cjs` / `run_asar.js` 一并删除 → 项目根无残留
- [x] `node-linker=hoisted` 根治：**已取证 + 决定不根治**（见「其他问题·结论」#2；川哥 2026-09-12「就这么定」）→ **全部 TODOS 完成，本 plan 归档**

## 其他问题·结论

1. **cpu-features**：asar 内实测存在（105 条），但其为 ssh2 的 **optional** 原生依赖、本地无 `.node` 二进制（`npmRebuild:false`）—— 实测顶层 `require('cpu-features')` 返回 `MODULE_NOT_FOUND`。但 ssh2 在 `ssh2/lib/protocol/constants.js:6-8` 用 `try { cpuInfo = require('cpu-features')(); } catch {}` **空 catch 吞掉**，仅退化为无 CPU 加速，不会导致 SFTP 报错。当前 `cannot find module` 报错仅来自 concat-stream，故**无需开启 npmRebuild**，保持现状。
2. **node-linker=hoisted 未生效**（根因级，**已取证**）：`node_modules/.modules.yaml` 记录 `"nodeLinker": "isolated"`（另有 `storeDir: D:\.pnpm-store\v11`、`prunedAt: 2026-09-09`）→ 当前 node_modules 是以 **isolated** 布局安装的，`.npmrc` 的 `node-linker=hoisted` 未作用于它。**建议：不根治**——理由：① concat-stream 已稳定修复并端到端验证；② hoisted 属**重型变更**（重建 node_modules，可能引入幽灵依赖/提升版本差异，需全量回归）；③ 收益仅为「移除 link:deps 补丁」。若日后要根治，本地步骤：① `pnpm config get node-linker` 确认设置是否被读取（若返回 `isolated`，说明该 pnpm 版本需把 `node-linker` 写进 `pnpm-workspace.yaml` 而非 `.npmrc`）；② 备份后删 `node_modules`；③ `pnpm install --force`；④ 校验 `node_modules/concat-stream` 非符号链接；⑤ 移除 `link:deps` 构建步骤并全量回归（tsc + vitest + `package:win` + SFTP）。
3. **release/ 残留 1.2.4 exe/Setup**：**已清理** —— 旧 exe/Setup 此前已被 electron-builder 的 `EnsureEmptyDir` 删除；残缺的 `release/win-unpacked` 已删，`release/` 现为空。
4. **验证用临时文件**：`diag_asar_tmp.asar` 的占用锁**已自行释放**并删除；另清理了残留脚本 `cleanup_tmp.cjs`、`run_asar.js` → 项目根现无任何临时残留。
5. **沙箱对「已存在 asar」的 stale 占用锁（环境坑，非代码问题）**：`release/win-unpacked/resources/app.asar` 与 `diag_asar_tmp.asar` 均无法删除——tasklist 确认**无** AI-Tools / electron / app-builder 进程持有，`fs.rmSync`（safe-delete trash 中止）/ `cmd del /f /q` / `rename` 全部 EBUSY；而**新建** `.asar` 可即刻删除 → 是对已存在 asar 的 stale 句柄锁。这正是 electron-builder 清理默认输出目录 `release/` 失败的直接原因（此前「14min 卡死」的真相）。**绕过法**：改到全新输出目录 `release-verify` + 复用本地 `electronDist` + 关 `signAndEditExecutable`（免下载 winCodeSign）。**川哥本地无此锁，直接 `pnpm run package:win` 即可出正式包。** 该 stale 锁约 1 小时后自动释放（本次已复测：删除成功）。
6. **`release-verify/`**：沙箱真实出包验证的 `--dir` 产物（未签名、无 NSIS/portable 安装包）。川哥本机出包（`release/`）后已删除，当前不存在。

---

## 来源 `plan-19.0.md` · plan-19.0 · 桌面端在线升级（electron-updater）+ GitHub Actions 自动化构建

> 版本：1.0（2026-09-15 新建）· 单一活动 plan：`doc/` 同时仅保留此一份。
> 前任归档：[archive/plan-18.0.md](archive/plan-18.0.md)。
> 对应软件版本：**1.2.5 → 1.3.0**（本次小版本号 +1）。

## 背景与目标
当前 `publish: null` 且未装 `electron-updater`，应用**无任何在线升级能力**：升级只能用户手动重新下载安装包。目标是为本桌面端接入 `electron-updater` 在线更新——应用内检测新版本、下载、弹窗、重启安装；并引入 **GitHub Actions 免费 CI/CD** 自动化构建三平台安装包并发布到更新源。本次发布对应版本 **1.3.0**（小版本号 +1）。

**可行性结论（含平台差异，须如实告知用户）**

| 平台 / 目标 | 自更支持 | 说明 |
|---|---|---|
| Windows · NSIS（安装版） | ✅ **全支持** | 官方主路径，支持 `latest.yml` + `.blockmap` 增量差分 |
| Windows · portable（单文件版） | ❌ 不支持 | electron-updater 不认 portable 单文件，需提示走安装版或手动 |
| macOS · dmg / zip | ⚠️ 条件支持 | 仅 zip 走自动更新；**必须已签名 + 公证**，否则不可靠（现状未签名） |
| Linux · AppImage | ⚠️ 支持 | electron-updater 支持 AppImage；deb **不支持**自更 |


## 范围与边界
**做**
- 引入 `electron-updater`，配置 `build.publish`（generic 自助托管 feed URL）。
- 主进程接入 autoUpdater 事件（checking / available / not-available / downloaded / error）+ 下载与 `quitAndInstall`。
- preload/IPC 暴露「检查更新 / 下载 / 应用重启」与事件订阅；渲染层设置页加「检查更新」，启动时静默检查。
- **GitHub Actions 工作流**：tag/push 触发，在原生 runner（windows/macos/ubuntu）跑 install → typecheck → test → build → package，产出各平台安装包并发布到更新源。
- **版本号 1.2.5 → 1.3.0**：本次功能交付对应的发布版本。

**暂不做**
- 不接多通道（latest/beta 差异化），默认单渠道 latest。
- 不做强制更新/灰度、不做安装包归档清理自动化。
- macOS 签名/公证不在本 plan（仅设计「未签名则降级提示」，签名由川哥侧决定）。

## 实现思路（触点 → 步骤 → 取舍 → 风险回滚）

### 取舍
- 选 generic 自助托管而非 GitHub Releases：项目无公开 GitHub 仓库，且有自有域名/服务器，自助托管对 Windows 单 feed 最直接。
- `autoDownload=false`：把下载决定权交给用户，避免静默后台大体积下载；配合启动静默「仅检测、有更新再问」。
- GitHub Actions 免费额度构建本三平台矩阵足够；产物经 SFTP 直达自有服务器 feed，不额外占用 GitHub Release 存储。

### 风险与回滚
- feed URL 失效 / 无网络 / 元数据解析失败 → 捕获为 `error` 事件，UI 仅提示「检查失败，可到官网手动下载」，不崩、不弹 killBeer。
- 未签名 Windows：SmartScreen 可能拦截安装（自更前用户已装旧版，风险集中在升级安装包本身）。
- macOS 未签名/未公证 → 自动更新不可靠，降级为「提示转官网」。
- **GitHub 仓库需创建并公开代码**：若不愿公开源码，CI 无自托管 runner 则无法用 Actions 免费额度（此点需确认仓库可见性策略）。
- 回滚：`git` 还原文件 + 移除依赖即可，改动集中在新增 updater 模块与配置。

## 已确认决策（2026-09-15）
- **feed 托管**：自有服务器 HTTPS 静态目录（generic），发布时 SFTP 上传 `latest*.yml` + 安装包 + `.blockmap`。feed URL 占位：`https://<自有域名>/ai-tools/update/win/`（域名/目录以实际部署为准）。
- **检查频率**：仅启动时静默检查一次 + 设置页手动「检查更新」，不做周期轮询、不常驻。
- **升级策略**：Windows NSIS 安装版完整自更；mac（未签名）、Linux deb、Windows portable 降级为「有更新→提示转官网手动下载」，不执行 `quitAndInstall`。

## TODOS
- [x] 归档已完结 plan-18.0；确认无多活动 plan 并存
- [x] 版本号：`package.json` version `1.2.5 → 1.3.0`
- [x] 引入 `electron-updater`（6.8.9）；`build.publish` 配 generic feed（占位 URL，域名待用户替换）
- [x] 主进程：`src/main/updater.ts` 封装 autoUpdater（事件/下载/quitAndInstall/降级判定）+ `index.ts` 注册 IPC 与启动静默检查
- [x] preload：`updater.check/download/quitAndInstall/getStatus/onStatus` + 事件订阅
- [x] 渲染层：`electron.ts` 类型+mock；设置页「关于」弹窗新增检查更新/下载/重启/降级转官网
- [x] **GitHub Actions**：新增 `.github/workflows/release.yml`（test → 三平台 build → 上传产物 → tag 触发经 SFTP 发布）
- [x] 平台矩阵降级：`canAutoUpdate()` 仅放行 win-NSIS 与 Linux-AppImage，其余广播 `unsupported` 转官网
- [x] `tsc`（main/full 0 错）+ 既有测试 439 全绿；实机 `electron-builder --win --x64 --publish never` 出包 **1.3.0**，`latest.yml` 与 `app-update.yml` 均生成
> **已结转至 `doc/plan-1.0.md`**（归档不得留存未完成任务）： 归档：完成后归档本 plan 至 `doc/archive/plan-19.0.md`（附审计/验证产物）

## 验收结果（2026-09-15）
- `electron-builder --win --x64 --publish never` 生成：`AI-Tools Setup 1.3.0.exe` + `.blockmap` + `release/latest.yml`（version 1.3.0，含 sha512/size），且 `release/win-unpacked/resources/app-update.yml` 已内嵌——在线更新 feed 链路可用。
- `tsc -p tsconfig.main.json` / `tsc -p tsconfig.json` 均 0 错；`vitest run` 439 全绿。

## 用户侧待办（不计入 TODO 判定，需川哥实操）
- **真实 feed 域名**：`package.json → build.publish[0].url` 由占位 `https://updates.example.com/ai-tools` 替换为自有服务器 feed 目录；并确认该目录 HTTPS 可匿名访问。
- **创建/推送 GitHub 仓库**（含 `.github/` 与 `package.json`），并设置 Actions Secrets：`SFTP_HOST/USER/PORT/SSH_KEY/PATH`。
- 发布流程：升版本 → 打 `v1.3.0` tag 推送 → Actions 自动测试、三平台打包、tag 触发上传 feed。
- 设置页「前往官网下载」地址（`Settings.tsx` `openDownloadPage` 的 `https://www.ywhome.top`）按实际下载页替换。
- 本机复验：安装 1.3.0 后进「设置 → 关于 → 检查更新」，应显示「当前已是最新」（无更高版本时）或进入下载流程。

---

## 来源 `plan-20.0.md` · plan-20.0 · Release 由默认草稿改为正式版本

## 背景与目标
当前 tag 推送触发 GitHub Actions 构建时，electron-builder 生成的 GitHub Release 显示为 Draft（草稿），需要改为正式版本（Release），确保最终用户能匿名访问安装包与 latest*.yml 做在线升级。

## 范围与边界
- 做：在 package.json 的 build.publish[0]（github provider）显式声明 releaseType = release。
- 暂不做：不改动 workflow 触发逻辑、三方平台打包脚本、代码签名。
- 既有已存在的 Draft Release 需手动在 GitHub 上「Publish release」或删除后重新构建，本次代码修正只影响后续新建的 Release。

## 来源 `plan-20.1.md` · plan-20.1 · CI 构建 Node 版本由 20 升级到最新 LTS 24

## 背景与目标
.github/workflows/release.yml 的 test 与 build 两处 `node-version: 20`，而 Node 20 已于 2026-03-24 EOL，CI 会抛弃用警告。按 memory 约束「GitHub Actions 使用 Node.js 24+」，且用户选定最新 LTS，升级为 `node-version: 24`（setup-node 自动跟随最新 24.x 补丁，如 24.21.0）。

## 范围与边界
- 做：release.yml 两处 node-version 20 → 24。
- 暂不做：不改本机 Node、不加 npm/engines 字段、不动 package.json .nvmrc（项目无此文件）。
- 用户侧：提交并推送后触发 workflow 验证。

> **已省略的过程性章节**（12 节，按需查 git 历史）：构建 · 打包 · 发布 · 升级 / 规则（plan 管理铁律） / 现象 / 修复（已落地，纯 Node 递归复制） / 规则（plan 管理铁律） / 触点 / 步骤 / GitHub Actions 工作流（新增）设计 / 实现思路 / TODO / 实现思路 / TODO
