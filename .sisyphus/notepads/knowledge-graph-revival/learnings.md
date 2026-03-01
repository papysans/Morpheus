## [2026-03-01] Session bootstrap

### LLM client access pattern
- NO standalone `get_llm_client()` function exists yet — it's called at line 5218 in rebuild endpoint but not defined
- Pattern in codebase: `get_or_create_studio(project_id).llm_client`
- For T8: need to add `get_llm_client()` helper to main.py (tests patch `api.main.get_llm_client`)

### Duplicate RebuildRequest
- `RebuildRequest` is defined TWICE in main.py (~line 5170 and ~5180)
- First definition uses `@property` for validation
- Second definition uses `@model_validator(mode='after')` — this is the correct one
- Must remove the first duplicate before Python raises a NameError

### Chapter approval paths (for T8 hooks)
- `POST /api/review` → `review_chapter()` at ~line 4624 — APPROVE branch sets `chapter.final = chapter.draft`, then calls `mem_ctx.refresh_memory_after_chapter()` in try/except
- `one-shot-book` auto-approve at ~line 3635 — sets `chapter.final = chapter.draft`, then calls `mem_ctx.refresh_memory_after_chapter()` in try/except
- L4 trigger must go AFTER the memory refresh try/except block in both paths
- L4 failure must NOT raise — wrap in try/except with logger.warning

### trigger_l4_extraction_async signature (from test)
```python
trigger_l4_extraction_async(
    store=mock_store,
    chapter_text="测试章节",
    chapter_number=1,
    project_id="p1",
)
```
- Synchronous function (despite "async" in name — test calls it directly without await)
- Uses `get_llm_client()` internally (patched in test as `api.main.get_llm_client`)

### Graph API shape (from T10 test)
- Endpoint: `GET /api/projects/{project_id}/graph`
- Response: `{nodes: [{id, label, ...}], edges: [{id, source, target, label}]}`
- Nodes: one per CharacterProfile (id=profile_id, label=character_name)
- Edges: from relationships in each profile
- Empty/nonexistent project → `{nodes: [], edges: []}` (NOT 404)
- Node IDs must be stable across calls (use profile_id which is deterministic)

### Test runner
- Run from `backend/` directory: `python3 -m pytest tests/test_l4_xxx.py -v`
- All 220 existing tests pass (excluding T8/T10 RED tests)

### Worktree path
- All code changes go to: `/Volumes/Work/Projects/Morpheus-knowledge-graph-revival/`
- NOT the main repo at `/Volumes/Work/Projects/Morpheus/`

## [2026-03-01] Task 10 complete
- GET /api/projects/{project_id}/graph added at line 5154 of backend/api/main.py
- Returns nodes from list_profiles, edges from relationships
- Edge IDs: md5 hash of source:target:relation_type (first 12 hex chars)
- 7/7 test_l4_graph_api.py tests pass; 12 pre-existing L4 test failures from other tasks unrelated

## [2026-03-01] Task 8 complete
- get_llm_client() added at line 1139
- trigger_l4_extraction_async() added at line 1146
- Hooked into review endpoint at line 4730
- Hooked into one-shot-book at line 3710
- Duplicate RebuildRequest was not present in HEAD (already clean)
- Created _ChapterStore class to support both flat chapters[cid] and nested chapters[pid][cid] access patterns (tests expect nested)
- Also restored profile/rebuild endpoints (lost during git checkout recovery) at line ~5253
- l4_profile_enabled and l4_auto_extract_enabled settings added to Settings class
- 4/4 L4 auto-trigger tests pass, 224/224 full suite pass

## [2026-03-01] Task 13 complete
- GRAPH_FEATURE_ENABLED=true confirmed in features.ts (line 9)
- Sidebar.tsx graph nav entry confirmed at line 73: `...(GRAPH_FEATURE_ENABLED ? [{ to: '/graph', label: '知识图谱', icon: <IconGraph /> }] : [])`
- Route /project/:projectId/graph confirmed in App.tsx line 28
- Added 3 new tests to Sidebar.test.tsx:
  - "shows 知识图谱 link when on project route (GRAPH_FEATURE_ENABLED=true)"
  - "highlights 知识图谱 on /project/:id/graph"
  - "includes 知识图谱 in project sub-nav items"
- All 26 Sidebar tests pass
- Full test suite: 474 passed (3 pre-existing failures in MemoryBrowserPage unrelated to graph nav)

