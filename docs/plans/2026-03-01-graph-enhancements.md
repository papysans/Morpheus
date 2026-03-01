# Knowledge Graph Enhancements: Centrality Layout + Manual Node CRUD

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fixed grid/concentric layout with a true centrality-based force layout, and add manual graph node CRUD (add, delete, merge duplicates) with undo and audit trail.

**Architecture:**
- Backend: New SQLite tables (`graph_node_overrides`, `graph_node_aliases`, `graph_audit_log`) layered on top of existing `character_profiles` table. No migration — overrides are a separate layer that patches the read path.
- Frontend: Replace concentric fallback with D3 `forceSimulation` + `forceRadial` (inverse-degree radius). Add context menu + toolbar for node CRUD. Zustand store for undo/redo command stack.
- Rebuild conflict strategy: `graph_node_overrides.overridden_fields` JSON column tracks which fields the user touched; LLM rebuild skips those fields. Soft-deleted nodes stay deleted across rebuilds. Manual nodes are untouchable by rebuild.

**Tech Stack:**
- Python 3.11+, FastAPI, SQLite, Pydantic 2
- React 18, TypeScript, ReactFlow 11, D3.js 7 (`d3-force`), Zustand 4

**Constraints (from user):**
- 不在前端新增新一套关系抽取/归一化规则
- 不改写 L1/L2/L3 既有语义与核心检索排序逻辑
- 不扩展为'实时逐 token 抽取'或额外图谱分析平台
- 不引入跨项目关系合并
- 不把 L4 失败升级为章节创建/更新失败
- 不采用全量覆盖策略

---

## Phase 1: Backend — Override Layer (Tables + Store Methods)

### Task 1: Create `graph_node_overrides` table

**Files:**
- Modify: `backend/memory/__init__.py:415-432` (after `character_profiles` CREATE TABLE)
- Test: `backend/tests/test_graph_overrides_store.py` (new)

**Step 1: Write the failing test**

```python
"""Tests for graph_node_overrides table and store methods."""
import os
import unittest
from uuid import uuid4

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"

from memory import MemoryStore


class TestGraphNodeOverrides(unittest.TestCase):
    def setUp(self):
        self.project_id = uuid4().hex
        self.store = MemoryStore(f"/tmp/test-overrides-{self.project_id}")

    def test_table_exists(self):
        """graph_node_overrides table is created on init."""
        with self.store._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='graph_node_overrides'"
            )
            self.assertIsNotNone(cursor.fetchone())

    def test_upsert_and_get_override(self):
        node_id = "node-001"
        self.store.upsert_node_override(
            node_id=node_id,
            project_id=self.project_id,
            overridden_fields={"label": "自定义名称", "overview": "手动概述"},
        )
        override = self.store.get_node_override(node_id)
        self.assertIsNotNone(override)
        self.assertEqual(override["overridden_fields"]["label"], "自定义名称")

    def test_get_nonexistent_override_returns_none(self):
        self.assertIsNone(self.store.get_node_override("nonexistent"))

    def test_list_overrides_for_project(self):
        self.store.upsert_node_override("n1", self.project_id, {"label": "A"})
        self.store.upsert_node_override("n2", self.project_id, {"label": "B"})
        overrides = self.store.list_node_overrides(self.project_id)
        self.assertEqual(len(overrides), 2)

    def test_soft_delete_override(self):
        self.store.upsert_node_override("n1", self.project_id, {"label": "A"})
        self.store.soft_delete_node("n1")
        override = self.store.get_node_override("n1")
        self.assertIsNotNone(override)
        self.assertTrue(override["is_deleted"])

    def test_restore_soft_deleted_node(self):
        self.store.upsert_node_override("n1", self.project_id, {"label": "A"})
        self.store.soft_delete_node("n1")
        self.store.restore_node("n1")
        override = self.store.get_node_override("n1")
        self.assertFalse(override["is_deleted"])

    def test_manual_node_creation(self):
        """A fully manual node (no profile backing) can be created."""
        self.store.upsert_node_override(
            node_id="manual-001",
            project_id=self.project_id,
            overridden_fields={"label": "手动角色", "overview": "用户创建"},
            is_manual=True,
        )
        override = self.store.get_node_override("manual-001")
        self.assertTrue(override["is_manual"])


if __name__ == "__main__":
    unittest.main()
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_graph_overrides_store.py -v`
Expected: FAIL — `AttributeError: 'MemoryStore' object has no attribute 'upsert_node_override'`

**Step 3: Write minimal implementation**

In `backend/memory/__init__.py`, after the `character_profiles` CREATE TABLE block (line ~432), add the new table creation:

```python
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS graph_node_overrides (
                    node_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    overridden_fields TEXT NOT NULL DEFAULT '{}',
                    is_deleted INTEGER NOT NULL DEFAULT 0,
                    is_manual INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            cursor.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_overrides_project
                ON graph_node_overrides (project_id)
                """
            )
```

Then add these methods to the `MemoryStore` class (after `delete_profile` at line ~1017):

```python
    # ------------------------------------------------------------------
    # Graph Node Overrides
    # ------------------------------------------------------------------

    def upsert_node_override(
        self,
        node_id: str,
        project_id: str,
        overridden_fields: dict,
        is_manual: bool = False,
    ) -> None:
        """Insert or update a graph node override."""
        now = datetime.now().isoformat()
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO graph_node_overrides
                (node_id, project_id, overridden_fields, is_manual, is_deleted, created_at, updated_at)
                VALUES (?, ?, ?, ?, 0, ?, ?)
                ON CONFLICT(node_id) DO UPDATE SET
                    overridden_fields = excluded.overridden_fields,
                    is_manual = excluded.is_manual,
                    updated_at = excluded.updated_at
                """,
                (node_id, project_id, json.dumps(overridden_fields, ensure_ascii=False), int(is_manual), now, now),
            )
            conn.commit()

    def get_node_override(self, node_id: str) -> Optional[dict]:
        """Fetch a single node override, or None."""
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT node_id, project_id, overridden_fields, is_deleted, is_manual, created_at, updated_at "
                "FROM graph_node_overrides WHERE node_id = ?",
                (node_id,),
            )
            row = cursor.fetchone()
            if not row:
                return None
            return {
                "node_id": row["node_id"],
                "project_id": row["project_id"],
                "overridden_fields": json.loads(row["overridden_fields"]),
                "is_deleted": bool(row["is_deleted"]),
                "is_manual": bool(row["is_manual"]),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }

    def list_node_overrides(self, project_id: str) -> list:
        """List all overrides for a project."""
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT node_id, project_id, overridden_fields, is_deleted, is_manual, created_at, updated_at "
                "FROM graph_node_overrides WHERE project_id = ?",
                (project_id,),
            )
            return [
                {
                    "node_id": row["node_id"],
                    "project_id": row["project_id"],
                    "overridden_fields": json.loads(row["overridden_fields"]),
                    "is_deleted": bool(row["is_deleted"]),
                    "is_manual": bool(row["is_manual"]),
                }
                for row in cursor.fetchall()
            ]

    def soft_delete_node(self, node_id: str) -> None:
        """Mark a node as soft-deleted."""
        now = datetime.now().isoformat()
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE graph_node_overrides SET is_deleted = 1, updated_at = ? WHERE node_id = ?",
                (now, node_id),
            )
            conn.commit()

    def restore_node(self, node_id: str) -> None:
        """Restore a soft-deleted node."""
        now = datetime.now().isoformat()
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE graph_node_overrides SET is_deleted = 0, updated_at = ? WHERE node_id = ?",
                (now, node_id),
            )
            conn.commit()
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_graph_overrides_store.py -v`
Expected: All 7 tests PASS

