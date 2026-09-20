# plan-2.5 · ai-tools 授权体系收口（RTL 止血 / 分类 i18n / 激活契约与入口 / 付费态单调时钟 / 俄日阿补译与离线端到端）

> 原文（含各轮实施明细、完整分类清单）备份：`D:\ProductSpace\.workbuddy\backups\plan-cleanup-20260920\plan-2.4.md`

## 背景与目标

2026-09-18 起的一轮授权体系修整。**已完成五个主题**（结论见「实现思路」）：① 阿拉伯语 RTL 止血；② 商店分类 i18n + 三个重叠命名空间合并；③ 激活契约对齐（响应壳 / SKU / 权益词表）；④ 激活入口两分 + 服务地址统一 + 去激活二次确认；⑤ 订阅到期策略与付费态单调时钟（C7）。

**2026-09-20 追加两项**：⑥ 俄/日/阿残缺文案补齐；⑦ 授权链路离线端到端冒烟。

**已拍板的两条产品口径**：订阅到期后**本地自动失效、不做周期性在线复核、续期必须联网**；`update_until` / `max_major_version` 走**软门控**（超范围仍可继续用旧版，只挡新版本更新，不硬阻断运行）。

## 范围与边界

**做**：上述 7 个主题（均已完成）。

**暂不做**：完整 RTL 适配（30+ 组件）；第二批大平台分类翻译（modelscope MCP + skillsmp）；billing-license-service 服务端改动；deep-link 回跳 / 内嵌 webview；周期性在线复核（已被产品口径排除）。

**硬约束**：
- 分类 id / 查询传值**一律不变**（coze 的分类 id 本身是中文名，且要传给其 API 当过滤参数）。
- locale 文件 **CRLF** 行尾 + **9 语言 key 对齐**（新增/删除一律同步 9 份）。
- vault 新增字段**必须可选**，保证旧存档免迁移、缺值不炸。
- **所有到期判定必须走 `effectiveNow()`**，不得直接 `Date.now()`——否则改系统时间就能让过期授权复活。

## 实现思路

### RTL 止血

`src/renderer/src/i18n.ts` 移除 `dir` 翻转、仅保留 `lang` 同步，并清掉随之成为死代码的 `isRtl()`。原因：全项目零 RTL 适配（Tailwind `rtl:` 0 处、CSS 逻辑属性 0 处），容器翻转会让两套规则打架。完整适配的前置条件已写在注释里。

### 分类 i18n 与命名空间合并

把重叠的 `platformCategory` / `mcpCategory` / `skillCategory` 合并为单一 `category`（并集 76 键，27 键重复、14 键译文分歧，逐键选优）；下拉（`useStoreFacets`）与四处卡片/详情页统一走同一函数 `localizeCategoryList`，coze / skillhub 这类「只有中文名」的源经 `lib/categoryAlias.ts` 先转 slug 再查 i18n。各 adapter 的字段形态（实测）：

| 平台 | `categories` | `categoryNames`/`categoryName` | 取用策略 |
| --- | --- | --- | --- |
| bailian / modelscope / npm | slug ✓ | 中文 | slug → i18n |
| clawhub | slug ✓ | 无 | slug → i18n |
| coze | 无（`extra.categories` 为中文） | 中文单数 | 别名表 → slug → i18n |
| skillhub | 无 | 中文单数 | 别名表 → slug → i18n |
| skillsmp | 无分类字段 | — | 不在本批范围 |

取舍：别名映射放在显示层而非改 id（改 id 会破坏分类过滤）；modelscope 的 `Knowledge&Memory` 与 `knowledge-and-memory` 实测是不同分类（591 条 vs 1 条），不做归一化去重。

### 激活契约对齐与入口两分

- **契约**：响应外层按服务端统一壳解析 `$.data.*` 并保留扁平回退；SKU 改为配置驱动 `acceptedSkus`；新增 `skuFeatures`（SKU → 客户端 gate 键，与身为「营销文案」的 `feat` 解耦）。服务端零改动。
- **入口**：`ActivationModal` 的 Mode 扩为 `choose|redeem|offline`，在线/离线/兑换三入口并列；离线页从兑换表单里迁出（原先被埋在两级之下）；试用态「去激活」（对试用是空操作）换成「立即激活」；已激活态的「去激活」加二次确认，取消不产生任何调用。
- **地址**：`checkoutUrlTemplate` / `redeemApiUrl` 两字段收敛为单一 **`serviceBaseUrl`**（+ 服务端契约常量路径），跳收银台与兑换恒定同源；默认指向本地 `http://localhost:8000`，上线由包外 `license.config.json` 覆盖为生产域名，无需发版。
- 三个决策点（三入口结构 / 兑换地址一并指 localhost / 试用态换按钮）系提问未获回复后按推荐默认执行，已呈报，**可随时翻转**。

### 订阅到期策略与付费态单调时钟（C7）

