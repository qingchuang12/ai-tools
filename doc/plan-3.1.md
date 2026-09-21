# plan-3.1 · 广告接入与免费版编译开关

> 版本：v1.1（2026-09-21）· 唯一活动 plan（ai-tools）。承接 plan-2.7（授权体系 R1-R6，编码已全绿），其登记表外部阻塞项结转至本 plan 末尾。
> v1.1 变更：广告渠道拍板——**海外 Overwolf（ow-electron）+ 国内 360联盟**，架构改为按地区/渠道区分；广告渠道决策项关闭。

## 背景与目标

在 `ai-tools`（Electron 43 桌面应用，React+Vite renderer / TS 主进程）中引入广告变现，并通过**编译期开关**产出两种免费版形态：

- **免费版1**：功能完整（含云同步）+ 广告
- **免费版2**：无云同步 + 无广告

**「激活版」不是第三种产物**：用户在免费版1 里输入激活码，`license` 权益链路判定通过后广告自动消失——这是**运行时状态**，不单独打包。故整体只出 **2 个安装包**。

## 广告渠道（已拍板 — 按地区区分）

- **海外**：**Overwolf（ow-electron）**。ow-electron 是 Overwolf 官方维护的 Electron 分支，专为桌面应用设计，配套 Overwolf Ads SDK（应用内广告容器展示广告），对桌面端**真实可行**。
  - ⚠️**需实访核实**（本次离线，官方文档 `dev.overwolf.com` 超时未通）：ow-electron 是替换现有 `electron 43` 依赖，还是并存；Ads SDK 的初始化/广告位 API 具体形态；是否要求 Overwolf 账号/审核。
- **国内**：**360联盟**。
  - ⚠️**需实访核实**（`union.360.cn` 超时未通）：360联盟历史上主要是**网站网盟广告**，其对 **PC 客户端/桌面软件**的广告 SDK 支持能力尚未确认——若仅支持网页广告位，则需评估在 Electron webview 内嵌的可行性与合规性。**这是国内渠道能否落地的关键前提，落地前必须确认。**

> 地区判定方式（待定，落地时定）：编译期 build flag（`AD_REGION: 'overseas'|'cn'`）或运行时探测（locale/时区/IP）。默认走**编译期 flag**，与免费版编译开关同一套机制，产物明确、不依赖运行时网络探测。

## 产品形态（按需求原文确定 — 共 2 个编译变体，不是 3 个包）

需求原文「免费版1 功能完整+广告 / 免费版2 功能没有云同步+无广告，有编译配置开关来切换」即：

| 变体 | 云同步 | 广告 |
|---|---|---|
| **免费版1**（默认变体） | ✅ 有 | ✅ 有，按地区加载对应渠道 |
| **免费版2** | ❌ 编译期砍掉 | ❌ 无 |

**「激活版」不是第三个安装包**，而是免费版1 在运行时输入激活码后的**状态**——复用现有 `activation` / `feature-gate` 链路，广告随 `status === 'activated'` 自动隐藏。所以总共只打 2 个包。

唯一未定的小细节（不阻塞框架，改一行 flag 即可）：**免费版2 里激活后，云同步是否解锁**。默认：免费版2 保留激活入口，激活后解锁云同步。若本意是免费版2 云同步永不开放，改 flag 即可。

## 范围与边界

**做：**
- 编译期 build flag 机制（区分 免费版1 / 免费版2，以及广告地区 overseas/cn）
- 广告位组件框架 + 广告适配器接口（`AdProvider` 抽象），落地 `OverwolfAdProvider`（海外）、`Union360AdProvider`（国内）、`NoopAdProvider`（占位/免费版2）三种实现
- 广告显隐判定：`免费版2` 或 `激活版` → 隐藏；`免费版1 且未激活` → 按地区加载对应 provider
- 云同步在免费版2 编译期禁用（UI 入口 + 主进程通道双向关闭）
- 免费版1（overseas / cn 两地区）+ 免费版2 的 electron-builder 打包命令

**暂不做：**
- 新增付费档位 / 改动现有 license 验签链路
- 服务端改动
- 广告渠道 SDK 的**真实凭据接入与投放联调**（需先实访核实两渠道桌面端 API，见「广告渠道」段的⚠️项）

## 实现思路（触点 → 步骤 → 取舍 → 风险）

### 触点（已查证）
- 构建：`vite.config.ts`（renderer，`define` 注入 build flag）、`tsconfig.main.json`（主进程，`process.env` 注入）、`package.json` scripts（新增 `package:free1` / `package:free2`）
- 权益判定现状：renderer `useActivationStore` 提供 `state.status`（`'inactive'|'trial'|'activated'`）与 `hasFeature('cloud_sync')`；主进程 `license/feature-gate.ts` 的 `assertFeature()` 为唯一 gate
- 云同步：主进程 `cloud-sync-service.ts` + `cloud-sync:*` IPC；renderer `CloudSyncManager.tsx`、preload `cloud-sync:*`
- 共享常量：`src/shared/license-constants.ts`（键名契约唯一来源）

