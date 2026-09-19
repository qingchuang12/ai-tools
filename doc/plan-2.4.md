# plan-2.4 · 阿拉伯语 RTL 止血 + 商店平台分类 i18n + 激活契约对齐 + 激活入口两分与本地默认地址 + 付费态单调时钟

## 背景与目标

> **追加主题（2026-09-19 · 付费态单调时钟 + C5/C7 拍板）**：川哥拍板订阅口径——**到期后本地自动失效、不做周期性在线复核、续期必须联网**。据此核查 `src/main/license`，发现唯一缺口是**付费态没有自己的时间下界**：付费激活时 `getState()` 走早期返回不推进 trial 水印，redeem 的 `serverTime` 只抬高试用下界 → 订阅物理过期后把系统时间调回过去即可复活（云同步等 gate 一并放行）。修复＝付费账本自带单调时钟（`watermark` + `server_time_floor`），与试用并入同一个 `effectiveNow()`。同日 C5 拍板：`update_until` / `max_major_version` 走**软门控**（超范围仍可用旧版，只挡新版本更新），不硬阻断运行。

> **追加主题（2026-09-18 · 激活契约对齐）**：客户端 `ai-tools@bd47ada` 与服务端 `billing-license-service@bbdd7ef` 逐字段比对，发现**兑换（激活）链路端到端走不通**——6 处硬不兼容：① 响应外层（客户端读 `$.signedToken`，实际在 `$.data.signedToken`）；② 入参（服务端 E1–E5 后要 `customerEmail`，客户端仍发 `customerId:''`）；③ SKU 词表（客户端 `AI-TOOLS-PRO` vs 产品表 `pro-buyout` 等）；④ 权益词表（客户端 `pro|cloud_sync` vs 产品 `OFFLINE|MULTI_DEVICE|…`）；⑤ 缺 `serverTime`；⑥ `update_until`/`max_major_version` 客户端未消费。完整证据与影响见 `billing-license-service/docs/上线准备工作.md` §8；服务端侧条目见该仓 `docs/plan-3.0.md` TODOS-K。
>
> **本轮决策（2026-09-18，用户指令「修复激活逻辑完整性」后按已呈报的推荐方案执行）**：
> 1. **响应外层**：改客户端——按服务端统一壳解析 `$.data.*`，并保留扁平回退（旧服务端/自签 token 不受影响）。理由：服务端统一壳是全体端点的一致约定，为单个端点开洞会破坏一致性。
> 2. **SKU 词表**：改客户端→**配置驱动**：新增 `acceptedSkus`（本产品接受的 SKU 列表，默认 = 服务端四个种子 SKU）。理由：SKU 是服务端可扩展的业务数据（新档位只需改包外 `license.config.json`，不必发版）。
> 3. **权益词表**：新增 `skuFeatures`（SKU → 客户端权益键），与 `acceptedSkus` 解耦（可接受某 SKU 但不解锁功能）。理由：服务端 `feat` 是**营销权益文案**（OFFLINE/MULTI_DEVICE/…），客户端 gate 键是**功能开关**，两者语义不同，不应改服务端种子去迎合客户端（那需要 V12 迁移且把营销词绑定到 gate）。原始 `feat` 仍并入生效权益（展示 + 未来若服务端直接下发 gate 键即生效）。
> 4. **不改服务端 SKU/种子/响应壳**，避免 Flyway 迁移与全体端点契约变更。


用户反馈两个问题（2026-09-18）：

1. **切换阿拉伯语后排版整体错乱**。根因已定位：`src/renderer/src/i18n.ts:29-41` 在 `ar` 时执行 `document.documentElement.dir = 'rtl'`，但全项目**零 RTL 适配**（实测：Tailwind `rtl:` 变体 0 处、CSS 逻辑属性 0 处、`tailwind.config.cjs` 无 rtl 配置），导致容器翻转而内部间距/圆角/绝对定位/图标方向不跟随，两套规则打架。→ **用户决策：关闭翻转**。
2. **商店各数据源的分类未国际化**。实测缺口 185 类：
   - 显示面 ①（过滤下拉）：`useStoreFacets.ts` 的 `translateCategoryTree` 查不到分类 key 时**回退后端中文名**。
   - 显示面 ②（卡片 tag / 详情页）：`ServerCard.tsx`、`PlatformServerDetail.tsx` 直接用主进程透出的中文 `categoryNames`，**完全未走 i18n**。
   - → **用户决策：分两批**，先补 5 个中小平台共 60 类（×9 语言）；modelscope MCP + skillsmp 作第二批。显示面 ② 一并修。
   - → **追加决策（同日）**：分类译文原有 `skillCategory` / `mcpCategory` / `platformCategory` **三个命名空间职责重叠**（并集 76 键、27 键重复、14 键译文分歧），**合并为单一 `category` 命名空间**，冲突键逐键选优。

