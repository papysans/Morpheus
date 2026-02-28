"""Tests for L4 import capability (TDD - Task 16)."""

import os
import io
import json
import zipfile
import unittest
from uuid import uuid4

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"

from fastapi.testclient import TestClient
from api.main import app, get_or_create_store
from models import CharacterProfile
from memory import MemoryStore


class TestL4Import(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _create_project(self) -> str:
        res = self.client.post(
            "/api/projects",
            json={
                "name": f"import-l4-{uuid4().hex[:6]}",
                "genre": "奇幻",
                "style": "冷峻",
            },
        )
        self.assertEqual(res.status_code, 200)
        return res.json()["id"]

    def _seed_l4(self, project_id: str):
        store = get_or_create_store(project_id)
        pid = MemoryStore.make_profile_id(project_id, "张三")
        profile = CharacterProfile(
            profile_id=pid,
            project_id=project_id,
            character_name="张三",
            overview="主角",
        )
        store.upsert_profile(profile)
        return pid

    def _export_bytes(self, project_id: str) -> bytes:
        res = self.client.get(f"/api/projects/{project_id}/export")
        self.assertEqual(res.status_code, 200)
        return res.content

    def _import_zip(self, zip_bytes: bytes) -> str:
        res = self.client.post(
            "/api/projects/import",
            files={"file": ("project.zip", io.BytesIO(zip_bytes), "application/zip")},
        )
        self.assertEqual(res.status_code, 200)
        return res.json()["project_id"]

    def test_import_new_format_restores_l4_profiles(self):
        """Importing a new-format archive (with novelist.db) restores L4 profiles."""
        orig_pid = self._create_project()
        self._seed_l4(orig_pid)
        zip_bytes = self._export_bytes(orig_pid)
        new_pid = self._import_zip(zip_bytes)
        store = get_or_create_store(new_pid)
        profiles = store.list_profiles(new_pid)
        self.assertGreater(len(profiles), 0, "Expected L4 profiles after import")
        names = [p.character_name for p in profiles]
        self.assertIn("张三", names)

    def test_import_old_format_succeeds_with_empty_l4(self):
        """Importing an old-format archive (without novelist.db) succeeds with empty L4."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            project_data = {
                "id": "old-proj-id",
                "name": "老项目",
                "genre": "奇幻",
                "style": "冷峻",
                "target_length": 100000,
                "created_at": "2025-01-01T00:00:00",
                "updated_at": "2025-01-01T00:00:00",
            }
            zf.writestr("project-old/project.json", json.dumps(project_data))
        buf.seek(0)
        res = self.client.post(
            "/api/projects/import",
            files={"file": ("old.zip", buf, "application/zip")},
        )
        self.assertEqual(res.status_code, 200)
        new_pid = res.json()["project_id"]
        store = get_or_create_store(new_pid)
        profiles = store.list_profiles(new_pid)
        self.assertEqual(profiles, [], "Old-format import should have empty L4")

    def test_import_preserves_character_name(self):
        """Character name must survive export→import round-trip."""
        orig_pid = self._create_project()
        self._seed_l4(orig_pid)
        zip_bytes = self._export_bytes(orig_pid)
        new_pid = self._import_zip(zip_bytes)
        store = get_or_create_store(new_pid)
        profiles = store.list_profiles(new_pid)
        self.assertTrue(
            any(p.character_name == "张三" for p in profiles),
            "Character name '张三' must survive round-trip",
        )


if __name__ == "__main__":
    unittest.main()
