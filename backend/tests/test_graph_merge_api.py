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
        store.upsert_profile(
            CharacterProfile(
                profile_id=pid_a,
                project_id=pid,
                character_name="普罗米修斯",
                overview="火种之神",
            )
        )
        store.upsert_profile(
            CharacterProfile(
                profile_id=pid_b,
                project_id=pid,
                character_name="普罗米修斯A",
                overview="变体",
                relationships=[
                    CharacterRelationship(
                        source_character="普罗米修斯A",
                        target_character="宙斯",
                        relation_type="对抗",
                        chapter=3,
                    )
                ],
            )
        )
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
        store.upsert_profile(
            CharacterProfile(
                profile_id=pid_a,
                project_id=pid,
                character_name="沈砺",
            )
        )
        store.upsert_profile(
            CharacterProfile(
                profile_id=pid_b,
                project_id=pid,
                character_name="林溪",
            )
        )
        self.client.post(
            f"/api/projects/{pid}/graph/nodes/merge",
            json={"keep_node_id": pid_a, "merge_node_ids": [pid_b]},
        )
        aliases = store.get_node_aliases(pid_a)
        alias_names = {a["alias_name"] for a in aliases}
        self.assertIn("林溪", alias_names)


if __name__ == "__main__":
    unittest.main()