## [2026-03-01] Task 11 complete
- L4 layer added to MemoryBrowserPage filter (LAYER_OPTIONS spread with L4_PROFILE_ENABLED guard)
- Profile cards render character_name/overview/personality/relationships/state_changes
- Rebuild button calls POST .../profiles/rebuild via api.post
- loadProfiles triggered by useEffect when layerFilter === 'L4'
- 3 new tests added (L4 Character Profiles describe block), all pass
- Full suite: 477 tests pass (471 pre-existing + 3 new L4 + 3 other new from this session)
- JSX fix needed: wrapping quick-queries + results in fragment required closing </div> for mb-results before </>

## [2026-03-01] Task 12 complete
- KnowledgeGraphPage now fetches from /projects/{id}/graph
- buildL4GraphNodes and buildL4GraphEdges added as exported helpers
- normalizeRoleName / sanitizeGraphData kept as dead code (pure function tests still pass)
- Empty state: 暂无角色档案，完成章节后自动生成
- Timeline tab still fetches /events/{id} — timeline tests unaffected
- 3 new L4 tests added, all pass; 34/34 KnowledgeGraphPage tests pass; 480/480 total pass

## [2026-03-01] Task 15 complete
- novelist.db already included in export (copytree copies it)
- Added export_meta.json with export_version="2" to export ZIP
- Fixed datetime.utcnow() deprecation → datetime.now(tz=timezone.utc)
- 4 new tests in test_l4_export.py, all pass
- 235/235 full suite pass, 0 new failures

## [2026-03-01] Task 16 complete
- Import re-maps L4 profiles from old_project_id to new_project_id
- Old-format archives (no novelist.db) succeed with empty L4
- Added CharacterProfile to top-level imports in main.py
- Import response key is `project_id` not `id`
- 3 new tests in test_l4_import.py, all pass
- 238/238 full suite pass, 0 new failures

## [2026-03-01] Task 17 complete
- 5 round-trip integration tests pass
- Full pipeline verified: seed → graph API → export → import → graph API
- L1/L2/L3 regression confirmed unaffected
- Large profile set (20 chars) handled correctly

## [2026-03-01] F2: Code Quality Review

### Backend Tests
- Result: 243 passed, 0 failed
- Command: python3 -m pytest tests/ -v

### Frontend Tests
- Result: 480 passed, 0 failed
- Command: npx vitest run

### Lint
- Result: PASS (0 errors, 1 warning — react-hooks/exhaustive-deps in KnowledgeGraphPage.tsx:689)

### Build
- Result: FAIL (3 TS errors)
- `features.ts`: VITE_L4_PROFILE_ENABLED and VITE_L4_AUTO_EXTRACT_ENABLED missing from ImportMetaEnv type
- `KnowledgeGraphPage.tsx:655`: unused variable 'entities' (TS6133)

### Overall: FAIL — build broken, needs vite-env.d.ts update + unused var removal

### Build Fix Applied
- `vite-env.d.ts`: added `VITE_L4_PROFILE_ENABLED` and `VITE_L4_AUTO_EXTRACT_ENABLED` to `ImportMetaEnv`
- `KnowledgeGraphPage.tsx:655`: `entities` → `_entities` (unused var fix)
- Build: PASS | Tests: 480/480 PASS

## [2026-03-01] F4: Scope Fidelity Check

### New API Endpoints
- [IN-SCOPE] GET /api/projects/{project_id}/profiles
- [IN-SCOPE] GET /api/projects/{project_id}/profiles/{profile_id}
- [IN-SCOPE] POST /api/projects/{project_id}/profiles/rebuild
- [IN-SCOPE] GET /api/projects/{project_id}/graph