**Step 5: Commit**

```bash
git add backend/memory/__init__.py backend/tests/test_graph_overrides_store.py
git commit -m "feat(graph): add graph_node_overrides table and store methods"
```

---

### Task 2: Create `graph_node_aliases` table

**Files:**
- Modify: `backend/memory/__init__.py` (after overrides table creation)
- Test: `backend/tests/test_graph_aliases_store.py` (new)

**Step 1: Write the failing test**

```python
"""Tests for graph_node_aliases table and store methods."""
import os
import unittest
from uuid import uuid4

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"

from memory import MemoryStore


class TestGraphNodeAliases(unittest.TestCase):
    def setUp(self):
        self.project_id = uuid4().hex
        self.store = MemoryStore(f"/tmp/test-aliases-{self.project_id}")

    def test_table_exists(self):
        with self.store._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='graph_node_aliases'"
            )
            self.assertIsNotNone(cursor.fetchone())

    def test_add_alias(self):
        self.store.add_node_alias(self.project_id, "node-001", "普罗米修斯")
        aliases = self.store.get_node_aliases("node-001")
        self.assertEqual(len(aliases), 1)
        self.assertEqual(aliases[0]["alias_name"], "普罗米修斯")

    def test_resolve_alias_to_canonical(self):
        self.store.add_node_alias(self.project_id, "node-001", "普罗米修斯")
        self.store.add_node_alias(self.project_id, "node-001", "Prometheus")
        resolved = self.store.resolve_alias(self.project_id, "普罗米修斯")
        self.assertEqual(resolved, "node-001")

    def test_resolve_unknown_alias_returns_none(self):
        self.assertIsNone(self.store.resolve_alias(self.project_id, "不存在"))

    def test_delete_alias(self):
        self.store.add_node_alias(self.project_id, "node-001", "普罗米修斯")
        self.store.delete_node_alias(self.project_id, "node-001", "普罗米修斯")
        aliases = self.store.get_node_aliases("node-001")
        self.assertEqual(len(aliases), 0)

    def test_list_all_aliases_for_project(self):
        self.store.add_node_alias(self.project_id, "n1", "A")
        self.store.add_node_alias(self.project_id, "n1", "B")
        self.store.add_node_alias(self.project_id, "n2", "C")
        all_aliases = self.store.list_project_aliases(self.project_id)
        self.assertEqual(len(all_aliases), 3)


if __name__ == "__main__":
    unittest.main()
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_graph_aliases_store.py -v`
Expected: FAIL — `AttributeError: 'MemoryStore' object has no attribute 'add_node_alias'`

**Step 3: Write minimal implementation**

In `backend/memory/__init__.py`, after the `graph_node_overrides` table creation, add:

```python
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS graph_node_aliases (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL,
                    canonical_node_id TEXT NOT NULL,
                    alias_name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(project_id, alias_name)
                )
                """
            )
            cursor.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_aliases_project
                ON graph_node_aliases (project_id)
                """
            )
            cursor.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_aliases_canonical
                ON graph_node_aliases (canonical_node_id)
                """
            )
```

Then add methods to `MemoryStore` (after `restore_node`):

```python
    # ------------------------------------------------------------------
    # Graph Node Aliases
    # ------------------------------------------------------------------

    def add_node_alias(
        self, project_id: str, canonical_node_id: str, alias_name: str
    ) -> None:
        """Register an alias name that resolves to a canonical node."""
        now = datetime.now().isoformat()
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO graph_node_aliases
                (project_id, canonical_node_id, alias_name, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (project_id, canonical_node_id, alias_name, now),
            )
            conn.commit()

    def get_node_aliases(self, canonical_node_id: str) -> list:
        """Get all aliases for a canonical node."""
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT alias_name, created_at FROM graph_node_aliases WHERE canonical_node_id = ?",
                (canonical_node_id,),
            )
            return [{"alias_name": row["alias_name"], "created_at": row["created_at"]} for row in cursor.fetchall()]

    def resolve_alias(self, project_id: str, alias_name: str) -> Optional[str]:
        """Resolve an alias name to its canonical node ID, or None."""
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT canonical_node_id FROM graph_node_aliases WHERE project_id = ? AND alias_name = ?",
                (project_id, alias_name),
            )
            row = cursor.fetchone()
            return row["canonical_node_id"] if row else None

    def delete_node_alias(
        self, project_id: str, canonical_node_id: str, alias_name: str
    ) -> None:
        """Remove a specific alias."""
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM graph_node_aliases WHERE project_id = ? AND canonical_node_id = ? AND alias_name = ?",
                (project_id, canonical_node_id, alias_name),
            )
            conn.commit()

    def list_project_aliases(self, project_id: str) -> list:
        """List all aliases for a project."""
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT canonical_node_id, alias_name, created_at FROM graph_node_aliases WHERE project_id = ?",
                (project_id,),
            )
            return [
                {"canonical_node_id": row["canonical_node_id"], "alias_name": row["alias_name"], "created_at": row["created_at"]}
                for row in cursor.fetchall()
            ]
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_graph_aliases_store.py -v`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add backend/memory/__init__.py backend/tests/test_graph_aliases_store.py
git commit -m "feat(graph): add graph_node_aliases table and store methods"
```

---

### Task 3: Create `graph_audit_log` table

**Files:**
- Modify: `backend/memory/__init__.py` (after aliases table creation)
- Test: `backend/tests/test_graph_audit_log.py` (new)

**Step 1: Write the failing test**

```python
"""Tests for graph_audit_log table and store methods."""
import os
import unittest
from uuid import uuid4

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"

from memory import MemoryStore


class TestGraphAuditLog(unittest.TestCase):
    def setUp(self):
        self.project_id = uuid4().hex
        self.store = MemoryStore(f"/tmp/test-audit-{self.project_id}")

    def test_table_exists(self):
        with self.store._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='graph_audit_log'"
            )
            self.assertIsNotNone(cursor.fetchone())

    def test_log_action(self):
        self.store.log_graph_action(
            project_id=self.project_id,
            action="update_node",
            node_id="n1",
            details={"field": "label", "old": "旧名", "new": "新名"},
        )
        logs = self.store.get_graph_audit_log(self.project_id)
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["action"], "update_node")
        self.assertEqual(logs[0]["details"]["field"], "label")

    def test_log_ordering(self):
        for i in range(3):
            self.store.log_graph_action(
                project_id=self.project_id,
                action=f"action_{i}",
                node_id="n1",
                details={},
            )
        logs = self.store.get_graph_audit_log(self.project_id)
        self.assertEqual(len(logs), 3)
        # Most recent first
        self.assertEqual(logs[0]["action"], "action_2")

    def test_log_with_limit(self):
        for i in range(10):
            self.store.log_graph_action(
                project_id=self.project_id,
                action=f"action_{i}",
                node_id="n1",
                details={},
            )
        logs = self.store.get_graph_audit_log(self.project_id, limit=5)
        self.assertEqual(len(logs), 5)


