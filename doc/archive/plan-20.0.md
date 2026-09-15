# plan-20.0 · Release 由默认草稿改为正式版本

## 背景与目标
当前 tag 推送触发 GitHub Actions 构建时，electron-builder 生成的 GitHub Release 显示为 Draft（草稿），需要改为正式版本（Release），确保最终用户能匿名访问安装包与 latest*.yml 做在线升级。

## 范围与边界
- 做：在 package.json 的 build.publish[0]（github provider）显式声明 releaseType = release。
- 暂不做：不改动 workflow 触发逻辑、三方平台打包脚本、代码签名。
- 既有已存在的 Draft Release 需手动在 GitHub 上「Publish release」或删除后重新构建，本次代码修正只影响后续新建的 Release。

## 实现思路
- 触点：package.json → build.publish[0]（provider: github）。
- 根因：electron-builder github 发布器默认 releaseType=draft（node_modules 内 gitHubPublisher.js:52、scheme.json:1509 已实测核实）。
- 步骤：为该 publish 对象追加 "releaseType": "release"。
- 取舍：也可用 options.draft=false，但 releaseType="release" 更明确、官方文档即为推荐写法。
- 风险：低；仅一处配置。

## TODO
- [x] package.json build.publish[0] 追加 releaseType = "release"
- [x] 验证 package.json JSON 合法、publish 配置结构正确（node 解析 + electron-builder --help 加载配置无报错）
- [ ] 触发 tag 构建后确认新 Release 为正式版本（用户侧复验，见根因节说明）