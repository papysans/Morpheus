"""Tests for L4 API contracts - GET /api/projects/{id}/profiles (TDD - Task 3)."""

import os
import unittest
from uuid import uuid4

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"
os.environ["GRAPH_FEATURE_ENABLED"] = "true"

from fastapi.testclient import TestClient
from api.main import app, get_or_create_store


class TestL4ProfilesAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _create_project(self) -> str:
        res = self.client.post(
            "/api/projects",
            json={
                "name": f"test-{uuid4().hex[:6]}",
                "genre": "奇幻",
                "style": "冷峻",
            },
        )
        self.assertEqual(res.status_code, 200)
        return res.json()["id"]

    def _seed_profile(self, project_id: str, name: str = "张三"):
        from models import CharacterProfile
        from memory import MemoryStore

        store = get_or_create_store(project_id)
        profile_id = MemoryStore.make_profile_id(project_id, name)
        profile = CharacterProfile(
            profile_id=profile_id,
            project_id=project_id,
            character_name=name,
            overview=f"{name}的概述",
            personality="坚毅",
        )
        store.upsert_profile(profile)
        return profile_id

    # --- List profiles ---

    def test_list_profiles_empty(self):
        pid = self._create_project()
        res = self.client.get(f"/api/projects/{pid}/profiles")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIsInstance(data, list)
        self.assertEqual(len(data), 0)

    def test_list_profiles_returns_profiles(self):
        pid = self._create_project()
        self._seed_profile(pid, "张三")
        self._seed_profile(pid, "李四")
        res = self.client.get(f"/api/projects/{pid}/profiles")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(len(data), 2)
        names = {p["character_name"] for p in data}
        self.assertIn("张三", names)
        self.assertIn("李四", names)

    def test_list_profiles_has_required_fields(self):
        pid = self._create_project()
        self._seed_profile(pid)
        res = self.client.get(f"/api/projects/{pid}/profiles")
        self.assertEqual(res.status_code, 200)
        profile = res.json()[0]
        for field in [
            "profile_id",
            "character_name",
            "overview",
            "personality",
            "relationships",
            "state_changes",
            "chapter_events",
        ]:
            self.assertIn(field, profile, f"Missing field: {field}")

    def test_list_profiles_nonexistent_project_returns_empty(self):
        res = self.client.get("/api/projects/nonexistent-proj/profiles")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), [])

    # --- Get single profile ---

    def test_get_profile_by_id(self):
        pid = self._create_project()
        profile_id = self._seed_profile(pid, "张三")
        res = self.client.get(f"/api/projects/{pid}/profiles/{profile_id}")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["character_name"], "张三")
        self.assertEqual(data["overview"], "张三的概述")

    def test_get_profile_not_found(self):
        pid = self._create_project()
        res = self.client.get(f"/api/projects/{pid}/profiles/nonexistent-profile-id")
        self.assertEqual(res.status_code, 404)
        self.assertIn("detail", res.json())

    def test_get_profile_wrong_project(self):
        pid1 = self._create_project()
        pid2 = self._create_project()
        profile_id = self._seed_profile(pid1, "张三")
        # Profile belongs to pid1, not pid2
        res = self.client.get(f"/api/projects/{pid2}/profiles/{profile_id}")
        self.assertEqual(res.status_code, 404)

    # --- Existing endpoints unaffected ---

    def test_existing_entities_endpoint_unaffected(self):
        pid = self._create_project()
        res = self.client.get(f"/api/entities/{pid}")
        self.assertEqual(res.status_code, 200)

    def test_existing_events_endpoint_unaffected(self):
        pid = self._create_project()
        res = self.client.get(f"/api/events/{pid}")
        self.assertEqual(res.status_code, 200)


if __name__ == "__main__":
    unittest.main()
