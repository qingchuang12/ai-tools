# plan-20.1 · CI 构建 Node 版本由 20 升级到最新 LTS 24

## 背景与目标
.github/workflows/release.yml 的 test 与 build 两处 `node-version: 20`，而 Node 20 已于 2026-03-24 EOL，CI 会抛弃用警告。按 memory 约束「GitHub Actions 使用 Node.js 24+」，且用户选定最新 LTS，升级为 `node-version: 24`（setup-node 自动跟随最新 24.x 补丁，如 24.21.0）。

## 范围与边界
- 做：release.yml 两处 node-version 20 → 24。
- 暂不做：不改本机 Node、不加 npm/engines 字段、不动 package.json .nvmrc（项目无此文件）。
- 用户侧：提交并推送后触发 workflow 验证。

## 实现思路
- 触点：.github/workflows/release.yml 第 46、77 行。
- 取舍：不写死 24.21.0，用 `24` 大版本号，自动拉最新补丁，少维护。
- 风险：低；vite7/electron-builder24 对 Node 24 兼容已验证。

## TODO
- [x] release.yml 两处 node-version 20 → 24
- [x] 复核项目依赖 engines 均兼容 Node 24（vite≥22.12、electron-builder≥16）
- [ ] 用户侧：提交推送后触发 CI，确认无 Node 弃用警告且构建通过