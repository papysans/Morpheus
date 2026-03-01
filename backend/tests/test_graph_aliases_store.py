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
        tmp = f"/tmp/test-aliases-{self.project_id}"
        self.store = MemoryStore(project_path=tmp, db_path=f"{tmp}/test.db")

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
