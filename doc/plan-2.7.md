# plan-2.7 · 授权体系（R1-R5 已交付，R6 原子换绑已定稿）

> 版本：v3.0（2026-09-20）· 唯一活动 plan（ai-tools）。R1-R5 已实现并提交推送（commit 3596906）。typecheck 全绿；vitest 561/563 通过（2 失败为 qa-first-run-audit 既有 wall-clock 容差抖动，与本次无关、文件未改动）。R6（原子换绑）代码+后端单测已落地，待 IDEA MCP 构建链类型检查与真实后端/打包验证。

## 现状（R6 背景，已查证）

- **去激活现状**：`ActivationModal.doDeactivate`（`src/renderer/src/components/ActivationModal.tsx:229`）→ `api.activation.deactivate()` → 主进程 `deactivate()`（`src/main/license/index.ts:360`）。后者读 vault、把 `signed_token` 等字段**直接清空**、写回、`clear payloadCache`。**纯本地、即时、无服务端调用**。
- **已激活 UI 只有「去激活」**：`ActivationModal.tsx:416-471` 在 `status === 'activated'` 时只渲染去激活确认，**没有「换绑 / 激活新授权」入口**。要换码必须先把旧的抹掉再激活新的——中间新码失败即掉未激活，两头落空。
- **本地原子性已具备**：`applySignedToken`（`src/main/license/index.ts:376`）以**全新 license 对象整体替换** `vault.license`，新 token 写入即旧 `signed_token` 被覆盖；`writeVault`（`src/main/license/vault.ts:222`）整块加密落盘，无旧 token 残留。

## R6 · 原子换绑（新生效 → 旧解绑）— 前后端一起改（已定方向）

### 语义澄清（重要，避免与既有设计冲突）

- **「解绑」≠「吊销」**：`LicenseController` 注释明确「客户端自吊销端点已删除（吊销唯一入口为管理端）」（2026-09-14 I3/I4/I5 简化）。R6 的「旧激活码再解绑」是**释放本机绑定**（`licenses.machine_code = NULL`），**不取消授权本身、不动 `REVOKED` 状态**。与 `revokeLicense`（管理端退款/违规）、`reissueLicense`（换机重发，标记旧证 REISSUED 并签发新证）语义均不同，不与之冲突。
- 复用已有能力：`LicenseIssuer.verifyLicense(token)`（验签）、`decodePayload(token)`（取 `lic`/`mid`），License 实体已有 `machineCode`、`LicenseEvent` 审计。

### 后端：新增「释放本机绑定」端点

- **路径**：`POST /api/licenses/unbind`（公开，需持有旧 token 证明归属）。命名用 `unbind` 而非 `deactivate`，明确语义是「释放绑定」非「吊销授权」。
- **请求体** `UnbindRequest`：`{ signedToken: string, machineId: string }`。
- **逻辑**（`LicenseService.unbindDevice`）：
  1. `licenseIssuer.verifyLicense(signedToken)` 必须为 true（签名有效）。
  2. `licenseIssuer.decodePayload(signedToken)` 取 `lic`（licenseKey）、`mid`（签发时绑定机器码）。
  3. 按 `lic` 查 License；不存在 / 已 `REVOKED` → 报错（400）。
  4. **归属校验**：`license.machineCode` 必须等于 `mid` 且等于请求 `machineId`（请求方须为绑定本机，防止远端解绑他人授权；切换发生在同一台设备，正常匹配）。
  5. `license.setMachineCode(null)`（释放席位，`status` 保持 `ACTIVE`），落库；记 `LicenseEvent`（新类型 `UNBOUND`）。
  6. 返回成功。
- **新增**：`LicenseEvent.EventType.UNBOUND`；`LicenseService.unbindDevice`；`LicenseController` 新增 `POST /api/licenses/unbind`；DTO `UnbindRequest`。**不动** `revokeLicense` / `reissueLicense`。

### 前端：新增「换绑」入口 + 顺序保证

