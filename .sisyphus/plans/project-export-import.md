# 项目级导出/导入功能

## TL;DR

> **Quick Summary**: 为 Morpheus 添加完整的项目级导出/导入功能。导出将项目所有数据（含记忆系统、章节、轨迹、SQLite 数据库）打包为 zip，排除向量索引；导入接受 zip 文件，始终创建新项目（新 ID），自动重建索引。UI 入口统一放在项目列表页，与现有的章节/整书文本导出完全分离。
> 
> **Deliverables**:
> - 后端导出端点（排除 lancedb 的 zip 下载）
> - 后端导入端点（zip 上传 → 新项目创建）
> - 前端项目列表页的导出/导入 UI
> - 对应的测试覆盖
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1+2 (parallel) → Task 3 → Task 4 (verification)

---

## Context

### Original Request
用户需要一个可以导出/导入整个项目的功能，包括文章内容、三层记忆以及各种数据。这个导出导入要和原本的导出整书、整章区分开。

### Interview Summary
**Key Discussions**:
- 导入行为：始终创建新项目（分配新 ID），不覆盖已有项目
- UI 入口：项目列表页统一管理导出和导入
- 数据库策略：导出包含 novelist.db，不包含 lancedb 向量索引；导入后重建索引

**Research Findings**:
- 后端已有 `GET /api/projects/{project_id}/export` 端点，但它 zip 整个目录（含 lancedb），且前端从未调用
- 前端现有导出仅限 `ChapterExportMenu`（Markdown/TXT 纯文本），通过 `exportService.ts` 实现
- 项目数据结构：project.json, chapters/*.json, traces/*.json, memory/{L1,L2,L3}/*.md, OPEN_THREADS.md, logs/daily/*.md, novelist.db, index/lancedb/
- novelist.db 表中无 project_id 列（按项目目录隔离），可直接复制
- AgentTrace.chapter_id 是整数（章节号），非 UUID，简化了导入逻辑
- Chapter UUID 全局唯一，导入时保留原 UUID，仅更新 project_id 字段
- `sync_file_memories()` 可从 markdown 文件重建 SQLite FTS 索引
- LanceDB 向量索引在首次搜索时通过 `vector_index_signatures` 检查自动重建

### Metis Review
**Identified Gaps** (addressed):
- 章节 UUID 策略：保留原 UUID，仅更新 project_id 字段（避免复杂的 ID 重映射）
- 导入后内存状态注册：必须手动注册到 projects/chapters/traces 全局字典，不能依赖重启
- `fanqie_book_id` 字段：导入时清空（平台特定 ID 对新项目无意义）
- Zip 安全：路径遍历保护 + zip 炸弹保护（500MB 上限）
- 现有导出端点处理：修改现有端点以排除 lancedb（前端从未调用，无破坏性变更风险）

---

## Work Objectives

### Core Objective
为 Morpheus 添加完整的项目级数据导出/导入功能，使用户可以备份、迁移和分享整个项目（含所有创作数据和记忆系统）。

### Concrete Deliverables
- `GET /api/projects/{project_id}/export` 端点修改（排除 lancedb）
- `POST /api/projects/import` 新端点
- `ProjectList.tsx` 中的导出/导入 UI 组件
- `useProjectStore.ts` 中的导入 action
- 后端测试 + 前端测试

### Definition of Done
- [ ] 导出的 zip 不包含 `index/` 目录
- [ ] 导出的 zip 包含 novelist.db、project.json、chapters/、traces/、memory/、logs/
- [ ] 导入 zip 后创建新项目，新 project_id，原章节 UUID 保留
- [ ] 导入后项目立即可通过 API 访问（无需重启）
- [ ] 导入后记忆系统可正常查询
- [ ] 项目列表页显示"导入项目"按钮和每个项目卡片上的"导出"按钮
- [ ] 现有的 ChapterExportMenu 和 exportService.ts 完全不受影响

### Must Have
- 导出排除 lancedb 向量索引（体积过大）
- 导入始终创建新项目（新 UUID）
- 导入时保留章节 UUID，仅更新 project_id
- 导入后自动注册到内存状态 + 重建 FTS 索引
- Zip 安全验证（路径遍历 + 大小限制）
- 导入时清空 fanqie_book_id
- UI 与现有文本导出视觉区分

### Must NOT Have (Guardrails)
- 不修改 `ChapterExportMenu` 组件
- 不修改 `exportService.ts`
- 不修改任何现有的章节/整书文本导出流程
- 不添加批量导出（多项目同时导出）
- 不添加导出格式选项（固定内容集）
- 不添加导入预览功能
- 不添加 SSE 进度推送
- 不添加导入历史/审计日志
- 不在 ProjectDetail 页面添加项目级导出入口（仅 ProjectList）
- 不阻塞导入响应等待向量索引重建

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (Vitest + Playwright for frontend, pytest for backend)
- **Automated tests**: Tests-after
- **Framework**: pytest (backend), vitest (frontend)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **API/Backend**: Use Bash (curl) — Send requests, assert status + response fields
- **Frontend/UI**: Use Playwright (playwright skill) — Navigate, interact, assert DOM, screenshot

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — backend endpoints, PARALLEL):
├── Task 1: Backend export endpoint modification [quick]
└── Task 2: Backend import endpoint [deep]

Wave 2 (After Wave 1 — frontend + integration):
├── Task 3: Frontend export/import UI on ProjectList [visual-engineering]
└── Task 4: Backend + frontend tests [unspecified-high]

Wave FINAL (After ALL tasks — verification):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1+2 → Task 3 → Task 4 → F1-F4
Parallel Speedup: ~40% faster than sequential
Max Concurrent: 2 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 | — | 3, 4 |
| 2 | — | 3, 4 |
| 3 | 1, 2 | 4 |
| 4 | 1, 2, 3 | F1-F4 |
| F1-F4 | 4 | — |

### Agent Dispatch Summary

- **Wave 1**: 2 tasks — T1 → `quick`, T2 → `deep`
- **Wave 2**: 2 tasks — T3 → `visual-engineering`, T4 → `unspecified-high`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [ ] 1. Backend: 修改导出端点（排除 lancedb）

  **What to do**:
  - 修改 `backend/api/main.py` 中的 `export_project` 函数（约第 3003 行）
  - 当前实现直接 `shutil.make_archive` 整个项目目录，需要改为先 `shutil.copytree` 到临时目录并排除 `index/` 目录，再打包
  - 使用 `shutil.copytree(src, dst, ignore=shutil.ignore_patterns('index', 'graph'))` 排除 lancedb 向量索引和空的 graph 目录
  - 保留现有的 `cleanup_export_file` + `BackgroundTask` 清理模式
  - 保留现有的 `FileResponse` 返回模式和文件命名逻辑

  **Must NOT do**:
  - 不改变端点路径 (`/api/projects/{project_id}/export`)
  - 不改变响应格式（仍然是 zip FileResponse）
  - 不添加任何查询参数或选项
  - 不触碰 `sanitize_narrative_for_export` 或任何文本导出相关代码

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 单文件修改，逻辑简单（copytree + ignore pattern）
  - **Skills**: [`superpowers/verification-before-completion`]
    - `superpowers/verification-before-completion`: 确保导出 zip 内容正确

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Tasks 3, 4
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `backend/api/main.py:3003-3029` — 现有 export_project 函数，需要修改的目标代码
  - `backend/api/main.py:443-455` — cleanup_export_file 清理函数，复用此模式

  **API/Type References**:
  - `backend/api/main.py:3017` — safe_name 文件名清理逻辑，保持不变

  **External References**:
  - Python docs: `shutil.copytree` ignore 参数 — https://docs.python.org/3/library/shutil.html#shutil.copytree

  **WHY Each Reference Matters**:
  - `main.py:3003-3029`: 这是要修改的目标函数，需要理解当前的 zip 打包逻辑
  - `main.py:443-455`: cleanup 模式需要扩展以清理 copytree 产生的额外临时目录

  **Acceptance Criteria**:
  - [ ] `GET /api/projects/{id}/export` 返回 200 + zip 文件
  - [ ] zip 内不包含 `index/` 目录: `unzip -l export.zip | grep -c 'index/'` → 0
  - [ ] zip 内包含 novelist.db: `unzip -l export.zip | grep -c 'novelist.db'` → 1
  - [ ] zip 内包含 project.json, chapters/, traces/, memory/, logs/
  - [ ] 临时文件在下载后被清理（BackgroundTask）

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 导出 zip 排除 lancedb
    Tool: Bash (curl + unzip)
    Preconditions: 后端运行中，至少有一个项目存在
    Steps:
      1. curl -s -o /tmp/export-test.zip http://localhost:8000/api/projects/{project_id}/export
      2. unzip -l /tmp/export-test.zip | grep -c 'index/'
      3. unzip -l /tmp/export-test.zip | grep -c 'novelist.db'
      4. unzip -l /tmp/export-test.zip | grep -c 'project.json'
      5. unzip -l /tmp/export-test.zip | grep -c 'chapters/'
      6. unzip -l /tmp/export-test.zip | grep -c 'memory/'
    Expected Result: Step 2 → 0, Steps 3-6 → ≥1
    Failure Indicators: index/ 出现在 zip 中，或必要文件缺失
    Evidence: .sisyphus/evidence/task-1-export-zip-contents.txt

  Scenario: 导出不存在的项目返回 404
    Tool: Bash (curl)
    Preconditions: 后端运行中
    Steps:
      1. curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/projects/nonexistent-id/export
    Expected Result: HTTP 404
    Failure Indicators: 返回 200 或 500
    Evidence: .sisyphus/evidence/task-1-export-404.txt
  ```

  **Evidence to Capture:**
  - [ ] task-1-export-zip-contents.txt — unzip -l 输出
  - [ ] task-1-export-404.txt — 404 响应

  **Commit**: YES
  - Message: `feat(api): exclude lancedb from project export zip`
  - Files: `backend/api/main.py`
  - Pre-commit: `cd backend && python -m pytest tests/ -v -x`

- [ ] 2. Backend: 添加项目导入端点

  **What to do**:
  - 在 `backend/api/main.py` 中添加 `POST /api/projects/import` 端点
  - 接受 `multipart/form-data`，字段名 `file`，类型为 `UploadFile`
  - 实现以下步骤：
    1. **大小验证**: 将上传文件写入临时文件，检查大小 ≤ 500MB，超出返回 HTTP 413
    2. **Zip 验证**: 验证文件是有效的 zip，否则返回 HTTP 400
    3. **安全验证**: 检查 zip 内所有条目路径，拒绝任何包含 `..` 或绝对路径的条目（路径遍历保护），返回 HTTP 400
    4. **解压到临时目录**: 使用 `tempfile.mkdtemp(prefix='novelist-import-')` 创建临时目录，解压 zip
    5. **自动检测根目录**: zip 可能直接包含文件，也可能包含一个顶层目录。检测 project.json 的位置来确定实际根目录
    6. **结构验证**: 确认解压目录中存在 `project.json`，否则返回 HTTP 400
    7. **生成新 ID**: `new_project_id = str(uuid4())`
    8. **更新 project.json**: 读取并解析，设置 `id = new_project_id`，清空 `fanqie_book_id = None`，更新 `updated_at`，写回
    9. **更新 chapters**: 遍历 `chapters/*.json`，更新每个文件中的 `project_id` 字段为 `new_project_id`，保留原 chapter UUID
    10. **复制到目标位置**: `shutil.copytree(extracted_root, projects_root() / new_project_id)`
    11. **注册内存状态**: 将新项目注册到 `projects` 全局字典，遍历 chapters 和 traces 注册到对应字典
    12. **重建记忆索引**: 调用 `get_or_create_store(new_project_id)` 然后 `store.sync_file_memories()`
    13. **清理临时目录**: 使用 `shutil.rmtree` 清理
    14. **返回响应**: `{"project_id": new_project_id, "name": project_name, "chapter_count": N}`
  - 如果 novelist.db 缺失，不报错 — `get_or_create_store` 会创建新的空 DB，`sync_file_memories` 会从 markdown 重建
  - 如果 memory/ 目录缺失，不报错 — `ThreeLayerMemory._ensure_directories()` 会创建默认文件

  **Must NOT do**:
  - 不覆盖已有项目（始终新 ID）
  - 不修改章节 UUID（保留原值）
  - 不阻塞响应等待向量索引重建
  - 不添加 SSE 进度推送
  - 不添加导入预览
  - 不处理 lancedb 索引重建（它会在首次搜索时自动重建）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 多步骤逻辑，涉及文件操作、安全验证、状态管理，需要仔细处理边界情况
  - **Skills**: [`superpowers/verification-before-completion`]
    - `superpowers/verification-before-completion`: 确保导入后项目可正常访问

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Tasks 3, 4
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - `backend/api/main.py:612-651` — `bootstrap_state()` 函数，展示如何从磁盘加载项目/章节/轨迹到内存字典
  - `backend/api/main.py:421-425` — `save_project()` 函数，展示如何序列化 Project 到 JSON
  - `backend/api/main.py:428-433` — `save_chapter()` 函数，展示如何序列化 Chapter 到 JSON
  - `backend/api/main.py:654-659` — `get_or_create_store()` 函数，展示如何初始化 MemoryStore
  - `backend/api/main.py:443-455` — `cleanup_export_file()` 函数，展示临时文件清理模式

  **API/Type References**:
  - `backend/models/__init__.py:97-108` — `Project` 模型定义，包含 `fanqie_book_id` 字段
  - `backend/models/__init__.py:137-155` — `Chapter` 模型定义，包含 `project_id` 字段
  - `backend/models/__init__.py:169-176` — `AgentTrace` 模型定义
  - `backend/api/main.py:301-306` — 全局字典定义 (`projects`, `chapters`, `traces`, `memory_stores`)

  **Test References**:
  - `backend/tests/` — 现有后端测试目录，新测试放在这里

  **External References**:
  - FastAPI docs: File Upload — https://fastapi.tiangolo.com/tutorial/request-files/
  - Python docs: zipfile — https://docs.python.org/3/library/zipfile.html

  **WHY Each Reference Matters**:
  - `bootstrap_state()`: 导入后需要复制相同的注册逻辑，将新项目/章节/轨迹加入全局字典
  - `Project` 模型: 需要知道哪些字段要更新（id, fanqie_book_id, updated_at）
  - `Chapter` 模型: 需要知道 project_id 字段位置以便更新
  - `get_or_create_store()`: 导入后调用此函数初始化 MemoryStore 并重建索引

  **Acceptance Criteria**:
  - [ ] `POST /api/projects/import` 接受 zip 文件，返回 200 + `{project_id, name, chapter_count}`
  - [ ] 返回的 project_id 是新生成的 UUID，与 zip 内原 ID 不同
  - [ ] 导入后 `GET /api/projects/{new_id}` 返回 200
  - [ ] 导入后 `GET /api/projects/{old_id}` 仍然返回原项目（不被覆盖）
  - [ ] 导入后章节数量与原项目一致
  - [ ] 导入后记忆查询可用
  - [ ] 上传非 zip 文件返回 400
  - [ ] 上传缺少 project.json 的 zip 返回 400
  - [ ] 上传超过 500MB 的文件返回 413

  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 正常导入 — 完整 round-trip
    Tool: Bash (curl + jq)
    Preconditions: 后端运行中，已有至少一个项目，已通过 Task 1 导出了 zip
    Steps:
      1. export_response=$(curl -s -o /tmp/roundtrip.zip -w '%{http_code}' http://localhost:8000/api/projects/{existing_id}/export)
      2. assert export_response == 200
      3. import_response=$(curl -s -X POST http://localhost:8000/api/projects/import -F 'file=@/tmp/roundtrip.zip')
      4. new_id=$(echo $import_response | jq -r '.project_id')
      5. assert new_id != '{existing_id}' (新 ID 不等于原 ID)
      6. curl -s http://localhost:8000/api/projects/$new_id | jq '.name' (应返回项目名)
      7. chapter_count=$(echo $import_response | jq '.chapter_count')
      8. assert chapter_count >= 0
    Expected Result: 导入成功，新项目可访问，章节数一致
    Failure Indicators: new_id 为 null，项目不可访问，章节数不匹配
    Evidence: .sisyphus/evidence/task-2-roundtrip-import.txt

  Scenario: 导入非 zip 文件返回 400
    Tool: Bash (curl)
    Preconditions: 后端运行中
    Steps:
      1. echo 'not a zip' > /tmp/bad.zip
      2. status=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8000/api/projects/import -F 'file=@/tmp/bad.zip')
      3. assert status == 400
    Expected Result: HTTP 400
    Failure Indicators: 返回 200 或 500
    Evidence: .sisyphus/evidence/task-2-bad-zip-400.txt

  Scenario: 导入缺少 project.json 的 zip 返回 400
    Tool: Bash (curl + zip)
    Preconditions: 后端运行中
    Steps:
      1. mkdir -p /tmp/no-project && echo 'test' > /tmp/no-project/test.txt
      2. cd /tmp && zip -r no-project.zip no-project/
      3. status=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8000/api/projects/import -F 'file=@/tmp/no-project.zip')
      4. assert status == 400
    Expected Result: HTTP 400
    Failure Indicators: 返回 200 或 500
    Evidence: .sisyphus/evidence/task-2-no-project-json-400.txt
  ```

  **Evidence to Capture:**
  - [ ] task-2-roundtrip-import.txt — 完整 round-trip 输出
  - [ ] task-2-bad-zip-400.txt — 非 zip 文件 400 响应
  - [ ] task-2-no-project-json-400.txt — 缺少 project.json 的 400 响应

  **Commit**: YES
  - Message: `feat(api): add project import endpoint with ID remapping`
  - Files: `backend/api/main.py`
  - Pre-commit: `cd backend && python -m pytest tests/ -v -x`

- [ ] 3. Frontend: 项目列表页导出/导入 UI
  **What to do**:
  - 修改 `frontend/src/pages/ProjectList.tsx`:
    1. **导入按钮**: 在页面顶部 `page-head` 区域（"新建项目"按钮旁边）添加"导入项目"按钮
    2. **隐藏 file input**: 添加 `<input type="file" accept=".zip" />` 隐藏元素，导入按钮点击时触发
    3. **导入流程**: 选择文件后，POST 到 `/api/projects/import` 作为 `multipart/form-data`，显示 loading 状态，成功后刷新项目列表并显示 toast
    4. **导出按钮**: 在每个项目卡片的操作区域添加"导出"按钮（与现有"删除"按钮并列）
    5. **导出流程**: 点击后通过 `window.open` 或 `<a>` 标签触发 `GET /api/projects/{id}/export` 下载
    6. **错误处理**: 导入失败时显示 error toast，包含后端返回的错误信息
  - 修改 `frontend/src/stores/useProjectStore.ts`:
    1. 添加 `importProject(file: File)` action，封装 fetch + FormData 上传逻辑
    2. 成功后自动调用 `fetchProjects()` 刷新列表
    3. 返回 `{project_id, name, chapter_count}` 响应数据
  - 修改 `frontend/src/lib/api.ts`（如需要）:
    1. 添加 `importProject` API 函数（如果 store 不直接使用 fetch）
  - 样式要求:
    1. 导入按钮使用 `btn btn-secondary` 样式（与"新建项目"的 `btn btn-primary` 区分）
    2. 导出按钮使用 `btn btn-ghost` 或类似低调样式，不抢占视觉焦点
    3. 导入中显示 loading spinner 或 disabled 状态
  **Must NOT do**:
  - 不修改 `ChapterExportMenu` 组件
  - 不修改 `exportService.ts`
  - 不在 ProjectDetail 页面添加项目级导出入口
  - 不添加批量导出功能
  - 不添加导入预览或进度条
  - 不添加拖拽上传
  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 涉及 UI 组件修改、交互流程、样式调整
  - **Skills**: [`frontend-ui-ux`, `superpowers/verification-before-completion`]
    - `frontend-ui-ux`: UI 组件设计和交互模式
    - `superpowers/verification-before-completion`: 确保 UI 正确渲染和交互
  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential after Wave 1)
  - **Blocks**: Task 4
  - **Blocked By**: Tasks 1, 2
  **References**:
  **Pattern References**:
  - `frontend/src/pages/ProjectList.tsx` — 整个文件，需要理解现有布局结构、按钮位置、项目卡片结构
  - `frontend/src/pages/ProjectDetail.tsx:33,175-203,299-300` — 现有的"整书导出"按钮实现，作为导出交互的参考（但不要修改此文件）
  - `frontend/src/components/chapter/ChapterExportMenu.tsx` — 现有导出菜单的 UI 模式参考（但不要修改此文件）
  **API/Type References**:
  - `frontend/src/stores/useProjectStore.ts` — 现有 store 结构，需要添加 importProject action
  - `frontend/src/lib/api.ts` — 现有 API 封装模式
  - `frontend/src/stores/useToastStore.ts` — toast 通知模式
  **WHY Each Reference Matters**:
  - `ProjectList.tsx`: 需要理解页面布局才能正确插入按钮位置
  - `ProjectDetail.tsx`: 展示了现有导出按钮的交互模式（loading 状态、toast 通知），可以复用相同模式
  - `useProjectStore.ts`: 需要在此添加 importProject action，必须理解现有 store 结构
  **Acceptance Criteria**:
  - [ ] 项目列表页显示"导入项目"按钮（在"新建项目"旁边）
  - [ ] 每个项目卡片显示"导出"按钮
  - [ ] 点击"导出"触发 zip 下载
  - [ ] 点击"导入项目"打开文件选择器，仅接受 .zip
  - [ ] 选择 zip 后自动上传，显示 loading 状态
  - [ ] 导入成功后项目列表自动刷新，显示 success toast
  - [ ] 导入失败时显示 error toast
  - [ ] `npx tsc --noEmit` 无类型错误
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 导出按钮触发下载
    Tool: Playwright (playwright skill)
    Preconditions: 前后端运行中，至少有一个项目
    Steps:
      1. 导航到 http://localhost:3000/
      2. 等待项目列表加载完成
      3. 找到第一个项目卡片上的"导出"按钮
      4. 点击导出按钮
      5. 等待下载开始（监听 download 事件）
    Expected Result: 浏览器触发 .zip 文件下载
    Failure Indicators: 无下载事件，或下载的文件不是 zip
    Evidence: .sisyphus/evidence/task-3-export-download.png
  Scenario: 导入按钮上传并创建新项目
    Tool: Playwright (playwright skill)
    Preconditions: 前后端运行中，已有一个导出的 zip 文件
    Steps:
      1. 导航到 http://localhost:3000/
      2. 记录当前项目数量
      3. 找到"导入项目"按钮
      4. 通过隐藏 file input 上传 zip 文件
      5. 等待 loading 状态出现并消失
      6. 等待 success toast 出现
      7. 验证项目列表数量增加了 1
    Expected Result: 新项目出现在列表中，toast 显示成功
    Failure Indicators: 项目数量未增加，error toast 出现
    Evidence: .sisyphus/evidence/task-3-import-success.png
  Scenario: 导入非 zip 文件显示错误
    Tool: Playwright (playwright skill)
    Preconditions: 前后端运行中
    Steps:
      1. 导航到 http://localhost:3000/
      2. 通过隐藏 file input 上传一个 .txt 文件
      3. 等待 error toast 出现
    Expected Result: error toast 显示错误信息
    Failure Indicators: 无 toast 或显示 success
    Evidence: .sisyphus/evidence/task-3-import-error.png
  ```
  **Evidence to Capture:**
  - [ ] task-3-export-download.png — 导出下载截图
  - [ ] task-3-import-success.png — 导入成功截图
  - [ ] task-3-import-error.png — 导入错误截图
  **Commit**: YES
  - Message: `feat(ui): add project export/import buttons to project list`
  - Files: `frontend/src/pages/ProjectList.tsx`, `frontend/src/stores/useProjectStore.ts`
  - Pre-commit: `cd frontend && npx tsc --noEmit && npm run lint`
- [ ] 4. 后端 + 前端测试
  **What to do**:
  - 后端测试 (`backend/tests/test_export_import.py`):
    1. 测试导出端点返回 zip 且不含 index/ 目录
    2. 测试导入端点正常 round-trip（导出 → 导入 → 验证新项目）
    3. 测试导入非 zip 文件返回 400
    4. 测试导入缺少 project.json 的 zip 返回 400
    5. 测试导入后项目可通过 API 访问
    6. 测试导入后章节数量正确
    7. 使用 FastAPI TestClient 进行测试
  - 前端测试 (`frontend/src/pages/__tests__/ProjectList.export-import.test.tsx`):
    1. 测试"导入项目"按钮渲染
    2. 测试"导出"按钮在每个项目卡片上渲染
    3. 测试导入成功后刷新项目列表
    4. 测试导入失败时显示 error toast
    5. Mock API 调用
  **Must NOT do**:
  - 不修改现有测试文件
  - 不测试 ChapterExportMenu 或 exportService（已有测试覆盖）
  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 跨前后端测试，需要理解两端的测试模式
  - **Skills**: [`superpowers/verification-before-completion`]
    - `superpowers/verification-before-completion`: 确保所有测试通过
  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (after Task 3)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 1, 2, 3
  **References**:
  **Pattern References**:
  - `backend/tests/` — 现有后端测试目录和测试模式
  - `frontend/src/pages/__tests__/ProjectDetail.test.tsx:167-180` — 现有的导出按钮测试，展示测试模式
  - `frontend/src/pages/__tests__/ProjectList.test.tsx` — 现有 ProjectList 测试，展示 mock 和渲染模式
  **Test References**:
  - `frontend/src/services/__tests__/exportService.test.ts` — 现有 exportService 测试模式参考
  **WHY Each Reference Matters**:
  - `backend/tests/`: 需要遵循现有测试结构和命名约定
  - `ProjectDetail.test.tsx:167-180`: 展示了如何测试导出按钮渲染和点击行为
  - `ProjectList.test.tsx`: 展示了如何 mock useProjectStore 和渲染 ProjectList
  **Acceptance Criteria**:
  - [ ] `cd backend && python -m pytest tests/test_export_import.py -v` 全部通过
  - [ ] `cd frontend && npm run test -- --run src/pages/__tests__/ProjectList.export-import.test.tsx` 全部通过
  - [ ] 后端测试覆盖：正常导出、正常导入、错误输入（3 种）
  - [ ] 前端测试覆盖：按钮渲染、导入成功、导入失败
  **QA Scenarios (MANDATORY):**
  ```
  Scenario: 所有测试通过
    Tool: Bash
    Preconditions: 依赖已安装
    Steps:
      1. cd backend && python -m pytest tests/test_export_import.py -v
      2. cd frontend && npm run test -- --run src/pages/__tests__/ProjectList.export-import.test.tsx
    Expected Result: 所有测试 PASS
    Failure Indicators: 任何测试 FAIL
    Evidence: .sisyphus/evidence/task-4-test-results.txt
  Scenario: 现有测试不受影响
    Tool: Bash
    Preconditions: 依赖已安装
    Steps:
      1. cd backend && python -m pytest tests/ -v --timeout=60
      2. cd frontend && npm run test -- --run
    Expected Result: 所有现有测试仍然 PASS
    Failure Indicators: 之前通过的测试现在 FAIL
    Evidence: .sisyphus/evidence/task-4-existing-tests.txt
  ```
  **Evidence to Capture:**
  - [ ] task-4-test-results.txt — 新测试运行结果
  - [ ] task-4-existing-tests.txt — 现有测试运行结果
  **Commit**: YES
  - Message: `test: add export/import endpoint and UI tests`
  - Files: `backend/tests/test_export_import.py`, `frontend/src/pages/__tests__/ProjectList.export-import.test.tsx`
  - Pre-commit: `cd backend && python -m pytest tests/ -v -x && cd ../frontend && npm run test -- --run`

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `cd frontend && npx tsc --noEmit` + `npm run lint` + `npm run test`. Run `cd backend && python -m pytest -v` + `python -m ruff check .`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (export then import round-trip). Test edge cases: empty project, large project, corrupted zip. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Task 1**: `feat(api): exclude lancedb from project export zip` — backend/api/main.py
- **Task 2**: `feat(api): add project import endpoint with ID remapping` — backend/api/main.py
- **Task 3**: `feat(ui): add project export/import buttons to project list` — frontend/src/pages/ProjectList.tsx, frontend/src/stores/useProjectStore.ts
- **Task 4**: `test: add export/import endpoint and UI tests` — backend/tests/, frontend/src/

---

## Success Criteria

### Verification Commands
```bash
# Export excludes lancedb
curl -s -o /tmp/test-export.zip http://localhost:8000/api/projects/{id}/export
unzip -l /tmp/test-export.zip | grep -c "index/"  # Expected: 0

# Export includes novelist.db
unzip -l /tmp/test-export.zip | grep -c "novelist.db"  # Expected: 1

# Import creates new project
curl -s -X POST http://localhost:8000/api/projects/import \
  -F "file=@/tmp/test-export.zip" | jq '.project_id'  # Expected: new UUID

# Imported project accessible
curl -s http://localhost:8000/api/projects/{new_id} | jq '.name'  # Expected: project name

# Memory accessible after import
curl -s "http://localhost:8000/api/memory/query?project_id={new_id}&q=test"  # Expected: 200

# Malformed zip returns 400
echo "not a zip" > /tmp/bad.zip
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8000/api/projects/import \
  -F "file=@/tmp/bad.zip"  # Expected: 400
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Export → Import round-trip produces functional project