> **当前状态（2026-09-18）**：RTL 止血、两批分类 i18n、激活契约对齐三项均已交付并通过门禁（`tsc --noEmit` exit 0；`vitest run` 34 文件 / 500 用例全绿）。未完成条目见文末 TODOS。

> **追加主题（2026-09-19 · 激活入口两分与本地默认地址）**：用户新需求两条——① ai-tools 支持在线激活与离线激活；② 点击在线激活的跳转地址可配置，默认指向 billing-license-service 本地地址 `http://localhost:8000`。现状核查：兑换码（在线）与导入 `.lic`/粘贴令牌（离线）能力均已存在（`main/license/index.ts` 的 redeem / importLicenseFile / importLicenseText），但入口未按「在线/离线」两分（离线导入藏在兑换表单内）；跳转地址已有三层可覆盖配置位 `checkoutUrlTemplate`（包外 license.config.json → asar 内置 → 代码默认），仅需改默认值。另发现既有缺陷：试用态「去激活」按钮实调 deactivate（对试用为空操作）且无激活入口。
> **三个决策点提问未获回复，按推荐默认执行（待确认，用户可随时翻转）**：① 选择页三入口并列（在线激活/离线激活/兑换激活码），兑换表单移除导入入口；② `redeemApiUrl` 默认一并指向 `http://localhost:8000`（本地联调同源；上线由包外配置覆盖为生产域名）；③ 试用态以「立即激活」替换空操作「去激活」。

## 范围与边界

**做**：关闭 RTL 翻转；补 60 个平台分类 key ×9 语言；新增中文名→slug 别名映射；下拉 + 服务器卡片 + 技能卡片 + 两个详情页四处显示统一走 i18n；**合并 `skillCategory`/`mcpCategory`/`platformCategory` 为单一 `category`**；验证门禁。

**暂不做**：完整 RTL 适配（30+ 组件，另立专项）；第二批大平台分类翻译（modelscope MCP + skillsmp）；无数据分类的 `count=0` 过滤优化（待第二批一并评估）。

**硬约束**：
- 分类 id / 查询传值**一律不变**（尤其 coze 的分类 id 是传给其 API 的过滤参数，注释已明确「分类 id 本就是中文名」）。
- 仅改显示层。
- 新增 key 一律 **9 语言同步**（项目惯例）。
- locale 文件 **CRLF** 行尾必须保持。

**做（2026-09-19 追加 · 激活入口两分）**：默认地址三处改为 `http://localhost:8000` 前缀（constants.ts 代码默认 / asar 种子 license.config.json / dist 镜像）；`ActivationModal.tsx` 选择页三入口、新增离线激活页（文件/粘贴）、兑换表单瘦身、试用态「立即激活」；4 个新 i18n key ×9 语言（保持 CRLF）；门禁验证。

**暂不做**：billing-license-service 服务端改动（收银台页已满足跳转承接，带 machineId 支付后直接发令牌）；deep-link 回跳 / 内嵌 webview；在线复核（C7）/ 版本门槛（C5）/ 试用防重置（C8）。

## 实现思路

### 触点与步骤

