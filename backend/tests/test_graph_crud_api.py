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
        store = get_or_create_store(pid)
        profile_id = MemoryStore.make_profile_id(pid, "测试角色")
        store.upsert_profile(
            CharacterProfile(
                profile_id=profile_id,
                project_id=pid,
                character_name="测试角色",
            )
        )
        res = self.client.patch(
            f"/api/projects/{pid}/graph/nodes/{profile_id}",
            json={"label": "改名角色", "overview": "新概述"},
        )
        self.assertEqual(res.status_code, 200)
        graph = self.client.get(f"/api/projects/{pid}/graph").json()
        node = next(n for n in graph["nodes"] if n["id"] == profile_id)
        self.assertEqual(node["label"], "改名角色")

    def test_soft_delete_node(self):
        pid = self._create_project()
        store = get_or_create_store(pid)
        profile_id = MemoryStore.make_profile_id(pid, "待删角色")
        store.upsert_profile(
            CharacterProfile(
                profile_id=profile_id,
                project_id=pid,
                character_name="待删角色",
            )
        )
        res = self.client.delete(f"/api/projects/{pid}/graph/nodes/{profile_id}")
        self.assertEqual(res.status_code, 200)
        graph = self.client.get(f"/api/projects/{pid}/graph").json()
        self.assertNotIn(profile_id, {n["id"] for n in graph["nodes"]})

    def test_restore_node(self):
        pid = self._create_project()
        store = get_or_create_store(pid)
        profile_id = MemoryStore.make_profile_id(pid, "恢复角色")
        store.upsert_profile(
            CharacterProfile(
                profile_id=profile_id,
                project_id=pid,
                character_name="恢复角色",
            )
        )
        self.client.delete(f"/api/projects/{pid}/graph/nodes/{profile_id}")
        res = self.client.post(f"/api/projects/{pid}/graph/nodes/{profile_id}/restore")
        self.assertEqual(res.status_code, 200)
        graph = self.client.get(f"/api/projects/{pid}/graph").json()
        self.assertIn(profile_id, {n["id"] for n in graph["nodes"]})


if __name__ == "__main__":
    unittest.main()
