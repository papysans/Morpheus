# 知识图谱复活（LLM 驱动 + L4 角色档案）实施工作计划

## TL;DR

> **Quick Summary**: 用 LLM 替换当前硬编码人物关系提取链路，新增独立 L4 角色档案记忆层，并同步复活知识图谱页面、扩展记忆浏览器和导入导出能力。
>
> **Deliverables**:
> - 后端 L4 数据模型、存储、API、提取服务（自动 + 手动）
> - 前端 Memory Browser 的 L4 展示
> - Knowledge Graph 页面切换到 L4 数据源并恢复可用
> - 导出/导入对 L4 + override/provenance 的完整 round-trip
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves + Final Verification
> **Critical Path**: Schema/Store → LLM Extraction Service → Trigger Integration → Graph API/Frontend

---

## Context

### Original Request
复活知识图谱功能，当前依赖硬编码规则提取人物关系准确率低；希望引入 LLM 更新关系；在三层记忆上新增一层用于角色概述/性格/章节事件；记忆浏览器新增展示层；导入导出适配新架构。

### Interview Summary
**Key Discussions**:
- 新层级方案：采用独立 **L4 Character Profiles**（而非塞入 L2）
- 触发策略：章节完稿后自动提取 + 支持手动重跑
- 图谱范围：本次一起复活图谱页面
- 档案字段：概述、性格、章节事件、关系、状态变化时间线
- 测试策略：**TDD**（先红后绿）
- 变更原则：尽量少改动，必要时允许深改

**Research Findings**:
- 当前关系提取在 `backend/api/main.py` 章节写回路径，偏硬规则
- `KnowledgeGraphPage.tsx` 现有大量规则归一化逻辑且 feature flag 默认关闭
- `MemoryBrowserPage.tsx` 已有 L1/L2/L3 浏览与 source 打开能力，可扩展 L4
- 导出/导入通过项目目录 ZIP round-trip，可在结构中纳入 L4

### Metis Review
**Identified Gaps (addressed in this plan)**:
- 明确 source-of-truth：采用 **LLM 基线 + 用户字段级 override 优先**
- 明确去重与稳定 ID：定义 deterministic key/hash，避免图谱抖动
- 明确边界：不新增复杂图谱分析能力，不做实时流式抽取
- 明确兼容：老项目无 L4 时可读可写可导入

---

## Work Objectives

### Core Objective
在不破坏现有 L1/L2/L3 和记忆检索流程的前提下，引入可维护、可验证、可导入导出的 L4 角色档案层，替换规则式关系抽取并恢复图谱可视化价值。

### Concrete Deliverables
- 后端新增 L4 模型与存储（含 override/provenance）
- 后端新增 L4 查询与手动重跑 API，章节完成后自动写入
- 前端记忆浏览器新增 L4 分层展示
- 前端图谱页切换到 L4 数据并移除硬编码归一化依赖
- 导出/导入全链路保留 L4 + override + provenance

### Definition of Done
- [x] 完成章节后可自动看到 L4 档案更新
- [x] 手动重跑可刷新 L4，且保留用户 override
- [x] 图谱页可正常渲染角色和关系（非规则回退）
- [x] 导出→导入后 L4 数据与 override 完整保留
- [x] 相关后端/前端测试通过

### Must Have
- 字段级 override 优先级：`user_override > llm_extracted`
- deterministic ID / 去重规则，避免重复角色和关系爆炸
- 兼容老项目（无 L4）

### Must NOT Have (Guardrails)
- 不在前端新增新一套关系抽取/归一化规则
- 不改写 L1/L2/L3 既有语义与核心检索排序逻辑
- 不扩展为“实时逐 token 抽取”或额外图谱分析平台
- 不引入跨项目关系合并

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: TDD
- **Framework**: pytest + Vitest + Playwright
- **If TDD**: 每个任务先创建失败测试（RED），再实现（GREEN），最后清理（REFACTOR）

### QA Policy
每个任务都包含 Agent-Executed QA 场景（happy + negative）。
证据路径统一落地到 `.sisyphus/evidence/task-{N}-{scenario}.{ext}`。

- **Backend/API**: Bash(curl) + pytest
- **Frontend/UI**: Playwright
- **Data round-trip**: 导出/导入 API + JSON/ZIP 验证

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — start immediately)
├── Task 1: L4 domain schema & model contracts [quick]
├── Task 2: SQLite schema migration + store primitives [unspecified-high]
├── Task 3: L4 API contracts (request/response DTO) [quick]
├── Task 4: Extraction prompt/spec + parser validator [deep]
└── Task 5: Feature flag/runtime config wiring [quick]