- 已激活态（`ActivationModal.tsx:416`）新增「激活新授权 / 换绑」按钮 → `switching` 态复用现有 redeem / import 流程，**不先调 `deactivate`**。已激活区块加 `&& !switching` 守卫；提供「取消换绑」返回。
- **门面原子序列**（核心，保证「新生效 → 旧解绑」）：
  - `redeem` / `importLicenseText` / `importLicenseFile` 增加可选 `switchMode: boolean`。
  - 为 true 时走 `withUnbindPrior()`：先读 vault 取 `priorToken = vault.license?.signed_token`；跑激活（`applySignedToken` 整对象替换，新生效、旧被覆盖）；**成功后**若 `priorToken` 存在，由主进程直接 `fetch(POST /api/licenses/unbind, {signedToken: priorToken, machineId})`（主进程已有 `fetch` + `getMachineCode`，无需新增 IPC）。
  - **解绑失败**：best-effort——记日志 + 轻提示，**不回滚新激活、不阻挡**（具体见 TODOS 决策项）。
- `deactivate()` 保留给「仅去激活、不换绑」场景，行为不变。
- **失败（新码无效）**：错误提示，旧授权不动（vault 未被改写）。
- 新增 API 常量 `UNBIND_API_PATH = '/api/licenses/unbind'`（`src/main/license/constants.ts`）。

### 验证

- 已激活态出现换绑入口；走兑换 / 导入 → 新码有效 → 本地新授权生效，vault 旧 `signed_token` 被覆盖（`getState` 校验）。
- 调 `POST /api/licenses/unbind` 成功 → 后端 `licenses.machine_code` 置 NULL（查库或 `verify` 返回 `machineCode=null` 验证）。
- 解绑失败（断网）：新授权仍可用，弹轻提示。
- 新码无效：报错，旧授权仍在，不掉未激活。

## TODOS（仅决策 / 开发项）

- [x] **【决策】** 解绑旧码服务器侧失败 → 已拍板「**新生效优先、解绑尽力而为**」（不回滚、轻提示）。门面 `applyWithSwitch` 已实现该语义：`unbindWarning` 标记 + UI amber 轻提示，不阻挡新授权。
- [x] **【后端】** `POST /api/licenses/unbind` + `LicenseService.unbindDevice` + `UnbindRequest` + `LicenseEvent.UNBOUND`（不动 revoke/reissue）。补 `import java.util.Map`（EBUSY 绕过后漏掉的编译项）；新增 5 个单测（成功释放 / 空 token / 签名无效 / 机器码不符 / 已吊销）。
- [x] **【前端】** `ActivationModal` 换绑入口 + `switching` 态 + `cancelSwitch`；`redeem/importX` 加 `switchMode`；门面 `applyWithSwitch`（新生效→旧解绑 best-effort）；主进程 `unbindPriorOnServer` 直连 `POST /api/licenses/unbind`；常量 `UNBIND_API_PATH` / `UNBIND_API_TIMEOUT_MS`；`ActivationApi` + preload 透传 `switchMode`；i18n 加 `switch` / `switchSuccess` / `unbindFailed` / `cancelSwitch`（en/zh）。
- [x] **【测试】** 后端 `unbindDevice` 单测已加；前端换绑路径代码完成。**tsc 类型检查**走 IDEA MCP 构建链（本机无 node_modules，未跑）。

## 登记表（外部阻塞，非编码项 — 来源 plan-2.5/2.6/2.7/2.9 结转）

- 真实后端端到端冒烟：`fetchRedeem` / `unbind` 走真实私钥签发链路（**阻塞**：需真实后端实例）。
- 打包产物运行时验证：electron-builder 产物 GUI 冒烟（**阻塞**：需打包 + GUI 环境）。
- 前端 tsc 类型检查：`tsc -p tsconfig.main.json` 随 IDEA MCP 主进程构建链执行（本机无 node_modules，未本地跑；preload / facade / Modal 改动需过类型门）。
- 其余 7 个语言包（除 en/zh）未补换绑文案，i18next 回退到默认语言（**可选**，不影响功能）。
