"""Tests for graph data API switched to L4 source (TDD - Task 10)."""

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


def _seed_l4_data(project_id: str):
    store = get_or_create_store(project_id)
    pid_a = MemoryStore.make_profile_id(project_id, "张三")
    pid_b = MemoryStore.make_profile_id(project_id, "李四")
    profile_a = CharacterProfile(
        profile_id=pid_a,
        project_id=project_id,
        character_name="张三",
        overview="主角",
        relationships=[
            CharacterRelationship(
                source_character="张三",
                target_character="李四",
                relation_type="师徒",
                chapter=1,
            )
        ],
    )
    profile_b = CharacterProfile(
        profile_id=pid_b,
        project_id=project_id,
        character_name="李四",
        overview="师父",
    )
    store.upsert_profile(profile_a)
    store.upsert_profile(profile_b)
    return store


class TestGraphDataAPIL4(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _create_project(self) -> str:
        res = self.client.post(
            "/api/projects",
            json={
                "name": f"graph-l4-{uuid4().hex[:6]}",
                "genre": "奇幻",
                "style": "冷峻",
            },
        )
        self.assertEqual(res.status_code, 200)
        return res.json()["id"]

    def test_graph_data_endpoint_exists(self):
        pid = self._create_project()
        res = self.client.get(f"/api/projects/{pid}/graph")
        self.assertIn(res.status_code, [200])

    def test_graph_data_returns_nodes_and_edges(self):
        pid = self._create_project()
        res = self.client.get(f"/api/projects/{pid}/graph")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("nodes", data)
        self.assertIn("edges", data)

    def test_graph_data_empty_project_returns_empty_lists(self):
        pid = self._create_project()
        res = self.client.get(f"/api/projects/{pid}/graph")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIsInstance(data["nodes"], list)
        self.assertIsInstance(data["edges"], list)

    def test_graph_data_with_l4_profiles_returns_nodes(self):
        pid = self._create_project()
        _seed_l4_data(pid)
        res = self.client.get(f"/api/projects/{pid}/graph")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertGreater(len(data["nodes"]), 0)
        node_ids = {n["id"] for n in data["nodes"]}
        self.assertTrue(any("张三" in str(n) for n in data["nodes"]))

    def test_graph_data_with_l4_profiles_returns_edges(self):
        pid = self._create_project()
        _seed_l4_data(pid)
        res = self.client.get(f"/api/projects/{pid}/graph")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertGreater(len(data["edges"]), 0)
        edge = data["edges"][0]
        for field in ["id", "source", "target", "label"]:
            self.assertIn(field, edge, f"Missing edge field: {field}")

    def test_graph_nodes_have_stable_ids(self):
        pid = self._create_project()
        _seed_l4_data(pid)
        res1 = self.client.get(f"/api/projects/{pid}/graph")
        res2 = self.client.get(f"/api/projects/{pid}/graph")
        ids1 = {n["id"] for n in res1.json()["nodes"]}
        ids2 = {n["id"] for n in res2.json()["nodes"]}
        self.assertEqual(ids1, ids2)

    def test_graph_data_nonexistent_project_returns_empty(self):
        res = self.client.get("/api/projects/nonexistent-proj/graph")
        self.assertIn(res.status_code, [200, 404])
        if res.status_code == 200:
            data = res.json()
            self.assertEqual(data["nodes"], [])
            self.assertEqual(data["edges"], [])

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


if __name__ == "__main__":
    unittest.main()