Wave 2 (Core backend implementation)
├── Task 6: LLM extraction service implementation (TDD) [deep]
├── Task 7: Merge engine (override precedence + dedupe) [deep]
├── Task 8: Auto-trigger integration on chapter completion [unspecified-high]
├── Task 9: Manual re-run API endpoint + error policy [quick]
└── Task 10: Graph data API switched to L4 source [unspecified-high]

Wave 3 (Frontend memory + graph)
├── Task 11: MemoryBrowser L4 panel + details rendering [visual-engineering]
├── Task 12: KnowledgeGraphPage refactor to L4 graph data [visual-engineering]
├── Task 13: Enable graph feature and nav exposure [quick]
└── Task 14: Frontend test suite updates (Memory/Graph) [unspecified-high]

Wave 4 (Import/export + compatibility)
├── Task 15: Export payload include L4 + provenance + overrides [unspecified-high]
├── Task 16: Import restore L4 + backward compatibility path [unspecified-high]
└── Task 17: Round-trip integrity tests (new/old archives) [deep]

Wave FINAL (Independent verification)
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real QA scenario replay (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: 1 → 2 → 6 → 7 → 8 → 10 → 12 → 15 → 16 → 17
Parallel Speedup: ~60-70%
Max Concurrent: 5
```

### Dependency Matrix (full)

- **1**: blocked_by=None; blocks=6,7,3
- **2**: blocked_by=1; blocks=6,7,15,16
- **3**: blocked_by=1; blocks=9,10,11,12
- **4**: blocked_by=1; blocks=6
- **5**: blocked_by=None; blocks=8,13
- **6**: blocked_by=1,2,4; blocks=7,8,9
- **7**: blocked_by=1,2,6; blocks=8,10,11,12,15
- **8**: blocked_by=5,6,7; blocks=17
- **9**: blocked_by=3,6; blocks=14,17
- **10**: blocked_by=3,7; blocks=12,14
- **11**: blocked_by=3,7; blocks=14
- **12**: blocked_by=3,7,10; blocks=14
- **13**: blocked_by=5; blocks=14
- **14**: blocked_by=9,10,11,12,13; blocks=17
- **15**: blocked_by=2,7; blocks=16,17
- **16**: blocked_by=2,15; blocks=17
- **17**: blocked_by=8,9,14,15,16; blocks=F1-F4

### Agent Dispatch Summary

- **Wave 1**: T1 quick, T2 unspecified-high, T3 quick, T4 deep, T5 quick
- **Wave 2**: T6 deep, T7 deep, T8 unspecified-high, T9 quick, T10 unspecified-high
- **Wave 3**: T11 visual-engineering, T12 visual-engineering, T13 quick, T14 unspecified-high
- **Wave 4**: T15 unspecified-high, T16 unspecified-high, T17 deep
- **Final**: F1 oracle, F2 unspecified-high, F3 unspecified-high(+playwright), F4 deep

---

## TODOs

- [x] 1. 定义 L4 领域模型与契约（TDD）

  **What to do**:
  - 先写失败测试：验证新增 Layer.L4 与 CharacterProfile/Relationship/StateChange/ChapterEvent 模型序列化。
  - 在 `backend/models/__init__.py` 增加 L4 相关枚举与 Pydantic 模型，含 `override_source`、`confidence`、`provenance` 字段。
  - 保持对现有 L1/L2/L3 与 EntityState/EventEdge 的兼容。

  **Must NOT do**:
  - 不修改现有 L1/L2/L3 语义。
  - 不引入前端专用字段到后端核心模型。

  **Recommended Agent Profile**:
  - **Category**: `quick`（模型契约与测试定义）
  - **Skills**: `superpowers/test-driven-development`, `superpowers/verification-before-completion`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 2,3,4,6,7
  - **Blocked By**: None

  **References**:
  - `backend/models/__init__.py` - 现有 Layer/EntityState/EventEdge 定义风格。
  - `backend/tests/test_api_smoke.py` - API/模型兼容测试风格。

  **Acceptance Criteria**:
  - [x] 新模型单测先失败后通过。
  - [x] `python -m pytest -v backend/tests -k "l4 or profile"` PASS。

  **QA Scenarios**:
  ```
  Scenario: L4 模型序列化成功（happy）
    Tool: Bash (pytest)
    Steps:
      1. 运行新增模型单测
      2. 断言包含 Layer.L4 和 CharacterProfile JSON round-trip
    Expected Result: 新增测试全部通过
    Evidence: .sisyphus/evidence/task-1-model-serialization.txt

  Scenario: 非法字段被拒绝（negative）
    Tool: Bash (pytest)
    Steps:
      1. 用缺少必填字段构造 CharacterProfile
      2. 断言抛出 ValidationError
    Expected Result: 校验错误信息包含缺失字段
    Evidence: .sisyphus/evidence/task-1-invalid-model-error.txt
  ```

- [x] 2. 扩展 SQLite/MemoryStore 支持 L4 持久化（TDD）

  **What to do**:
  - 先写失败测试：L4 profile CRUD、去重 key、override/provenance 持久化。
  - 在 `backend/memory/__init__.py` 增加 L4 表或扩展现有结构（推荐独立表），实现 add/get/list/upsert。
  - 增加 deterministic id/hash 规则（project + character + relation/event hash）。

  **Must NOT do**:
  - 不破坏 `memory_items/entities/events` 既有读写。

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `superpowers/test-driven-development`, `superpowers/systematic-debugging`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 6,7,15,16
  - **Blocked By**: 1

  **References**:
  - `backend/memory/__init__.py` - MemoryStore schema/init/CRUD 模式。
  - `backend/models/__init__.py` - 数据模型对齐。

  **Acceptance Criteria**:
  - [x] L4 CRUD 测试通过。
  - [x] 并发 upsert 不产生重复 profile（同 deterministic id）。

  **QA Scenarios**:
  ```
  Scenario: Profile upsert + query（happy）
    Tool: Bash (pytest)
    Steps:
      1. 插入 profile
      2. 再次 upsert 同角色不同字段
      3. 读取并断言字段更新且 ID 不变
    Expected Result: 单条 profile 被更新非重复
    Evidence: .sisyphus/evidence/task-2-upsert.txt

  Scenario: 重复关系去重（negative）
    Tool: Bash (pytest)
    Steps:
      1. 写入同章节同关系重复输入
      2. 断言存储只保留一条（hash 去重）
    Expected Result: 重复关系未膨胀
    Evidence: .sisyphus/evidence/task-2-dedupe.txt
  ```

- [x] 3. 新增 L4 API 契约与查询端点（TDD）

  **What to do**:
  - 先写 API 失败测试：`GET /api/projects/{id}/profiles`、`GET /api/projects/{id}/profiles/{character_id}`。
  - 在 `backend/api/main.py` 增加响应 DTO 与路由，支持分页/过滤（name/chapter）。
  - 保持旧端点兼容，避免破坏现有前端调用。

  **Must NOT do**:
  - 不变更现有 `/api/entities/{project_id}` 与 `/api/events/{project_id}` 的返回结构。

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `superpowers/test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 9,10,11,12
  - **Blocked By**: 1

  **References**:
  - `backend/api/main.py` - 现有 API 注册和响应风格。
  - `backend/tests/test_api_smoke.py` - 接口 smoke 测试风格。

  **Acceptance Criteria**:
  - [x] 新端点测试通过（200/404/empty）。

  **QA Scenarios**:
  ```
  Scenario: 查询项目 profiles（happy）
    Tool: Bash (pytest + curl)
    Steps:
      1. 准备测试项目 profile 数据
      2. GET /api/projects/{id}/profiles
      3. 断言返回数组含 overview/personality 字段
    Expected Result: 响应结构符合 DTO
    Evidence: .sisyphus/evidence/task-3-list-profiles.json

  Scenario: 查询不存在角色（negative）
    Tool: Bash (curl)
    Steps:
      1. GET /api/projects/{id}/profiles/non-exist
      2. 断言 status=404
    Expected Result: 正确错误码与 detail
    Evidence: .sisyphus/evidence/task-3-not-found.json
  ```

- [x] 4. 定义 LLM 抽取规范、解析与校验器（TDD）

  **What to do**:
  - 先写失败测试：LLM 输出不完整/错字段时 parser 可兜底。
  - 新增 extraction spec（JSON schema + prompt contract）和 parser validator。
  - 规范输出字段：character, relationships, state_changes, chapter_events, confidence。

  **Must NOT do**:
  - 不在前端定义抽取规则。

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `superpowers/test-driven-development`, `superpowers/systematic-debugging`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 6
  - **Blocked By**: 1

  **References**:
  - `backend/core/llm_client.py` - 现有 chat/embedding 调用方式。
  - `backend/api/main.py` - 当前章节完稿链路与文本上下文来源。

  **Acceptance Criteria**:
  - [x] 对 malformed LLM 输出有稳定降级结果。

  **QA Scenarios**:
  ```

- [x] 5. 增加 L4 运行时配置与 feature wiring（TDD）

  **What to do**:
  - 先写失败测试：L4 开关、图谱开关和抽取开关可独立启停。
  - 后端配置增加 `L4_PROFILE_ENABLED`、`L4_AUTO_EXTRACT_ENABLED`。
  - 前端配置调整 `GRAPH_FEATURE_ENABLED` 默认策略（按环境开启）。

  **Must NOT do**:
  - 不把 L4 与图谱开关强耦合成“全开全关”。

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `superpowers/test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 8,13
  - **Blocked By**: None

  **References**:
  - `frontend/src/config/features.ts` - 现有 feature flag 解析。
  - `backend/api/main.py` settings/env 区域。

  **Acceptance Criteria**:
  - [x] 开关关闭时无 L4 副作用；开启时流程正常。

  **QA Scenarios**:
  ```
  Scenario: 开关开启路径（happy）
    Tool: Bash (pytest)
    Steps:
      1. 设置 L4_PROFILE_ENABLED=true
      2. 触发章节完成流程
      3. 断言 L4 数据写入
    Expected Result: L4 写入成功
    Evidence: .sisyphus/evidence/task-5-flag-on.txt

  Scenario: 开关关闭路径（negative）
    Tool: Bash (pytest)
    Steps:
      1. 设置 L4_PROFILE_ENABLED=false
      2. 触发同流程
      3. 断言无 L4 写入且无异常
    Expected Result: 流程退化正常
    Evidence: .sisyphus/evidence/task-5-flag-off.txt
  ```

- [x] 6. 实现 LLM 角色档案抽取服务（TDD）

  **What to do**:
  - 先写失败测试：给定章节文本可生成 profile payload。
  - 新增 service（建议 `backend/services/character_profile_extraction.py`）调用 `LLMClient.chat`。
  - 输出标准化数据并附 `confidence/provenance`。

  **Must NOT do**:
  - 不在 API controller 内堆叠抽取逻辑。

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `superpowers/test-driven-development`, `superpowers/systematic-debugging`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 7,8,9
  - **Blocked By**: 1,2,4

  **References**:
  - `backend/core/llm_client.py` - 统一 LLM 调用入口。
  - `backend/services/memory_context.py` - 章节上下文组装可复用。

  **Acceptance Criteria**:
  - [x] 抽取服务集成测试通过（mock LLM + real schema validation）。

  **QA Scenarios**:
  ```
  Scenario: 章节文本抽取 profile（happy）
    Tool: Bash (pytest)
    Steps:
      1. mock LLM 返回合法档案 JSON
      2. 调用 extraction service
      3. 断言产出 profiles/relationships/state_changes 非空
    Expected Result: 结构化结果可直接入库
    Evidence: .sisyphus/evidence/task-6-extraction-success.txt

  Scenario: LLM 超时/异常（negative）
    Tool: Bash (pytest)
    Steps:
      1. mock LLM 抛 timeout
      2. 调用 service
      3. 断言返回 fallback + error provenance
    Expected Result: 无崩溃，流程可继续
    Evidence: .sisyphus/evidence/task-6-extraction-timeout.txt
  ```

- [x] 7. 实现 merge 引擎（override 优先 + 去重）

  **What to do**:
  - 先写失败测试：用户已编辑字段在重跑后不被覆盖。
  - 实现字段级 merge：`user_override > llm_extracted`。
  - 实现关系与事件 dedupe（characterId/chapter/type/hash）。

  **Must NOT do**:
  - 不采用全量覆盖策略。

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `superpowers/test-driven-development`, `superpowers/systematic-debugging`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 8,10,11,12,15
  - **Blocked By**: 1,2,6

  **References**:
  - `backend/memory/__init__.py` - 现有 upsert 模式。
  - 本计划 Metis guardrails - source-of-truth 与 dedupe 约束。

  **Acceptance Criteria**:
  - [x] override 字段在任意重跑后保持不变。
  - [x] 重复关系/事件不膨胀。

  **QA Scenarios**:
  ```
  Scenario: override 保持（happy）
    Tool: Bash (pytest)
    Steps:
      1. 写入用户 personality override
      2. 执行手动重跑
      3. 断言 personality 仍为用户版本
    Expected Result: override 优先
    Evidence: .sisyphus/evidence/task-7-override-win.txt

  Scenario: 全量覆盖回归（negative）
    Tool: Bash (pytest)
    Steps:
      1. 构造会覆盖用户字段的 LLM 返回
      2. 执行 merge
      3. 断言测试失败（若被覆盖）
    Expected Result: 覆盖被阻止
    Evidence: .sisyphus/evidence/task-7-no-full-replace.txt
  ```

- [x] 8. 接入章节完稿自动触发 L4 更新（TDD）

  **What to do**:
  - 先写失败集成测试：章节状态变为 completed 后触发 L4 更新。
  - 在章节完成/写回路径接入 extraction + merge + store。
  - 增加失败隔离：抽取失败不阻断章节完成主流程。

  **Must NOT do**:
  - 不把 L4 失败升级为章节创建/更新失败。

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `superpowers/test-driven-development`, `superpowers/systematic-debugging`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 17
  - **Blocked By**: 5,6,7

  **References**:
  - `backend/api/main.py` - chapter 完稿与 memory refresh 路径。
  - `backend/services/memory_context.py` - 现有章节末写回逻辑。

  **Acceptance Criteria**:
  - [x] 章节完成后自动出现 L4 更新记录。
  - [x] L4 失败时章节流程仍成功。

  **QA Scenarios**:
  ```

- [x] 9. 增加 L4 手动重跑 API（TDD）

  **What to do**:
  - 先写失败测试：`POST /api/projects/{id}/profiles/rebuild`。
  - 支持按全项目、按章节区间、按角色名过滤重跑。
  - 返回重跑统计（processed/updated/skipped/errors）。

  **Must NOT do**:
  - 不把手动重跑实现为前端拼接多次单章请求。

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `superpowers/test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 14,17
  - **Blocked By**: 3,6

  **References**:
  - `backend/api/main.py` - API route + request model 风格。

  **Acceptance Criteria**:
  - [x] 手动重跑支持参数化范围。

  **QA Scenarios**:
  ```
  Scenario: 全量手动重跑（happy）
    Tool: Bash (curl)
    Steps:
      1. POST /api/projects/{id}/profiles/rebuild
      2. 断言返回 processed>0
    Expected Result: 任务完成且统计字段完整
    Evidence: .sisyphus/evidence/task-9-manual-rebuild.json

  Scenario: 非法范围参数（negative）
    Tool: Bash (curl)
    Steps:
      1. 提交 start_chapter > end_chapter
      2. 断言 400 与错误说明
    Expected Result: 参数校验生效
    Evidence: .sisyphus/evidence/task-9-invalid-range.json
  ```

- [x] 10. 图谱数据 API 切换到 L4 数据源（TDD）

  **What to do**:
  - 先写失败测试：图谱节点和边来自 L4 profile + relationships。
  - 新增/改造后端图谱接口，统一输出前端可消费结构。
  - 保留向后兼容字段，避免前端一次性大改风险。

  **Must NOT do**:
  - 不继续依赖旧规则提取作为主数据源。

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `superpowers/test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 12,14
  - **Blocked By**: 3,7

  **References**:
  - `frontend/src/pages/KnowledgeGraphPage.tsx` - 期望数据形状（EntityNode/EventEdge）。
  - `backend/api/main.py` - entities/events 现有接口实现。

  **Acceptance Criteria**:
  - [x] 图谱 API 响应含稳定节点 ID 与关系边。

  **QA Scenarios**:
  ```
  Scenario: L4 图谱数据返回（happy）
    Tool: Bash (curl)
    Steps:
      1. GET 图谱数据端点
      2. 断言 nodes/edges 数量 > 0 且 ID 稳定
    Expected Result: 数据可直接驱动 ReactFlow
    Evidence: .sisyphus/evidence/task-10-graph-data.json

  Scenario: 无 L4 项目兼容（negative）
    Tool: Bash (curl)
    Steps:
      1. 用老项目请求图谱数据
      2. 断言返回空数组而非 500
    Expected Result: backward compatibility 成立
    Evidence: .sisyphus/evidence/task-10-legacy-empty.json
  ```

- [x] 11. 记忆浏览器新增 L4 档案展示（TDD）

  **What to do**:
  - 先写失败前端测试：能看到 L4 层、角色卡、关系与状态变化。
  - 在 `MemoryBrowserPage.tsx` 新增 L4 layer option + UI section。
  - 加入“手动重跑”入口与执行反馈。

  **Must NOT do**:
  - 不移除现有 L1/L2/L3 浏览能力。

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: `frontend-ui-ux`, `superpowers/test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 14
  - **Blocked By**: 3,7

  **References**:
  - `frontend/src/pages/MemoryBrowserPage.tsx` - 现有分层 UI 与交互模式。
  - `frontend/src/pages/__tests__/MemoryBrowserPage.test.tsx` - 现有测试基线。

  **Acceptance Criteria**:
  - [x] L4 层可筛选、可展开、可查看关系与状态变化。

  **QA Scenarios**:
  ```
  Scenario: 浏览 L4 档案（happy）
    Tool: Playwright
    Steps:
      1. 打开 /project/{id}/memory
      2. 切换筛选到 L4
      3. 展开角色卡，断言存在“性格/关系/状态变化”字段
    Expected Result: L4 信息完整可读
    Evidence: .sisyphus/evidence/task-11-memory-l4.png

  Scenario: 手动重跑失败提示（negative）
    Tool: Playwright
    Steps:
      1. mock 重跑接口 500
      2. 点击“重跑 L4”
      3. 断言 toast 显示失败信息
    Expected Result: 错误可见且页面不崩溃
    Evidence: .sisyphus/evidence/task-11-rebuild-error.png
  ```

- [x] 12. 知识图谱页面改造为 L4 驱动并清理硬规则依赖（TDD）

  **What to do**:
  - 先写失败测试：图谱展示依赖 API 数据，不依赖前端 normalize 规则。
  - 在 `KnowledgeGraphPage.tsx` 移除/旁路 `normalizeRoleName` 规则链作为主路径。
  - 以 L4 relationships 构建 edges，保留 hover/高亮/timeline 交互。

  **Must NOT do**:
  - 不新增另一套 regex/stopword 作为主逻辑。

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: `frontend-ui-ux`, `superpowers/test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 14
  - **Blocked By**: 3,7,10

  **References**:
  - `frontend/src/pages/KnowledgeGraphPage.tsx` - 节点/边构建与交互逻辑。
  - `frontend/src/config/features.ts` - 图谱开关。

  **Acceptance Criteria**:
  - [x] 图谱能渲染 L4 角色关系并支持高亮。
  - [x] 去掉对旧规则链的硬依赖。

  **QA Scenarios**:
  ```

- [x] 13. 恢复图谱入口与导航曝光（TDD）

  **What to do**:
  - 先写失败测试：Sidebar/AppLayout/ProjectDetail 出现图谱入口。
  - 调整 feature flag 与导航配置，保证可控启用。
  - 验证路由可达与回退行为。

  **Must NOT do**:
  - 不硬编码永久开启（需保留环境可控能力）。

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `superpowers/test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 14
  - **Blocked By**: 5

  **References**:
  - `frontend/src/components/layout/Sidebar.tsx`
  - `frontend/src/components/layout/AppLayout.tsx`
  - `frontend/src/pages/ProjectDetail.tsx`

  **Acceptance Criteria**:
  - [x] 入口可见、可点、路由正确。

  **QA Scenarios**:
  ```
  Scenario: 导航入口可达（happy）
    Tool: Playwright
    Steps:
      1. 进入项目页
      2. 点击“知识图谱/图谱”入口
      3. 断言 URL 包含 /graph
    Expected Result: 路由跳转成功
    Evidence: .sisyphus/evidence/task-13-nav-graph.png

  Scenario: 开关关闭时入口隐藏（negative）
    Tool: Playwright
    Steps:
      1. 关闭图谱开关环境
      2. 打开项目页
      3. 断言入口不可见
    Expected Result: feature flag 生效
    Evidence: .sisyphus/evidence/task-13-nav-hidden.png
  ```

- [x] 14. 前端测试补全（Memory + Graph）

  **What to do**:
  - 补齐 MemoryBrowser L4 渲染、手动重跑交互、错误提示测试。
  - 补齐 GraphPage L4 数据渲染、高亮、空态、开关行为测试。
  - 修正 mock API 以覆盖新端点。

  **Must NOT do**:
  - 不删除既有测试来“换通过”。

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `superpowers/test-driven-development`, `superpowers/systematic-debugging`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 17
  - **Blocked By**: 9,10,11,12,13

  **References**:
  - `frontend/src/pages/__tests__/MemoryBrowserPage.test.tsx`
  - `frontend/src/pages/KnowledgeGraphPage.tsx`

  **Acceptance Criteria**:
  - [x] 新增前端单测通过且覆盖关键路径。

  **QA Scenarios**:
  ```
  Scenario: 前端测试集通过（happy）
    Tool: Bash (vitest)
    Steps:
      1. 运行 npm run test
      2. 断言新增测试全部 PASS
    Expected Result: 0 fail
    Evidence: .sisyphus/evidence/task-14-frontend-tests.txt

  Scenario: API mock 缺失回归（negative）
    Tool: Bash (vitest)
    Steps:
      1. 临时模拟缺失新端点返回
      2. 断言测试明确失败并提示 mock 缺口
    Expected Result: 能定位失败原因
    Evidence: .sisyphus/evidence/task-14-mock-gap.txt
  ```

- [x] 15. 导出能力纳入 L4 + override + provenance（TDD）

  **What to do**:
  - 先写失败测试：导出包包含 L4 数据文件/字段。
  - 在 `backend/api/main.py` export 逻辑中纳入 L4 存储文件与元数据。
  - 定义导出结构版本号（建议 `export_version`）。

  **Must NOT do**:
  - 不仅导出“纯文本章节”而遗漏 L4 结构化数据。

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `superpowers/test-driven-development`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: 16,17
  - **Blocked By**: 2,7

  **References**:
  - `backend/api/main.py` `/api/projects/{id}/export`
  - `backend/tests/test_export_import.py`

  **Acceptance Criteria**:
  - [x] 导出 zip 中可找到 L4 与 override/provenance。

  **QA Scenarios**:
  ```
  Scenario: 导出含 L4（happy）
    Tool: Bash (pytest)
    Steps:
      1. 构造含 L4 数据项目
      2. 调用导出接口并解压
      3. 断言 L4 文件/字段存在
    Expected Result: 数据完整导出
    Evidence: .sisyphus/evidence/task-15-export-l4.txt

  Scenario: 无 L4 项目导出（negative）
    Tool: Bash (pytest)
    Steps:
      1. 老项目执行导出
      2. 断言仍成功且结构合法
    Expected Result: backward compatibility
    Evidence: .sisyphus/evidence/task-15-export-legacy.txt
  ```

- [x] 16. 导入能力恢复 L4 并保持兼容（TDD）

  **What to do**:
  - 先写失败测试：导入新/旧包均成功。
  - 在 import 路径中恢复 L4 数据、override、provenance。
  - 对缺失字段做默认填充，防止旧包报错。

  **Must NOT do**:
  - 不要求“只有新格式包才能导入”。

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `superpowers/test-driven-development`, `superpowers/systematic-debugging`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: 17
  - **Blocked By**: 2,15

  **References**:
  - `backend/api/main.py` `/api/projects/import`
  - `backend/tests/test_export_import.py`

  **Acceptance Criteria**:
  - [x] 新老包导入都成功，L4 在新包中可恢复。

  **QA Scenarios**:
  ```
  Scenario: 导入新格式包（happy）
    Tool: Bash (pytest)
    Steps:
      1. 导出含 L4 包
      2. 导入到新项目
      3. 断言 profiles 与 override 恢复
    Expected Result: L4 完整恢复
    Evidence: .sisyphus/evidence/task-16-import-new.txt

  Scenario: 导入旧格式包（negative）
    Tool: Bash (pytest)
    Steps:
      1. 导入不含 L4 的历史包
      2. 断言导入成功且 L4 默认为空
    Expected Result: 无兼容性崩溃
    Evidence: .sisyphus/evidence/task-16-import-legacy.txt
  ```

- [x] 17. Round-trip 完整性与跨层集成回归（TDD）

  **What to do**:
  - 编写端到端集成测试：完稿触发 → L4 更新 → 图谱可视化数据 → 导出 → 导入 → 再查询一致。
  - 增加性能守卫：大章节/多角色时图谱接口响应阈值。
  - 回归老路径：L1/L2/L3 记忆检索与导入导出未破坏。

  **Must NOT do**:
  - 不跳过证据采集。

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `superpowers/test-driven-development`, `superpowers/verification-before-completion`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 收敛
  - **Blocks**: F1,F2,F3,F4
  - **Blocked By**: 8,9,14,15,16

  **References**:
  - `backend/tests/test_export_import.py`
  - `backend/tests/test_api_smoke.py`
  - `frontend/e2e/` 现有 E2E 模式

  **Acceptance Criteria**:
  - [x] Round-trip 场景全通过。
  - [x] 关键响应时延满足基线阈值（计划中定义具体阈值）。

  **QA Scenarios**:
  ```
  Scenario: 全链路 round-trip（happy）
    Tool: Bash + Playwright
    Steps:
      1. 完成章节触发 L4
      2. 校验图谱页展示
      3. 导出并导入
      4. 再次校验 L4 与图谱一致
    Expected Result: 数据保真
    Evidence: .sisyphus/evidence/task-17-roundtrip.txt

  Scenario: 高负载角色集（negative）
    Tool: Bash (pytest benchmark/integration)
    Steps:
      1. 构造 200+ 关系边数据
      2. 请求图谱 API
      3. 断言无 500 且延迟在阈值内
    Expected Result: 性能可接受
    Evidence: .sisyphus/evidence/task-17-performance.txt
  ```

  Scenario: 图谱渲染 L4 关系（happy）
    Tool: Playwright
    Steps:
      1. 打开 /project/{id}/graph
      2. 等待节点渲染
      3. 点击节点，断言相邻边高亮
    Expected Result: 关系图交互正常
    Evidence: .sisyphus/evidence/task-12-graph-highlight.png

  Scenario: 空图谱项目（negative）
    Tool: Playwright
    Steps:
      1. 使用无 L4 数据项目进入图谱页
      2. 断言显示空态文案而非报错
    Expected Result: 空态稳定
    Evidence: .sisyphus/evidence/task-12-graph-empty.png
  ```

  Scenario: 完稿自动触发（happy）
    Tool: Bash (pytest + curl)
    Steps:
      1. 完成一章并调用完稿接口
      2. 读取 /api/projects/{id}/profiles
      3. 断言新增角色事件条目
    Expected Result: 自动更新成功
    Evidence: .sisyphus/evidence/task-8-auto-trigger.json

  Scenario: 抽取失败不中断（negative）
    Tool: Bash (pytest)
    Steps:
      1. mock extraction service 异常
      2. 执行完稿
      3. 断言完稿接口仍返回成功
    Expected Result: 失败被隔离并记录日志
    Evidence: .sisyphus/evidence/task-8-failure-isolation.txt
  ```

  Scenario: 解析合法 LLM JSON（happy）
    Tool: Bash (pytest)
    Steps:
      1. 输入合法 mock JSON
      2. 断言 parser 输出标准化结构
    Expected Result: 输出字段齐全且类型正确
    Evidence: .sisyphus/evidence/task-4-parse-valid.txt

  Scenario: 解析非法 JSON（negative）
    Tool: Bash (pytest)
    Steps:
      1. 输入截断/缺字段 JSON
      2. 断言 fallback 结构被返回并附错误标记
    Expected Result: 无崩溃，返回可写入最小结构
    Evidence: .sisyphus/evidence/task-4-parse-invalid.txt
  ```

---

## Final Verification Wave (MANDATORY)

- [x] F1. **Plan Compliance Audit** — `oracle`
  对照本计划逐条核验 Must Have / Must NOT Have；检查 `.sisyphus/evidence/` 证据文件是否完整。

- [x] F2. **Code Quality Review** — `unspecified-high`
  运行 `python -m pytest -v`、`npm run test`、`npm run lint`、`npm run build`，排查类型与风格问题。

- [x] F3. **Real QA Replay** — `unspecified-high` (+ `playwright`)
  按各任务 QA 场景执行，覆盖自动提取、手动重跑、图谱展示、导入导出回放。

- [x] F4. **Scope Fidelity Check** — `deep`
  校验每个任务产出是否严格在范围内，确认没有引入额外平台化功能。

---

## Commit Strategy

- **1**: `feat(memory): add l4 character profile schema and store`
- **2**: `feat(extraction): implement llm profile extraction and merge engine`
- **3**: `feat(graph): revive knowledge graph with l4 source`
- **4**: `feat(io): support l4 in export and import roundtrip`
- **5**: `test(l4): add backend/frontend roundtrip and integration coverage`

---

## Success Criteria

### Verification Commands
```bash
cd backend && python -m pytest -v
cd frontend && npm run test
cd frontend && npm run lint && npm run build
```

### Final Checklist
- [x] 所有 Must Have 实现且可自动验证
- [x] 所有 Must NOT Have 未出现
- [x] 自动提取 + 手动重跑均可用
- [x] 图谱页面复活并基于 L4 数据
- [x] 导出导入 round-trip 保真（含 override/provenance）