1. **RTL 止血**（`src/renderer/src/i18n.ts`）：移除 `dir` 翻转，仅保留 `lang` 同步；`isRtl()` 一并清理（避免死代码）。保留 `applyDocumentLanguage` 导出以不破坏调用点。
2. **分类 key 清单化**：全部统一挂**单一 `category.*` 命名空间**（由原 `platformCategory` / `mcpCategory` / `skillCategory` 三命名空间并集而来，76 键；重叠 27 键、冲突 14 键逐键选优）。清单：
   - 百炼 8：`CORPORATE_SERVICE` / `LIFE_SERVICE` / `DATA_SEARCH` / `DEVELOPER_TOOL` / `CONTENT_GENERATION` / `CLOUD_NATIVE` / `SEARCH_TOOL` / `UNCLASSIFIED`
   - coze 8：id 为中文，需走别名映射（见 3）
   - clawhub 9：`integrations` / `automation` / `research` / `communication` / `creative` / `knowledge` / `agents` / `operations` / `lifestyle`
   - skillhub 12：`pay-skill` / `office-efficiency` / `content-creation` / `dev-programming` / `data-analysis` / `design-media` / `ai-agent` / `knowledge-management` / `business-ops` / `professional` / `it-ops-security` / `life-service`
   - modelscope Skill 7：`mobile-development` / `content-strategy` / `analytics` / `skill-creation` / `ui-ux-design` / `general-tools` / `api-design`
   - npm 6：`devtools` / `database` / `web-search` / `system` / `office` / `mcp`（本就在 `mcpCategory` 内，合并后自动归入 `category`）
3. **中文名 → slug 别名映射**（新建共享模块 `lib/categoryAlias.ts`，供下拉与卡片共用）：覆盖形态为「仅中文名，无 slug」的 adapter——coze 8 项、skillhub 13 项。映射目标**优先复用已有 slug**（如 数据分析→`data-analysis`、其他→`other`、学习教育→`education`），避免重复造键。
4. **下拉接入**（`useStoreFacets.ts`）：`translateCategoryTree` 增加别名映射前置解析——先 `category.<id>`，未命中则用别名表把中文 id 转 slug 再查，最后才回退 `c.name`。
5. **卡片 tag / 详情页接入**：
   - `ServerCard.tsx`：优先 `categories`(slug) → `category.<slug>`；回退 `categoryNames`/`categoryName`（中文）→ 别名表转 slug → 翻译；再回退原文。
   - `SkillCard.tsx` / `SkillDetail.tsx`：同一策略。
   - `PlatformServerDetail.tsx`：同一策略（**四处复用同一取用函数 `localizeCategoryList`，不重复实现**）。
6. **验证**：9 语言 JSON 可解析 + key 对齐 + 「全部平台分类在 zh locale 命中」+ `tsc --noEmit` exit 0 + CRLF 保持 + 旧命名空间零残留。

### 三种 adapter 字段形态（实测）

| 平台 | `categories` | `categoryNames`/`categoryName` | 卡片取用策略 |
| --- | --- | --- | --- |
| bailian / modelscope / npm | slug ✓ | 中文 | slug → i18n |
| clawhub | slug ✓ | 无 | slug → i18n |
| coze | 无（`extra.categories` 为中文） | `categoryName` 中文单数 | 别名表 → slug → i18n |
| skillhub | 无 | `categoryName` 中文单数 | 别名表 → slug → i18n |
| skillsmp | 列表项无分类字段 | — | 不在本批范围 |

### 取舍与风险

- **不引入 `rtl:` 适配**：用户已明确关闭翻转，避免半成品功能继续误导。
- **别名映射而非改 id**：coze id 是 API 过滤参数，改动会破坏分类过滤（违反既有注释结论），故只在显示层加映射。
- **命名空间合并而非保留三份**：三命名空间并集 76 键、27 键重复、14 键译文分歧，保留会造成「同一分类不同命名空间译文不一致」的隐性 bug；合并为 `category` 后查找路径唯一。冲突键逐键选优（如 `all→全部`、`design→Design`、`productivity→效率工具`、`finance→金融`、`lifestyle→更本地化`）。**分类 id / 查询传值照旧不变**，合并不触及该约束。
- **modelscope 的 `Knowledge&Memory` 与 `knowledge-and-memory` 不合并**：`modelscope.ts:188` 开发者注释已实测确认二者是不同分类（591 条 vs 1 条），非大小写变体，不做「归一化去重」。
- **回滚**：改动集中在 1 个 i18n 配置文件 + 9 个 locale + 4 个渲染层文件（`ServerCard` / `SkillCard` / `SkillDetail` / `PlatformServerDetail`）+ 1 个 hooks（`useStoreFacets`）+ 1 个新建共享模块（`lib/categoryAlias.ts`），均可按文件级 revert。

### 激活入口两分与本地默认地址（2026-09-19 完成）

