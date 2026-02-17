# Novelist Agent System Implementation Plan

> **For Claude:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a complete multi-agent novel writing system with three-layer memory, hybrid search, and visualization

**Architecture:** 
- Backend: Python FastAPI with SQLite FTS + LanceDB vector search
- Frontend: React + TypeScript + Tailwind CSS + React Router
- Multi-Agent: Director, Setter, Continuity, Stylist, Arbiter roles
- Memory: L1 (IDENTITY.md), L2 (logs/), L3 (summaries/)
- Visualization: Decision traces, knowledge graphs, timeline

**Tech Stack:** 
- Python 3.11+, FastAPI, SQLite, LanceDB, OpenAI API
- React 18, TypeScript, Tailwind, React Router, Zustand, Recharts

---

## Completed Components

### Task 1: Project Structure
- Created: `backend/pyproject.toml`, `backend/.env.example`
- Created: `frontend/package.json`, `vite.config.ts`, `tsconfig.json`
- Created: Directory structure for backend and frontend

### Task 2: Three-Layer Memory System
- Files: `backend/memory/__init__.py`
- Implements: ThreeLayerMemory class for L1/L2/L3 storage
- Implements: MemoryStore with SQLite FTS and entity/event storage
- Methods: add_memory_item, search_fts, add_entity, get_events

### Task 3: Hybrid Search Engine
- Files: `backend/memory/search.py`
- Implements: VectorStore with LanceDB fallback
- Implements: HybridSearchEngine merging FTS + vector results
- Implements: EmbeddingProvider for OpenAI embeddings

### Task 4: Multi-Agent Studio
- Files: `backend/agents/studio.py`
- Implements: Agent base class with async think()
- Implements: AgentStudio with 5 roles (Director, Setter, Continuity, Stylist, Arbiter)
- Implements: StudioWorkflow for plan/draft/consistency/polish flow

### Task 5: Consistency Engine
- Files: `backend/services/consistency.py`
- Implements: 5 rules (R1-R5) for timeline, character, relation, world, foreshadow
- Implements: Severity levels (P0/P1/P2) with blocking
- Methods: check(), resolve_conflict(), exempt_conflict()

### Task 6: FastAPI Backend
- Files: `backend/api/main.py`
- Endpoints: 
  - POST /projects - Create project
  - GET /projects/{id} - Get project
  - POST /chapters - Create chapter
  - GET /chapters/{id} - Get chapter
  - POST /chapters/{id}/plan - Generate plan
  - POST /chapters/{id}/draft - Generate draft
  - POST /consistency/check - Check consistency
  - POST /memory/commit - Commit memory
  - GET /memory/query - Query memory
  - GET /trace/{id} - Get trace
  - POST /review - Review chapter
  - GET /metrics - Get metrics

### Task 7: React Frontend
- Pages:
  - ProjectList - Project creation and listing
  - ProjectDetail - Project overview with chapters
  - ChapterWorkbench - Plan/draft/review workflow
  - MemoryBrowser - Search and L1 identity editor
  - KnowledgeGraph - Entity relationships and timeline
  - TraceReplay - Agent decision visualization
  - Dashboard - Metrics and status

---

## Next Steps (For Production)

### Step 1: Install Dependencies

```bash
# Backend
cd backend
poetry install

# Frontend
cd frontend
npm install
```

### Step 2: Configure Environment

```bash
# Copy and configure .env
cp backend/.env.example backend/.env
# Edit with your API keys
```

### Step 3: Run Backend

```bash
cd backend
python -m uvicorn api.main:app --reload
```

### Step 4: Run Frontend

```bash
cd frontend
npm run dev
```

### Step 5: Open Browser

Navigate to http://localhost:3000

---

## API Key Configuration

Set your provider key in `backend/.env`:

```
# OpenAI
OPENAI_API_KEY=sk-your-key-here

# or MiniMax
MINIMAX_API_KEY=your-minimax-key
```

---

## Testing the Workflow

1. Create a new project with genre and style
2. Create a chapter with title and goal
3. Click "Generate Plan" to get AI-generated beats/conflicts
4. Click "Generate Draft" to create chapter content
5. Review conflicts (P0 blocks submission)
6. Approve or reject the draft
7. View trace replay to see agent decisions
8. Check memory browser for search functionality
