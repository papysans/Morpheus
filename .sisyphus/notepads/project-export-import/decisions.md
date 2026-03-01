# Decisions

## [2026-02-28] Core Design Decisions
- Import ALWAYS creates new project (new UUID) — never overwrites existing
- UI entry point: ProjectList page only (not ProjectDetail)
- Export includes novelist.db, excludes index/ (lancedb) and graph/ directories
- Import rebuilds FTS index via sync_file_memories(), LanceDB rebuilds lazily on first search
- Zip safety: path traversal protection + 500MB size limit
- Chapter UUIDs preserved on import, only project_id field updated
- fanqie_book_id cleared to None on import
- No SSE progress, no import preview, no batch export
- Existing ChapterExportMenu and exportService.ts must NOT be touched
