# plan-4.1 · ai-tools 未完成项

> 本仓**唯一活动 plan**，只登记未完成项；已落地实现与决策叙述不留存（历史结论查 `git log -- doc/ src/`）。
> 长期口径落点：广告渠道与构建变体 → `doc/ads-and-build-variants.md`；客户端配置删除语义与 i18n/locale 口径 → `doc/client-config-deletion.md`；授权复核节奏/时钟回拨/共享知识 → `doc/license-recheck-design.md`（§0.4 / §1.5 / §8）；产品与用户文档 → `doc/README.md` / `README_CN.md` / `软件介绍.md`。
> 跨仓同一批实机验证的服务端腿在 `../billing-license-service/docs/plan-7.0.md` TODOS（E1 真付款腿、E3 走查合批）。

## TODOS（仅未完成）

- [ ] **【需你处理】ow-electron 底座实机验证 + 打包链实跑** 前置**已解除**（2026-10-01 实测）：`package.json:68` 已用别名锁 `@overwolf/ow-electron@42.7.1`，`node_modules/electron/dist/electron.exe` 存在，`node_modules/@overwolf`（含 `ow-electron-builder`）与 `7zip-bin` 均已装。待做：① `webviewTag:true` + `ow-electron --test-ad` 实机跑通 `<owadview/>`（需 GUI）；② `pnpm package:win` 打包链实跑。**未核实项**：本机 `pnpm install` 反复报 `os error 2/5/183`（符号链接/文件已存在/拒绝访问）本轮未复现，若重跑仍失败须先修文件系统或安全软件拦截，勿改包版本。
- [ ] **【需你处理】免费版1/2 GUI 冒烟** dev 下按 `AI_TOOLS_EDITION` 组合核对广告位与云同步入口显隐、激活态切换（变体矩阵与 flag 短路见 `doc/ads-and-build-variants.md` 第一节）。
- [ ] **【需你处理】真实后端端到端冒烟** `fetchRedeem` / `unbind` / `activate` / 登录 + MFA 走真实私钥与账号链路（阻塞：需真实后端实例 + 可登录账号）。
- [ ] **【需你处理】360 联盟商务对接** 确认 PC 桌面 SDK 是否存在并取文档 → 按 `AdProvider` 接口补实现（`union.360.cn` 三次超时不可达，公开渠道只有移动端 API 文档，桌面端支持仍未确认）。
- [ ] **【需你处理】Overwolf Console 注册 App UID + 申请广告开通**（发布另需开发者代码签名证书；双签与 DSC 要求见 `doc/ads-and-build-variants.md` 第二节）。
- [ ] **【需你处理】无官方原文的路径/字段核实** ① Antigravity 的 Windows 路径与 Skills 目录（`~/.gemini/config/skills` 官方未确认，issue #686 仍在问；实测生效的是 `~/.gemini/skills/`）；② TRAE 国际版三平台绝对路径（docs.trae.ai 抓取失败）；③ ZCode 远程条目的 JSON 字段名（官方只给 stdio 示例）；④ JetBrains 产品目录前缀全集（RustRover 等是否支持无官方表）；⑤ `~/.gemini/antigravity-cli/mcp_config.json` 是否为用户级真实落点（antigravity.google 本机不可达，且它更像 CLI 独立落点而非 IDE 的 `~/.gemini/config/mcp_config.json`）——现候选链只保留「主 `~/.gemini/config/mcp_config.json` + 读回退 `~/.gemini/antigravity/mcp_config.json`」（`src/main/client-probe.ts:170-175`），官方路径可访后再补第 5 项。
- [ ] **【需你决策】批次⑤ 异构/受阻客户端（动手前先拍板）** 逐个决定「做 / 不做 / 换方案」，每项都有硬阻塞：Goose（YAML `extensions:` + `cmd/envs/uri`，**需新增 YAML 依赖**）；Kilo Code（顶层 `mcp`、`~/.config/kilo/kilo.jsonc`，**Windows 目录未文档化**）；Amazon Q Developer CLI（`cli-agents/` 与 `default.json` 与 legacy `mcp.json` 三套并存，官方推荐走 `q mcp` 子命令，本工具无 CLI 写入通道）；Roo Code（真实路径取决于宿主编辑器的扩展 globalStorage，**不可硬编码**，官方文档里的路径字符串甚至仍残留 Cline 旧路径）。**推荐**：只做 Kilo（等其 Windows 目录文档化后）与 Amazon Q（走 CLI 子命令需先决定要不要引入命令执行通道），Goose 因新依赖、Roo 因路径不可靠而**暂缓**——四者共同点是探测与写入都无法做到「零猜测」。
- [ ] **【需你决策】Codex CLI 远程/超时字段是否补齐** stdio 字段已坐实无需改（`codex-rs/config/src/mcp_types.rs` 的 `RawMcpServerConfig`，`deny_unknown_fields` 含 `command/args/env/env_vars/cwd`；顶层 `mcp_servers` 见 `config_toml.rs:293`——**外部仓原文，本轮未复核，如需引用请重取**）。现写入分支只落 stdio 字段（TOML 段见 `src/main/config/format-adapters.ts:289-297`：只写 `command`/`args`/`env`/`cwd`，全仓无 `url`/`startup_timeout_sec`）：远程 `url` + `bearer_token_env_var`/`http_headers` 与 `startup_timeout_sec`/`tool_timeout_sec`/`enabled` 未覆盖。**推荐**：先不补——现有用户尚无远程 codex 场景，补了也无法本地验证（需真机 codex CLI）。
- [ ] **【需你处理】仓库卫生（结转自 `plan-1.0` F4，2026-10-01）** 两个 commit 的 message 与内容不符，且**均已推送**（实测 `git log origin/main..HEAD` 为空，HEAD＝`a3819d3`＝`origin/main`）→ `--amend` / 交互式 rebase 属改写已发布历史，**不在建议范围**：
  - `9da1919` message 写「refactor(license): 移除 pending 查询的订单候选回退路径」（那是 billing 侧改动），`git show --stat` 实测**只有 1 文件 +35 行＝新增一次性探针** `src/__tests__/zz-e2-probe.scratch.test.ts`；
  - 其直接子提交 `a3819d3` message 只写「fix(license): 串行化 vault 读写」，实为 17 文件，**顺带**删掉该探针并补 9 语言 locale。
  - **推荐**：后续新提交一律起规范中文 message、让历史自明（本条留痕即够）；坚持改写历史须 force-push，影响所有协作者，需你明示后再做。服务端侧同类问题见 `billing-license-service/docs/plan-7.0.md`。
