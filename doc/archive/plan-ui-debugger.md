## 来源 `plan-ui-debugger.md`（原 plan-21.0.md） · plan-21.0 · 调试器页激活状态 + JSON 折叠

## 背景与目标
调试器（MCP Inspector）连接运行结果区当前用 `react-syntax-highlighter` 渲染 JSON，纯高亮、不支持节点折叠、数据量大时难查看。
本任务在调试器页**左上角**落地「激活状态」指示器（未激活/试用中/已激活）与配套弹窗，并把结果区改为支持**节点折叠**的 JSON 树 + 保留文本视图。

## 范围与边界（做/暂不做）
做：
- 应用级激活状态（主进程持久化 `~/.ai-tools/activation.json`，全局共享）。
- 左上角指示器 + 弹窗：未激活→离线/在线激活选择；离线激活展示机器码(CPU+主板UUID+MAC派生)+激活码输入+激活；试用中/已激活展示剩余时间+去激活；到期自动转未激活。
- 机器码基于 CPU 序列号 + 主板 UUID + 网卡 MAC 经 SHA-256 派生（跨平台 `child_process` 原生命令，不新增依赖）。
- 离线激活码本地签名校验（机器码经内置密钥派生应得激活码并比对；算法集中、后续可替换为服务端签发）。
- 在线激活：UI 占位（入口+输入框），主进程返回「尚未接入后端」。
- 结果区改为可折叠 JSON 树 + 树/文本视图切换。

暂不做：
- 真实对接 billing-license-service（仅占位）。
- 服务端签发激活码（本地校验占位）。
- 其它页面的激活入口（仅调试器页左上角展示）。

## 实现思路（触点→步骤→取舍→风险回滚）
1. `src/shared/activation-types.ts` — 共享类型（ActivationStatus/State/Api）。
2. `src/main/machine-code.ts` — `getMachineCode()`：跨平台采集 CPU/主板/MAC 并 SHA-256 派生。
3. `src/main/activation-store.ts` — 加载/持久化/归一化（试用默认 30 天；到期自动降级为未激活）；`deriveActivationCode` 本地校验；`offlineActivate`/`deactivate`。
4. `src/main/index.ts` — 注册 `activation:*` 五个 IPC（get-state / get-machine-code / offline-activate / online-activate / deactivate）。
5. `src/preload/index.ts` — `api.activation` 暴露上述调用 + 类型。
6. `src/renderer/src/lib/electron.ts` — `ElectronAPI.activation` 接口 + `mockAPI.activation` + 类型导出。
7. `src/renderer/src/store/activationStore.ts` — zustand：加载状态、每秒 ticker（倒计时 + 到期触发刷新持久化降级）、open/close modal。
8. `src/renderer/src/components/ActivationBadge.tsx` — 左上角指示器（点击开弹窗）。
9. `src/renderer/src/components/ActivationModal.tsx` — 状态分派弹窗（离线/在线/去激活）。
10. `src/renderer/src/components/JsonTree.tsx` — 递归可折叠 JSON 树（主题自适应配色）。
11. `src/renderer/src/pages/Inspector.tsx` — 顶部左侧加 Badge + 挂 Modal；结果区用 JsonTree + 树/文本切换，移除 `react-syntax-highlighter` 相关 import 与 `registerLanguage`。
12. `src/renderer/src/App.tsx` — 挂载时 `useActivationStore.getState().init()`（保证全局 ticker 单例）。

取舍：机器码用原生命令而非加 `systeminformation` 依赖，避免引入新依赖、降低打包风险；结果区自研 JsonTree 而非引入 `react-json-view`（React18 兼容性问题）。
风险回滚：预置仅新增 IPC 与组件、未改既有逻辑；若类型检查不过，定位到具体文件回退该行即可。

## TODOS
- [x] 新建 `src/shared/activation-types.ts`
- [x] 新建 `src/main/machine-code.ts`
- [x] 新建 `src/main/activation-store.ts`
- [x] `src/main/index.ts` 注册 `activation:*` IPC
- [x] `src/preload/index.ts` 暴露 `activation`
- [x] `src/renderer/src/lib/electron.ts` 加 `activation` 接口 + mock
- [x] 新建 `src/renderer/src/store/activationStore.ts`
- [x] 新建 `ActivationBadge.tsx`
- [x] 新建 `ActivationModal.tsx`
- [x] 新建 `JsonTree.tsx`
- [x] `Inspector.tsx` 接入 Badge/Modal 并替换结果区为 JsonTree + 文本切换
- [x] `App.tsx` 初始化 activation store
- [x] 类型检查（`tsc -p tsconfig.main.json` 与 `tsc -p tsconfig.json`）通过

## 产出与结论
- 激活状态三态（未激活/试用中/已激活）全链路打通：主进程采集机器码 → 离线激活码本地签名校验 → zustand 全局 ticker 倒计时与到期降级 → 左上角徽标 + 弹窗。
- 调试器结果区改为自研可折叠 `JsonTree`（树/文本双视图），移除 `react-syntax-highlighter` 依赖。
- 双端 `tsc --noEmit` 全绿（MAIN_OK / RENDERER_OK）。
- 在线激活为 UI 占位（主进程返回「尚未接入后端」），离线激活算法集中在 `activation-store.ts::deriveActivationCode`，后续可平滑替换为服务端签发。
- 2026-09-16 归档至 `doc/archive/plan-21.0.md`，活动 plan 无残留未完成项。

---

> **已省略的过程性章节**（1 节，按需查 git 历史）：调试器页与 UI 交互