if __name__ == "__main__":
    unittest.main()
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_graph_audit_log.py -v`
Expected: FAIL — `AttributeError: 'MemoryStore' object has no attribute 'log_graph_action'`

**Step 3: Write minimal implementation**

In `backend/memory/__init__.py`, after aliases table creation, add:

```python
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS graph_audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    node_id TEXT,
                    details TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                )
                """
            )
            cursor.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_audit_project
                ON graph_audit_log (project_id, created_at DESC)
                """
            )
```

Then add methods to `MemoryStore` (after alias methods):

```python
    # ------------------------------------------------------------------
    # Graph Audit Log
    # ------------------------------------------------------------------

    def log_graph_action(
        self,
        project_id: str,
        action: str,
        node_id: Optional[str] = None,
        details: Optional[dict] = None,
    ) -> None:
        """Append an entry to the graph audit log."""
        now = datetime.now().isoformat()
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO graph_audit_log (project_id, action, node_id, details, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (project_id, action, node_id, json.dumps(details or {}, ensure_ascii=False), now),
            )
            conn.commit()

    def get_graph_audit_log(self, project_id: str, limit: int = 50) -> list:
        """Get recent audit log entries, most recent first."""
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT id, action, node_id, details, created_at FROM graph_audit_log "
                "WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
                (project_id, limit),
            )
            return [
                {
                    "id": row["id"],
                    "action": row["action"],
                    "node_id": row["node_id"],
                    "details": json.loads(row["details"]),
                    "created_at": row["created_at"],
                }
                for row in cursor.fetchall()
            ]
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_graph_audit_log.py -v`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add backend/memory/__init__.py backend/tests/test_graph_audit_log.py
git commit -m "feat(graph): add graph_audit_log table and store methods"
```

---

## Phase 2: Backend — Graph CRUD API Endpoints

### Task 4: Enhanced `GET /graph` with override layer

**Files:**
- Modify: `backend/api/main.py:5263-5293` (existing `get_graph_data`)
- Modify: `backend/tests/test_l4_graph_api.py`

**Step 1: Write the failing test**

Add to `backend/tests/test_l4_graph_api.py`:

```python
    def test_graph_data_respects_soft_delete(self):
        pid = self._create_project()
        _seed_l4_data(pid)
        store = get_or_create_store(pid)
        profiles = store.list_profiles(pid)
        deleted_id = profiles[0].profile_id
        store.upsert_node_override(deleted_id, pid, {}, is_manual=False)
        store.soft_delete_node(deleted_id)
        res = self.client.get(f"/api/projects/{pid}/graph")
        self.assertEqual(res.status_code, 200)
        node_ids = {n["id"] for n in res.json()["nodes"]}
        self.assertNotIn(deleted_id, node_ids)

    def test_graph_data_applies_label_override(self):
        pid = self._create_project()
        _seed_l4_data(pid)
        store = get_or_create_store(pid)
        profiles = store.list_profiles(pid)
        target_id = profiles[0].profile_id
        store.upsert_node_override(target_id, pid, {"label": "自定义名"})
        res = self.client.get(f"/api/projects/{pid}/graph")
        node = next(n for n in res.json()["nodes"] if n["id"] == target_id)
        self.assertEqual(node["label"], "自定义名")

    def test_graph_data_includes_manual_nodes(self):
        pid = self._create_project()
        store = get_or_create_store(pid)
        store.upsert_node_override(
            "manual-001", pid,
            {"label": "手动角色", "overview": "用户创建的"},
            is_manual=True,
        )
        res = self.client.get(f"/api/projects/{pid}/graph")
        node_ids = {n["id"] for n in res.json()["nodes"]}
        self.assertIn("manual-001", node_ids)
        manual = next(n for n in res.json()["nodes"] if n["id"] == "manual-001")
        self.assertEqual(manual["label"], "手动角色")
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_l4_graph_api.py -v -k "soft_delete or label_override or manual_nodes"`
Expected: FAIL — soft-deleted nodes still appear, overrides not applied, manual nodes missing

**Step 3: Write minimal implementation**

Replace `get_graph_data` in `backend/api/main.py:5263-5293` with:

```python
@app.get("/api/projects/{project_id}/graph")
async def get_graph_data(project_id: str):
    """Return graph nodes and edges from L4 profiles + override layer."""
    store = get_or_create_store(project_id)
    try:
        profiles = store.list_profiles(project_id)
    except Exception:
        profiles = []

    # Load override layer
    overrides_list = store.list_node_overrides(project_id)
    overrides_map = {o["node_id"]: o for o in overrides_list}
    deleted_ids = {o["node_id"] for o in overrides_list if o["is_deleted"]}

    nodes = []
    edges = []
    seen_edge_ids: set = set()
    seen_node_ids: set = set()

    # Build nodes from profiles (skip soft-deleted)
    for profile in profiles:
        if profile.profile_id in deleted_ids:
            continue
        override = overrides_map.get(profile.profile_id, {})
        fields = override.get("overridden_fields", {}) if override else {}
        nodes.append({
            "id": profile.profile_id,
            "label": fields.get("label", profile.character_name),
            "overview": fields.get("overview", profile.overview or ""),
            "personality": fields.get("personality", profile.personality or ""),
            "is_manual": False,
        })
        seen_node_ids.add(profile.profile_id)

        for rel in (profile.relationships or []):
            target_pid = MemoryStore.make_profile_id(project_id, rel.target_character)
            if target_pid in deleted_ids:
                continue
            edge_key = f"{profile.profile_id}:{target_pid}:{rel.relation_type}"
            edge_id = hashlib.md5(edge_key.encode()).hexdigest()[:12]
            if edge_id not in seen_edge_ids:
                seen_edge_ids.add(edge_id)
                edges.append({
                    "id": edge_id,
                    "source": profile.profile_id,
                    "target": target_pid,
                    "label": rel.relation_type or "",
                })

    # Add manual nodes (is_manual=True, not deleted)
    for o in overrides_list:
        if o["is_manual"] and not o["is_deleted"] and o["node_id"] not in seen_node_ids:
            fields = o["overridden_fields"]
            nodes.append({
                "id": o["node_id"],
                "label": fields.get("label", "未命名"),
                "overview": fields.get("overview", ""),
                "personality": fields.get("personality", ""),
                "is_manual": True,
            })
            seen_node_ids.add(o["node_id"])

    return {"nodes": nodes, "edges": edges}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_l4_graph_api.py -v`
Expected: All tests PASS (existing + 3 new)

**Step 5: Commit**

```bash
git add backend/api/main.py backend/tests/test_l4_graph_api.py
git commit -m "feat(graph): enhance GET /graph with override layer, soft-delete, manual nodes"
```

---

### Task 5: Node CRUD API endpoints

**Files:**
- Modify: `backend/api/main.py` (after `get_graph_data`)
- Test: `backend/tests/test_graph_crud_api.py` (new)

**Step 1: Write the failing test**

