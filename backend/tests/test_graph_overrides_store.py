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
        tmp = f"/tmp/test-overrides-{self.project_id}"
        self.store = MemoryStore(project_path=tmp, db_path=f"{tmp}/test.db")

    def test_table_exists(self):
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
