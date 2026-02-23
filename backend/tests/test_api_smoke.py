import unittest
import os
import shutil
import json
import sqlite3
import re
from pathlib import Path
from datetime import datetime, timezone
from uuid import uuid4

from fastapi.testclient import TestClient

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"
os.environ["GRAPH_FEATURE_ENABLED"] = "true"

from api.main import (
    app,
    build_outline_messages,
    build_fallback_outline,
    extract_graph_role_names,
    validate_graph_role_name,
    enforce_draft_target_words,
    sanitize_narrative_for_export,
    get_or_create_store,
    trace_file,
    memory_stores,
    traces,
    projects,
    projects_root,
    chapters,
    data_root,
    BACKEND_ROOT,
    resolve_target_word_upper_bound,
    settings,
    upsert_graph_from_chapter,
)
from agents.studio import StudioWorkflow
from core.chapter_craft import normalize_chapter_title, strip_leading_chapter_heading
from models import AgentDecision, AgentRole, AgentTrace, EntityState, EventEdge, ProjectStatus, ChapterStatus, ChapterPlan, MemoryItem, Layer


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
        self.assertIn("quality", plan_res.json())
        self.assertIn("status", plan_res.json()["quality"])
        self.assertIn("score", plan_res.json()["quality"])

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

    def test_trace_replay_sanitizes_thinking_text(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=8)

        traces[chapter_id] = AgentTrace(
            id=f"trace-{uuid4().hex[:8]}",
            chapter_id=8,
            decisions=[
                AgentDecision(
                    id="decision-sanitize",
                    agent_role=AgentRole.DIRECTOR,
                    chapter_id=8,
                    input_refs=[],
                    decision_text="<think>internal</think>公开内容",
                    reasoning="thinking: hidden\n可见解释",
                    timestamp=datetime.now(timezone.utc),
                )
            ],
            memory_hits=[],
            conflicts_detected=[],
            final_draft="ok",
        )

        trace_res = self.client.get(f"/api/trace/{chapter_id}")
        self.assertEqual(trace_res.status_code, 200)
        decision = trace_res.json()["decisions"][0]
        self.assertEqual(decision["decision_text"], "公开内容")
        self.assertNotIn("<think>", decision["decision_text"])
        self.assertIn("可见解释", decision["reasoning"])
        self.assertNotIn("thinking:", decision["reasoning"].lower())

    def test_graph_endpoints_sanitize_placeholder_role_names(self):
        project_id = self._create_project()
        store = get_or_create_store(project_id)
        now = datetime.now(timezone.utc)

        store.add_entity(
            EntityState(
                entity_id=f"entity-primary-{uuid4().hex[:8]}",
                entity_type="character",
                name="primary",
                attrs={},
                constraints=[],
                first_seen_chapter=2,
                last_seen_chapter=2,
                created_at=now,
                updated_at=now,
            )
        )
        store.add_entity(
            EntityState(
                entity_id=f"entity-main-{uuid4().hex[:8]}",
                entity_type="character",
                name="主角",
                attrs={},
                constraints=[],
                first_seen_chapter=1,
                last_seen_chapter=3,
                created_at=now,
                updated_at=now,
            )
        )
        store.add_entity(
            EntityState(
                entity_id=f"entity-secondary-{uuid4().hex[:8]}",
                entity_type="character",
                name="secondary",
                attrs={},
                constraints=[],
                first_seen_chapter=2,
                last_seen_chapter=2,
                created_at=now,
                updated_at=now,
            )
        )
        store.add_entity(
            EntityState(
                entity_id=f"entity-hidden-{uuid4().hex[:8]}",
                entity_type="character",
                name="hidden",
                attrs={},
                constraints=[],
                first_seen_chapter=2,
                last_seen_chapter=2,
                created_at=now,
                updated_at=now,
            )
        )

        store.add_event(
            EventEdge(
                event_id=f"event-placeholder-{uuid4().hex[:8]}",
                subject="primary",
                relation="progress",
                object="secondary",
                chapter=2,
                timestamp=now,
                confidence=0.6,
                description="placeholder role names",
            )
        )
        store.add_event(
            EventEdge(
                event_id=f"event-hidden-{uuid4().hex[:8]}",
                subject="hidden",
                relation="progress",
                object="primary",
                chapter=3,
                timestamp=now,
                confidence=0.6,
                description="hidden should be dropped",
            )
        )

        entities_res = self.client.get(f"/api/entities/{project_id}")
        self.assertEqual(entities_res.status_code, 200)
        names = [item["name"] for item in entities_res.json()]
        self.assertIn("主角", names)
        self.assertIn("关键配角", names)
        self.assertNotIn("primary", names)
        self.assertNotIn("secondary", names)
        self.assertNotIn("hidden", names)
        self.assertEqual(names.count("主角"), 1)

        events_res = self.client.get(f"/api/events/{project_id}")
        self.assertEqual(events_res.status_code, 200)
        events_payload = events_res.json()
        self.assertTrue(any(item["subject"] == "主角" and item.get("object") == "关键配角" for item in events_payload))
        self.assertFalse(any(item["subject"] == "hidden" for item in events_payload))

    def test_extract_plan_payload_handles_object_entries_and_role_goal_noise(self):
        workflow = StudioWorkflow.__new__(StudioWorkflow)
        chapter = chapters[self._create_chapter(self._create_project(), chapter_number=9)]
        payload = """
        {
          "beats": [{"id":"b1","description":"陆仁甲在猪肉铺接单"}],
          "conflicts": [{"type":"外部","description":"苏小柒与林晓阳意见冲突"}],
          "foreshadowing": [{"item":"染血发卡"}],
          "callback_targets": [{"target":"第一章笑脸留言","potential_use":"建立信任"}],
          "role_goals": {"goal":"这不是角色名", "陆仁甲":"保护铺子", "苏小柒":"追查妹妹"}
        }
        """
        parsed = workflow._extract_plan_payload(payload, chapter)
        self.assertEqual(parsed["beats"], ["陆仁甲在猪肉铺接单"])
        self.assertEqual(parsed["conflicts"], ["苏小柒与林晓阳意见冲突"])
        self.assertEqual(parsed["foreshadowing"], ["染血发卡"])
        self.assertEqual(parsed["callback_targets"], ["第一章笑脸留言"])
        self.assertNotIn("goal", parsed["role_goals"])
        self.assertEqual(parsed["role_goals"].get("陆仁甲"), "保护铺子")
        self.assertEqual(parsed["role_goals"].get("苏小柒"), "追查妹妹")

    def test_graph_upsert_extracts_names_when_role_goals_empty(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=10)
        chapter = chapters[chapter_id]
        chapter.plan = ChapterPlan(
            id=f"plan-{uuid4().hex[:8]}",
            chapter_id=chapter.chapter_number,
            title=chapter.title,
            goal=chapter.goal,
            beats=[],
            conflicts=[],
            foreshadowing=[],
            callback_targets=[],
            role_goals={},
        )
        chapter.draft = (
            "陆仁甲看着案板发呆。苏小柒低声说今天不对劲。"
            "林晓阳问李教授是不是又来电话了。陆仁甲点头。"
        )
        store = get_or_create_store(project_id)
        upsert_graph_from_chapter(store, chapter)

        names = [item["name"] for item in self.client.get(f"/api/entities/{project_id}").json()]
        self.assertIn("陆仁甲", names)
        self.assertIn("苏小柒", names)
        self.assertIn("林晓阳", names)
        events = self.client.get(f"/api/events/{project_id}").json()
        self.assertGreaterEqual(len(events), 2)

    def test_extract_graph_role_names_avoids_urban_legend_fragment(self):
        text = "“都市传说”在这条街流传。陆仁甲低声说：别信。苏小柒看向他。"
        names = extract_graph_role_names(text, max_names=8)
        self.assertNotIn("都市传", names)
        self.assertIn("陆仁甲", names)
        self.assertIn("苏小柒", names)

    def test_validate_graph_role_name_rejects_common_noise_fragments(self):
        for raw in ("都没", "后者正", "胡说八", "任凭赵老板", "通风管", "从管", "冷静"):
            self.assertEqual(validate_graph_role_name(raw), "")
        self.assertEqual(validate_graph_role_name("赵老板"), "赵老板")

    def test_extract_graph_role_names_avoids_dao_sentence_false_positive(self):
        text = (
            "“通风管道。”苏小柒的激光笔红点移向线路。"
            "格栅后面有冷风从管道深处吹出。"
            "她冷静道：跟我来。"
        )
        names = extract_graph_role_names(text, max_names=8)
        self.assertNotIn("通风管", names)
        self.assertNotIn("从管", names)
        self.assertNotIn("冷静", names)

    def test_graph_upsert_ignores_role_goal_noise_like_urban_legend_fragment(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=12)
        chapter = chapters[chapter_id]
        chapter.goal = "陆仁甲和苏小柒调查都市传说背后的真相"
        chapter.plan = ChapterPlan(
            id=f"plan-{uuid4().hex[:8]}",
            chapter_id=chapter.chapter_number,
            title=chapter.title,
            goal=chapter.goal,
            beats=[],
            conflicts=[],
            foreshadowing=[],
            callback_targets=[],
            role_goals={
                "都市传": "制造恐慌",
                "陆仁甲": "护住万事屋",
                "苏小柒": "追查数据源",
            },
        )
        chapter.draft = (
            "这只是都市传说，不是证词。陆仁甲低声说：先查监控。"
            "苏小柒看向后巷，示意有人跟踪。"
        )
        store = get_or_create_store(project_id)
        upsert_graph_from_chapter(store, chapter)

        names = [item["name"] for item in self.client.get(f"/api/entities/{project_id}").json()]
        self.assertNotIn("都市传", names)
        self.assertIn("陆仁甲", names)
        self.assertIn("苏小柒", names)

    def test_graph_upsert_infers_non_progress_relation_with_conflict_text(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=11)
        chapter = chapters[chapter_id]
        chapter.goal = "陆仁甲与苏小柒产生正面冲突"
        chapter.plan = ChapterPlan(
            id=f"plan-{uuid4().hex[:8]}",
            chapter_id=chapter.chapter_number,
            title=chapter.title,
            goal=chapter.goal,
            beats=[],
            conflicts=["两人冲突升级并产生对抗"],
            foreshadowing=[],
            callback_targets=[],
            role_goals={},
        )
        chapter.draft = "陆仁甲与苏小柒在后巷激烈对抗，林晓阳试图劝阻。"
        store = get_or_create_store(project_id)
        upsert_graph_from_chapter(store, chapter)
        events = self.client.get(f"/api/events/{project_id}").json()
        self.assertTrue(any(event.get("relation") != "progress" for event in events))

    def test_fts_query_splits_long_chinese_prompt_and_returns_hits(self):
        project_id = self._create_project()
        store = get_or_create_store(project_id)
        now = datetime.now(timezone.utc)
        store.add_memory_item(
            MemoryItem(
                id=f"memory-{uuid4().hex[:8]}",
                layer=Layer.L3,
                source_path="memory/L3/test.md",
                summary="猪肉铺与万事屋线索",
                content="陆仁甲在猪肉铺成立万事屋，苏小柒潜入后留下关键数据。",
                entities=["陆仁甲", "苏小柒"],
                importance=8,
                recency=8,
                created_at=now,
                updated_at=now,
                metadata={"kind": "test"},
            )
        )
        query = "男主一在猪肉铺成立万事屋，首次接单帮邻居找猫后救下苏小柒"
        results = store.search_fts(query, top_k=10)
        self.assertGreaterEqual(len(results), 1)

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

    def test_memory_source_file_endpoint(self):
        project_id = self._create_project()
        source_res = self.client.get(
            f"/api/projects/{project_id}/memory/source",
            params={"source_path": "memory/L1/IDENTITY.md"},
        )
        self.assertEqual(source_res.status_code, 200)
        self.assertIn("IDENTITY", source_res.text)

    def test_memory_source_file_rejects_path_traversal(self):
        project_id = self._create_project()
        source_res = self.client.get(
            f"/api/projects/{project_id}/memory/source",
            params={"source_path": "../project.json"},
        )
        self.assertEqual(source_res.status_code, 400)

    def test_story_template_applies_to_project_identity(self):
        templates_res = self.client.get("/api/story-templates")
        self.assertEqual(templates_res.status_code, 200)
        templates = templates_res.json().get("templates") or []
        self.assertTrue(any(item.get("id") == "serial-gintama" for item in templates))

        create_res = self.client.post(
            "/api/projects",
            json={
                "name": f"模板项目-{uuid4().hex[:8]}",
                "genre": "科幻喜剧",
                "style": "吐槽热血",
                "template_id": "serial-gintama",
                "target_length": 320000,
                "taboo_constraints": ["主角开局无敌"],
            },
        )
        self.assertEqual(create_res.status_code, 200)
        project_id = create_res.json()["id"]

        project_res = self.client.get(f"/api/projects/{project_id}")
        self.assertEqual(project_res.status_code, 200)
        project_payload = project_res.json()
        self.assertEqual(project_payload.get("template_id"), "serial-gintama")
        self.assertIn("主角开局无敌", project_payload.get("taboo_constraints") or [])
        self.assertIn("单章直接终结主线", project_payload.get("taboo_constraints") or [])

        identity_res = self.client.get(f"/api/identity/{project_id}")
        self.assertEqual(identity_res.status_code, 200)
        identity = identity_res.json().get("content", "")
        self.assertIn("Template Rules", identity)
        self.assertIn("每章新增1个钩子", identity)

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

    def test_one_shot_book_continuation_mode_uses_next_chapter_number(self):
        project_id = self._create_project()
        self._create_chapter(project_id, chapter_number=1)
        self._create_chapter(project_id, chapter_number=2)

        res = self.client.post(
            f"/api/projects/{project_id}/one-shot-book",
            json={
                "prompt": "续写主线并留钩子。",
                "scope": "book",
                "mode": "quick",
                "chapter_count": 1,
                "words_per_chapter": 700,
                "continuation_mode": True,
            },
        )
        self.assertEqual(res.status_code, 200)
        payload = res.json()
        self.assertTrue(payload["continuation_mode"])
        self.assertEqual(payload["start_chapter_number"], 3)
        self.assertEqual(payload["chapters"][0]["chapter_number"], 3)

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
            "effective_base_url",
            "remote_requested",
            "remote_effective",
            "remote_ready",
            "has_openai_key",
            "has_minimax_key",
            "has_deepseek_key",
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

    def test_list_projects_self_heals_missing_graph_tables(self):
        project_id = self._create_project()
        store = get_or_create_store(project_id)

        with sqlite3.connect(store.db_path) as conn:
            conn.execute("DROP TABLE IF EXISTS entities")
            conn.execute("DROP TABLE IF EXISTS events")
            conn.commit()

        res = self.client.get("/api/projects")
        self.assertEqual(res.status_code, 200)
        target = next(item for item in res.json() if item["id"] == project_id)
        self.assertEqual(target["entity_count"], 0)
        self.assertEqual(target["event_count"], 0)

        repaired_store = get_or_create_store(project_id)
        self.assertEqual(repaired_store.get_entity_count(), 0)
        self.assertEqual(repaired_store.get_event_count(), 0)

    def test_list_projects_purges_stale_in_memory_deleted_project(self):
        project_id = self._create_project()
        project_dir = projects_root() / project_id
        self.assertTrue(project_dir.exists())

        shutil.rmtree(project_dir)
        self.assertFalse(project_dir.exists())
        self.assertIn(project_id, projects)

        res = self.client.get("/api/projects")
        self.assertEqual(res.status_code, 200)
        ids = [item["id"] for item in res.json()]
        self.assertNotIn(project_id, ids)
        self.assertNotIn(project_id, projects)

    def test_delete_project_works_even_if_not_cached_in_worker(self):
        project_id = self._create_project()
        project_dir = projects_root() / project_id
        self.assertTrue(project_dir.exists())

        projects.pop(project_id, None)
        res = self.client.delete(f"/api/projects/{project_id}")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "deleted")
        self.assertFalse(project_dir.exists())

    def test_batch_delete_projects_handles_deleted_and_missing_items(self):
        project_a = self._create_project()
        project_b = self._create_project()
        dir_a = projects_root() / project_a
        dir_b = projects_root() / project_b
        self.assertTrue(dir_a.exists())
        self.assertTrue(dir_b.exists())

        missing_id = str(uuid4())
        res = self.client.request(
            "DELETE",
            "/api/projects",
            json={"project_ids": [project_a, project_b, missing_id, project_a]},
        )
        self.assertEqual(res.status_code, 200)
        payload = res.json()
        self.assertEqual(payload["requested_count"], 3)
        self.assertEqual(payload["deleted_count"], 2)
        self.assertEqual(payload["missing_count"], 1)
        self.assertEqual(payload["failed_count"], 0)
        self.assertFalse(dir_a.exists())
        self.assertFalse(dir_b.exists())
        self.assertNotIn(project_a, projects)
        self.assertNotIn(project_b, projects)

    def test_metrics_quality_rates_are_computed_from_chapters_and_traces(self):
        project_id = self._create_project(taboo_constraints=["禁词触发器"])
        chapter_a = self._create_chapter(project_id, chapter_number=1)
        chapter_b = self._create_chapter(project_id, chapter_number=2)

        res_a = self.client.put(
            f"/api/chapters/{chapter_a}/draft",
            json={"draft": "这是一段普通文本，不包含禁词。"},
        )
        self.assertEqual(res_a.status_code, 200)
        self.assertEqual(res_a.json()["consistency"]["p0_count"], 0)

        res_b = self.client.put(
            f"/api/chapters/{chapter_b}/draft",
            json={"draft": "这里包含禁词触发器，应当触发 P0。"},
        )
        self.assertEqual(res_b.status_code, 200)
        self.assertGreaterEqual(res_b.json()["consistency"]["p0_count"], 1)

        trace_a = AgentTrace(
            id=f"trace-{uuid4().hex[:8]}",
            chapter_id=1,
            decisions=[],
            memory_hits=[{"item_id": "m-1", "summary": "命中"}],
            conflicts_detected=[],
            final_draft="a",
        )
        trace_b = AgentTrace(
            id=f"trace-{uuid4().hex[:8]}",
            chapter_id=2,
            decisions=[],
            memory_hits=[],
            conflicts_detected=[],
            final_draft="b",
        )
        traces[chapter_a] = trace_a
        traces[chapter_b] = trace_b
        trace_file(project_id, chapter_a).write_text(
            json.dumps(trace_a.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        trace_file(project_id, chapter_b).write_text(
            json.dumps(trace_b.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        # Ensure endpoint can recover from disk traces, not only in-memory cache.
        traces.pop(chapter_a, None)
        traces.pop(chapter_b, None)

        metrics_res = self.client.get("/api/metrics", params={"project_id": project_id})
        self.assertEqual(metrics_res.status_code, 200)
        payload = metrics_res.json()
        self.assertEqual(payload["sample_size"], 2)
        self.assertEqual(payload["chapters_with_p0"], 1)
        self.assertEqual(payload["chapters_first_pass_ok"], 1)
        self.assertEqual(payload["chapters_with_memory_hits"], 1)
        self.assertAlmostEqual(payload["p0_ratio"], 0.5, places=3)
        self.assertAlmostEqual(payload["first_pass_rate"], 0.5, places=3)
        self.assertAlmostEqual(payload["recall_hit_rate"], 0.5, places=3)
        details = payload.get("quality_details") or {}
        self.assertEqual(len(details.get("p0_conflict_chapters") or []), 1)
        self.assertEqual(len(details.get("first_pass_failed_chapters") or []), 1)
        self.assertEqual(len(details.get("recall_missed_chapters") or []), 1)

    def test_create_chapter_works_even_if_project_not_cached_in_worker(self):
        project_id = self._create_project()
        projects.pop(project_id, None)

        res = self.client.post(
            "/api/chapters",
            json={
                "project_id": project_id,
                "chapter_number": 1,
                "title": "缓存缺失章节",
                "goal": "验证跨 worker 项目解析",
            },
        )
        self.assertEqual(res.status_code, 200)
        payload = res.json()
        self.assertEqual(payload["project_id"], project_id)
        self.assertEqual(payload["chapter_number"], 1)

    def test_delete_chapter_removes_files_and_listing(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=6)
        chapter_file = projects_root() / project_id / "chapters" / f"{chapter_id}.json"
        self.assertTrue(chapter_file.exists())

        store = get_or_create_store(project_id)
        now = datetime.now(timezone.utc)
        store.add_event(
            EventEdge(
                event_id=f"event-delete-{uuid4().hex[:8]}",
                subject="主角",
                relation="冲突",
                object="反派",
                chapter=6,
                timestamp=now,
                confidence=0.8,
                description="删除章节前事件",
            )
        )

        delete_res = self.client.delete(f"/api/chapters/{chapter_id}")
        self.assertEqual(delete_res.status_code, 200)
        self.assertEqual(delete_res.json()["status"], "deleted")
        self.assertFalse(chapter_file.exists())

        get_res = self.client.get(f"/api/chapters/{chapter_id}")
        self.assertEqual(get_res.status_code, 404)
        list_res = self.client.get(f"/api/projects/{project_id}/chapters")
        self.assertEqual(list_res.status_code, 200)
        self.assertFalse(any(item["id"] == chapter_id for item in list_res.json()))

        events = self.client.get(f"/api/events/{project_id}").json()
        self.assertFalse(any(event.get("chapter") == 6 for event in events))

    def test_delete_chapter_reindexes_following_chapters(self):
        project_id = self._create_project()
        ch20 = self._create_chapter(project_id, chapter_number=20)
        ch21 = self._create_chapter(project_id, chapter_number=21)
        ch22 = self._create_chapter(project_id, chapter_number=22)

        store = get_or_create_store(project_id)
        now = datetime.now(timezone.utc)
        store.add_event(
            EventEdge(
                event_id=f"event-shift-{uuid4().hex[:8]}",
                subject="主角",
                relation="调查",
                object="镜城",
                chapter=21,
                timestamp=now,
                confidence=0.9,
                description="原第21章事件",
            )
        )
        store.add_event(
            EventEdge(
                event_id=f"event-shift-{uuid4().hex[:8]}",
                subject="主角",
                relation="冲突",
                object="哨兵",
                chapter=22,
                timestamp=now,
                confidence=0.9,
                description="原第22章事件",
            )
        )

        delete_res = self.client.delete(f"/api/chapters/{ch20}")
        self.assertEqual(delete_res.status_code, 200)
        payload = delete_res.json()
        self.assertEqual(payload.get("status"), "deleted")
        renumbered = payload.get("renumbered") or []
        self.assertEqual(len(renumbered), 2)
        self.assertTrue(any(item.get("from") == 21 and item.get("to") == 20 for item in renumbered))
        self.assertTrue(any(item.get("from") == 22 and item.get("to") == 21 for item in renumbered))

        list_res = self.client.get(f"/api/projects/{project_id}/chapters")
        self.assertEqual(list_res.status_code, 200)
        chapter_map = {item["id"]: item["chapter_number"] for item in list_res.json()}
        self.assertNotIn(ch20, chapter_map)
        self.assertEqual(chapter_map.get(ch21), 20)
        self.assertEqual(chapter_map.get(ch22), 21)

        events = self.client.get(f"/api/events/{project_id}").json()
        shifted_chapters = sorted({event.get("chapter") for event in events})
        self.assertEqual(shifted_chapters, [20, 21])

    def test_build_outline_messages_includes_continuation_constraints(self):
        project_id = self._create_project()
        project = projects[project_id]
        messages = build_outline_messages(
            prompt="继续写",
            chapter_count=3,
            scope="book",
            project=project,
            identity="IDENTITY",
            continuation_mode=True,
        )
        self.assertEqual(len(messages), 2)
        payload = json.loads(messages[1]["content"])
        constraints = payload.get("constraints") or []
        self.assertTrue(payload.get("continuation_mode"))
        self.assertTrue(any("主线仅推进" in item for item in constraints))
        self.assertTrue(any("最多回收 1 个伏笔" in item for item in constraints))
        forbidden = payload.get("forbidden_title_keywords") or []
        self.assertIn("阶段收束", forbidden)
        self.assertIn("第二阶段钩子", forbidden)

    def test_build_fallback_outline_avoids_phase_template_titles(self):
        outline = build_fallback_outline(
            prompt="开始在10章内收束阶段里程碑，但是不要写死，记得抛出第二阶段钩子",
            chapter_count=10,
            continuation_mode=True,
        )
        self.assertEqual(len(outline), 10)
        pattern = re.compile(r"^(起势递进|代价扩张|阶段收束)([·:：\\-][0-9]+)?$")
        self.assertFalse(any(pattern.match(item.get("title", "")) for item in outline))

    def test_get_chapter_works_even_if_chapter_not_cached_in_worker(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=2)
        chapters.pop(chapter_id, None)
        projects.pop(project_id, None)

        res = self.client.get(f"/api/chapters/{chapter_id}")
        self.assertEqual(res.status_code, 200)
        payload = res.json()
        self.assertEqual(payload["id"], chapter_id)
        self.assertEqual(payload["project_id"], project_id)

    def test_get_project_refreshes_from_disk_when_cache_stale(self):
        project_id = self._create_project()
        project_json = projects_root() / project_id / "project.json"
        payload = json.loads(project_json.read_text(encoding="utf-8"))
        payload["style"] = "硬科幻纪实"
        payload["status"] = "completed"
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        project_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

        stale = projects[project_id].model_copy(deep=True)
        stale.style = "旧文风"
        stale.status = ProjectStatus.WRITING
        projects[project_id] = stale

        res = self.client.get(f"/api/projects/{project_id}")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["style"], "硬科幻纪实")
        self.assertEqual(body["status"], "completed")

    def test_get_chapter_refreshes_from_disk_when_cache_stale(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=3)
        chapter_json = projects_root() / project_id / "chapters" / f"{chapter_id}.json"
        payload = json.loads(chapter_json.read_text(encoding="utf-8"))
        payload["title"] = "磁盘已更新标题"
        payload["status"] = "reviewing"
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        chapter_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

        stale = chapters[chapter_id].model_copy(deep=True)
        stale.title = "旧标题"
        stale.status = ChapterStatus.DRAFT
        chapters[chapter_id] = stale

        res = self.client.get(f"/api/chapters/{chapter_id}")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["title"], "磁盘已更新标题")
        self.assertEqual(body["status"], "reviewing")

    def test_get_chapter_returns_404_when_project_deleted_but_chapter_cached(self):
        project_id = self._create_project()
        chapter_id = self._create_chapter(project_id, chapter_number=4)
        project_json = projects_root() / project_id / "project.json"
        project_json.unlink()
        projects.pop(project_id, None)

        res = self.client.get(f"/api/chapters/{chapter_id}")
        self.assertEqual(res.status_code, 404)

    def test_data_root_resolves_relative_to_backend_root(self):
        original = settings.data_dir
        try:
            settings.data_dir = "../data"
            self.assertEqual(data_root(), (BACKEND_ROOT / "../data").resolve())
        finally:
            settings.data_dir = original

    def test_enforce_draft_target_words_uses_soft_limit_without_clipping(self):
        target_words = 1800
        original = "段落。" * 3000  # ~9k chars
        clipped = enforce_draft_target_words(original, target_words)
        self.assertEqual(clipped, original.strip())
        self.assertGreater(len(clipped), resolve_target_word_upper_bound(target_words))

    def test_enforce_draft_target_words_keeps_normal_output(self):
        target_words = 1800
        normal = "内容。" * 500
        clipped = enforce_draft_target_words(normal, target_words)
        self.assertEqual(clipped, normal.strip())

    def test_title_normalization_removes_chapter_prefix_and_deduplicates(self):
        used = set()
        first = normalize_chapter_title(
            raw_title="第5章 继续",
            goal="主角破解盲区协议并付出代价",
            chapter_number=5,
            used_titles=used,
            phase="压力升级",
        )
        second = normalize_chapter_title(
            raw_title="第6章 继续",
            goal="主角破解盲区协议并付出代价",
            chapter_number=6,
            used_titles=used,
            phase="压力升级",
        )
        self.assertNotIn("第5章", first)
        self.assertNotIn("第6章", second)
        self.assertNotEqual(first, second)

    def test_title_normalization_rewrites_phase_template_title(self):
        used = set()
        title = normalize_chapter_title(
            raw_title="阶段收束·10",
            goal="围绕“开始在10章内收束阶段里程碑，但是不要写死，记得抛出第二阶段钩子”推进：引入新异常并绑定角色目标",
            chapter_number=20,
            used_titles=used,
            phase="阶段收束",
        )
        self.assertTrue(title)
        self.assertNotEqual(title, "阶段收束·10")
        self.assertNotIn("阶段收束", title)

    def test_strip_leading_chapter_heading(self):
        raw = "# 第8章 深夜食堂\n\n正文第一段。\n\n正文第二段。"
        cleaned = strip_leading_chapter_heading(raw)
        self.assertEqual(cleaned, "正文第一段。\n\n正文第二段。")

    def test_sanitize_narrative_for_export_removes_editorial_parentheses(self):
        raw = "镜子再次出现（与“镜之城”呼应）；信号抖动。（反转）"
        cleaned = sanitize_narrative_for_export(raw)
        self.assertEqual(cleaned, "镜子再次出现；信号抖动。")

    def test_sanitize_narrative_for_export_keeps_normal_parentheses(self):
        raw = "她低声说（别回头），然后继续向前。"
        cleaned = sanitize_narrative_for_export(raw)
        self.assertEqual(cleaned, raw)


if __name__ == "__main__":
    unittest.main()
