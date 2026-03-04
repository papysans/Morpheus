# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Morpheus is a multi-agent AI novel writing system. Four AI agents (Director → Setter → Stylist → Arbiter) orchestrate chapter generation through a sequential pipeline, backed by a three-layer memory system (L1 Identity, L2 Entities, L3 Events) with an optional L4 Knowledge Graph.

## Commands

### Backend (run from `backend/`)

```bash
poetry install                              # Install dependencies
poetry run uvicorn api.main:app --reload    # Dev server on :8000
API_WORKERS=2 ./scripts/run_api.sh          # Multi-worker dev server

python -m pytest -v                         # All tests
python -m pytest tests/test_api_smoke.py -v # Smoke tests only
python -m pytest tests/test_l4_api.py -v    # Knowledge graph tests

python -m ruff check .                      # Lint
python -m ruff format .                     # Auto-format
python -m mypy .                            # Type check (excludes tests/, api/main.py, agents/studio.py)
```

### Frontend (run from `frontend/`)

```bash
npm run dev          # Vite dev server on :3000 (proxies /api → :8000)
npm run build        # tsc + vite build
npm run lint         # ESLint
npm run test         # Vitest unit tests
npm run test:e2e     # Playwright E2E
```

### Production

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## Architecture

### Backend (`backend/`)

- **`api/main.py`** (~6K lines): All FastAPI REST + SSE endpoints. This is the monolith API file — projects, chapters, memory, graph, consistency, metrics all live here.
- **`agents/studio.py`**: AgentStudio orchestration. Defines 4 agent roles with Chinese system prompts, implements `think()` and `think_stream()` async methods.
- **`core/llm_client.py`**: DeepSeek LLM wrapper with offline fallback.
- **`core/chapter_craft.py`**: Title generation and outline utilities.
- **`memory/__init__.py`**: ThreeLayerMemory + MemoryStore — L1 (identity markdown), L2 (entities with rolling 3-chapter window), L3 (events with confidence scores).
- **`memory/search.py`**: HybridSearchEngine combining SQLite FTS5 + LanceDB vector similarity.
- **`models/__init__.py`**: Pydantic models (Project, Chapter, Layer, EntityState, etc.).
- **`services/consistency.py`**: Rule-based conflict detection (timeline, traits, world rules).

### Frontend (`frontend/src/`)

- **Pages**: 8 route-level pages. `ChapterWorkbenchPage.tsx` (84KB, main editor) and `WritingConsolePage.tsx` (53KB, batch generation) are the largest.
- **Stores** (Zustand): `useProjectStore` (main state), `useStreamStore` (SSE streams), `useActivityStore`, `useUIStore`.
- **`hooks/useSSEStream.ts`**: SSE client for real-time chapter generation. Event types: `outline_ready`, `chapter_chunk`, `done`, `error`.
- **Routing**: react-router-dom v6 with lazy loading and ErrorBoundary.

### Communication Pattern

Frontend → Vite proxy (`/api` → `:8000`) → FastAPI. Real-time generation uses SSE (not WebSocket). Use `API_WORKERS=2+` in production to prevent LLM generation from blocking read endpoints.

### Data Storage

- **SQLite** (`data/novelist.db`): Projects, chapters, metadata via SQLAlchemy
- **LanceDB** (`data/vectors/`): Embeddings for semantic search
- **JSON** (`data/projects/`): Full project snapshots
- **Markdown**: Memory files (L1, L2, L3 content)
- All runtime data in `data/` (git-ignored)

## Code Style

- **Python**: line-length 100, target py311. Ruff for linting/formatting, Black config present.
- **TypeScript**: strict mode, ES2020 target. Tailwind CSS for styling.
- **Language**: UI and agent prompts are Chinese-first. Code identifiers and comments in English.

## Environment

Backend config via `backend/.env` (see `.env.example`). Key vars:
- `LLM_PROVIDER`: `deepseek`
- `GRAPH_FEATURE_ENABLED` / `L4_PROFILE_ENABLED`: Feature flags for knowledge graph
- `API_WORKERS`: Number of uvicorn workers (recommend 2+)
