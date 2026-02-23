# Memory Context Injection 深度抓虫报告（2026-02-23）

## 1. 抓虫范围与方法

- 范围：
  - `backend/services/memory_context.py`
  - `backend/api/main.py`
  - `backend/agents/studio.py`
  - `backend/memory/__init__.py`
  - `frontend/src/pages/WritingConsolePage.tsx`
  - `frontend/src/pages/ChapterWorkbenchPage.tsx`
- 方法：
  - 代码审查（关键调用链 + 需求对照）
  - 回归测试
  - API 真实调用复现（`fastapi TestClient`）
  - 最小脚本验证边界条件

## 2. 验证结果摘要

- 后端测试（通过）：
  - `cd backend && LOG_FILE=/tmp/morpheus-audit.log pytest -q tests/test_memory_context.py tests/test_memory_context_pbt.py tests/test_studio_plan_parser.py tests/test_api_smoke.py`
  - 结果：`94 passed`
- 前端测试（通过）：
  - `cd frontend && npm test -- --run src/pages/__tests__/WritingConsolePage.test.tsx src/pages/__tests__/ChapterWorkbenchPage.test.tsx`
  - 结果：`78 passed`

> 说明：测试通过不代表无严重问题。以下多个问题属于“当前测试未覆盖”的真实运行链路缺陷。

## 3. 关键问题清单（按严重级别）

### P0-1：章末记忆回写在真实 API 链路中会报错并被吞掉，导致三层记忆实际未生效

- 现象：
  - 生成草稿、审批通过后，`refresh_memory_after_chapter` 触发异常但 API 仍返回成功。
  - 你会看到“功能看起来改了，但记忆回写效果不稳定/不生效”。
- 复现：
  - 通过 TestClient 调用：`POST /api/chapters/{id}/draft` -> `POST /api/review`（approve）。
  - 日志出现 `AttributeError: 'ChapterPlan' object has no attribute 'get'`。
- 根因：
  - `backend/services/memory_context.py:236-239` 中 `generate_chapter_synopsis()` 直接对 `chapter_plan` 调用 `.get()`，假设其为 `dict`。
  - 但 API 传入的是 Pydantic `ChapterPlan` 对象（`backend/api/main.py:2064`, `4165`, `4363`, `3443` 等）。
  - 调用点外层 `try/except` 仅打 warning，不中断流程，形成“静默降级”。
- 影响：
  - `chapter_synopsis`、`OPEN_THREADS`、`RUNTIME_STATE`、阈值重写链路在核心路径失效。
- 建议修复：
  - 在 service 层统一做 plan 归一化：`dict | ChapterPlan | None -> dict`。
  - 关键回写失败改为结构化错误上报（至少在 debug 字段返回）。
  - 为 API 集成路径增加真实对象类型测试（非仅 dict 单测）。

---

### P1-1：一旦修复 P0-1，consolidated 路径会出现“双重 reflect”重复写入

- 现象：
  - 同一章审批/提交后，L3 summary 与 MEMORY 可能重复追加。
- 根因：
  - API 层已调用 `reflect()`：
    - `backend/api/main.py:4353`（review approve）
    - `backend/api/main.py:4155`（commit_memory）
    - `backend/api/main.py:3432`（auto_approve）
  - `MemoryContextService.refresh_memory_after_chapter(mode="consolidated")` 内部再次调用 `reflect()`：
    - `backend/services/memory_context.py:553-555`
- 影响：
  - 记忆重复、统计偏移、后续检索污染。
- 建议修复：
  - 只保留一处 `reflect()` 入口（推荐在 service 层统一编排，API 层删除直接 reflect）。
  - 增加幂等保护（同章同模式重复触发不重复写）。

---

### P1-2：Context Pack 预算算法可能超过模型上下文和输入预算

- 现象：
  - 小上下文窗口时，`total_budget` 反而大于 `context_window_tokens`，预算统计失真。
- 证据：
  - `MemoryContextService(context_window_tokens=2048, input_budget_ratio=0.6)` 下，`total_budget=3584`。
- 根因：
  - `_compute_field_budgets()` 每字段最小 512（7 字段至少 3584）：
    - `backend/services/memory_context.py:67`, `83-90`
  - `build_generation_context_pack()` 未接收上游真实 `input_budget`：
    - `backend/services/memory_context.py:123`
  - 上游虽算了 `input_budget`，但未传入：
    - `backend/api/main.py:2140` 与 `2153`
- 影响：
  - 历史上下文可能挤压正文生成预算，增加截断与退化概率。
- 建议修复：
  - 让 `build_generation_context_pack` 接收 `input_budget_tokens`。
  - 最小预算改为“总预算约束下按权重回退”，而非固定 512。

---

### P1-3：删章重排后，章节号与 plan/synopsis 元数据不一致