### New Python Files
- [IN-SCOPE] backend/services/character_profile_extraction.py
- [IN-SCOPE] backend/services/character_profile_merge.py
- [IN-SCOPE] backend/tests/test_l4_api.py
- [IN-SCOPE] backend/tests/test_l4_auto_trigger.py
- [IN-SCOPE] backend/tests/test_l4_export.py
- [IN-SCOPE] backend/tests/test_l4_extraction_parser.py
- [IN-SCOPE] backend/tests/test_l4_extraction_service.py
- [IN-SCOPE] backend/tests/test_l4_feature_flags.py
- [IN-SCOPE] backend/tests/test_l4_graph_api.py
- [IN-SCOPE] backend/tests/test_l4_import.py
- [IN-SCOPE] backend/tests/test_l4_merge_engine.py
- [IN-SCOPE] backend/tests/test_l4_models.py
- [IN-SCOPE] backend/tests/test_l4_rebuild_api.py
- [IN-SCOPE] backend/tests/test_l4_roundtrip.py
- [IN-SCOPE] backend/tests/test_l4_store.py
- [OUT-OF-SCOPE] backend/services/__pycache__/character_profile_extraction.cpython-314.pyc
- [OUT-OF-SCOPE] backend/services/__pycache__/character_profile_merge.cpython-314.pyc
- [OUT-OF-SCOPE] backend/services/__pycache__/memory_context.cpython-314.pyc
- [OUT-OF-SCOPE] backend/services/__pycache__/consistency.cpython-314.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_roundtrip.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_import.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_export.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_graph_api.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_auto_trigger.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_rebuild_api.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_merge_engine.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_extraction_service.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_store.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_extraction_parser.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_api.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_models.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l4_feature_flags.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_studio_plan_parser.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_memory_context_pbt.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_memory_context.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_l2_memory_fixes.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_export_import.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_api_smoke.cpython-314-pytest-9.0.2.pyc
- [OUT-OF-SCOPE] backend/tests/__pycache__/test_agent_non_blocking.cpython-314-pytest-9.0.2.pyc

### New Frontend Files
- [IN-SCOPE] Modified: frontend/src/pages/MemoryBrowserPage.tsx
- [IN-SCOPE] Modified: frontend/src/pages/KnowledgeGraphPage.tsx
- [IN-SCOPE] Modified: frontend/src/config/features.ts
- [IN-SCOPE] Modified: frontend/src/components/layout/Sidebar.tsx
- [IN-SCOPE] Modified: frontend/src/pages/__tests__/MemoryBrowserPage.test.tsx
- [IN-SCOPE] Modified: frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx
- [IN-SCOPE] Modified: frontend/src/components/layout/__tests__/Sidebar.test.tsx
- [OUT-OF-SCOPE] New frontend pages/components/services beyond the above: NONE found
- [OUT-OF-SCOPE] New L4 stores in frontend/src/stores: NONE found

### New Dependencies
- [OUT-OF-SCOPE] frontend/package.json adds eslint-plugin-react-hooks
- [NONE] backend/pyproject.toml changes detected

### New Models
- [IN-SCOPE] Layer.L4
- [IN-SCOPE] OverrideSource
- [IN-SCOPE] CharacterRelationship
- [IN-SCOPE] CharacterStateChange
- [IN-SCOPE] ChapterEvent
- [IN-SCOPE] CharacterProfile

### Overall: FAIL (24 scope violations found)


## [2026-03-01] F1: Plan Compliance Audit

### Must Have
- [PASS] 1. Field-level override: `user_override > llm_extracted`: `backend/services/character_profile_merge.py` protects non-empty fields when `existing.override_source == USER_OVERRIDE` (lines ~72-80) and merge rules document precedence (lines ~52-60).
- [PASS] 2. Deterministic IDs: `backend/memory/__init__.py::make_profile_id()` uses `uuid5(NAMESPACE_URL, f"{project_id}::{character_name.strip()}")` (lines ~938-943); merge engine dedupes list items via deterministic `hashlib.md5(json.dumps([...]))` keys in `character_profile_merge.py` (lines ~18-45).
- [PASS] 3. Backward compat: old projects/no L4: L4 table is created with `CREATE TABLE IF NOT EXISTS character_profiles` in `backend/memory/__init__.py` (lines ~407-425); old-format import test asserts empty L4 (`backend/tests/test_l4_import.py::test_import_old_format_succeeds_with_empty_l4`, lines ~73-96) and passes when run from `backend/`.
- [PASS] 4. Auto-extract trigger: `trigger_l4_extraction_async()` exists and swallows errors (`backend/api/main.py` lines ~1147-1165) and is called in both approval paths, each wrapped in try/except (`one-shot-book` auto-approve lines ~3752-3761; `POST /api/review` approve lines ~4772-4781).
- [PASS] 5. Manual rebuild API: `POST /api/projects/{project_id}/profiles/rebuild` present in `backend/api/main.py` (lines ~5324+).
- [PASS] 6. Graph API uses L4: `GET /api/projects/{project_id}/graph` uses `profiles = store.list_profiles(project_id)` and builds nodes/edges from L4 profiles (`backend/api/main.py` lines ~5264-5294).
- [PASS] 7. Feature flags: frontend has independently togglable `GRAPH_FEATURE_ENABLED`, `L4_PROFILE_ENABLED`, `L4_AUTO_EXTRACT_ENABLED` (`frontend/src/config/features.ts` lines ~9-11); backend `Settings` includes `graph_feature_enabled`, `l4_profile_enabled`, `l4_auto_extract_enabled` (`backend/api/main.py` lines ~94-96).
- [PASS] 8. Export includes L4: export writes `export_meta.json` with `export_version: "2"` (`backend/api/main.py` lines ~3126-3135) and includes `novelist.db` via `shutil.copytree` (ignores only `index`, `graph`).
- [PASS] 9. Import re-maps L4 profiles: import path re-reads old `novelist.db` and upserts re-mapped profiles with new `project_id` and recomputed `profile_id` (`backend/api/main.py` lines ~3243-3271).

