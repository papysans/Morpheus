# Learnings

## [2026-02-28] Setup
- Worktree: /Volumes/Work/Projects/Morpheus-export-import (branch: feat/project-export-import)
- All code changes go in the worktree, NOT the main repo
- Backend: /Volumes/Work/Projects/Morpheus-export-import/backend/api/main.py
- Frontend: /Volumes/Work/Projects/Morpheus-export-import/frontend/src/

## Key Architecture Facts
- novelist.db has NO project_id column — isolated by project directory, safe to copy directly
- AgentTrace.chapter_id is integer (chapter number), not UUID — simplifies import logic
- Chapter UUIDs are globally unique — preserve on import, only update project_id field
- sync_file_memories() rebuilds SQLite FTS index from markdown files
- LanceDB vector index auto-rebuilds on first search via vector_index_signatures check
- fanqie_book_id must be cleared on import (platform-specific ID)
- Global dicts: projects, chapters, traces, memory_stores (defined ~line 301-306 in main.py)
- bootstrap_state() at line 612-651 shows how to register projects/chapters/traces into memory
- get_or_create_store() at line 654-659 initializes MemoryStore
- cleanup_export_file() at line 443-455 shows BackgroundTask cleanup pattern

## [2026-02-28] Task 1: Export Zip Exclusion
- Modified `export_project()` function (line 3003-3029) to exclude `index/` and `graph/` directories
- Implementation: Use `shutil.copytree()` with `ignore=shutil.ignore_patterns("index", "graph")` to copy project to temp dir, then archive the temp copy
- Key insight: `cleanup_export_file()` already handles cleanup of both zip file AND temp directory via BackgroundTask pattern
- Commit: `feat(api): exclude lancedb from project export zip` (b669369)
- Worktree: `/Volumes/Work/Projects/Morpheus-export-import` branch `feat/project-export-import`
- `tempfile` module already imported at line 11, no additional imports needed
- Archive structure: `shutil.make_archive()` with `root_dir=tmp_dir` and `base_dir=project-{project_id}` ensures zip contains only project contents without index/graph

## [2026-02-28] Task 2: Project Import Endpoint
- Added `POST /api/projects/import` endpoint after export endpoint in `backend/api/main.py`
- Uploads zip to temp file, enforces 500MB limit (413), validates zip file (400), rejects path traversal entries (400)
- Auto-detects `project.json`, rewrites `id`, clears `fanqie_book_id`, updates `updated_at`, and updates chapter `project_id`
- Registers Project/Chapter/AgentTrace into in-memory dicts and rebuilds FTS with `sync_file_memories()`
- Uses temp directories for upload/extract and cleans up in finally block

## UI Task: ProjectList export/import buttons (2026-02-28)

### What was done
- Added `importProject(file: File)` to `ProjectStore` interface and implementation in `useProjectStore.ts`
- Added `useRef` import, `importInputRef`, `importLoading` state, `handleImportClick`, `handleImportFileChange`, `handleExport` handlers to `ProjectList.tsx`
- Added hidden `<input type="file" accept=".zip">` + "导入项目" button in page-head alongside "新建项目"
- Added "导出" button on each project card next to "删除"

### Gotchas
- Edit tool operations in worktrees can silently fail to persist if the file hash changes between reads — always re-read and verify with grep after edits
- The `append` op with a binding anchor appended AFTER the closing `}` of `handleBatchDelete`, which was correct
- Duplicate interface entries appeared when the replace op matched the wrong line hash — fixed by reading the exact current line numbers before each edit
- Pre-existing tsc errors in `features.ts` (ImportMeta.env) and `ProjectDetail.test.tsx` (missing synopsis field) are unrelated to this task and were present before changes
- `npx tsc` installs a wrong `tsc` package — must use `./node_modules/.bin/tsc --noEmit` directly

### Patterns confirmed
- `beginLoading()` / `endLoading()` wraps all async store actions
- Export download: create `<a>` element, set `href` + `download`, append to body, click, remove — avoids page navigation
- `api` base URL is `/api`, so store calls use `/projects/import` not `/api/projects/import`
- `addToast('success' | 'error', message)` — no options needed for basic toasts

## [2026-02-28] Task 4: Export/Import Tests

### Backend tests (backend/tests/test_export_import.py)
- 5 tests: export excludes lancedb, export 404, import round-trip, invalid zip 400, missing project.json 400
- Pattern: `unittest.TestCase` + `TestClient(app)`, same as `test_api_smoke.py`
- Round-trip test: create → export → import → verify new UUID + GET 200
- In-memory zip creation with `io.BytesIO` + `zipfile.ZipFile` for negative cases
- `--timeout` flag not available (no pytest-timeout installed) — omit it

### Frontend tests (frontend/src/pages/__tests__/ProjectList.export-import.test.tsx)
- 4 tests: import button renders, export buttons per card, import success toast, import failure toast
- Pattern matches `ProjectList.test.tsx`: `vi.mock('react-router-dom')`, `useProjectStore.setState`, `useToastStore`
- Toast assertions use `useToastStore.getState().toasts` (same pattern as existing tests)
- File input found via `container.querySelector('input[type="file"]')`, triggered with `fireEvent.change`
- Mock `importProject` via `useProjectStore.setState({ importProject: vi.fn().mockResolvedValue(...) })`
- Error toast extracts `error.response.data.detail` — mock rejection must match that shape

### Poetry worktree gotcha
- Worktree has its own poetry virtualenv — `poetry install` needed before first `pytest` run
- Poetry creates venv in `~/Library/Caches/pypoetry/virtualenvs/` keyed by project name + hash
