# plan-4.1 · ai-tools 活跃开发总览（合并原 plan-3.1）

> 本文件现为本仓**唯一活动 plan**（已合并 `doc/plan-3.1.md`）。原 4.1 的「依赖构建配置修复」已收口，仅余 ow-electron 二进制补齐一项（与 3.1 的 ow-electron 验证重叠，已并入下方 TODOS）；原 3.1 的广告接入/免费版开关/ow-electron/授权跨仓对齐为当前活跃主线。

## 背景与目标

### A. 依赖构建配置修复（已收口，仅作背景留存）
pnpm 11/12 键位错位导致构建白名单整体失效：`package.json` 的 `pnpm.onlyBuiltDependencies`（pnpm 12 不读）、`pnpm-workspace.yaml` 的旧 `allowBuilds` 半填草稿、无效的 `allowScripts` 死字段并存。已统一收口到 `pnpm-workspace.yaml` 的 `allowBuilds` 单键（pnpm 11.24 / 12.4.1 共同认可）。
- 已完成：构建脚本白名单统一、删除死配置、esbuild 二进制补齐。
- `allowBuilds` 裁决（pnpm 12 权威键）：`@overwolf/ow-electron: true`（真实包名，devDependencies 里以别名 `electron` 引用）、`esbuild: true`、`cpu-features/ssh2/electron-winstaller: false`（纯 JS 回退 / 用不到 Squirrel 打包）。

### B. 广告接入与免费版编译开关（活跃主线）
在 `ai-tools`（Electron 43 桌面应用，React+Vite renderer / TS 主进程）中引入广告变现，并通过**编译期开关**产出两种免费版形态：
- **免费版1**：功能完整（含云同步）+ 广告
- **免费版2**：无云同步 + 无广告

**「激活版」不是第三种产物**：用户在免费版1 里输入激活码，`license` 权益链路判定通过后广告自动消失——这是**运行时状态**，不单独打包。故整体只出 **2 个安装包**（海外版另按地区出 1 个，共 3 条打包命令）。

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

- 做：广告接入、免费版编译开关、ow-electron 底座与打包链验证、授权客户端跨仓对齐（见 TODOS）。
- 暂不做：`packageManager: pnpm@12.4.1` 与全局 pnpm 11.24.0 的版本口径对齐（项目内已按 manage-package-manager-versions 自动切 12.4.1，行为一致）；360联盟 SDK 实现（待商务文档）；Overwolf 发布链双签（待 Console 开通）。

## 实现思路（已完成校验留存）

- 依赖构建白名单：`pnpm-workspace.yaml` 的 `allowBuilds` 单键裁决（见背景 A）。
- 广告底座：`package.json` 用 pnpm alias `"electron": "npm:@overwolf/ow-electron@42.7.1"`（**代码 import 保持 `'electron'` 不变**，类型由 ow-electron 自带 `electron.d.ts` 提供）；二进制**不能自动下载**（`@electron/get` 对 149MB 包 fetch 超时），须手动下载 `https://content.overwolf.com/ow-electron/releases/download/v42.7.1/ow-electron-v42.7.1-win32-x64.zip` → 解压到 `node_modules/electron/dist` → 写 `path.txt=electron.exe`。已验证：**typecheck 0 错、单测 570/572（2 失败为 A1/A2 5s 阈值历史 flaky）、`build:main` 混淆链 66 文件 0 失败、ssh2/sftp/electron-updater 加载正常**。

## TODOS（仅未完成）

- [ ] **【验证】ow-electron 底座实机验证 + 打包链实跑（含二进制补齐）** — 前置：手动补齐 `@overwolf/ow-electron` 42.7.1 Electron 二进制（2026-09-22 外网 DNS 全部不可达，`node install.js` 报 fetch failed；网络恢复后在项目根执行 `node node_modules/electron/install.js`，幂等约 100MB，完成后 `node_modules/electron/dist/electron.exe` 应存在；仍失败先确认代理/VPN，勿改包版本）。待做：① `webviewTag:true` + `--test-ad` 实机跑通 owadview（需 GUI）；② 打包链实跑——`@overwolf/ow-electron-builder` 已写入 package.json，但本机 `pnpm install` 反复报 `os error 2/5/183`（符号链接/文件已存在/拒绝访问），`7zip-bin` 等打包传递依赖未装齐，**须先修本机文件系统/安全软件环境再重跑 install**。
- [ ] **【开发】** trial/AdSlot 落地后实机冒烟（dev 下 free1/free2 组合的广告位与云同步入口显隐、激活态切换）。
- [ ] **【外部】** 360联盟商务对接：确认 PC 桌面 SDK 是否存在并取文档 → 补齐 `AdProvider` 实现（官网三次超时，公开渠道无桌面文档）。
- [ ] **【外部】** Overwolf Console 注册 App UID + 申请广告开通（发布另需开发者代码签名证书）。

### 授权客户端跨仓对齐（登记自 billing-license-service `plan-7.0` A9，2026-09-23）

> 服务端侧**已就绪**（`POST /api/licenses/activate` 与 **D2 自动上报绑定端点** `POST /api/licenses/report-binding` 均已上线，全量 **338** 测试全绿；管理端 License 处置亦已落地）。以下均为**客户端侧**待做。服务端契约见其 `README.md`「凭证激活」段 /「客户端自动上报绑定（plan-7.0 / D2）」段与 `接口调用时序图.md` §1.7.6 / §3.13 / §4.10 / §4.12 / §4.13。