- **默认地址（D1）**：`constants.ts`（代码默认）、asar 种子 `src/main/license/assets/license.config.json`、dev 实读镜像 `dist/main/license/assets/license.config.json` 三处同值——`checkoutUrlTemplate = http://localhost:8000/checkout/index.html?machineId={machineId}`（服务根路径无页面，收银台托管于 `/checkout/`）、`redeemApiUrl = http://localhost:8000/api/redeem/redeem`（与跳转同源，本地联调一致）。**本项取代了 C4 写入的 `https://billing.ywhome.top/...` 默认值**；上线前由包外 `license.config.json` 覆盖为生产域名，无需发版。
- **弹窗结构（D2，`ActivationModal.tsx`）**：`Mode` 扩为 `choose|redeem|offline`；choose 页三入口——在线激活（`getPurchaseUrl` → `openExternal` 跳系统浏览器，成功后 choose 页内展示 `openedOnlineHint` 引导「支付完回到此处粘贴令牌或输入兑换码」）、离线激活（转 offline 页）、兑换激活码（转 redeem 页）；offline 页承接「导入许可证文件 + 粘贴令牌文本」（复用既有 `doImportFile`/`doImportText`，自兑换表单迁出，修复了离线入口被埋两级的问题）；redeem 页仅留邮箱+码。试用态引入 `activating` 局部态：「立即激活」进入 choose（激活流程页对 inactive 与 trial-activating 共用，choose 底部对 trial 显示「返回」），**删除了原空操作「去激活」按钮**（实调 deactivate，对试用为 no-op）；已激活态不动。新增 i18n key 4 个 ×9 语言：`modal.onlineActivation` / `modal.offlineActivation` / `modal.activateNow` / `modal.openedOnlineHint`（术语逐语言对齐既有「激活/兑换」译法；locale 保持 CRLF），并移除因改名孤儿化的 `modal.purchase`（×9）。
- **服务地址统一（2026-09-19 追加）**：用户新指令「在线激活、离线激活、兑换码激活请求后台服务的地址统一设置，url 和 billing-license-service 要对应起来」。配置收敛为单一 **`serviceBaseUrl`**（origin，结尾 `/` 由 mergeConfig 归一剥除）：收银台页 = `serviceBaseUrl + CHECKOUT_PAGE_PATH`（`/checkout/index.html`）、兑换 API = `serviceBaseUrl + REDEEM_API_PATH`（`/api/redeem/redeem`），两个路径是服务端契约常量（`constants.ts`），machineId 由 `buildCheckoutUrl()` 直接拼接（不再走 `{machineId}` 模板占位）。原 `checkoutUrlTemplate` / `redeemApiUrl` 两字段整体移除（产品未发布、无存量包外配置，不留兼容层），改点：`types.ts` / `constants.ts` / `config.ts` / `redeem.ts` / 两份 `license.config.json` / 4 个测试 fixture（均无 URL 断言）。说明：**离线激活不发任何网络请求**（导入文件/令牌后本地 Ed25519 验签落盘），其凭证本就产自 billing-license-service（收银台页发放或后台签发），故无地址可配——统一后实际收敛的是「跳转 + 兑换」两处，且二者恒定同源。门禁复跑：typecheck exit 0；vitest 35 文件 / 525 用例全绿。
- **去激活二次确认（2026-09-19 追加，用户指令）**：已激活视图的「去激活」按钮改为行内二次确认——点击先展示红色警示文案（去激活后授权立即失效、付费功能停止、需重新激活），**确认**才调 `deactivate()`，**取消/关闭弹窗均不产生任何调用、已激活状态原样保留**（`confirmingDeactivate` 局部态，弹窗重开时复位）。新增 i18n key 3 个 ×9 语言：`modal.deactivateConfirm` / `modal.confirmDeactivate` / `modal.cancel`（术语对齐各语言既有「去激活/Deactivate」译法，locale 保持 CRLF）。typecheck exit 0；vitest 35 文件 / 525 用例全绿。
- **源管理样式归一 + 移除「内置」徽标（2026-09-19 追加，用户指令）**：设置页 MCP 源管理与 Skill 源管理（`McpSourceManager`/`ConnectionManager` 共用通用组件 `SourceManager`）的「未绑定令牌（公开访问不携带鉴权）」此前配色不同（MCP 默认灰 `--color-muted2`，Skill 传橙 `#ff9f0a`）——统一为默认灰（该状态是「公开访问无需鉴权」的中性提示，非警告；如需橙色一行可改）。移除两处源列表的「内置」徽标（`badgeOrder` 两种排序随之失去意义）。清理死代码：`noTokenColor`/`badgeOrder` 两个 prop、`isBuiltin` 变量、孤儿 i18n key `mcpSource.builtin`/`skillSource.builtin` ×9 语言；`builtinIds` prop 保留（仍用于「恢复内置源」按钮判断）。文件头注释的差异项清单 10→8 同步更新。typecheck exit 0；vitest 35 文件 / 525 用例全绿。
- **决策点说明**：三入口结构 / redeemApiUrl 一并指向 localhost / 试用态改「立即激活」三项系提问未获回复后按推荐默认执行，已呈报用户，可随时翻转。
- **门禁（D3）**：`pnpm run typecheck` exit 0；`pnpm test` 35 文件 / 525 用例全绿（测试均注入自有配置，默认地址变更不涉既有用例）。billing-license-service 服务端零改动。
- **回滚**：全部改动可按文件级 revert（constants.ts、2 个 license.config.json、ActivationModal.tsx、9 个 locale）。