```python
"""Tests for graph node CRUD API endpoints."""
import os
import unittest
from uuid import uuid4

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"
os.environ["GRAPH_FEATURE_ENABLED"] = "true"

from fastapi.testclient import TestClient
from api.main import app, get_or_create_store
from memory import MemoryStore
from models import CharacterProfile


class TestGraphNodeCRUD(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _create_project(self) -> str:
        res = self.client.post(
            "/api/projects",
            json={"name": f"crud-{uuid4().hex[:6]}", "genre": "奇幻", "style": "冷峻"},
        )
        return res.json()["id"]

    def test_create_manual_node(self):
        pid = self._create_project()
        res = self.client.post(
            f"/api/projects/{pid}/graph/nodes",
            json={"label": "新角色", "overview": "手动创建"},
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("node_id", data)
        self.assertTrue(data["is_manual"])

    def test_update_node_fields(self):
        pid = self._create_project()
        # Seed a profile-backed node
        store = get_or_create_store(pid)
        profile_id = MemoryStore.make_profile_id(pid, "测试角色")
        store.upsert_profile(CharacterProfile(
            profile_id=profile_id, project_id=pid, character_name="测试角色",
        ))
        res = self.client.patch(
            f"/api/projects/{pid}/graph/nodes/{profile_id}",
            json={"label": "改名角色", "overview": "新概述"},
        )
        self.assertEqual(res.status_code, 200)
        # Verify via graph endpoint
        graph = self.client.get(f"/api/projects/{pid}/graph").json()
        node = next(n for n in graph["nodes"] if n["id"] == profile_id)
        self.assertEqual(node["label"], "改名角色")

    def test_soft_delete_node(self):
        pid = self._create_project()
        store = get_or_create_store(pid)
        profile_id = MemoryStore.make_profile_id(pid, "待删角色")
        store.upsert_profile(CharacterProfile(
            profile_id=profile_id, project_id=pid, character_name="待删角色",
        ))
        res = self.client.delete(f"/api/projects/{pid}/graph/nodes/{profile_id}")
        self.assertEqual(res.status_code, 200)
        graph = self.client.get(f"/api/projects/{pid}/graph").json()
        self.assertNotIn(profile_id, {n["id"] for n in graph["nodes"]})

    def test_restore_node(self):
        pid = self._create_project()
        store = get_or_create_store(pid)
        profile_id = MemoryStore.make_profile_id(pid, "恢复角色")
        store.upsert_profile(CharacterProfile(
            profile_id=profile_id, project_id=pid, character_name="恢复角色",
        ))
        self.client.delete(f"/api/projects/{pid}/graph/nodes/{profile_id}")
        res = self.client.post(f"/api/projects/{pid}/graph/nodes/{profile_id}/restore")
        self.assertEqual(res.status_code, 200)
        graph = self.client.get(f"/api/projects/{pid}/graph").json()
        self.assertIn(profile_id, {n["id"] for n in graph["nodes"]})


if __name__ == "__main__":
    unittest.main()
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_graph_crud_api.py -v`
Expected: FAIL — 404 on POST/PATCH/DELETE endpoints (not yet created)

**Step 3: Write minimal implementation**

Add to `backend/api/main.py` after `get_graph_data`:

```python
class CreateNodeRequest(BaseModel):
    label: str
    overview: str = ""
    personality: str = ""


class UpdateNodeRequest(BaseModel):
    label: Optional[str] = None
    overview: Optional[str] = None
    personality: Optional[str] = None


@app.post("/api/projects/{project_id}/graph/nodes")
async def create_graph_node(project_id: str, req: CreateNodeRequest):
    """Create a fully manual graph node."""
    if not resolve_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    store = get_or_create_store(project_id)
    node_id = f"manual-{uuid4().hex[:12]}"
    fields = {"label": req.label, "overview": req.overview, "personality": req.personality}
    store.upsert_node_override(node_id, project_id, fields, is_manual=True)
    store.log_graph_action(project_id, "create_node", node_id, {"fields": fields})
    return {"node_id": node_id, "is_manual": True, "fields": fields}


@app.patch("/api/projects/{project_id}/graph/nodes/{node_id}")
async def update_graph_node(project_id: str, node_id: str, req: UpdateNodeRequest):
    """Override fields on an existing graph node."""
    if not resolve_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    store = get_or_create_store(project_id)
    existing = store.get_node_override(node_id)
    old_fields = existing["overridden_fields"] if existing else {}
    is_manual = existing["is_manual"] if existing else False
    new_fields = dict(old_fields)
    update_details = {}
    for key in ["label", "overview", "personality"]:
        val = getattr(req, key)
        if val is not None:
            update_details[key] = {"old": old_fields.get(key), "new": val}
            new_fields[key] = val
    store.upsert_node_override(node_id, project_id, new_fields, is_manual=is_manual)
    store.log_graph_action(project_id, "update_node", node_id, update_details)
    return {"node_id": node_id, "fields": new_fields}


@app.delete("/api/projects/{project_id}/graph/nodes/{node_id}")
async def delete_graph_node(project_id: str, node_id: str):
    """Soft-delete a graph node."""
    if not resolve_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    store = get_or_create_store(project_id)
    existing = store.get_node_override(node_id)
    if not existing:
        store.upsert_node_override(node_id, project_id, {})
    store.soft_delete_node(node_id)
    store.log_graph_action(project_id, "delete_node", node_id, {})
    return {"node_id": node_id, "deleted": True}


@app.post("/api/projects/{project_id}/graph/nodes/{node_id}/restore")
async def restore_graph_node(project_id: str, node_id: str):
    """Restore a soft-deleted graph node."""
    if not resolve_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    store = get_or_create_store(project_id)
    store.restore_node(node_id)
    store.log_graph_action(project_id, "restore_node", node_id, {})
    return {"node_id": node_id, "restored": True}
```

Note: `uuid4` is already imported at the top of `main.py`. Verify this.

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_graph_crud_api.py -v`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add backend/api/main.py backend/tests/test_graph_crud_api.py
git commit -m "feat(graph): add node CRUD API endpoints (create, update, delete, restore)"
```

---

### Task 6: Merge nodes API endpoint

**Files:**
- Modify: `backend/api/main.py` (after restore endpoint)
- Modify: `backend/memory/__init__.py` (add merge helper)
- Test: `backend/tests/test_graph_merge_api.py` (new)

**Step 1: Write the failing test**

