"""Tests for L4 export capability (TDD - Task 15)."""

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
from models import CharacterProfile, CharacterRelationship
from memory import MemoryStore


class TestL4Export(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _create_project(self) -> str:
        res = self.client.post(
            "/api/projects",
            json={
                "name": f"export-l4-{uuid4().hex[:6]}",
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
            relationships=[
                CharacterRelationship(
                    source_character="张三",
                    target_character="李四",
                    relation_type="师徒",
                    chapter=1,
                )
            ],
        )
        store.upsert_profile(profile)

    def _export_zip(self, project_id: str) -> zipfile.ZipFile:
        res = self.client.get(f"/api/projects/{project_id}/export")
        self.assertEqual(res.status_code, 200)
        return zipfile.ZipFile(io.BytesIO(res.content))

    def test_export_contains_novelist_db(self):
        """novelist.db (which holds character_profiles) must be in the ZIP."""
        pid = self._create_project()
        self._seed_l4(pid)
        with self._export_zip(pid) as zf:
            names = zf.namelist()
            has_db = any("novelist.db" in n for n in names)
            self.assertTrue(has_db, f"novelist.db not found in export. Files: {names}")

    def test_export_contains_export_meta(self):
        """export_meta.json with export_version must be in the ZIP."""
        pid = self._create_project()
        with self._export_zip(pid) as zf:
            names = zf.namelist()
            meta_entry = next((n for n in names if "export_meta.json" in n), None)
            self.assertIsNotNone(meta_entry, f"export_meta.json not found. Files: {names}")
            meta = json.loads(zf.read(meta_entry))
            self.assertIn("export_version", meta)

    def test_export_meta_version_is_l4(self):
        """export_version must indicate L4 support."""
        pid = self._create_project()
        with self._export_zip(pid) as zf:
            meta_entry = next(n for n in zf.namelist() if "export_meta.json" in n)
            meta = json.loads(zf.read(meta_entry))
            self.assertIn(meta["export_version"], ["2", "l4", 2])

    def test_export_legacy_project_still_succeeds(self):
        """Projects without L4 data must still export successfully."""
        pid = self._create_project()
        # No L4 data seeded
        res = self.client.get(f"/api/projects/{pid}/export")
        self.assertEqual(res.status_code, 200)
        self.assertIn("zip", res.headers.get("content-type", ""))


if __name__ == "__main__":
    unittest.main()