- **订阅到期策略（2026-09-19 川哥拍板）**：订阅到期后**本地自动失效**，不做周期性在线复核；**续期必须联网**（在线 redeem，或联网取得新令牌后离线导入——凭证本身产自服务端）。代码面原本就符合该策略：`feature-gate.assertFeature()` 每次调用**实时全量验签**（无结论缓存），令牌过期即刻拦下一次 gate 调用，无需重启。
- **付费态单调时钟（C7 落地，两路都上）**：旧实现的两处漏洞是 ① 付费激活时 `getState()` 早期返回，**不推进 trial 水印**；② redeem 的 `serverTime` 只抬高**试用**下界。做法是给付费账本自带一份时间下界，与试用共用一个出口：
  - `types.ts#LicenseVault` 新增可选字段 `watermark` / `server_time_floor`（**可选 = 旧 vault 免迁移**，缺按 null）；`vault.ts#sanitizeLicense` 同步读取。
  - `trial.ts`：`effectiveNow(trial, nowMs, extraFloorMs?)` 新增第三路；新增 `licenseFloor()`（取付费两字段的 max）、`raiseLicenseWatermark()`（只增不减，**步进 60s 节流**，避免每次 IPC 复算都重写 vault）、`raiseLicenseServerFloor()`。
  - `index.ts`：`getState()` 付费分支改用 `effectiveNow(vault.trial, now, licenseFloor(vault.license))`，并**不论验签成败都推进付费水印（软件「见过的最新时间」不能丢）；`applySignedToken()` 落盘前判定同口径，且把 `serverTime` 下界从试用扩到付费账本（沿用上一张授权已有的下界）；硬件宽限分支一并带上付费下界。
  - `feature-gate.ts`：gate 判定同口径（只读，不写 vault，保持亚毫秒）。
  - **诚实的边界**：这两路只能挡「过期之后才回拨」。若用户在过期前就调表且中间从未联网/从未查询过状态，客户端拿不到可信时间，仍判断不出——彻底堵死只能靠周期性联网复核（已被拍板排除）。
  - **验证**：新增 `src/__tests__/license-clock-rollback.test.ts`（5 用例：回拨后仍 expired 且 gate 关闭 / serverTime 下界生效 / 有效期内不受影响 / 两个助手函数）。**负向对照**：临时把 `getState` 与 `feature-gate` 改回两参 `effectiveNow` → 2 条用例如期失败（`expected 'activated' to be 'inactive'`），确认用例真的守得住。门禁：`typecheck` exit 0；`vitest run` **36 文件 / 530 用例全绿**（原 35/525）。
- **C5 口径（2026-09-19 川哥拍板）**：`update_until` / `max_major_version` → **只做更新门控，不硬阻断运行**。即「买到 1.x 的用户已装的照常用，只是装不了 2.0」，避免付费用户被突然踢下线引发差评/退款。当前服务端尚未真正下发这两个 claim，故**代码零改动**；等 updater 接入时按此口径实现（TODOS 保留一行指针）。

## 已完成（2026-09-18 自行执行项）