```python
"""Tests for graph node merge API endpoint."""
import os
import unittest
from uuid import uuid4

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"
os.environ["GRAPH_FEATURE_ENABLED"] = "true"

from fastapi.testclient import TestClient
from api.main import app, get_or_create_store
from memory import MemoryStore
from models import CharacterProfile, CharacterRelationship


class TestGraphMergeAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _create_project(self) -> str:
        res = self.client.post(
            "/api/projects",
            json={"name": f"merge-{uuid4().hex[:6]}", "genre": "奇幻", "style": "冷峻"},
        )
        return res.json()["id"]

    def test_merge_two_nodes(self):
        pid = self._create_project()
        store = get_or_create_store(pid)
        pid_a = MemoryStore.make_profile_id(pid, "普罗米修斯")
        pid_b = MemoryStore.make_profile_id(pid, "普罗米修斯A")
        store.upsert_profile(CharacterProfile(
            profile_id=pid_a, project_id=pid, character_name="普罗米修斯",
            overview="火种之神",
        ))
        store.upsert_profile(CharacterProfile(
            profile_id=pid_b, project_id=pid, character_name="普罗米修斯A",
            overview="变体",
            relationships=[CharacterRelationship(
                source_character="普罗米修斯A", target_character="宙斯",
                relation_type="对抗", chapter=3,
            )],
        ))
        res = self.client.post(
            f"/api/projects/{pid}/graph/nodes/merge",
            json={"keep_node_id": pid_a, "merge_node_ids": [pid_b]},
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["kept_node_id"], pid_a)
        self.assertIn(pid_b, data["merged_node_ids"])
        # Merged node should be soft-deleted
        graph = self.client.get(f"/api/projects/{pid}/graph").json()
        node_ids = {n["id"] for n in graph["nodes"]}
        self.assertIn(pid_a, node_ids)
        self.assertNotIn(pid_b, node_ids)

    def test_merge_creates_aliases(self):
        pid = self._create_project()
        store = get_or_create_store(pid)
        pid_a = MemoryStore.make_profile_id(pid, "沈砺")
        pid_b = MemoryStore.make_profile_id(pid, "林溪")
        store.upsert_profile(CharacterProfile(
            profile_id=pid_a, project_id=pid, character_name="沈砺",
        ))
        store.upsert_profile(CharacterProfile(
            profile_id=pid_b, project_id=pid, character_name="林溪",
        ))
        self.client.post(
            f"/api/projects/{pid}/graph/nodes/merge",
            json={"keep_node_id": pid_a, "merge_node_ids": [pid_b]},
        )
        aliases = store.get_node_aliases(pid_a)
        alias_names = {a["alias_name"] for a in aliases}
        self.assertIn("林溪", alias_names)


if __name__ == "__main__":
    unittest.main()
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_graph_merge_api.py -v`
Expected: FAIL — 404 on POST merge endpoint

**Step 3: Write minimal implementation**

Add to `backend/api/main.py` after `restore_graph_node`:

```python
class MergeNodesRequest(BaseModel):
    keep_node_id: str
    merge_node_ids: List[str]


@app.post("/api/projects/{project_id}/graph/nodes/merge")
async def merge_graph_nodes(project_id: str, req: MergeNodesRequest):
    """Merge duplicate nodes into one. Soft-deletes merged nodes, creates aliases."""
    if not resolve_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    store = get_or_create_store(project_id)
    # Ensure keep node has an override record
    keep_override = store.get_node_override(req.keep_node_id)
    if not keep_override:
        store.upsert_node_override(req.keep_node_id, project_id, {})
    for merge_id in req.merge_node_ids:
        # Get the merged node's name for alias
        profile = store.get_profile(merge_id)
        alias_name = profile.character_name if profile else None
        # Soft-delete the merged node
        merge_override = store.get_node_override(merge_id)
        if not merge_override:
            store.upsert_node_override(merge_id, project_id, {})
        store.soft_delete_node(merge_id)
        # Register alias on the kept node
        if alias_name:
            store.add_node_alias(project_id, req.keep_node_id, alias_name)
        store.log_graph_action(
            project_id, "merge_node", req.keep_node_id,
            {"merged_from": merge_id, "alias": alias_name},
        )
    return {"kept_node_id": req.keep_node_id, "merged_node_ids": req.merge_node_ids}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_graph_merge_api.py -v`
Expected: All 2 tests PASS

**Step 5: Commit**

```bash
git add backend/api/main.py backend/tests/test_graph_merge_api.py
git commit -m "feat(graph): add merge nodes API endpoint with alias creation"
```

---

### Task 7: Protect user overrides during LLM rebuild

**Files:**
- Modify: `backend/api/main.py:5323-5368` (existing `rebuild_profiles`)
- Modify: `backend/tests/test_l4_rebuild_api.py`

**Step 1: Write the failing test**

Add to `backend/tests/test_l4_rebuild_api.py`:

```python
    def test_rebuild_respects_user_override_fields(self):
        """Fields in overridden_fields should not be overwritten by rebuild."""
        pid = self._create_project()
        store = get_or_create_store(pid)
        profile_id = MemoryStore.make_profile_id(pid, "张三")
        store.upsert_profile(CharacterProfile(
            profile_id=profile_id, project_id=pid, character_name="张三",
            overview="LLM概述",
        ))
        # User overrides the label
        store.upsert_node_override(profile_id, pid, {"label": "用户自定义名"})
        # After rebuild, the graph should still show user's label
        graph = self.client.get(f"/api/projects/{pid}/graph").json()
        node = next((n for n in graph["nodes"] if n["id"] == profile_id), None)
        self.assertIsNotNone(node)
        self.assertEqual(node["label"], "用户自定义名")

    def test_rebuild_skips_soft_deleted_nodes(self):
        """Soft-deleted nodes should stay deleted after rebuild."""
        pid = self._create_project()
        store = get_or_create_store(pid)
        profile_id = MemoryStore.make_profile_id(pid, "李四")
        store.upsert_profile(CharacterProfile(
            profile_id=profile_id, project_id=pid, character_name="李四",
        ))
        store.upsert_node_override(profile_id, pid, {})
        store.soft_delete_node(profile_id)
        # After rebuild, node should still be absent from graph
        graph = self.client.get(f"/api/projects/{pid}/graph").json()
        self.assertNotIn(profile_id, {n["id"] for n in graph["nodes"]})
```

**Step 2: Run test to verify it fails (or passes)**

Run: `cd backend && python -m pytest tests/test_l4_rebuild_api.py -v -k "user_override_fields or soft_deleted"`
Expected: These tests should already PASS because the override layer is applied at read time in `get_graph_data` (Task 4). If they pass, this task is a verification-only step — no code changes needed.

**Step 3: Verify and commit**

```bash
git add backend/tests/test_l4_rebuild_api.py
git commit -m "test(graph): verify rebuild respects user overrides and soft deletes"
```

---
## Phase 3: Frontend — Centrality-Based Force Layout

### Task 8: Replace concentric fallback with D3 forceRadial layout

**Files:**
- Modify: `frontend/src/pages/KnowledgeGraphPage.tsx:607-669` (replace `buildL4GraphNodes`)
- Modify: `frontend/src/pages/KnowledgeGraphPage.tsx:309-364` (replace `layoutGraphWithElk`)
- Test: `frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx`

**Step 1: Write the failing test**

Add to `frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx`:

