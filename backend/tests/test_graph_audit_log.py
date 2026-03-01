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
        tmp = f"/tmp/test-audit-{self.project_id}"
        self.store = MemoryStore(project_path=tmp, db_path=f"{tmp}/test.db")

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
