# plan-2.7 · 授权体系（R1-R5 已交付，仅留阻塞外部验证）

> 版本：v2.8（2026-09-20）· 唯一活动 plan（ai-tools）。R1-R5 已实现并提交推送（commit 3596906）：feature-gate fail-closed + FEATURE_PROVIDERS 归一（R1/R5）、vault 外高水位锚（R2）、更新权益软门控（R3）、first_seen_at 合理性窗（R4）。typecheck 全绿；vitest 561/563 通过（2 失败为 qa-first-run-audit 既有 wall-clock 容差抖动，与本次无关、文件未改动）。已完成项按规则清出 TODOS。

## TODOS（仅未完成 — 阻塞外部资源，非可编码项）
- [ ] 真实后端端到端冒烟：fetchRedeem 走真实私钥签发链路（**阻塞**：需真实后端实例）。来源：plan-2.5/2.6/2.7 登记表结转。
- [ ] 打包产物运行时验证：electron-builder 产物 GUI 冒烟（**阻塞**：需打包 + GUI 环境）。来源：同上。
