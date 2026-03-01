"""Tests for L4 character profile store primitives (TDD - Task 2)."""

import os
import tempfile
import unittest
from pathlib import Path

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"

from memory import MemoryStore
from models import (
    CharacterProfile,
    CharacterRelationship,
    CharacterStateChange,
    ChapterEvent,
    OverrideSource,
)


def _make_store() -> MemoryStore:
    tmp = tempfile.mkdtemp()
    return MemoryStore(project_path=tmp, db_path=str(Path(tmp) / "test.db"))


def _make_profile(project_id="proj1", name="张三", **kwargs) -> CharacterProfile:
    profile_id = MemoryStore.make_profile_id(project_id, name)
    return CharacterProfile(
        profile_id=profile_id,
        project_id=project_id,
        character_name=name,
        **kwargs,
    )


class TestProfileId(unittest.TestCase):
    def test_deterministic(self):
        a = MemoryStore.make_profile_id("proj1", "张三")
        b = MemoryStore.make_profile_id("proj1", "张三")
        self.assertEqual(a, b)

    def test_different_names(self):
        a = MemoryStore.make_profile_id("proj1", "张三")
        b = MemoryStore.make_profile_id("proj1", "李四")
        self.assertNotEqual(a, b)

    def test_different_projects(self):
        a = MemoryStore.make_profile_id("proj1", "张三")
        b = MemoryStore.make_profile_id("proj2", "张三")
        self.assertNotEqual(a, b)


class TestProfileCRUD(unittest.TestCase):
    def setUp(self):
        self.store = _make_store()

    def test_upsert_and_get(self):
        profile = _make_profile(overview="主角", personality="坚毅")
        self.store.upsert_profile(profile)
        fetched = self.store.get_profile(profile.profile_id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.character_name, "张三")
        self.assertEqual(fetched.overview, "主角")
        self.assertEqual(fetched.personality, "坚毅")

    def test_upsert_updates_existing(self):
        profile = _make_profile(overview="初始")
        self.store.upsert_profile(profile)
        profile.overview = "更新后"
        self.store.upsert_profile(profile)
        fetched = self.store.get_profile(profile.profile_id)
        self.assertEqual(fetched.overview, "更新后")

    def test_upsert_same_id_no_duplicate(self):
        profile = _make_profile()
        self.store.upsert_profile(profile)
        self.store.upsert_profile(profile)
        profiles = self.store.list_profiles("proj1")
        self.assertEqual(len(profiles), 1)

    def test_get_nonexistent_returns_none(self):
        result = self.store.get_profile("nonexistent-id")
        self.assertIsNone(result)

    def test_list_profiles_by_project(self):
        p1 = _make_profile("proj1", "张三")
        p2 = _make_profile("proj1", "李四")
        p3 = _make_profile("proj2", "王五")
        for p in [p1, p2, p3]:
            self.store.upsert_profile(p)
        results = self.store.list_profiles("proj1")
        self.assertEqual(len(results), 2)
        names = {r.character_name for r in results}
        self.assertIn("张三", names)
        self.assertIn("李四", names)

    def test_list_profiles_empty_project(self):
        results = self.store.list_profiles("no-such-project")
        self.assertEqual(results, [])

    def test_nested_relationships_roundtrip(self):
        profile = _make_profile(
            relationships=[
                CharacterRelationship(
                    source_character="张三",
                    target_character="李四",
                    relation_type="师徒",
                    chapter=1,
                )
            ]
        )
        self.store.upsert_profile(profile)
        fetched = self.store.get_profile(profile.profile_id)
        self.assertEqual(len(fetched.relationships), 1)
        self.assertEqual(fetched.relationships[0].relation_type, "师徒")

    def test_nested_state_changes_roundtrip(self):
        profile = _make_profile(
            state_changes=[
                CharacterStateChange(
                    character="张三", attribute="实力", to_value="金丹期", chapter=3
                )
            ]
        )
        self.store.upsert_profile(profile)
        fetched = self.store.get_profile(profile.profile_id)
        self.assertEqual(len(fetched.state_changes), 1)
        self.assertEqual(fetched.state_changes[0].to_value, "金丹期")

    def test_nested_chapter_events_roundtrip(self):
        profile = _make_profile(
            chapter_events=[ChapterEvent(character="张三", chapter=2, event_summary="初次登场")]
        )
        self.store.upsert_profile(profile)
        fetched = self.store.get_profile(profile.profile_id)
        self.assertEqual(len(fetched.chapter_events), 1)
        self.assertEqual(fetched.chapter_events[0].event_summary, "初次登场")

    def test_override_source_preserved(self):
        profile = _make_profile(override_source=OverrideSource.USER_OVERRIDE)
        self.store.upsert_profile(profile)
        fetched = self.store.get_profile(profile.profile_id)
        self.assertEqual(fetched.override_source, OverrideSource.USER_OVERRIDE)

    def test_delete_profile(self):
        profile = _make_profile()
        self.store.upsert_profile(profile)
        self.store.delete_profile(profile.profile_id)
        self.assertIsNone(self.store.get_profile(profile.profile_id))

    def test_existing_tables_unaffected(self):
        """Ensure L1/L2/L3 tables still work after L4 migration."""
        from models import EntityState

        entity = EntityState(entity_id="e1", entity_type="character", name="测试角色")
        self.store.add_entity(entity)
        fetched = self.store.get_entity("e1")
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.name, "测试角色")


if __name__ == "__main__":
    unittest.main()