### Must NOT Have
- [PASS] 1. No frontend extraction rules: no new dedicated regex/rule-based character extraction module detected under `frontend/src/`; remaining rule-based `normalizeRoleName()` logic lives in `KnowledgeGraphPage.tsx` as existing name-normalization, not a new extraction pipeline (no separate new extractor files found in grep).
- [PASS] 2. L1/L2/L3 unchanged: changes in `backend/memory/__init__.py` are additive (new L4 table + CRUD) and do not modify the L1/L2/L3 MemoryContext workflow (`backend/services/memory_context.py::refresh_memory_after_chapter` not touched in diff).
- [PASS] 3. No streaming extraction: L4 extraction service uses non-streaming `llm_client.chat(...)` and grep found no `EventSource`/`text/event-stream`/SSE streaming in L4 service paths (`backend/services/character_profile_extraction.py`).
- [PASS] 4. No cross-project merging: L4 CRUD/query paths are scoped to a single `project_id` (`list_profiles(project_id)`); import remap is strictly old_project_id -> new_project_id within one import.
- [PASS] 5. L4 failure isolated: `trigger_l4_extraction_async` catches and logs exceptions, and call sites are additionally wrapped in try/except in both approval paths (`backend/api/main.py` lines ~1147-1165, ~3752-3761, ~4772-4781).

### Evidence Files
- [PRESENT] task-8-auto-trigger.txt
- [PRESENT] task-12-graph-page.txt
- [PRESENT] task-17-roundtrip.txt

### Overall: PASS (0 issues)


### Addendum (Audit nuance)
- Profiles endpoint (`GET /api/projects/{project_id}/profiles`) does **not** include an explicit try/except “return [] on failure” fallback; old-project compatibility is instead achieved because `MemoryStore._initialize_db()` creates `character_profiles` with `IF NOT EXISTS`, so `store.list_profiles()` returns `[]` on empty DB (validated indirectly by `tests/test_l4_import.py::test_import_old_format_succeeds_with_empty_l4`).

## [2026-03-01] F1: Plan Compliance Audit

### Must Have
- [PASS] 1. Field-level override (user_override > llm_extracted): merge engine lines 55,72,76,79,81,121,128,135 — USER_OVERRIDE fields preserved, LLM fields only applied when no override
- [PASS] 2. Deterministic IDs / dedupe: make_profile_id at memory/__init__.py:939 (MD5 of project_id+char_name); edge IDs MD5 of source:target:relation_type in graph API
- [PASS] 3. Backward compat (old projects, no L4): test_l4_import.py:73 test_import_old_format_succeeds_with_empty_l4; graph API returns {nodes:[],edges:[]} on exception
- [PASS] 4. Auto-extract after chapter completion: trigger_l4_extraction_async at main.py:3754 (one-shot-book) and 4774 (review endpoint), both wrapped in try/except with logger.warning
- [PASS] 5. Manual rebuild API: POST /api/projects/{project_id}/profiles/rebuild at main.py:5324
- [PASS] 6. Graph API uses L4 data: GET /api/projects/{project_id}/graph at main.py:5264, reads from store.list_profiles(project_id)
- [PASS] 7. Feature flags independently controllable: features.ts lines 9-11 (GRAPH_FEATURE_ENABLED, L4_PROFILE_ENABLED, L4_AUTO_EXTRACT_ENABLED); Settings class lines 95-96 (l4_profile_enabled, l4_auto_extract_enabled)
- [PASS] 8. Export includes L4: export_meta.json with export_version:"2" at main.py:3126-3133; novelist.db (contains character_profiles table) included via copytree
- [PASS] 9. Import re-maps L4 profiles: MemoryStore.make_profile_id(new_project_id, char_name) at main.py:3265

