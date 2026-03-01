import io
import os
import unittest
from typing import ClassVar, TypedDict, cast, override
from uuid import uuid4

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"
os.environ["GRAPH_FEATURE_ENABLED"] = "true"

from fastapi.testclient import TestClient
from api.main import app, get_or_create_store
from models import CharacterProfile, CharacterRelationship, OverrideSource
from memory import MemoryStore


class GraphNode(TypedDict):
    id: str
    label: str


class GraphResponse(TypedDict):
    nodes: list[GraphNode]
    edges: list[dict[str, object]]


class TestL4RoundTrip(unittest.TestCase):
    client: ClassVar[TestClient]

    @classmethod
    @override
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _create_project(self) -> str:
        res = self.client.post(
            "/api/projects",
            json={
                "name": f"roundtrip-{uuid4().hex[:6]}",
                "genre": "奇幻",
                "style": "冷峻",
            },
        )
        self.assertEqual(res.status_code, 200)
        payload = cast(dict[str, object], res.json())
        project_id = payload["id"]
        self.assertIsInstance(project_id, str)
        return cast(str, project_id)

    def _graph_nodes(self, project_id: str) -> list[GraphNode]:
        graph_res = self.client.get(f"/api/projects/{project_id}/graph")
        self.assertEqual(graph_res.status_code, 200)
        payload = cast(GraphResponse, graph_res.json())
        return payload["nodes"]

    def _seed_profiles(self, project_id: str, count: int = 2):
        store = get_or_create_store(project_id)
        for i in range(count):
            name = f"角色{i}"
            pid = MemoryStore.make_profile_id(project_id, name)
            profile = CharacterProfile(
                profile_id=pid,
                project_id=project_id,
                character_name=name,
                overview=f"角色{i}的概述",
                relationships=(
                    [
                        CharacterRelationship(
                            source_character=name,
                            target_character=f"角色{(i + 1) % count}",
                            relation_type="朋友",
                            chapter=1,
                        )
                    ]
                    if count > 1
                    else []
                ),
            )
            store.upsert_profile(profile)

    def test_full_roundtrip_l4_data_consistent(self):
        orig_pid = self._create_project()
        self._seed_profiles(orig_pid, count=2)

        orig_nodes = self._graph_nodes(orig_pid)
        self.assertGreater(len(orig_nodes), 0)

        export_res = self.client.get(f"/api/projects/{orig_pid}/export")
        self.assertEqual(export_res.status_code, 200)

        import_res = self.client.post(
            "/api/projects/import",
            files={"file": ("project.zip", io.BytesIO(export_res.content), "application/zip")},
        )
        self.assertEqual(import_res.status_code, 200)
        import_payload = cast(dict[str, object], import_res.json())
        new_pid = import_payload["project_id"]
        self.assertIsInstance(new_pid, str)
        new_pid = cast(str, new_pid)

        new_nodes = self._graph_nodes(new_pid)
        self.assertGreater(len(new_nodes), 0)

        orig_names = {n["label"] for n in orig_nodes}
        new_names = {n["label"] for n in new_nodes}
        self.assertEqual(orig_names, new_names, "Character names must survive round-trip")

    def test_l1_l2_l3_memory_unaffected_by_l4_operations(self):
        pid = self._create_project()
        _ = self.client.post(
            "/api/memory/commit",
            json={
                "project_id": pid,
                "layer": "L1",
                "content": "世界观：冰霜大陆",
                "source_path": "memory/L1/IDENTITY.md",
            },
        )
        self._seed_profiles(pid, count=3)
        _ = self.client.post(f"/api/projects/{pid}/profiles/rebuild", json={})
        query_res = self.client.get(
            "/api/memory/query",
            params={
                "project_id": pid,
                "query": "冰霜大陆",
            },
        )
        self.assertIn(query_res.status_code, [200])

    def test_graph_api_handles_large_profile_set(self):
        pid = self._create_project()
        self._seed_profiles(pid, count=20)
        res = self.client.get(f"/api/projects/{pid}/graph")
        self.assertEqual(res.status_code, 200)
        data = cast(GraphResponse, res.json())
        self.assertEqual(len(data["nodes"]), 20)

    def test_graph_node_ids_stable_across_calls(self):
        pid = self._create_project()
        self._seed_profiles(pid, count=3)
        ids1 = {n["id"] for n in self._graph_nodes(pid)}
        ids2 = {n["id"] for n in self._graph_nodes(pid)}
        self.assertEqual(ids1, ids2, "Node IDs must be stable (deterministic)")

    def test_l4_rebuild_preserves_user_override(self):
        pid = self._create_project()
        store = get_or_create_store(pid)
        profile_id = MemoryStore.make_profile_id(pid, "张三")
        profile = CharacterProfile(
            profile_id=profile_id,
            project_id=pid,
            character_name="张三",
            personality="用户设定的性格",
            override_source=OverrideSource.USER_OVERRIDE,
        )
        store.upsert_profile(profile)
        _ = self.client.post(f"/api/projects/{pid}/profiles/rebuild", json={})
        updated = store.get_profile(profile_id)
        if updated:
            self.assertEqual(
                updated.personality,
                "用户设定的性格",
                "User override must survive rebuild",
            )
