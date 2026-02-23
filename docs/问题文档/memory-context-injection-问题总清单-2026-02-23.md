# Memory Context Injection 问题总清单（2026-02-23）

## 归档信息

- 已归档文档：
  - `docs/archive/resolved/bug-report-memory-context-injection-2026-02-23.resolved.md`
- 归档原因：
  - 文档内主问题已完成修复并复测通过，转入已解决档案。

## 已解决问题（已关闭）

| ID | 严重级别 | 问题描述 | 当前状态 |
|---|---|---|---|
| R-01 | P0 | `refresh_memory_after_chapter` 处理 `ChapterPlan` 对象时报 `.get` 异常，导致回写链路静默失败 | 已修复 |
| R-02 | P1 | Context Pack 调试接口存在写副作用（调用后改写 `OPEN_THREADS.md`） | 已修复（只读模式） |
| R-03 | P1 | 预算汇总可能超过输入预算/窗口预算，统计失真 | 已修复（增加预算缩放） |
| R-04 | P1 | 删章后 `plan.chapter_id` 未同步重排 | 已修复 |
| R-05 | P2 | FTS 未同步 `RUNTIME_STATE.md` / `OPEN_THREADS.md` | 已修复 |
| R-06 | P2 | 删章后 `chapter_synopsis` 编号未重排 | 已修复 |
| R-07 | P3 | 回写日志缺少关键文件大小字段 | 已修复（已输出 runtime/memory/open_threads 大小） |

## 待解决问题（未关闭）

| ID | 严重级别 | 需求项 | 问题描述 | 关键位置 | 状态 |
|---|---|---|---|---|---|
| O-01 | P1 | Req 5.5 | 仍有 `generate_plan` 路径未注入 Context Pack（仅传 `project_info + previous_chapters`） | `backend/api/main.py:3858` | ✅ 已修复 |
| O-02 | P1 | Req 5.5 | `draft` 内部"先生成 plan"分支未注入 Context Pack | `backend/api/main.py:4011` | ✅ 已修复 |
| O-03 | P2 | Req 8.2 | 生成前日志未提供明确 `source_counts` 与 `truncation_amounts` 字段 | `backend/services/memory_context.py:230` | ✅ 已修复 |
| O-04 | P2 | Req 8.3 | 回写日志未显式输出 rewrite duration（非阈值时长/总时长） | `backend/services/memory_context.py:634` | ✅ 已修复 |
| O-05 | P2 | Req 1.3 | `RUNTIME_STATE` 的 `state_changes` 仍未实质提取（长期为空） | `backend/services/memory_context.py:453` | ✅ 已修复 |
| O-06 | P2 | Req 4.2 | Synopsis 目前 plan 优先直接返回，未与正文融合提取 | `backend/services/memory_context.py:276` | ✅ 已修复 |
| O-07 | P2 | Req 2.6 | open threads 仅 top-k 截取，未体现"高置信筛选"策略 | `backend/services/memory_context.py:180` | ✅ 已修复 |
| O-08 | P3 | Req 10.4 | 模型层已新增 `plan_quality` / `plan_quality_debug` 字段，与"避免模型字段变更"条款冲突 | `backend/models/__init__.py:124` | ⏳ 产品决策 |

## 建议执行顺序

1. ~~先补齐所有 `generate_plan` 入口的 Context Pack 注入（O-01, O-02）。~~ ✅
2. ~~再补可观测性字段（O-03, O-04），便于后续持续排障。~~ ✅
3. ~~最后补质量与语义一致性策略（O-05, O-06, O-07）。~~ ✅
4. 对 O-08 做产品决策：保留字段并更新 requirement，或回退为非模型字段存储。
