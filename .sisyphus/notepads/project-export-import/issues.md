# Issues & Gotchas

## [2026-02-28] Known Gotchas
- Import must manually register to global dicts (projects/chapters/traces) — cannot rely on restart
- Zip may have a top-level directory or files directly at root — must auto-detect project.json location
- If novelist.db missing in zip, get_or_create_store() creates new empty DB, sync_file_memories() rebuilds from markdown
- If memory/ dir missing, ThreeLayerMemory._ensure_directories() creates defaults
- Do NOT block import response waiting for vector index rebuild
- Export endpoint already exists at GET /api/projects/{id}/export but zips entire dir including lancedb — needs fix
- Frontend has never called the export endpoint — no breaking change risk
