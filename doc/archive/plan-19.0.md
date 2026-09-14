# plan-19.0 · 桌面端在线升级（electron-updater）+ GitHub Actions 自动化构建

> 版本：1.0（2026-09-15 新建）· 单一活动 plan：`doc/` 同时仅保留此一份。
> 前任归档：[archive/plan-18.0.md](archive/plan-18.0.md)。
> 对应软件版本：**1.2.5 → 1.3.0**（本次小版本号 +1）。

## 规则（plan 管理铁律）
- `doc/` 下同一时刻只保留一个活动 plan；新任务合并进本 plan。
- 执行完结 → 归档到 `doc/archive/`（plan 与 audit 一并归档）。
- 每次软件调整：细化进 plan → 确认 → 执行 → 归档检查。

---

## 背景与目标
当前 `publish: null` 且未装 `electron-updater`，应用**无任何在线升级能力**：升级只能用户手动重新下载安装包。目标是为本桌面端接入 `electron-updater` 在线更新——应用内检测新版本、下载、弹窗、重启安装；并引入 **GitHub Actions 免费 CI/CD** 自动化构建三平台安装包并发布到更新源。本次发布对应版本 **1.3.0**（小版本号 +1）。

**可行性结论（含平台差异，须如实告知用户）**

| 平台 / 目标 | 自更支持 | 说明 |
|---|---|---|
| Windows · NSIS（安装版） | ✅ **全支持** | 官方主路径，支持 `latest.yml` + `.blockmap` 增量差分 |
| Windows · portable（单文件版） | ❌ 不支持 | electron-updater 不认 portable 单文件，需提示走安装版或手动 |
| macOS · dmg / zip | ⚠️ 条件支持 | 仅 zip 走自动更新；**必须已签名 + 公证**，否则不可靠（现状未签名） |
| Linux · AppImage | ⚠️ 支持 | electron-updater 支持 AppImage；deb **不支持**自更 |

→ 策略：核心支持 Windows NSIS；mac / Linux 与 portable 做「版本有更新」提示 + 引导官网手动下载，不自更。

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

### 触点
- 依赖与配置：`package.json`（devDeps + `build.publish`）。
- 主进程：`src/main/index.ts` 或独立 `src/main/updater.ts`（推荐独立模块，index 只注册 IPC）。
- preload：`src/preload/*`；渲染层：设置页 + `src/renderer/src/lib/electron.ts` 的 IPC 封装。
- 发布：`scripts/`（`package` 流程扩展）；feed 目录约定 `<feed>/<platform>/latest*.yml + 安装包 + blockmap`。

### 步骤
1. **依赖与配置**：`pnpm add -D electron-updater`；`build.publish = [{provider:'generic', url:'<feed>'}]`。
   - electron-builder ≥24 配置 publish 后，打包会生成 `latest.yml`（win）/ `latest-linux.yml`（linux）/ `latest-mac.yml`（mac）并内嵌 `app-update.yml`（以实机生成验证为准，消除猜疑）。
2. **版本号**：`package.json` version `1.2.5 → 1.3.0`（小版本号 +1）。
3. **主进程 updater 模块**：`autoUpdater.autoDownload=false`；订阅事件广播到渲染层；IPC：`update:check / update:download / update:quitAndInstall`；`update-downloaded` 后由用户触发重启；非 NSIS/portable/无签名等降级场景返回「仅提示转官网」，不 `quitAndInstall`。
4. **preload + IPC 封装**：`onUpdateAvailable/onUpdateDownloaded/onUpdateError` 等订阅接口；渲染层按需调用。
5. **渲染层 UI**：设置页新增「检查更新」（显示当前版本）；启动时静默检查一次；有新版弹「下载并安装 / 稍后」，下载完成弹「立即重启」。
6. **版本纪律**：只升 `package.json.version`；禁止降级（allowDowngrade=false）。

### GitHub Actions 工作流（新增）设计
- **触发**：推送 `v*` tag（或 `workflow_dispatch` 手动）触发发布；`push` 主分支跑 PR 校验（typecheck+test）。
- **matrix**：`os: [windows-latest, macos-latest, ubuntu-latest]`，各自原生 runner 打对应平台安装包（mac 构建必须在 macos runner）。
- **步骤**：checkout → setup `actions/setup-node@v4` + pnpm → `pnpm install` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `electron-builder --publish never`（生成安装包 + `latest*.yml`）→ 上传产物（`actions/upload-artifact@v4`）。
- **发布到 feed**：generic provider 只产出元数据，上传到自有服务器需额外步骤——用 SSH/SFTP action（如 `easingthemes/ssh-deploy`）把 `release/*latest*.yml` + 安装包 + `*.blockmap` 推送到 feed，SFTP 凭证存 **repository secrets**（`SFTP_HOST/USER/KEY/PATH`）。
- **mac 签名**（可选）：需在 secrets 配证书 + notarize 凭据，工作流解锁钥匙串；本 plan 未实现签名，未配置时自动跳过并以「未签名→降级提示」处理。
- **前置**：需要一个 GitHub 仓库承载 `package.json` 与工作流（当前本地目录需先推送/创建远程仓库）。

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
- [ ] 归档：完成后归档本 plan 至 `doc/archive/plan-19.0.md`（附审计/验证产物）

## 验收结果（2026-09-15）
- `electron-builder --win --x64 --publish never` 生成：`AI-Tools Setup 1.3.0.exe` + `.blockmap` + `release/latest.yml`（version 1.3.0，含 sha512/size），且 `release/win-unpacked/resources/app-update.yml` 已内嵌——在线更新 feed 链路可用。
- `tsc -p tsconfig.main.json` / `tsc -p tsconfig.json` 均 0 错；`vitest run` 439 全绿。

## 用户侧待办（不计入 TODO 判定，需川哥实操）
- **真实 feed 域名**：`package.json → build.publish[0].url` 由占位 `https://updates.example.com/ai-tools` 替换为自有服务器 feed 目录；并确认该目录 HTTPS 可匿名访问。
- **创建/推送 GitHub 仓库**（含 `.github/` 与 `package.json`），并设置 Actions Secrets：`SFTP_HOST/USER/PORT/SSH_KEY/PATH`。
- 发布流程：升版本 → 打 `v1.3.0` tag 推送 → Actions 自动测试、三平台打包、tag 触发上传 feed。
- 设置页「前往官网下载」地址（`Settings.tsx` `openDownloadPage` 的 `https://www.ywhome.top`）按实际下载页替换。
- 本机复验：安装 1.3.0 后进「设置 → 关于 → 检查更新」，应显示「当前已是最新」（无更高版本时）或进入下载流程。