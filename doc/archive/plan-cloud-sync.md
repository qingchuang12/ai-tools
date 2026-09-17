## 来源 `plan-cloud-sync.md`（原 plan-3.0.md） · plan-3.0 · 云端一致性：不一致主动提示 + 双方时间展示 + 对照查看

> 版本：3.0（2026-09-07 起始，同日代码完成并归档） · 前任：doc/archive/plan-2.0（客户端口径统一，代码已完成）
> 归档说明：TODOS 全部完成（含用户反馈修正①-⑥、Claude Code 装机误判修复、Skill 导出/导入/附属文件完整支持/选择入口合并）。
> 跨版本遗留：P7（cloud 是否保留技能安装目标）与「手动验证清单」随迁至活动 plan-3.1 的 TODOS。
> 后续增强：Skill 附属文件**编辑**支持，见活动 plan-3.1。

## 背景与目标

用户要求：**多客户端与云端必须保持一致；出现不一致时立即提示用户处理，提示显示不一致两者的更新时间，并提供对照查看功能。**

现状扫描结论（2026-09-07，代码实证）：

| 环节 | 现状 | 差距 |
|------|------|------|
| 技能上传（本地→云端） | 已有冲突检测（detectCloudConflicts：updatedAt/mtime 比对 + 弹窗显示双方时间 + 覆盖/跳过） | 达标，复用 |
| MCP 上传 | `syncServersBatch(['cloud'])` 直接覆盖，无检测 | 需补「完整覆盖确认」 |
| 云端→本地客户端 | `syncBatch`/`syncServer` 直接覆盖本地，无检测 | 需补「新覆盖旧」冲突防护 |
| 主动一致性提示 | 仅技能上传时被动检测；进 Library / 启动 pull 后不提示 | 需补主动扫描 + banner |
| 对照查看 | 冲突弹窗只有名称+时间 | 需补内容对照弹窗 |
| 启动自动 pull | `gitPull` 用 `reset --hard FETCH_HEAD` 强制覆盖暂存区 | 未推送改动可能被冲掉，需脏检查防护 |

1. 检测范围：本地客户端版本 vs 云端（按时间/内容）；涉及云端的同步默认「新覆盖旧」；手动上传提示「是否完整覆盖」。
2. MCP 时间口径：内容比对（JSON 不一致即报）+ 文件级 mtime 展示（标注「文件修改时间」）。
3. 提示深度：banner + 对照弹窗（左右并排，差异行高亮）。

## 范围与边界

**做**

1. main：一致性检测模块 `src/main/cloud-consistency.ts`（技能双向 + MCP 内容比对）+ IPC `cloud-sync:check-consistency`。
2. main：对照内容读取 IPC（本地端 / 云端端的 SKILL.md 与 server JSON）。
3. renderer：Library 顶部一致性 banner（数量摘要 + 明细 + 逐项/批量操作）。
4. renderer：`ConsistencyCompareModal` 对照弹窗（左右并排 + 差异行高亮）。
5. renderer：云端→本地同步前的冲突检测接入（技能复用现有弹窗；MCP 补同类弹窗），默认「新覆盖旧」。
6. renderer：MCP 手动上传前的「完整覆盖云端？」确认弹窗（列出将变化的 server，不比新旧）。
7. main：git 模式启动 pull 前的暂存区脏检查（脏则跳过 pull 并在同步任务中提示）。
8. i18n（zh/en）+ 单测 + typecheck/test 全绿。

**不做**（理由）

- 本地客户端互检（Cursor vs Claude Code 的版本差异）——本地多客户端版本不同是常态，报出来噪音大于价值；用户选择的范围也仅「本地 vs 云端」（注：该决策后因用户反馈修正⑥逆转，本轮已实现本地互检）。
- MCP per-server 时间戳元数据（.meta.json 方案）——用户已选内容比对+文件时间，避免数据格式侵入。
- SFTP 模式的启动 pull 脏检查——SFTP 为覆盖式下载无本地提交概念，风险场景（上次上传未完成）由同步任务队列串行化缓解，本轮不动。
- 复杂 diff 算法（Myers 等）——行集合比对 + 高亮足够，不引第三方依赖。

### 关键取舍

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 检测数据源 | 云端=本地暂存区（`~/.ai-tools/cloud/ai-tools`） | 暂存区与远端同构，push/pull 保证二者一致；检测本地↔暂存区即可代表本地↔云端 |
| 技能时间 | `.source.json` updatedAt ‖ SKILL.md mtime | 复用 conflict.ts 现成算法，行为一致 |
| MCP 判定 | server 配置 deep-equal；时间取双方 mcp.json mtime | 无 per-server 时间戳的现实约束（用户已确认） |
| 一致项分类 | local_newer / cloud_newer / same_content / local_only / cloud_only | same（内容相同）不报；「仅一侧存在」单独分组提示 |
| 对照实现 | 两端内容读取后逐行比对，相同行淡化、差异行高亮 | 零依赖，满足「对照查看」诉求 |
| 操作语义 | 每项操作按钮随 resolution 联动（本地新→上传、云端新→下载、仅一侧→相应方向）；批量按钮按组提供 | 「新覆盖旧」作为默认推荐而非自动执行——破坏性操作必须经用户点击 |

### 风险与回滚