到期自动失效本来就成立：`feature-gate.assertFeature()` 每次调用实时全量验签、不缓存结论，令牌过期即刻拦下一次付费功能调用。**缺口**是付费态没有自己的时间下界——付费激活时 `getState()` 走早期返回不推进 trial 水印，而 redeem 的 `serverTime` 只抬高**试用**下界，于是过期后把系统时间调回过去就能复活。

做法：`LicenseVault` 新增**可选**字段 `watermark` / `server_time_floor`（旧 vault 免迁移），`trial.ts` 的 `effectiveNow(trial, nowMs, extraFloorMs?)` 多并一路，新增 `licenseFloor()` / `raiseLicenseWatermark()`（只增不减、60s 步进节流，避免每次 IPC 复算重写 vault）/ `raiseLicenseServerFloor()`；`getState()` 付费分支与硬件宽限分支都带付费下界（**不论验签成败**都推进水印），`applySignedToken()` 落盘前判定同口径并把 `serverTime` 下界扩到付费账本，gate 只读不写以保持亚毫秒。

**边界（必须知道）**：这两路只能挡「过期之后才回拨」。用户若在过期前就调表、且中间从未联网/从未查询过状态，客户端拿不到可信时间，判断不出来——彻底堵死只能靠周期性联网复核（已被产品口径排除）。门禁证据：`src/__tests__/license-clock-rollback.test.ts`（5 用例），并做过**负向对照**（改回两参 `effectiveNow` → 2 条如期失败）。

### 俄/日/阿残缺文案补齐（2026-09-20）

按实测扫描（比对 en 与各语言直出相同的键）锁定 16 条真遗漏，三语言各补齐：`mcpSource` / `skillSource` 的 `scope` / `expiry` / `noExpiry` / `revoked` / `normal`（真实用在 `SourceManager.tsx` 的令牌元信息行与 `<option>` 后缀），加 `inspector.keyPlaceholder` / `valuePlaceholder` / `headerNamePlaceholder`、`addServer.displayNamePlaceholder`、`settings.enterClientName`、`platformCustom`。

**剩余 10 条保持英文是有意为之**，勿"顺手"翻：`HTTP` / `SSE` / `Streamable HTTP` / `URL`（技术专有名词）、`argumentsPlaceholder` / `urlPlaceholder`（照抄的命令与地址示例）、`smithery`（品牌名）、`aboutDesc` / `aboutCopyright`（产品名+版本+版权文本）、`settings.english`（语言名按母语写法，与 `chinese` 一致的处理）。另注：de/fr/it/es 与英文相同的键（de 81 / fr 58 / it 51 / es 38）抽样看多为品牌名、技术术语与同源词（如 `Backend` / `Design` / `Finance`），**未发现成片漏译**，不在本轮处理。校验：9 语言 key 与 en 完全对齐（缺 0 多 0）。

### 授权链路离线端到端冒烟（2026-09-20）

`src/__tests__/license-e2e-offline.test.ts`：用**测试进程现生成的临时私钥**全流程跑一遍——全新环境进试用（gate 全量放行）→ 导入令牌激活（权益解锁、licenseKey 脱敏）→ 伪造签名被拒且对外只有统一文案 `license.errors.generic`（返回值里不含任何 `LIC_` 内部码）→ 过期令牌被拒 → 换机器码判 `machine_mismatch` 且 gate 关闭 → `killSwitch` 止血放行 → 开关复位、机器还原后授权自动回来 → 去激活回到试用且试用起点没被这次折腾改写。

踩到的两个点：① `vi.hoisted` 的工厂**先于**模块级常量求值，mock 初始值必须写字面量；② 过期判定有 **2 小时时钟容差**，测"过期"要给足超过容差的时间戳，否则测的是容差内放行。

**没覆盖**：真实 `fetchRedeem` 链路（`$.data.*` 响应壳、`serverTime`、真实私钥），那部分仍需真实后端——已降到下方登记表。

## 登记表（阻塞中，不占待办）

| 项 | 阻塞原因 | 备注 |
| --- | --- | --- |
| C5 按软门控接入 updater | 项目暂无更新链路，无处写代码；且服务端当前未真正下发这两个 claim | 口径已定：只挡新版本更新，不阻断运行 |
| 端到端冒烟（真实后端） | 缺后端可用实例与真实 Ed25519 测试私钥 | 离线版已覆盖除 `fetchRedeem` 外的全部环节 |
| 打包产物运行时验证 | 本机无图形界面，需人工双击 `release_verify/win-unpacked/AI-Tools.exe` | 打包**链路**已验通过，待验的是运行时读取 `resources/license/` |

## TODOS

- [ ] **C8 试用防重置上限（P2，需跨仓库决策 + 服务端开发）**：当前两处首跑账本在客户端看来可被"删档重来"骗过；彻底封死需服务端记住机器码的首次 redeem/试用时间。等川哥决定何时推、`billing-license-service` 何时配合。
- [ ] **T-RTL 完整阿拉伯语适配（可选，等决策）**：要做得先完成全站方向性样式适配（Tailwind `rtl:` / CSS 逻辑属性 / 图标镜像 / 绝对定位与滚动条），30+ 组件。川哥若确定不做，本条直接清掉。