- **C4 客户端收银台 URL 改指后端内嵌收银台（原 P0 跨仓前端）**：因后端 `billing-license-service` 的 `/checkout/` 收银台页已上线（自托管于 `static/checkout/`），原「在 mian 实现收银台页」方案被取代。客户端 `checkoutUrlTemplate` 由 `https://www.ywhome.top/getlicense?machineId={machineId}` 改为 `https://billing.ywhome.top/checkout/index.html?machineId={machineId}`，与后端页面 URL 及 `machineId` 参数名对齐（后端 `checkout.js:1640/1712` 从 `?machineId=` 读取并绑定设备）。改点 4 处：`src/main/license/constants.ts`（默认值）、`src/main/license/assets/license.config.json`（asar 种子，运行时覆盖默认值）、以及 `dist/main/license/` 下两处镜像（dev 实际读 dist）。测试 fixtures（`example.test/getlicense`）与 `dist/renderer` 旧包为占位/旧构建产物，不动。验收标准见 `billing-license-service/docs/上线准备工作.md` §10-6（现由后端页面承担）。**（2026-09-19 追记：默认地址已被本 plan「激活入口两分」改指本地 `http://localhost:8000`，见实现思路；上线仍由包外配置覆盖为生产域名。）**
- **清理 `scripts/obfuscate-main.mjs` 的 `.pnpm` 通配兜底**：`resolveObfuscator()` 删除遍历 `node_modules/.pnpm` 按 `javascript-obfuscator@*` 定位真实路径的回退分支，仅保留直接依赖 `require('javascript-obfuscator')` + 失败抛错（附原始错误）。依据：`javascript-obfuscator@4.2.2` 已是 `package.json` 显式 devDependency（:67），删除兜底为零行为变化。

## TODOS

> 规则：只留未完成项，已完成项直接移出（不留 `[x]`）；本目录同时只保留一个活动 plan。
> **2026-09-18 清理**：已完成章节（第五/六/八/九/十/十一/十二轮记录）已移出本文件，原文备份见 `D:\ProductSpace\.workbuddy\backups\plan-cleanup-20260918\`；「结转自 plan-2.1」中的未完成项已并入下方，其中已完成的「实跑 `pnpm run package:win`」一并移出。

- [ ] **C5 按软门控接入 updater（P2，等 updater 集成时再做）**：口径已拍板（见实现思路）——超出 `max_major_version` / 越过 `update_until` **只挡新版本更新，不硬阻断运行**；服务端目前未真正下发这两个 claim，故现在没有可改的代码。阻塞原因：项目尚无可消费这两个 claim 的更新链路。
- [ ] **C8 试用防重置上限（P2，待产品/服务端决策）**：试用起点现已下沉到 `main/license/first-run.ts` 的**两处首跑账本**（沿用旧版安装标记路径），vault 被删也能按原起点重建；但**本地无 TEE**，删掉两处账本 + vault 在客户端看来等价于全新安装，无法区分。若要彻底封死，需服务端侧绑定（首次 redeem/试用上报机器码并由服务端记住首跑时间）。

- [ ] **T-RTL（可选后续，非本次范围）**：若将来真要支持阿拉伯语 RTL，须**先完成全站方向性样式适配**（Tailwind `rtl:` 变体 / CSS 逻辑属性 / 图标镜像 / 绝对定位与滚动条），完成后再在 `applyDocumentLanguage` 中开启 `dir` 翻转——该处已留注释说明前置条件。
- [ ] **T8-follow（用户未要求，待定）**：审计中另有 16 个 key 在 ru/ja/ar 直出英文，但均**非分类/排序、亦非 hover**：`mcpSource`/`skillSource` 各 5（`scope`/`expiry`/`noExpiry`/`revoked`/`normal`，实际用在 `SourceManager.tsx:372` 的令牌元信息行内文本与 `:449` 的 `<option>` 标签）、`inspector` 3 + `addServer` 1 + `settings` 1 + `platformCustom` 1（占位符示例文本，是否该译需逐条判断）。另有 2 个属**合法缩写/专有名词**、非遗漏：`category.devops`（9 语言均为 `DevOps`）、`category.ci-cd`（9 语言均为 `CI/CD`）。

### 结转自 plan-2.1（与本次无关，勿丢）

- [ ] **端到端冒烟**（测试 Ed25519 私钥签 token → 兑换/导入 → 云同步解锁；换机器码 → 拒绝；改签名 → 统一文案；`killSwitch:true` → 全放行）。依赖后端/测试私钥。
- [ ] **打包产物运行时验证**：启动 `release_verify/win-unpacked/AI-Tools.exe` 做混淆后主进程冒烟，并验证 `resources/license/` 资产被正确读取（打包链路已验证，运行时读取未验）。