- **风险 1**：一致性扫描的 IO 开销（遍历各客户端 skills 目录 + 读 mcp.json）——与 getAllInstalledSkills 同量级，进 Library 一次扫描可接受；检测异步不阻塞 UI。
- **风险 2**：deep-equal 判定对 JSON 键序敏感——统一先 `JSON.stringify` 规范化（键序由 stringify 保持对象字面量序，读出的同一文件稳定）；跨客户端写入的键序不同会产生误报 → 比对前按键名递归排序再序列化。
- **风险 3**：banner 与现有技能上传冲突弹窗（同数据源不同入口）状态不同步 → banner 操作完成后统一 `loadData()` + 重新触发检测刷新 banner。
- **风险 4**：gitPull 脏检查改变启动行为（脏时不再自动 pull）→ 仅跳过并提示，用户可通过手动「下载」恢复；同步任务面板可见原因。
- **回滚**：全部 additive（新模块/新组件/新 IPC），既有行为除 gitPull 脏检查与 MCP 上传确认弹窗外不变；逐文件 revert 即可。

### 验证

1. `npm run typecheck` 退出码 0；`npm run test` 全绿（含新增 cloud-consistency 单测）。
2. 手动（本机，云同步已配置）：
   - 本地改一个 skill 不上传 → 进「我的库」出现 banner，明细含该项与双方时间；
   - 点「对照」→ 左右并排且差异行高亮；
   - 云端较新的项点「下载」→ 本地被更新，banner 消失；
   - MCP：本地 mcp.json 改一个 server → banner 出现对应项；手动「云上传」→ 弹「完整覆盖云端？」确认；
   - 暂存区手改文件（模拟未推送）后重启 → 启动 pull 被跳过且同步任务中有原因说明。

## TODOS

- [x] conflict.ts：抽出时间读取函数供复用（readSkillUpdatedAt，行为等价重构）
- [x] cloud-consistency.ts：技能双向 + MCP 内容比对检测核心 + 单测（13 个用例全绿）
- [x] index.ts：check-consistency / read-ends IPC；gitPull 脏检查经核实**已存在**（P0-2 备份分支机制，优于计划方案），无需新增
- [x] electron.ts + preload：类型 + API + mock（ConsistencyItem / ConsistencyReport 桥接）
- [x] ConsistencyBanner / ConsistencyCompareModal 组件 + Library 接入（挂载 / onPulled / 手动刷新三处触发）
- [x] 云端→本地同步冲突防护（技能按时间弹逐项确认，MCP 按内容弹覆盖确认）
- [x] MCP 上传「完整覆盖云端？」确认（useCloudUpload，云端非空时弹窗）
- [x] i18n zh/en 文案（consistency 段 28 键 + library 段 9 键）
- [x] typecheck + test 全绿（209/209；执行中修复一处 JSX 标签不平衡与一处未用变量）
- [x] 用户反馈修正①：对照窗口加大——Modal 新增 xl/full 尺寸，对照弹窗默认 1024px 宽 + 「全面显示」按钮切换近全屏（95vw、内容区更高）
- [x] 用户反馈修正②：banner 按钮改为「覆盖本地 / 覆盖云端」两枚；覆盖本地 = 所有已安装客户端全部覆盖（不再局限于已持有该条目的客户端）
- [x] 用户反馈修正③：Skill 与 MCP 分组显示（互不混排）；对照弹窗多客户端一致性说明；仅单侧存在的不再算不一致；两边都存在的恒定提供「覆盖本地 + 覆盖云端」两枚按钮
- [x] 用户反馈修正④：一致性 banner 按当前 Tab 过滤——MCP Servers tab 只显示 MCP 不一致，Skills tab 只显示 Skill 不一致；摘要行对 0 计数的类型隐藏
- [x] 用户反馈修正⑤：内容完全相同（仅时间戳差异）→ 默认视为已同步，静默不报。Skill 检测从「纯时间比对」改为「SKILL.md 内容比对 + 时间判定」；MCP 本就是内容比对
- [x] 用户反馈修正⑥：本地多客户端互检——同名 Skill / Server 在各本地客户端内容不一致 → 报 local_diverged（紫色标签，逐客户端时间明细），提供「统一同步」（最新客户端为源覆盖其余）与两个本地客户端互相对照
- [x] 用户报障修复（跨主题，属 plan-2.0 客户端口径回归）：Claude Code 未安装却显示已安装——① CLI 形态客户端（EXECUTABLE_ONLY_CLIENTS）不再用 configExists 兜底判定已安装；② 移除 codex-cli / opencode(win32) / openclaw(win32) 探测表中的裸目录项
- [x] Skill 导出优化：选中导出从 JSON 元数据改为 zip 包——新增零依赖 zip-writer（Node zlib 自实现）+ skills-export（递归打包 {skillName}/ 结构）+ IPC skills:export-zip；单 skill → {name}.zip，多 skill → skills-export-时间戳.zip
- [x] Skill 导入优化：创建弹窗拖拽/选择不再依赖 File.path（新版本 Electron 下 undefined），改「内存字节通道」——File → ArrayBuffer → IPC import-zip-buffer → archive 解包解析；导出↔导入闭环单测验证互操作
- [x] Skill 附属文件完整支持（用户确认：编辑后保存一并写入；.source.json 跳过）：importFromZipBuffer 返回完整 files → createCustomSkill 增加 files 落盘通道（assertWithin 防穿越 + 解压上限防 zip 炸弹）→ CreateSkillModal 保存时一并写入
- [x] 创建弹窗选择入口合并：去掉独立的「选择 Skill 文件夹」按钮与 file input，拖拽区点击统一走系统对话框（openFile + openDirectory，filter zip/skill/md）；拖拽仍走内存 bytes 通道

> **已省略的过程性章节**（5 节，按需查 git 历史）：云端同步与一致性 / 实现思路 / 触点清单 / 步骤 / 执行备注（2026-09-07）