- [ ] **【开发】接入统一激活端点** `POST /api/licenses/activate` — 服务端把「绑定设备 + 拿签名令牌」从四处入口收敛为**单一端点**，`credential` 传兑换码（`RC-` 前缀）或许可证密钥、由服务端自动识别；响应与既有 `RedeemResponse` 同构（含客户端已消费的 `serverTime`，字段口径不变）。**已定案（服务端 B2 = C，2026-09-23 口径修正）**：无机器码订单**照常自动发兑换码**（系统**发兑换码邮件** + 客户可登录网站查看），客服人工发码**仅用于活动/运营发放**、与自动发码并存——故兑换码是**长期存在的主凭证**，本项**成立且必要**；客户端继续以兑换码为主凭证，切换目标端点不变。
- [ ] **【开发】新增账号登录能力** — 密钥激活分支**要求登录且归属本人**（否则服务端返回 `LOGIN_REQUIRED` / `CREDENTIAL_NOT_FOUND`），而客户端目前**零登录代码**（全仓无 `accessToken` 使用、未调 `/api/account/login`）。这是「客户端只能走兑换码」的根因，也是 A9 的**真正改造量**；服务端账号体系（注册 / 登录 / 找回密码）已可用。
- [ ] **【修复】R6 换绑解绑从未生效（403 静默失败）** — `UNBIND_API_PATH = '/api/licenses/unbind'` 命中服务端 `anyRequest().denyAll()` → **403**，而 `unbindPriorOnServer` 是 best-effort、失败静默 `return false`，故该功能**从未生效且无任何报错**。**服务端已落地 B10 = A（2026-09-23）：旧端点 `POST /api/licenses/unbind` 已物理删除**（连同 `LicenseService.unbindDevice`、`UnbindRequest` DTO 一并移除，其 5 个单测同步删除），故 `constants.ts` 的 `UNBIND_API_PATH` **必须**改指向。⚠️ **但修法被「客户端登录能力」阻塞**——服务端账号侧解绑端点 `POST /api/account/licenses/{licenseKey}/unbind` **需登录 + 归属校验**，客户端零登录时无法调用；故本项应排在「新增账号登录能力」之后，或等服务端 D2「自动上报绑定」定案后评估能否复用同族的「凭 `signedToken`」端点（服务端 E1 已定案：上报绑定**走 `signedToken` 验签**）。
- [ ] **【开发】兑换码激活后自动上报机器码（新需求，2026-09-23 川哥指定）** — 客户端**凭兑换码激活成功**后，于**程序启动时上报一次**本机机器码给服务端完成绑定（服务端将**新增「自动上报绑定」端点**，见其 `plan-7.0` D2/D5 段）；**已上报过则不再触发**（本地持久化一次性标记，与本机试用账本同族）。**场景**：兑换/激活时未携带机器码 → License 落成未绑定态，靠本次补报完成绑定；**不是**替换激活流程，而是在激活之后补一次上报。**归属凭证已定案（服务端 E1 = ①）**：上报时携带客户端持有的 **`signedToken`**（授权文件本体），服务端验签通过即完成绑定——**客户端无需先做登录**，本项可独立于「新增账号登录能力」先行落地。服务端侧接口见其 `plan-7.0` **D2**（**服务端已落地** 2026-09-23，端点 `POST /api/licenses/report-binding`，凭 `signedToken` 验签、无需登录）。
- [ ] **【开发】购买后自动存证 + 轮询上限 1 小时（服务端决策 B5 = 手动按钮 + 轮询）** — 付款后轮询 `GET /api/checkout/{checkoutId}/status` 自动存证并激活，**最长轮询 1 小时，超时即停止轮询**；同时保留手动「检查我的订单」按钮兜底。**服务端已确认无阻碍**：该端点**不受任何限流**，且对渠道的主动对账已有 30 秒冷却窗口（`CheckoutService:38` `COMPENSATION_COOLDOWN_SECONDS = 30`），1 小时内高频轮询**不会**放大渠道 API 调用。

**该组已核实（2026-09-23，原为服务端 C2 待核实项）**：客户端支持凭证类型 = **仅兑换码**；**无「两套硬编码逻辑」**（因为只有一套）；**无可复用轮询代码**（未轮询 `/api/checkout/{checkoutId}/status`——收银台是服务端托管页，由页面自身轮询）。凭证路径引用点仅：`src/main/license/constants.ts:34/37/44` → `src/main/license/redeem.ts:54/98/170`。

> **实现提示**：客户端对外文案已按设计统一收敛为 `license.errors.generic`（`license/errors.ts` 明确「绝不回传错误码」），故服务端新增/改名的错误码（如 `CREDENTIAL_NOT_FOUND`）**无需客户端 i18n 改动**——不要为它加文案映射。

## 登记表（外部阻塞，非编码项）

- 真实后端端到端冒烟：`fetchRedeem` / `unbind` / 新增 `activate` 走真实私钥签发链路（**阻塞**：需真实后端实例；`activate` 另需先具备客户端登录能力，见上「授权客户端跨仓对齐」）。
- 打包产物运行时验证：electron-builder 产物 GUI 冒烟（**阻塞**：需打包 + GUI 环境）。
- `qa-first-run-audit.test.ts` A1/A2 历史 flaky（5s 性能阈值断言）：与广告接入无关，待单独放宽阈值或改相对断言（属 license 域）。
- 其余 7 个语言包（除 en/zh）未补换绑文案，i18next 回退默认语言（**可选**，不影响功能）。
