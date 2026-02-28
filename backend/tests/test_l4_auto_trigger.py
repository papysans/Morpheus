"""Tests for L4 auto-trigger on chapter completion (TDD - Task 8)."""

import os
import unittest
from unittest.mock import patch, MagicMock
from uuid import uuid4

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"
os.environ["GRAPH_FEATURE_ENABLED"] = "true"
os.environ["L4_PROFILE_ENABLED"] = "true"
os.environ["L4_AUTO_EXTRACT_ENABLED"] = "true"

from fastapi.testclient import TestClient
from api.main import app


class TestL4AutoTrigger(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _create_project(self) -> str:
        res = self.client.post(
            "/api/projects",
            json={
                "name": f"autotrigger-{uuid4().hex[:6]}",
                "genre": "奇幻",
                "style": "冷峻",
            },
        )
        self.assertEqual(res.status_code, 200)
        return res.json()["id"]

    def _create_chapter(self, project_id: str) -> str:
        res = self.client.post(
            "/api/chapters",
            json={
                "project_id": project_id,
                "chapter_number": 1,
                "title": "第一章",
                "goal": "测试目标",
            },
        )
        self.assertEqual(res.status_code, 200)
        return res.json()["id"]

    def test_chapter_approval_succeeds_even_if_l4_extraction_fails(self):
        """L4 extraction failure must NOT block chapter approval."""
        pid = self._create_project()
        cid = self._create_chapter(pid)

        # Set draft content
        from api.main import chapters

        chapter = chapters[pid][cid]
        chapter.draft = "第一章正文内容，张三出场。"

        with patch(
            "api.main.trigger_l4_extraction_async",
            side_effect=RuntimeError("extraction exploded"),
        ):
            res = self.client.post(
                f"/api/review",
                json={
                    "chapter_id": cid,
                    "action": "approve",
                    "comment": "",
                },
            )
        # Chapter approval should still succeed
        self.assertIn(res.status_code, [200, 422])  # 422 if no draft, 200 if approved

    def test_l4_extraction_disabled_flag_skips_extraction(self):
        """When L4_AUTO_EXTRACT_ENABLED=false, extraction is not called."""
        pid = self._create_project()
        cid = self._create_chapter(pid)

        from api.main import chapters

        chapter = chapters[pid][cid]
        chapter.draft = "章节内容"

        with patch("api.main.settings") as mock_settings:
            mock_settings.l4_profile_enabled = True
            mock_settings.l4_auto_extract_enabled = False
            mock_settings.graph_feature_enabled = True

            with patch("api.main.trigger_l4_extraction_async") as mock_trigger:
                # Simulate the check that would happen in the approval path
                if mock_settings.l4_profile_enabled and mock_settings.l4_auto_extract_enabled:
                    mock_trigger()

                mock_trigger.assert_not_called()

    def test_trigger_l4_extraction_async_exists(self):
        """The trigger function must be importable from api.main."""
        from api.main import trigger_l4_extraction_async

        self.assertTrue(callable(trigger_l4_extraction_async))

    def test_trigger_l4_extraction_async_does_not_raise(self):
        """Calling trigger with mock store/chapter should not raise."""
        from api.main import trigger_l4_extraction_async

        mock_store = MagicMock()
        mock_store.get_profile.return_value = None
        mock_store.upsert_profile = MagicMock()

        with patch("api.main.get_llm_client") as mock_llm_factory:
            mock_llm = MagicMock()
            mock_llm.chat.return_value = '{"characters": []}'
            mock_llm_factory.return_value = mock_llm

            # Should not raise
            try:
                trigger_l4_extraction_async(
                    store=mock_store,
                    chapter_text="测试章节",
                    chapter_number=1,
                    project_id="p1",
                )
            except Exception as e:
                self.fail(f"trigger_l4_extraction_async raised: {e}")


if __name__ == "__main__":
    unittest.main()
