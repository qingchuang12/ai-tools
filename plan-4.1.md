# plan-4.1 · ai-tools 依赖构建配置修复（唯一活动 plan）

## 背景与目标

pnpm 11/12 键位错位导致构建白名单整体失效：`package.json` 的 `pnpm.onlyBuiltDependencies`（pnpm 12 不读）、`pnpm-workspace.yaml` 的旧 `allowBuilds` 半填草稿、无效的 `allowScripts` 死字段并存。已统一收口到 `pnpm-workspace.yaml` 的 `allowBuilds` 单键（pnpm 11.24 / 12.4.1 共同认可）。

## 范围与边界

- 做：构建脚本白名单统一、删除死配置、esbuild 二进制补齐（已完成）。
- 暂不做：`packageManager: pnpm@12.4.1` 与项目外全局 pnpm 11.24.0 的版本口径不在本次调整（项目内 pnpm 已按 manage-package-manager-versions 自动切 12.4.1 执行，行为一致）。

## 实现思路

`allowBuilds` 裁决（pnpm 12 权威键）：`@overwolf/ow-electron: true`（真实包名，devDependencies 里以别名 `electron` 引用）、`esbuild: true`、`cpu-features/ssh2/electron-winstaller: false`（纯 JS 回退 / 用不到 Squirrel 打包）。

## TODOS（仅未完成）

- [ ] **补装 @overwolf/ow-electron 42.7.1 的 Electron 二进制**（2026-09-22）— 当日外网 DNS 全部不可达（`content.overwolf.com` 解析失败，连 223.5.5.5 都超时），`node install.js` 报 fetch failed；本机 electron 缓存无该版本。网络恢复后在项目根执行：`node node_modules/electron/install.js`（幂等，约 100MB），完成后 `node_modules/electron/dist/electron.exe` 应存在。**注意**：若仍失败先确认代理/VPN，勿改包版本。

## 登记表（外部阻塞 / 需你本人动手，不占 TODOS）

- 无。