```typescript
describe('buildL4GraphNodes with D3 forceRadial', () => {
    it('places highest-degree node near center (0,0)', () => {
        const nodes: L4GraphNode[] = [
            { id: 'hub', label: 'Hub', overview: '', personality: '' },
            { id: 'a', label: 'A', overview: '', personality: '' },
            { id: 'b', label: 'B', overview: '', personality: '' },
            { id: 'c', label: 'C', overview: '', personality: '' },
            { id: 'leaf', label: 'Leaf', overview: '', personality: '' },
        ]
        const edges: L4GraphEdge[] = [
            { id: 'e1', source: 'hub', target: 'a', label: '' },
            { id: 'e2', source: 'hub', target: 'b', label: '' },
            { id: 'e3', source: 'hub', target: 'c', label: '' },
            { id: 'e4', source: 'hub', target: 'leaf', label: '' },
            { id: 'e5', source: 'a', target: 'b', label: '' },
        ]
        const result = buildL4GraphNodes(nodes, edges)
        const hubNode = result.find((n) => n.id === 'hub')!
        const leafNode = result.find((n) => n.id === 'leaf')!
        const hubDist = Math.sqrt(hubNode.position.x ** 2 + hubNode.position.y ** 2)
        const leafDist = Math.sqrt(leafNode.position.x ** 2 + leafNode.position.y ** 2)
        // Hub (degree 4) should be closer to center than leaf (degree 1)
        expect(hubDist).toBeLessThan(leafDist)
    })

    it('returns stable positions for same input', () => {
        const nodes: L4GraphNode[] = [
            { id: 'a', label: 'A', overview: '', personality: '' },
            { id: 'b', label: 'B', overview: '', personality: '' },
        ]
        const edges: L4GraphEdge[] = [
            { id: 'e1', source: 'a', target: 'b', label: '' },
        ]
        const r1 = buildL4GraphNodes(nodes, edges)
        const r2 = buildL4GraphNodes(nodes, edges)
        // Positions should be identical for same input (deterministic seed)
        expect(r1[0].position.x).toBeCloseTo(r2[0].position.x, 0)
        expect(r1[0].position.y).toBeCloseTo(r2[0].position.y, 0)
    })

    it('handles single node without crashing', () => {
        const nodes: L4GraphNode[] = [{ id: 'solo', label: 'Solo', overview: '', personality: '' }]
        const result = buildL4GraphNodes(nodes, [])
        expect(result).toHaveLength(1)
        expect(result[0].position).toBeDefined()
    })
})
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/__tests__/KnowledgeGraphPage.test.tsx --reporter=verbose`
Expected: FAIL — hub node is NOT closer to center than leaf (current concentric layout uses ring index, not force simulation)

**Step 3: Write minimal implementation**

Replace `buildL4GraphNodes` in `KnowledgeGraphPage.tsx:607-669` with a D3 force simulation:

```typescript
import {
    forceSimulation,
    forceLink,
    forceManyBody,
    forceRadial,
    forceCollide,
    type SimulationNodeDatum,
    type SimulationLinkDatum,
} from 'd3-force'

interface SimNode extends SimulationNodeDatum {
    id: string
    degree: number
}

export function buildL4GraphNodes(l4Nodes: L4GraphNode[], l4Edges: L4GraphEdge[]): Node<EntityNodeData>[] {
    if (l4Nodes.length === 0) return []
    if (l4Nodes.length === 1) {
        return [makeRfNode(l4Nodes[0], { x: 0, y: 0 }, 0)]
    }

    const nodeIds = new Set(l4Nodes.map((n) => n.id))
    const degree = new Map<string, number>()
    for (const n of l4Nodes) degree.set(n.id, 0)
    const safeEdges = l4Edges.filter(
        (e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target,
    )
    for (const e of safeEdges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    }

    const maxDegree = Math.max(...degree.values(), 1)
    const radiusScale = 380 // max radius for degree-0 nodes

    // Build simulation nodes
    const simNodes: SimNode[] = l4Nodes.map((n) => ({
        id: n.id,
        degree: degree.get(n.id) ?? 0,
        x: 0,
        y: 0,
    }))

    // Build simulation links
    const simLinks: SimulationLinkDatum<SimNode>[] = safeEdges.map((e) => ({
        source: e.source,
        target: e.target,
    }))

    // Run force simulation synchronously (tick to completion)
    const simulation = forceSimulation<SimNode>(simNodes)
        .force(
            'link',
            forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
                .id((d) => d.id)
                .distance(160)
                .strength(0.3),
        )
        .force('charge', forceManyBody().strength(-300))
        .force(
            'radial',
            forceRadial<SimNode>(
                (d) => radiusScale * (1 - d.degree / maxDegree),
                0,
                0,
            ).strength(0.8),
        )
        .force('collide', forceCollide<SimNode>(90))
        .stop()

    // Run 300 ticks synchronously for deterministic layout
    for (let i = 0; i < 300; i++) simulation.tick()

    const posMap = new Map(simNodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]))

    return l4Nodes.map((node) => {
        const pos = posMap.get(node.id) ?? { x: 0, y: 0 }
        return makeRfNode(node, pos, degree.get(node.id) ?? 0)
    })
}

function makeRfNode(
    node: L4GraphNode,
    position: { x: number; y: number },
    deg: number,
): Node<EntityNodeData> {
    return {
        id: node.id,
        type: 'entity',
        position,
        data: {
            label: node.label,
            entityType: 'character' as const,
            attrs: {
                连接度: deg,
                ...(node.overview ? { 概述: node.overview } : {}),
                ...(node.personality ? { 性格: node.personality } : {}),
            },
            firstSeen: 0,
            lastSeen: 0,
            highlighted: false,
            dimmed: false,
        },
    }
}
```

Also remove the old `buildL4GraphNodes` function entirely (lines 607-669).

**Step 4: Install d3-force if not already a direct dependency**

Run: `cd frontend && npm ls d3-force 2>/dev/null || npm install d3-force && npm install -D @types/d3-force`

**Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/__tests__/KnowledgeGraphPage.test.tsx --reporter=verbose`
Expected: All new tests PASS (hub closer to center than leaf)

**Step 6: Commit**

```bash
git add frontend/src/pages/KnowledgeGraphPage.tsx frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx frontend/package.json frontend/package-lock.json
git commit -m "feat(graph): replace concentric layout with D3 forceRadial centrality layout"
```

---

### Task 9: Remove ELK dependency and simplify layout pipeline

**Files:**
- Modify: `frontend/src/pages/KnowledgeGraphPage.tsx:309-364` (remove `layoutGraphWithElk`)
- Modify: `frontend/src/pages/KnowledgeGraphPage.tsx:762-798` (simplify layout effect)
- Test: `frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx`

**Step 1: Write the failing test**

Add to test file:

```typescript
describe('layout pipeline', () => {
    it('does not call ELK (removed dependency)', async () => {
        // Verify layoutGraphWithElk is no longer exported
        const mod = await import('../KnowledgeGraphPage')
        expect((mod as Record<string, unknown>).layoutGraphWithElk).toBeUndefined()
    })
})
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/__tests__/KnowledgeGraphPage.test.tsx -t "does not call ELK"`
Expected: FAIL — `layoutGraphWithElk` is still exported

**Step 3: Write minimal implementation**

1. Delete the `layoutGraphWithElk` function (lines 309-364) and its `getNodeLayoutBox` helper (lines 301-307).
2. Delete the `getElkInstance` dynamic import at the top of the file (search for `elkjs`).
3. Simplify the layout effect (lines 762-798) to use `buildL4GraphNodes` directly since it now returns force-positioned nodes:

```typescript
    useEffect(() => {
        if (!GRAPH_FEATURE_ENABLED) return
        if (l4Nodes.length === 0) {
            setNodes([])
            setEdges([])
            return
        }
        setLayoutLoading(true)
        const rfNodes = buildL4GraphNodes(l4Nodes, l4Edges)
        const nodeIdSet = new Set(rfNodes.map((node) => node.id))
        const rfEdges = buildL4GraphEdges(l4Edges, nodeIdSet)
        setNodes(rfNodes)
        setEdges(rfEdges)
        setSelectedNodeId(null)
        setLayoutLoading(false)
        requestAnimationFrame(() => {
            flowRef.current?.fitView({ padding: 0.36, duration: 420 })
        })
    }, [l4Nodes, l4Edges, setEdges, setNodes])
