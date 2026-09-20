# plan-2.7 · 授权体系 R1-R5 修复执行（承 plan-2.6）

> 版本：v2.7（2026-09-20 晨）· 唯一活动 plan（ai-tools）。前序 plan-2.6 为「仅列项」审查清单；川哥 2026-09-20 指示「针对 plan 下的任务进行处理，后续问题按最推荐方式先处理」→ 转入执行模式。plan-2.6 已清理（未完成项全部结转至此）。
> 另：`.zcode/plans/` 会话 plan（百炼 MCP 详情修复）经代码核实已完成（resolver 委派 + 外链收敛 + 测试 75 项全过），已直接清理。

## 背景与目标
- plan-2.6 审查发现 R1-R5 五项真实缺口（MEDIUM×3 / LOW×2），本版全部实施修复并交付。
- 交付口径：代码修改 + 定向/全量测试 + typecheck 通过后提交推送（川哥明确要求代为提交推送）。

## 范围与边界
- **做**：R1-R5 修复 + 回归测试；渲染层 Settings 更新态适配；两处共享常量扩展。
- **暂不做**：真实后端端到端冒烟 / 打包产物 GUI 验证（仍需真实环境，留登记表）；i18n 新增文案（R3 锁定文案沿用主进程既有 zh 直出模式，与 updater 现有状态文案同口径）。
- **硬边界**：不引入新原生依赖；不改 vault 结构与契约；Flyway/服务端无涉（本仓无服务端改动）。

## 实现思路与决策记录（按「最推荐方式」拍板）
- **R1 fail-closed**（`feature-gate.ts`）：未登记权益键一律拒绝并记 `gate_unregistered` 日志（原为放行）；`pro` 全量权益键走「令牌有效性」路径（`requiredFeature=null`，任意被接受 SKU 即全量）；测试遍历 `shared/license-constants` 全部 `FEATURE_*` 导出，断言每个键 = proFeature / ∈ gated / 有 provider 派生，新增付费常量漏配将在测试期暴露。
- **R5 权益模型统一**：新增共享 `FEATURE_PROVIDERS`（`remote_connect → cloud_sync`，依据 2026-09-17 拍板「SSH/SFTP 是云同步 provider、合并计费」）；主进程 gate 与渲染层 `activationStore.hasFeature` 共用同一派生表；`activatedState.features` 前置 `FEATURE_PRO`（与试用态「pro=全量」口径一致，修「已激活不含 pro 键」的不一致）。
- **R2 vault 外高水位锚定**：客户端激活后与服务器零接触（仅 redeem + 试用首见探测），服务端 last-seen 无法触达已签发令牌 → 取「vault 之外锚定」方向：新增 `license/anchor.ts`，`~/.ai-tools/license-anchor.json` 独立文件记录付费态高水位（与 vault 不同文件，备份还原 vault 不还原锚文件即失效）；`getState` / `assertFeature` / `applySignedToken` 三处把锚下界并入 `effectiveNow` 的 max 链；只增不减、60s 步进节流、写失败仅记日志。
- **R3 软门控**：新增 `license/update-gate.ts` 纯函数 `evaluateUpdateEntitlement`（`update_until` 过秒 → 拒；新版本 major > `max_major_version` → 拒；字段缺失 = 不限；payload 为 null = 放行——合同只对订阅令牌成立）；`updater.ts` 在 `update-available` 与 `downloadUpdate` 前置判定，新增更新态 `locked`，渲染层 Settings 复用 error/unsupported 分支展示 `update.message`。
- **R4 first_seen_at 下界**：`applyMachineFirstSeen` 增合理性窗 `MACHINE_FIRST_SEEN_MAX_AGE_MS = 2 年`——早于「now-2y」的值视为异常（epoch/0/负值），按「探测无效」处理（不改账本、下次启动重试自愈）。**与 plan-2.6 建议（试用窗 60d）的偏差**：60d 窗会拒收「200 天前来过」的合法回溯、令 C8 既有行为与测试失效；2 年窗既拒绝对异常值又不误伤真实长跨度部署。
- **测试**：新增 `license-feature-gate.test.ts`（R1+R5）、`license-anchor.test.ts`（R2 含「还原旧 vault+回拨仍判过期」端到端）、`license-update-gate.test.ts`（R3）；`license-trial-anti-reset.test.ts` 补 R4 异常值用例。

## 风险与回滚
- fail-closed 误伤：凡渲染层实际查询的权益键均已登记（cloud_sync）；若线上发现误锁，包外配置 `features.gated` 补键即恢复（无需发版）。
- 锚文件被整目录备份还原的残余风险已在 anchor.ts 头注释声明（本地锚定的理论上限；彻底防御需服务端在线锚，当前客户端无在线通道）。

## 登记表（阻塞/待用户侧，不占 TODOS）
- 真实后端端到端冒烟（fetchRedeem 真实私钥链路）、打包产物运行时验证——同 plan-2.5/2.6 登记表，需真实后端实例 + GUI。

## TODOS（仅未完成）
- [ ] R1+R5：共享常量 `FEATURE_PROVIDERS` + feature-gate fail-closed/pro 路径/provider 归一 + activatedState 含 pro 键 + 渲染层 hasFeature 派生
- [ ] R2：`anchor.ts` + `getState`/`assertFeature`/`applySignedToken` 并入锚下界
- [ ] R3：`update-gate.ts` + updater `locked` 态 + Settings 适配
- [ ] R4：`applyMachineFirstSeen` 合理性窗
- [ ] 测试：新增 3 份 + anti-reset 补用例，全量 vitest + typecheck 通过
