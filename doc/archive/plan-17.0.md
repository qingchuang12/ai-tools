# plan-17.0 · 单一活动计划（承接）

> 版本：1.0（2026-09-12 新建 / 本次任务细化同日）· 单一活动 plan：本仓库 `doc/` 同时仅保留此一份活动 plan。
> 前任归档：[archive/plan-16.0.md](archive/plan-16.0.md)（修复打包产物缺失传递依赖 `cannot find module concat-stream`——SFTP 传递闭包真实化 + 真实 electron-builder 出包验证；`release/` 与临时残留清理；`node-linker=hoisted` 已取证、决定不根治）。

## 规则（plan 管理铁律）
- `doc/` 下**同一时刻只保留一个活动 plan**（本文件）；新任务合并进本 plan，不另起 `plan-NN.N.md`。
- 任务**已执行完结** → 归档到 `doc/archive/`（plan 与 audit 一并归档）；**未执行** → 合并进活动 plan。
- 每次软件调整：细化进 plan → 确认 → 执行 → 归档检查。

---

## 跨版本遗留项

（暂无。已知能力边界：codex-cli 上游不支持远程 MCP 接入，UI 已明示拦截，上游支持后可移除。）

## 本次任务：平台源安装的 Skill「安装后打不开」（用户主诉：虾评 · AI情感咨询与治愈助手）

### 一、现象
商店 → 虾评 → 安装「AI情感咨询与治愈助手」成功（我的库可见），但**点击后详情页打不开**。

### 二、取证（实测，非推测）
1. 虾评列表接口实测 `GET https://xiaping.coze.com/api/skills`（匿名 200）：
   - `AI情感咨询与治愈助手` → `id = e8f2aaea-5076-443a-879a-678c9cf54246`（**UUID**），`name = AI情感咨询与治愈助手`。
2. 本机落盘现场 `C:\Users\qingc\.workbuddy\skills\AI情感咨询与治愈助手\.source.json`：
   - `id = e8f2aaea-5076-443a-879a-678c9cf54246`，目录名 = `AI情感咨询与治愈助手` → **id 与目录名不同源**。
3. 安装链路：
   - `SkillDetail.tsx:393` → `installPlatformSkill(connId, decodedId（平台 id）, skillView.name（展示名）)`
   - `main/index.ts:651` → `installSkillFromZip(url, skillName, clients, {id: skillId, ...})`
   - `skills-manager.ts:1264/1326/1350`：**目录名 = skillName**；`.source.json.id = 平台 id`。
4. 打开链路：
   - `Library.tsx:1003`：`const skillId = skill.source?.id || skill.name;` → 用**平台 id** 导航 `/skill/<UUID>`
   - `SkillDetail.tsx:270` → `getLocalSkillDetail(UUID)`
   - `skills-manager.ts:1437`：`skillName = skillId.split('/').pop()` → 拿 UUID 当**目录名**查盘 → 不存在 → `null` → 详情页无数据。

### 三、根因（通用缺陷，非虾评个案）
> 本地详情查询用**目录名**做唯一键，导航键却是 `.source.json` 的**平台 id**；两者只在「id 末段 == 目录名」时巧合一致。

- GitHub / Registry 通道：目录名与 id 同源派生（`skillId.split('/').pop()`）→ **自洽，不触发**。
- zip / 平台通道（`PLATFORM_SKILL_DOWNLOAD = coze / modelscope / clawhub / skillhub`）：id 是平台侧标识，目录名是展示名 → **不同源**：
  - coze：UUID → **必挂**（实测确认）；
  - clawhub：id = `ownerHandle/slug`，name = `displayName || name || title || id` → displayName 与 slug 不同时**必挂**；
  - skillhub：name = `display_name || name || title || slug` → 同上，取决于平台是否给展示名；
  - modelscope：id 形态随条目变化，命中与否靠运气。
- 结论：**通道级缺陷**，「其他数据源是否有类似问题」= 是（上述 4 个平台共用同一通道，只是是否触发取决于 id 与展示名是否恰好同名）。

### 四、修复方案（按「通道根治」而非个案补丁）
| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| R1 | `getLocalSkillDetail` 支持按 `.source.json.id` 反查目录 | `src/main/skills-manager.ts` | 目录名未命中时，遍历 skills 目录读 `.source.json`，按别名口径比对 id；命中返回**真实目录名**（避免详情页把 UUID 当标题）。根治，覆盖所有入口（我的库 / 深链 / 历史）。 |
| R2 | 标识匹配口径下沉 shared，单一事实源 | 新增 `src/shared/skill-identity.ts`；`src/renderer/src/lib/skillIdentity.ts` 改为 re-export | 主进程与渲染层共用 `skillMatchKeys`（全名 + 末段，小写），避免两套判定再次分裂。 |
| R3 | 我的库导航键改用物理目录名 | `src/renderer/src/pages/Library.tsx:1003` | `skill.name` 来自目录扫描，是本地权威键；不再依赖平台 id。 |
| R4 | 次生显示缺陷：作者名不再显示整串 UUID | `src/renderer/src/pages/SkillDetail.tsx:276 / 649 / 949` | id 不含 `/`（UUID）时不取首段；作者为空时隐藏 `by @`。 |
| R5 | 单测守卫 | 新增 `src/__tests__/skill-local-detail-resolve.test.ts` | 覆盖：UUID id 反查命中并返回目录名、目录名直查回归、owner/slug 末段匹配、不存在 id 返回 null（不误命中）。 |

### 五、风险与取舍
- R1 反查需遍历目录读 `.source.json`：仅在**目录名未命中时**触发，目录数通常为几十，开销可忽略。
- R3 与 R1 互为双保险：R3 让新建导航语义正确，R1 兜住历史深链 / 其它入口。
- 不改动 `.source.json` 的写入语义（id 仍保留平台 id，溯源与更新依赖它），避免影响更新/重装链路。

## TODOS（汇总）
- [x] R1 `getLocalSkillDetail` 按来源 id 反查目录（含返回真实目录名）
- [x] R2 标识口径下沉 `src/shared/skill-identity.ts` + renderer 改为直接引用 shared（旧文件删除）
- [x] R3 Library 导航键改用物理目录名
- [x] R4 详情页作者名不再显示 UUID（含空作者隐藏 `by @`）
- [x] R5 新增单测守卫并跑通 vitest + tsc
- [x] 清理临时取证脚本（`.tmp-probe-*.cjs/.log`）

## 验收结果（2026-09-12）
- 新增 `src/__tests__/skill-local-detail-resolve.test.ts`（5 项，含虾评 UUID 形态 V1）全绿；相关既有 28 项全绿。
- 全量 `vitest run`：437 passed / 1 failed —— 失败项为 `env-manager.test.ts > checkNpx`（沙箱环境 `npx` 解析问题，改动清单不含该文件，属既有环境性失败，非本次引入）。
- `tsc -p tsconfig.main.json --noEmit` 与 `tsc -p tsconfig.json --noEmit` 均 0 错误。
- 待川哥本机复验：我的库 → 点击「AI情感咨询与治愈助手」应能打开详情页（标题为中文名，作者行不再显示 UUID）。

## 其他问题·结论
- 虾评 `sourceUrl` 为站点根（`https://xiaping.coze.com`），无稳定详情直链——本次不处理（不影响打开）。