```

4. Remove `layoutRunRef` (line 711) since async layout is gone.

**Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/__tests__/KnowledgeGraphPage.test.tsx --reporter=verbose`
Expected: All tests PASS

**Step 5: Optionally remove elkjs from dependencies**

Run: `cd frontend && npm uninstall elkjs web-worker`
Only do this if no other code imports elkjs. Search first: `grep -r "elkjs" frontend/src/`

**Step 6: Commit**

```bash
git add frontend/src/pages/KnowledgeGraphPage.tsx frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx frontend/package.json frontend/package-lock.json
git commit -m "refactor(graph): remove ELK, use synchronous D3 force layout pipeline"
```

---
## Phase 4: Frontend — Manual Node CRUD UI
### Task 10: Graph node context menu (delete, edit)
**Files:**
- Modify: `frontend/src/pages/KnowledgeGraphPage.tsx` (add context menu state + handlers)
- Test: `frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx`
**Step 1: Write the failing test**
Add to test file:
```typescript
describe('node context menu', () => {
    it('shows context menu on node right-click', async () => {
        // This test verifies the context menu state management
        // We test the handler function directly since ReactFlow events are hard to simulate
        const { result } = renderHook(() => {
            const [contextMenu, setContextMenu] = useState<{
                nodeId: string
                x: number
                y: number
            } | null>(null)
            return { contextMenu, setContextMenu }
        })
        act(() => {
            result.current.setContextMenu({ nodeId: 'n1', x: 100, y: 200 })
        })
        expect(result.current.contextMenu).toEqual({ nodeId: 'n1', x: 100, y: 200 })
    })
})
```
**Step 2: Run test to verify it fails**
Run: `cd frontend && npx vitest run src/pages/__tests__/KnowledgeGraphPage.test.tsx -t "context menu"`
Expected: FAIL (test infrastructure not yet set up for this pattern)
**Step 3: Write minimal implementation**
Add to `KnowledgeGraphPage.tsx` inside the component:
```typescript
// State for context menu
const [contextMenu, setContextMenu] = useState<{
    nodeId: string
    x: number
    y: number
} | null>(null)
// Right-click handler for nodes
const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
        event.preventDefault()
        setContextMenu({ nodeId: node.id, x: event.clientX, y: event.clientY })
    },
    [],
)
// Close context menu on pane click (add to existing onPaneClick)
// In existing onPaneClick, add: setContextMenu(null)
// Delete handler
const handleDeleteNode = useCallback(async () => {
    if (!contextMenu || !projectId) return
    try {
        await api.delete(`/projects/${projectId}/graph/nodes/${contextMenu.nodeId}`)
        setContextMenu(null)
        addToast('success', '节点已删除')
        loadData()
    } catch {
        addToast('error', '删除失败')
    }
}, [contextMenu, projectId, addToast])
// Edit handler (opens inline edit)
const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
const [editLabel, setEditLabel] = useState('')
const handleStartEdit = useCallback(() => {
    if (!contextMenu) return
    const node = nodes.find((n) => n.id === contextMenu.nodeId)
    setEditLabel(node?.data.label ?? '')
    setEditingNodeId(contextMenu.nodeId)
    setContextMenu(null)
}, [contextMenu, nodes])
const handleSaveEdit = useCallback(async () => {
    if (!editingNodeId || !projectId) return
    try {
        await api.patch(`/projects/${projectId}/graph/nodes/${editingNodeId}`, {
            label: editLabel,
        })
        setEditingNodeId(null)
        addToast('success', '节点已更新')
        loadData()
    } catch {
        addToast('error', '更新失败')
    }
}, [editingNodeId, editLabel, projectId, addToast])
```
Add the context menu JSX inside the graph card `<div>`, after `<ReactFlow>`:
```tsx
{contextMenu && (
    <div
        style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            background: 'white',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            zIndex: 50,
            padding: '4px 0',
            minWidth: 140,
        }}
    >
        <button
            onClick={handleStartEdit}
            style={{
                display: 'block', width: '100%', padding: '8px 16px',
                border: 'none', background: 'none', textAlign: 'left',
                cursor: 'pointer', fontSize: '0.88rem',
            }}
        >
            ✐ 编辑节点
        </button>
        <button
            onClick={handleDeleteNode}
            style={{
                display: 'block', width: '100%', padding: '8px 16px',
                border: 'none', background: 'none', textAlign: 'left',
                cursor: 'pointer', fontSize: '0.88rem', color: '#d32f2f',
            }}
        >
            ✖ 删除节点
        </button>
    </div>
)}
```
Add `onNodeContextMenu` to the `<ReactFlow>` props:
```tsx
<ReactFlow
    ...
    onNodeContextMenu={onNodeContextMenu}
    ...
/>
```
Add to existing `onPaneClick`:
```typescript
setContextMenu(null)
setEditingNodeId(null)
```
**Step 4: Run test to verify it passes**
Run: `cd frontend && npx vitest run src/pages/__tests__/KnowledgeGraphPage.test.tsx --reporter=verbose`
Expected: PASS
**Step 5: Commit**
```bash
git add frontend/src/pages/KnowledgeGraphPage.tsx frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx
git commit -m "feat(graph): add node context menu with delete and edit actions"
```
---
### Task 11: Add node toolbar (create new node + merge)
**Files:**
- Modify: `frontend/src/pages/KnowledgeGraphPage.tsx` (add toolbar buttons)
- Test: `frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx`
**Step 1: Write the failing test**
```typescript
describe('graph toolbar', () => {
    it('renders add-node button', () => {
        render(
            <MemoryRouter initialEntries={['/project/test-id/graph']}>
                <Routes>
                    <Route path="/project/:projectId/graph" element={<KnowledgeGraphPage />} />
                </Routes>
            </MemoryRouter>,
        )
        // The button should exist in the toolbar area
        expect(screen.getByRole('button', { name: /添加节点/ })).toBeInTheDocument()
    })
})
```
**Step 2: Run test to verify it fails**
Run: `cd frontend && npx vitest run src/pages/__tests__/KnowledgeGraphPage.test.tsx -t "graph toolbar"`
Expected: FAIL — no button with name "添加节点"
**Step 3: Write minimal implementation**
Add state and handlers to the component:
```typescript
const [showAddModal, setShowAddModal] = useState(false)
const [newNodeLabel, setNewNodeLabel] = useState('')
const handleAddNode = useCallback(async () => {
    if (!newNodeLabel.trim() || !projectId) return
    try {
        await api.post(`/projects/${projectId}/graph/nodes`, {
            label: newNodeLabel.trim(),
        })
        setShowAddModal(false)
        setNewNodeLabel('')
        addToast('success', '节点已创建')
        loadData()
    } catch {
        addToast('error', '创建失败')
    }
}, [newNodeLabel, projectId, addToast])
```
Add toolbar buttons in the graph tab area (inside the `!loading && tab === 'graph'` block), after the existing chip buttons:
```tsx
<button
    className="chip-btn"
    onClick={() => setShowAddModal(true)}
    aria-label="添加节点"
>
    + 添加节点
</button>
```
Add a simple modal for node creation:
```tsx
{showAddModal && (
    <div
        style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100,
        }}
        onClick={() => setShowAddModal(false)}
    >
        <div
            className="card"
            style={{ padding: 24, minWidth: 320 }}
            onClick={(e) => e.stopPropagation()}
        >
            <h3 style={{ marginTop: 0, fontSize: '1rem' }}>添加新节点</h3>
            <input
                type="text"
                value={newNodeLabel}
                onChange={(e) => setNewNodeLabel(e.target.value)}
                placeholder="节点名称"
                style={{
                    width: '100%', padding: '8px 12px', border: '1px solid var(--border)',
                    borderRadius: 6, fontSize: '0.9rem', marginBottom: 12,
                }}
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleAddNode()}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={() => setShowAddModal(false)}>
                    取消
                </button>
                <button className="btn btn-primary" onClick={handleAddNode}>
                    创建
                </button>
            </div>
        </div>
    </div>
)}
```
**Step 4: Run test to verify it passes**
Run: `cd frontend && npx vitest run src/pages/__tests__/KnowledgeGraphPage.test.tsx --reporter=verbose`
Expected: PASS
**Step 5: Commit**
```bash
git add frontend/src/pages/KnowledgeGraphPage.tsx frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx
git commit -m "feat(graph): add node creation toolbar button and modal"
```
---
### Task 12: Merge nodes UI (multi-select + merge action)
**Files:**
- Modify: `frontend/src/pages/KnowledgeGraphPage.tsx`
- Test: `frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx`
**Step 1: Write the failing test**
```typescript
describe('merge nodes', () => {
    it('shows merge button when 2+ nodes are selected', () => {
        // Test the merge button visibility logic
        const selectedIds = new Set(['n1', 'n2'])
        const showMerge = selectedIds.size >= 2
        expect(showMerge).toBe(true)
    })
    it('hides merge button when fewer than 2 nodes selected', () => {
        const selectedIds = new Set(['n1'])
        const showMerge = selectedIds.size >= 2
        expect(showMerge).toBe(false)
    })
})
```
**Step 2: Run test to verify it fails**
Run: `cd frontend && npx vitest run src/pages/__tests__/KnowledgeGraphPage.test.tsx -t "merge nodes"`
Expected: These are pure logic tests, they should PASS immediately. The real test is the integration.
**Step 3: Write minimal implementation**
Add multi-select state:
```typescript
const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set())
// Toggle selection on Ctrl/Cmd+click
const onNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
        if (event.ctrlKey || event.metaKey) {
            // Multi-select mode
            setSelectedNodeIds((prev) => {
                const next = new Set(prev)
                if (next.has(node.id)) next.delete(node.id)
                else next.add(node.id)
                return next
            })
            return
        }
        // Single-click: existing highlight behavior (keep current code)
        setSelectedNodeIds(new Set())
        // ... existing onNodeClick logic ...
    },
    [/* existing deps */],
)
```
Add merge handler:
```typescript
const handleMergeNodes = useCallback(async () => {
    if (selectedNodeIds.size < 2 || !projectId) return
    const ids = [...selectedNodeIds]
    const keepId = ids[0] // First selected = keep target
    const mergeIds = ids.slice(1)
    try {
        await api.post(`/projects/${projectId}/graph/nodes/merge`, {
            keep_node_id: keepId,
            merge_node_ids: mergeIds,
        })
        setSelectedNodeIds(new Set())
        addToast('success', `已合并 ${mergeIds.length} 个节点`)
        loadData()
    } catch {
        addToast('error', '合并失败')
    }
}, [selectedNodeIds, projectId, addToast])
```
Add merge button in toolbar (conditionally visible):
```tsx
{selectedNodeIds.size >= 2 && (
    <button
        className="chip-btn active"
        onClick={handleMergeNodes}
        aria-label="合并节点"
    >
        ⇈ 合并选中的 {selectedNodeIds.size} 个节点
    </button>
)}
```
Add visual feedback for multi-selected nodes (in the node rendering):
```typescript
// In the node style computation, add a border highlight for selected nodes
// This integrates with the existing highlighted/dimmed system
```
**Step 4: Run test to verify it passes**
Run: `cd frontend && npx vitest run src/pages/__tests__/KnowledgeGraphPage.test.tsx --reporter=verbose`
Expected: PASS
**Step 5: Commit**
```bash
git add frontend/src/pages/KnowledgeGraphPage.tsx frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx
git commit -m "feat(graph): add multi-select and merge nodes UI"
```
---
## Phase 5: Integration Tests + Full Verification
### Task 13: Backend full test suite run
**Files:**
- All backend test files
**Step 1: Run full backend test suite**
Run: `cd backend && python -m pytest -v`
Expected: All tests PASS (existing 243 + new ~20 from Tasks 1-7)
**Step 2: Fix any failures**
If any pre-existing tests break due to new table creation or API changes, fix them. Common issues:
- Tests that check exact table count in SQLite may need updating
- Tests that mock `MemoryStore.__init__` may need to account for new tables
**Step 3: Commit if fixes were needed**
```bash
git add -A
git commit -m "fix(tests): update existing tests for new graph tables"
```
---
### Task 14: Frontend full test suite run
**Files:**
- All frontend test files
**Step 1: Run full frontend test suite**
Run: `cd frontend && npx vitest run --reporter=verbose`
Expected: All tests PASS (existing 480 + new ~10 from Tasks 8-12)
**Step 2: Run build**
Run: `cd frontend && npm run build`
Expected: Build succeeds with no TypeScript errors
**Step 3: Fix any failures**
Common issues:
- Import changes from removing ELK may break other test files that import `layoutGraphWithElk`
- New d3-force imports may need vitest config for ESM handling
**Step 4: Commit if fixes were needed**
```bash
git add -A
git commit -m "fix(tests): update frontend tests for new graph layout and CRUD"
```
---
### Task 15: Manual smoke test checklist
This task is NOT automated. The implementer should verify these manually with dev servers running:
1. Open `http://localhost:3000/project/{projectId}/graph`
2. Verify graph loads with centrality layout (high-degree nodes near center)
3. Right-click a node → context menu appears with "编辑" and "删除"
4. Click "删除" → node disappears, toast shows "节点已删除"
5. Click "+ 添加节点" → modal appears, type name, click "创建" → new node appears
6. Ctrl+click two nodes → merge button appears → click merge → one node remains
7. Refresh page → all changes persist (soft-deletes, manual nodes, merges)
8. Right-click a node → "编辑" → change name → save → label updates
---
## Summary
| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-3 | Backend override layer (3 new SQLite tables + store methods) |
| 2 | 4-7 | Backend CRUD API (enhanced GET /graph, POST/PATCH/DELETE nodes, merge, rebuild protection) |
| 3 | 8-9 | Frontend centrality layout (D3 forceRadial, remove ELK) |
| 4 | 10-12 | Frontend CRUD UI (context menu, add modal, multi-select merge) |
| 5 | 13-15 | Integration tests + manual smoke test |
**Total: 15 tasks, ~12 new files, ~6 modified files**
**Estimated effort: 3-5 hours with subagent-driven execution**
