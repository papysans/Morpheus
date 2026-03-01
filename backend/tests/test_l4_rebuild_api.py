"""Tests for L4 manual rebuild API (TDD - Task 9)."""

import os
import unittest
from uuid import uuid4

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"
os.environ["GRAPH_FEATURE_ENABLED"] = "true"

from fastapi.testclient import TestClient
from api.main import app


class TestManualRebuildAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _create_project(self) -> str:
        res = cls.client.post(
            "/api/projects",
            json={
                "name": f"rebuild-test-{uuid4().hex[:6]}",
                "genre": "奇幻",
                "style": "冷峻",
            },
        )
        return res.json()["id"]

    def setUp(self):
        self.client = TestClient(app)
        res = self.client.post(
            "/api/projects",
            json={
                "name": f"rebuild-test-{uuid4().hex[:6]}",
                "genre": "奇幻",
                "style": "冷峻",
            },
        )
        self.project_id = res.json()["id"]

    # --- Happy path ---

    def test_rebuild_returns_200(self):
        res = self.client.post(f"/api/projects/{self.project_id}/profiles/rebuild")
        self.assertEqual(res.status_code, 200)

    def test_rebuild_response_has_stats_fields(self):
        res = self.client.post(f"/api/projects/{self.project_id}/profiles/rebuild")
        data = res.json()
        for field in ["processed", "updated", "skipped", "errors"]:
            self.assertIn(field, data, f"Missing field: {field}")

    def test_rebuild_stats_are_integers(self):
        res = self.client.post(f"/api/projects/{self.project_id}/profiles/rebuild")
        data = res.json()
        self.assertIsInstance(data["processed"], int)
        self.assertIsInstance(data["updated"], int)
        self.assertIsInstance(data["skipped"], int)
        self.assertIsInstance(data["errors"], int)

    def test_rebuild_empty_project_returns_zero_processed(self):
        res = self.client.post(f"/api/projects/{self.project_id}/profiles/rebuild")
        data = res.json()
        self.assertEqual(data["processed"], 0)

    def test_rebuild_with_chapter_range(self):
        res = self.client.post(
            f"/api/projects/{self.project_id}/profiles/rebuild",
            json={"start_chapter": 1, "end_chapter": 5},
        )
        self.assertEqual(res.status_code, 200)

    def test_rebuild_with_character_filter(self):
        res = self.client.post(
            f"/api/projects/{self.project_id}/profiles/rebuild",
            json={"character_names": ["张三", "李四"]},
        )
        self.assertEqual(res.status_code, 200)

    # --- Negative / validation ---

    def test_rebuild_invalid_range_returns_400(self):
        res = self.client.post(
            f"/api/projects/{self.project_id}/profiles/rebuild",
            json={"start_chapter": 10, "end_chapter": 3},
        )
        self.assertEqual(res.status_code, 422)

    def test_rebuild_nonexistent_project_returns_404(self):
        res = self.client.post("/api/projects/nonexistent-proj/profiles/rebuild")
        self.assertEqual(res.status_code, 404)


if __name__ == "__main__":
    unittest.main()