- 现象：
  - 删除第 20 章后，原第 21 章变成 20，但其 `plan.chapter_id` 仍是 21。
  - `chapter_summary` 会 shift，`chapter_synopsis` 不会 shift。
- 根因：
  - 重排时只改 `chapter.chapter_number`，未改 `chapter.plan.chapter_id`：
    - `backend/api/main.py:3667-3673`
  - `shift_chapter_indices_after()` 只处理 `chapter_summary`：
    - `backend/memory/__init__.py:186-196`
    - 未处理 `chapter_synopsis`。
- 影响：
  - 蓝图/记忆引用章号错位，上一章梗概注入可能读到错误章节。
- 建议修复：
  - 删章重排时同步更新 `plan.chapter_id`。
  - `shift_chapter_indices_after` 同步处理 `chapter_synopsis` 和相关 summary 文本。

---

### P1-4：调试接口名为“non-destructive”，但实际会写文件

- 现象：
  - 调用 `GET /api/projects/{project_id}/memory/context-pack` 会更新 `OPEN_THREADS.md` 的 `_Last recomputed` 时间。
- 根因：
  - 调试接口调用 `build_generation_context_pack()`：
    - `backend/api/main.py:4296-4312`
  - 该函数内部调用 `recompute_open_threads()` 并落盘：
    - `backend/services/memory_context.py:155`, `354-385`
- 影响：
  - 调试请求产生副作用，污染审计与时间线，违背接口语义。
- 建议修复：
  - 将 `build_generation_context_pack()` 拆成纯读模式与重算模式。
  - 调试端点默认只读，必要时增加 `?recompute=true` 显式开关。

---

### P2-1：`sync_file_memories()` 未同步 `RUNTIME_STATE.md` 与 `OPEN_THREADS.md`

- 现象：
  - FTS 仅见 `IDENTITY.md` 和 `MEMORY.md`，不含运行态快照与伏笔账本。
- 根因：
  - 同步源文件列表只包含：
    - `memory/L1/IDENTITY.md`
    - `memory/L2/MEMORY.md`
    - logs + L3
  - 见 `backend/memory/__init__.py:768-775`。
- 影响：
  - 检索层无法利用最新 `RUNTIME_STATE` 和 `OPEN_THREADS` 信息。
- 建议修复：
  - 在 source_files 中加入：
    - `memory/L1/RUNTIME_STATE.md`
    - `memory/OPEN_THREADS.md`

---

### P2-2：部分生成路径未注入 Context Pack，和需求目标不一致

- 现象：
  - 手动 `POST /api/chapters/{id}/plan` 路径未注入 `identity_core/runtime_state/open_threads`。
  - `_generate_draft_internal` 在“无 plan 先生成 plan”分支中也未注入 Context Pack。
- 根因：
  - `backend/api/main.py:3858-3863` 仅传 `project_info + previous_chapters`。
  - `backend/api/main.py:4011-4014` 传 `previous_chapters: []`。
- 影响：
  - 同项目不同入口下，蓝图质量与一致性表现不稳定。
- 建议修复：
  - 抽统一 `build_plan_context_with_context_pack()`，所有 plan 入口复用。

---

### P3-1：可观测性与设计目标仍有差距

- 现象：
  - 回写日志未包含“写入文件大小”，仅有 threshold 与 duration。
- 根因：
  - `refresh_memory_after_chapter` 日志字段不足：
    - `backend/services/memory_context.py:575-581`
- 影响：
  - 排障时难快速判断“写了什么、写了多少、是否异常缩小”。
- 建议修复：
  - 增加 `runtime_state_bytes / memory_bytes / open_threads_bytes / l3_delta_count` 等指标。

## 4. 结论与优先级建议

- 立即修（本周）：
  - P0-1（回写类型错误 + 静默失败）
  - P1-1（双重 reflect，作为 P0 修复后的联动修复）
  - P1-2（预算超配）
- 次优先（下周）：
  - P1-3（删章重排元数据一致性）
  - P1-4（debug 端点副作用）
  - P2-1（RUNTIME_STATE/OPEN_THREADS 入索引）
  - P2-2（补齐全入口 Context Pack 注入）

## 5. 建议补测清单

- 新增集成测试：`chapter.plan` 为 Pydantic 对象时的 `refresh_memory_after_chapter` 全链路。
- 新增回归测试：approve/commit/auto-approve 不会重复 reflect。
- 新增删章回归：`chapter_number`、`plan.chapter_id`、`chapter_summary`、`chapter_synopsis` 同步重排。
- 新增预算测试：`total_budget <= input_budget_tokens`（覆盖小窗口模型）。
- 新增调试接口测试：默认调用不改动任何 memory 文件（mtime/hash 不变）。