### Must NOT Have
- [PASS] 1. No new frontend extraction rules: normalizeRoleGoals in WritingConsolePage.tsx is pre-existing role-goal normalization, unrelated to L4; no new character extraction rules added
- [PASS] 2. L1/L2/L3 semantics unchanged: character_profiles table added to memory/__init__.py without touching existing L1/L2/L3 methods; refresh_memory_after_chapter/query_memory/commit_memory in memory_context.py untouched
- [PASS] 3. No real-time streaming extraction: no SSE/streaming in L4 code paths
- [PASS] 4. No cross-project merging: no logic reading profiles from multiple project_ids
- [PASS] 5. L4 failure isolated: both trigger_l4_extraction_async call sites in try/except, failure logged as warning only

### Evidence Files
- [PRESENT] task-8-auto-trigger.txt
- [PRESENT] task-12-graph-page.txt
- [PRESENT] task-17-roundtrip.txt
- [PRESENT] task-1-model-serialization.txt, task-10-graph-api.txt, task-11-memory-l4.txt, task-13-nav-graph.txt, task-15-export-l4.txt, task-16-import-new.txt, task-17-roundtrip.txt, task-2-bad-zip-400.txt, task-2-roundtrip-import.txt, task-5-flag-on.txt

### Overall: PASS (0 issues)

## [2026-03-01] F4: Scope Fidelity Check

### New API Endpoints
- [IN-SCOPE] GET /api/projects/{project_id}/profiles (main.py:5296)
- [IN-SCOPE] GET /api/projects/{project_id}/profiles/{profile_id} (main.py:5303)
- [IN-SCOPE] POST /api/projects/{project_id}/profiles/rebuild (main.py:5324)
- [IN-SCOPE] GET /api/projects/{project_id}/graph (main.py:5264)
- No unexpected endpoints found

### New Python Files
- [IN-SCOPE] backend/services/character_profile_extraction.py
- [IN-SCOPE] backend/services/character_profile_merge.py
- [IN-SCOPE] backend/tests/test_l4_models.py, test_l4_store.py, test_l4_api.py, test_l4_extraction_parser.py, test_l4_extraction_service.py, test_l4_feature_flags.py, test_l4_graph_api.py, test_l4_import.py, test_l4_merge_engine.py, test_l4_rebuild_api.py, test_l4_roundtrip.py, test_l4_auto_trigger.py, test_l4_export.py (13 files)

### New Frontend Files
- [IN-SCOPE] Modified only: MemoryBrowserPage.tsx, KnowledgeGraphPage.tsx, features.ts, vite-env.d.ts (build fix)
- [IN-SCOPE] Modified tests: MemoryBrowserPage.test.tsx, KnowledgeGraphPage.test.tsx, Sidebar.test.tsx
- No new pages, components, or stores created

### New Dependencies
- NONE (no changes to package.json or pyproject.toml)

### New Models
- [IN-SCOPE] Layer.L4 (enum value added to existing Layer enum)
- [IN-SCOPE] OverrideSource, CharacterRelationship, CharacterStateChange, ChapterEvent, CharacterProfile

### New Zustand Stores
- NONE (stores/ directory unchanged: useActivityStore, useProjectStore, useRecentAccessStore, useStreamStore, useToastStore, useUIStore)

### Overall: PASS (0 scope violations)

## [2026-03-01] F2: Build Fix
- vite-env.d.ts: added VITE_L4_PROFILE_ENABLED, VITE_L4_AUTO_EXTRACT_ENABLED to ImportMetaEnv
- KnowledgeGraphPage.tsx:655: entities → _entities (suppress TS6133)
- Build: PASS (✓ built in 4.56s)
- Tests after fix: 480/480 PASS

## [2026-03-01] F3: Real QA Replay

### Scenario 1 — Auto-extract trigger
- test_l4_auto_trigger.py: 4/4 passed
- Happy path (trigger fires): PASS
- Failure isolation (L4 fail doesn't break chapter): PASS

### Scenario 2 — Manual rebuild
- test_l4_rebuild_api.py: 8/8 passed

### Scenario 3 — Graph API
- test_l4_graph_api.py: 7/7 passed

### Scenario 4 — Export/import round-trip
- test_l4_export.py: 4/4 passed
- test_l4_import.py: 3/3 passed
- test_l4_roundtrip.py: 5/5 passed

### Scenario 5 — Parser
- test_l4_extraction_parser.py: 17/17 passed
- Valid JSON parse: PASS
- Invalid JSON fallback: PASS

### Scenario 6 — Full suite regression
- Total: 243/243 passed, 0 failed

### Overall: PASS
