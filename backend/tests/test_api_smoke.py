import unittest
import os
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"

from api.main import app, memory_stores


class NovelistApiSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _create_project(self, taboo_constraints=None):
        payload = {
            "name": f"测试项目-{uuid4().hex[:8]}",
            "genre": "奇幻",
            "style": "冷峻",
            "target_length": 300000,
            "taboo_constraints": taboo_constraints or [],
        }
        res = self.client.post("/api/projects", json=payload)
        self.assertEqual(res.status_code, 200)
        return res.json()["id"]

    def _create_chapter(self, project_id: str, chapter_number: int = 1):
        res = self.client.post(
            "/api/chapters",
            json={
                "project_id": project_id,
                "chapter_number": chapter_number,
                "title": "雪夜开端",
                "goal": "建立冲突并埋伏笔",
            },
        )
        self.assertEqual(res.status_code, 200)
        return res.json()["id"]

    def test_end_to_end_generation_flow(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id)

        plan_res = self.client.post(f"/api/chapters/{chapter_id}/plan")
        self.assertEqual(plan_res.status_code, 200)
        self.assertGreaterEqual(len(plan_res.json()["plan"]["beats"]), 1)

        draft_res = self.client.post(f"/api/chapters/{chapter_id}/draft")
        self.assertEqual(draft_res.status_code, 200)
        self.assertIn("draft", draft_res.json())
        self.assertNotIn("请基于以下上下文继续创作并补全结构化内容", draft_res.json()["draft"])

        chapter_res = self.client.get(f"/api/chapters/{chapter_id}")
        self.assertEqual(chapter_res.status_code, 200)
        self.assertEqual(chapter_res.json()["status"], "reviewing")

    def test_trace_replay_returns_decisions(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=2)

        self.client.post(f"/api/chapters/{chapter_id}/plan")
        self.client.post(f"/api/chapters/{chapter_id}/draft")

        trace_res = self.client.get(f"/api/trace/{chapter_id}")
        self.assertEqual(trace_res.status_code, 200)
        self.assertGreaterEqual(len(trace_res.json()["decisions"]), 1)

    def test_memory_query_returns_results(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=3)

        self.client.post(f"/api/chapters/{chapter_id}/plan")
        self.client.post(f"/api/chapters/{chapter_id}/draft")

        query_res = self.client.get(
            "/api/memory/query",
            params={"project_id": project_id, "query": "IDENTITY"},
        )
        self.assertEqual(query_res.status_code, 200)
        self.assertGreaterEqual(query_res.json()["total"], 1)

    def test_p0_conflict_blocks_approval(self):
        project_id = self._create_project(taboo_constraints=["禁词触发器"])
        chapter_id = self._create_chapter(project_id, chapter_number=4)

        self.client.post(f"/api/chapters/{chapter_id}/plan")
        draft_res = self.client.post(f"/api/chapters/{chapter_id}/draft")
        self.assertEqual(draft_res.status_code, 200)

        conflict_res = self.client.put(
            f"/api/chapters/{chapter_id}/draft",
            json={"draft": f"{draft_res.json()['draft']}\n禁词触发器"},
        )
        self.assertEqual(conflict_res.status_code, 200)
        self.assertGreaterEqual(conflict_res.json()["consistency"]["p0_count"], 1)

        review_res = self.client.post(
            "/api/review",
            json={"chapter_id": chapter_id, "action": "approve"},
        )
        self.assertEqual(review_res.status_code, 400)

    def test_world_rule_catches_prefixed_constraint(self):
        project_id = self._create_project()
        self._create_chapter(project_id, chapter_number=6)

        update_identity_res = self.client.put(
            f"/api/identity/{project_id}",
            json={"content": "# IDENTITY\n- [世界规则]：主角不能复活\n"},
        )
        self.assertEqual(update_identity_res.status_code, 200)

        check_res = self.client.post(
            "/api/consistency/check",
            json={
                "project_id": project_id,
                "chapter_id": 6,
                "draft": "在众人注视下，主角复活并再次走向战场。",
            },
        )
        self.assertEqual(check_res.status_code, 200)
        self.assertFalse(check_res.json()["can_submit"])
        self.assertGreaterEqual(check_res.json()["p0_count"], 1)

    def test_stream_draft_endpoint(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=5)
        self.client.post(f"/api/chapters/{chapter_id}/plan")

        with self.client.stream("GET", f"/api/chapters/{chapter_id}/draft/stream?force=true") as response:
            self.assertEqual(response.status_code, 200)
            payload = "".join(chunk.decode("utf-8") for chunk in response.iter_raw())
            self.assertIn("event: meta", payload)
            self.assertIn("event: done", payload)

    def test_one_shot_generation_modes(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=7)

        quick_res = self.client.post(
            f"/api/chapters/{chapter_id}/one-shot",
            json={
                "prompt": "一句话：主角在雪夜被最信任的人背刺，但他选择隐忍布局反杀。",
                "mode": "quick",
                "target_words": 800,
            },
        )
        self.assertEqual(quick_res.status_code, 200)
        self.assertEqual(quick_res.json()["mode"], "quick")
        self.assertIn("draft", quick_res.json())
        self.assertGreater(len(quick_res.json()["draft"]), 80)

        cinematic_res = self.client.post(
            f"/api/chapters/{chapter_id}/one-shot",
            json={
                "prompt": "一句话：暴雪夜追逐战，主角在钟楼揭穿叛徒身份。",
                "mode": "cinematic",
                "target_words": 1000,
            },
        )
        self.assertEqual(cinematic_res.status_code, 200)
        self.assertEqual(cinematic_res.json()["mode"], "cinematic")
        self.assertIn("chapter", cinematic_res.json())

    def test_one_shot_book_generation(self):
        project_id = self._create_project()
        batch_res = self.client.post(
            f"/api/projects/{project_id}/one-shot-book",
            json={
                "prompt": "主角在雪夜被背叛后潜伏反击，最终揪出幕后主使。",
                "scope": "volume",
                "mode": "quick",
                "chapter_count": 3,
                "words_per_chapter": 700,
            },
        )
        self.assertEqual(batch_res.status_code, 200)
        self.assertEqual(batch_res.json()["generated_chapters"], 3)
        self.assertEqual(len(batch_res.json()["chapters"]), 3)

        chapters_res = self.client.get(f"/api/projects/{project_id}/chapters")
        self.assertEqual(chapters_res.status_code, 200)
        self.assertGreaterEqual(len(chapters_res.json()), 3)

    def test_one_shot_book_stream_generation(self):
        project_id = self._create_project()
        with self.client.stream(
            "POST",
            f"/api/projects/{project_id}/one-shot-book/stream",
            json={
                "prompt": "主角在雪夜被背叛后潜伏反击，最终揪出幕后主使。",
                "scope": "volume",
                "mode": "quick",
                "chapter_count": 1,
                "words_per_chapter": 700,
            },
        ) as response:
            self.assertEqual(response.status_code, 200)
            payload = "".join(chunk.decode("utf-8") for chunk in response.iter_raw())
            self.assertIn("event: outline_ready", payload)
            self.assertIn("event: chapter_chunk", payload)
            self.assertIn("event: done", payload)

    def test_consistency_check_endpoint(self):
        project_id = self._create_project(taboo_constraints=["禁止词"])
        check_res = self.client.post(
            "/api/consistency/check",
            json={
                "project_id": project_id,
                "chapter_id": 10,
                "draft": "这是一段包含禁止词的文本。",
            },
        )
        self.assertEqual(check_res.status_code, 200)
        self.assertFalse(check_res.json()["can_submit"])
        self.assertGreaterEqual(check_res.json()["p0_count"], 1)

    def test_llm_runtime_endpoint(self):
        res = self.client.get("/api/runtime/llm")
        self.assertEqual(res.status_code, 200)
        payload = res.json()
        for field in (
            "requested_provider",
            "effective_provider",
            "effective_model",
            "remote_requested",
            "remote_effective",
            "remote_ready",
            "has_openai_key",
            "has_minimax_key",
        ):
            self.assertIn(field, payload)

    def test_prompt_preview_endpoint(self):
        project_id = self._create_project()
        res = self.client.post(
            f"/api/projects/{project_id}/prompt-preview",
            json={
                "prompt": "主角重生后在雪夜发现背后阴谋。",
                "mode": "quick",
                "scope": "volume",
                "chapter_count": 6,
                "target_words": 1200,
            },
        )
        self.assertEqual(res.status_code, 200)
        payload = res.json()
        self.assertIn("runtime", payload)
        self.assertIn("constraints", payload)
        self.assertIn("outline_messages", payload)
        self.assertIn("one_shot_messages", payload)
        self.assertIn("studio_agent_prompts", payload)

    def test_projects_health_endpoint(self):
        project_id = self._create_project()
        res = self.client.get("/api/projects/health")
        self.assertEqual(res.status_code, 200)
        payload = res.json()
        self.assertIn("summary", payload)
        self.assertIn("items", payload)
        self.assertIn("orphans", payload)
        target = next(item for item in payload["items"] if item["project_id"] == project_id)
        self.assertIn("healthy", target)
        self.assertIn("issues", target)

    def test_projects_health_repair_endpoint(self):
        project_id = self._create_project()
        self.client.get("/api/projects")
        self.assertIn(project_id, memory_stores)
        memory_stores[project_id].db_path = Path("/dev/null/novelist.db")

        res = self.client.post(
            "/api/projects/health/repair",
            json={"project_id": project_id, "dry_run": False},
        )
        self.assertEqual(res.status_code, 200)
        payload = res.json()
        self.assertEqual(payload["target_count"], 1)
        self.assertTrue(payload["results"][0]["healthy_after"])

    def test_list_projects_survives_broken_project_db(self):
        project_id = self._create_project()
        self.client.get("/api/projects")
        self.assertIn(project_id, memory_stores)

        broken_store = memory_stores[project_id]
        broken_store.db_path = Path("/dev/null/novelist.db")

        res = self.client.get("/api/projects")
        self.assertEqual(res.status_code, 200)
        projects_payload = res.json()
        target = next(item for item in projects_payload if item["id"] == project_id)
        self.assertEqual(target["entity_count"], 0)
        self.assertEqual(target["event_count"], 0)


if __name__ == "__main__":
    unittest.main()