### 步骤（编译开关先行，广告位框架其次，渠道 provider 与云同步开关收尾）
1. 定义 build flag：新增 `src/shared/build-flags.ts` 契约（`EDITION: 'free1'|'free2'`、`ADS_ENABLED`、`CLOUD_SYNC_ENABLED`、`AD_REGION: 'overseas'|'cn'`），renderer 经 `vite define`、主进程经 tsconfig/env 注入，三端唯一来源。
2. 广告位组件框架：renderer 新增 `AdSlot` 组件 + `AdProvider` 适配器接口（`init/loadBanner/destroy`）。显隐 hook 复用 `useActivationStore`：`ADS_ENABLED && status !== 'activated'` 才渲染；按 `AD_REGION` 选择 provider。
3. 渠道 provider 实现：`OverwolfAdProvider`（海外，接 Overwolf Ads SDK）、`Union360AdProvider`（国内，接 360联盟）、`NoopAdProvider`（占位）。**先落接口 + Noop，两渠道具体实现待实访核实 API 后填**——框架不阻塞。
4. 云同步开关：`CLOUD_SYNC_ENABLED === false`（免费版2）时，renderer 隐藏 `CloudSyncManager` 入口，主进程 `cloud-sync:*` handler 直接返回禁用态（防绕过）。
5. 打包：`package.json` 新增编译命令（免费版1-overseas / 免费版1-cn / 免费版2），注入不同 flag 产出对应包。

### 取舍
- 广告适配器抽象化：Overwolf 与 360联盟接入方式差异大（前者原生 Ads SDK，后者可能是网页广告位），用统一 `AdProvider` 接口隔离，`AdSlot` 组件不感知渠道差异。
- 地区用编译期 flag 而非运行时探测：产物明确、不依赖启动时网络/IP 判断，也避免误判导致加载不可用的渠道。
- 云同步双向关闭（UI + 主进程）：仅隐藏 UI 会被 IPC 绕过，故主进程也须按 flag 短路。
- **ow-electron 依赖引入需谨慎**：若海外版需替换 `electron 43` 为 ow-electron 分支，将影响整个主进程运行时与打包链，须先小范围验证兼容性（尤其现有混淆链、`electron-builder`、`electron-updater`），再决定是否全量切换 / 是否海外版单独一套 electron 依赖。

### 风险 / 回滚
- build flag 注入方式需与现有混淆链（`obfuscate-main.mjs`、`vite-plugin-electron-obfuscator`）兼容——落地时验证 flag 未被 mangle 掉。
- **ow-electron 兼容性风险（高）**：替换 Electron 底座可能与现有 43 版本、原生依赖（`ssh2`、混淆插件）冲突，须先做隔离验证。
- **360联盟桌面端支持未确认（高）**：若仅支持网页广告，国内版广告落地方式需重新评估。
- 回滚：build flag 默认值设为「免费版1-cn 全功能」，未注入时行为等同现状；`NoopAdProvider` 兜底保证广告加载失败不影响主功能。

## TODOS

- [ ] **【核实】⚠️** 实访 `dev.overwolf.com` 核实 ow-electron 集成方式（替换/并存现有 electron 43）、Ads SDK API、账号/审核要求
- [ ] **【核实】⚠️** 实访 `union.360.cn` 核实 360联盟是否支持 PC 桌面软件广告 SDK（还是仅网页广告位）——国内渠道落地关键前提
- [ ] **【验证】** ow-electron 与现有底座兼容性隔离验证（electron 43 / ssh2 / 混淆链 / electron-builder / electron-updater）
- [ ] **【开发】** `src/shared/build-flags.ts` 契约（`EDITION`/`ADS_ENABLED`/`CLOUD_SYNC_ENABLED`/`AD_REGION`）+ renderer(`vite define`)/主进程(tsconfig env) 双端注入，验证与混淆链兼容
- [ ] **【开发】** renderer `AdSlot` 组件 + `AdProvider` 适配器接口 + `NoopAdProvider` 占位；显隐复用 `useActivationStore`，按 `AD_REGION` 选 provider
- [ ] **【开发】** `OverwolfAdProvider`（海外）实现 —— 依赖上面核实结果
- [ ] **【开发】** `Union360AdProvider`（国内）实现 —— 依赖上面核实结果
- [ ] **【开发】** 免费版2 云同步编译期禁用：renderer 隐藏 `CloudSyncManager` 入口 + 主进程 `cloud-sync:*` 按 flag 短路
- [ ] **【开发】** `package.json` 新增 `package:free1:overseas` / `package:free1:cn` / `package:free2` 命令注入对应 flag
- [ ] **【测试】** typecheck（IDEA MCP 构建链）+ 各 flag 组合下广告显隐/地区选择/云同步开关的单测

## 登记表（外部阻塞，非编码项 — 来源 plan-2.5/2.6/2.7/2.9 结转）

- 真实后端端到端冒烟：`fetchRedeem` / `unbind` 走真实私钥签发链路（**阻塞**：需真实后端实例）。
- 打包产物运行时验证：electron-builder 产物 GUI 冒烟（**阻塞**：需打包 + GUI 环境）。
- 前端 tsc 类型检查：`tsc -p tsconfig.main.json` 随 IDEA MCP 主进程构建链执行（本机无 node_modules，未本地跑）。
- 其余 7 个语言包（除 en/zh）未补换绑文案，i18next 回退默认语言（**可选**，不影响功能）。
