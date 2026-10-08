# 广告渠道与构建变体（口径已定案）

> 结转自原活动 plan（2026-10-01 搬家），**本文件是长期口径的唯一留存处**，plan 里不再重复。所有 `file:line` 为 2026-10-01 在 HEAD `a3819d3` 实测。未完成项见 `doc/plan-4.1.md`。

## 一、构建变体（两个 edition，GUI 冒烟按此核对）

| 变体 | 云同步 | 广告 |
|---|---|---|
| **free1**（默认变体） | ✅ 有 | ✅ 有，按地区加载对应渠道 |
| **free2** | ❌ 默认砍（激活且有 `cloud_sync` 权益后恢复） | ❌ 无（显式开启也被压掉） |

- 编译期开关由 5 个 env 注入：`scripts/gen-build-flags.mjs:8-12` 读 `AI_TOOLS_EDITION` / `AI_TOOLS_AD_REGION` / `AI_TOOLS_ADS` / `AI_TOOLS_CLOUD_SYNC` / `AI_TOOLS_CLOUD_SYNC_ACTIVATION_UNLOCKS`，`vite.config.mts:9-13` 同套机制下发渲染层。
- 默认值（缺 env 时）：`src/shared/build-flags.ts:47-53` ＝ `edition:'free1'`、`adRegion:'cn'`、`adsEnabled:true`、`cloudSyncEnabled:true`、`cloudSyncActivationUnlocks:true`；合法枚举 `EDITIONS=['free1','free2']`、`REGIONS=['overseas','cn']`。
- **free2 的强制短路**在 `src/shared/build-flags.ts:88-90`：`edition==='free2'` 时 `adsEnabled` 直接为 `false`（显式传 `AI_TOOLS_ADS=1` 也压掉），`cloudSyncEnabled` 默认 `false`。
- 「free2 激活后是否解锁云同步」默认＝解锁（`cloudSyncActivationUnlocks=true` 软模式）；要硬砍（激活也不开放）在打包时传 `AI_TOOLS_CLOUD_SYNC_ACTIVATION_UNLOCKS=0`，**UI 入口与主进程 IPC 读同一 flag**，不会留下点了没反应的死路入口。
- **广告地区判定为编译期 flag**（`AI_TOOLS_AD_REGION=overseas|cn`），与 edition 开关同一套 env 机制——产物明确，**不做运行时网络探测**。

## 二、海外渠道：Overwolf（ow-electron）

来源：npm registry、GitHub（`overwolf/ow-electron-packages-sample`）、官方文档站 `overwolf.github.io/tools/ow-electron`。

- `@overwolf/ow-electron` 是 Electron 的 drop-in 替换（fork），官方支持与普通 electron 并存（加脚本变体即可，不强制全量换底座）。
- 广告用 `<owadview/>` 标签：内置自管理广告容器，自动拉取/刷新/静音，需标准 IAB 尺寸容器。
- **底座已切换完毕**（原「项目锁 electron 43.0.0、换底座须降至 42」的风险已消除）：`package.json:68` 以别名 `"electron": "npm:@overwolf/ow-electron@42.11.4"` 锁定，`:69` 打包器 `@overwolf/ow-electron-builder ^26.9.3`，`package`/`package:win|mac|linux` 四条脚本（`:29-32`）已直接调 `ow-electron-builder`；`node_modules/electron` 实际解析为 `@overwolf/ow-electron` 42.11.4，`node_modules/electron/dist/electron.exe` 存在。
- 发布链前置：Console 注册 App UID + 联系 Overwolf 开通广告；发布需 Overwolf 签名 + 开发者代码签名双签（上商店则 DSC 强制）。测试可用 `ow-electron --test-ad` 免开通跑通。
- 版本可选性（2026-10-08 npm registry 实测）：42 线已到 **42.11.4**（`latest`），仍**无 43 线**；`42-x-y` dist-tag 只指向 `42.7.1-beta.9`，所以**必须锁精确版本、别用 dist-tag**。日后升级 electron 主线前须先确认 Overwolf 是否跟进。
- 换版本后 `node_modules/electron/dist/` 可能不落地（`pnpm install` 只更新了包元数据）：本机的 `allowBuilds['@overwolf/ow-electron']` 与 devDependencies 别名 `electron` 是否匹配**未核实**，脚本被跳过时手动 `node node_modules/electron/install.js` 补下载二进制。

## 三、国内渠道：360 联盟

- `union.360.cn` 直连/代理三次超时不可达；公开渠道仅见**移动端（Android）**广告 API 文档，**未见 PC 桌面软件广告 SDK 公开文档**——「桌面端支持未确认」这一结论成立且仍未解除。
- 拿到 SDK 文档后按现有 `AdProvider` 接口（`src/renderer/src/components/ads/types.ts`，已有 `OverwolfAdProvider` 与恒不填充的 `NoopAdProvider`）新增实现并接入工厂，不改调用方。
