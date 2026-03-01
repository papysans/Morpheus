"""Tests for L4 merge engine — override precedence + dedupe (TDD - Task 7)."""

import unittest
from datetime import datetime

from models import (
    CharacterProfile,
    CharacterRelationship,
    CharacterStateChange,
    ChapterEvent,
    OverrideSource,
)
from memory import MemoryStore
from services.character_profile_merge import ProfileMergeEngine


def _pid(project_id, name):
    return MemoryStore.make_profile_id(project_id, name)


def _profile(name="张三", project_id="p1", **kwargs):
    return CharacterProfile(
        profile_id=_pid(project_id, name),
        project_id=project_id,
        character_name=name,
        **kwargs,
    )


def _rel(source="张三", target="李四", rel_type="师徒", chapter=1, **kwargs):
    return CharacterRelationship(
        source_character=source,
        target_character=target,
        relation_type=rel_type,
        chapter=chapter,
        **kwargs,
    )


def _sc(character="张三", attribute="实力", to_value="筑基期", chapter=1, **kwargs):
    return CharacterStateChange(
        character=character, attribute=attribute, to_value=to_value, chapter=chapter, **kwargs
    )


def _evt(character="张三", chapter=1, summary="出场", **kwargs):
    return ChapterEvent(character=character, chapter=chapter, event_summary=summary, **kwargs)


class TestMergeEngineOverridePrecedence(unittest.TestCase):
    def setUp(self):
        self.engine = ProfileMergeEngine()

    def test_llm_fills_empty_overview(self):
        existing = _profile(overview="")
        incoming = _profile(overview="LLM提取的概述")
        merged = self.engine.merge(existing=existing, incoming=incoming)
        self.assertEqual(merged.overview, "LLM提取的概述")

    def test_user_override_wins_over_llm(self):
        existing = _profile(
            overview="用户手动编辑的概述",
            override_source=OverrideSource.USER_OVERRIDE,
        )
        incoming = _profile(overview="LLM新提取的概述")
        merged = self.engine.merge(existing=existing, incoming=incoming)
        self.assertEqual(merged.overview, "用户手动编辑的概述")

    def test_user_override_personality_preserved(self):
        existing = _profile(
            personality="用户定义的性格",
            override_source=OverrideSource.USER_OVERRIDE,
        )
        incoming = _profile(personality="LLM提取的性格")
        merged = self.engine.merge(existing=existing, incoming=incoming)
        self.assertEqual(merged.personality, "用户定义的性格")

    def test_llm_updates_non_overridden_field(self):
        existing = _profile(
            overview="用户概述",
            personality="",
            override_source=OverrideSource.USER_OVERRIDE,
        )
        incoming = _profile(overview="LLM概述", personality="LLM性格")
        merged = self.engine.merge(existing=existing, incoming=incoming)
        # overview is user-overridden, personality is not
        self.assertEqual(merged.overview, "用户概述")
        self.assertEqual(merged.personality, "LLM性格")

    def test_last_updated_chapter_advances(self):
        existing = _profile(last_updated_chapter=3)
        incoming = _profile(last_updated_chapter=5)
        merged = self.engine.merge(existing=existing, incoming=incoming)
        self.assertEqual(merged.last_updated_chapter, 5)


class TestMergeEngineRelationshipDedupe(unittest.TestCase):
    def setUp(self):
        self.engine = ProfileMergeEngine()

    def test_duplicate_relationship_not_added(self):
        rel = _rel(chapter=1)
        existing = _profile(relationships=[rel])
        incoming = _profile(relationships=[_rel(chapter=1)])  # same content
        merged = self.engine.merge(existing=existing, incoming=incoming)
        self.assertEqual(len(merged.relationships), 1)

    def test_different_chapter_same_relation_added(self):
        existing = _profile(relationships=[_rel(chapter=1)])
        incoming = _profile(relationships=[_rel(chapter=2)])
        merged = self.engine.merge(existing=existing, incoming=incoming)
        self.assertEqual(len(merged.relationships), 2)

    def test_different_relation_type_added(self):
        existing = _profile(relationships=[_rel(rel_type="师徒", chapter=1)])
        incoming = _profile(relationships=[_rel(rel_type="敌对", chapter=1)])
        merged = self.engine.merge(existing=existing, incoming=incoming)
        self.assertEqual(len(merged.relationships), 2)

    def test_user_override_relationship_preserved(self):
        user_rel = _rel(rel_type="师徒", chapter=1, override_source=OverrideSource.USER_OVERRIDE)
        existing = _profile(relationships=[user_rel])
        # LLM tries to add same relationship
        incoming = _profile(relationships=[_rel(rel_type="师徒", chapter=1)])
        merged = self.engine.merge(existing=existing, incoming=incoming)
        # Should still be 1, user version preserved
        self.assertEqual(len(merged.relationships), 1)
        self.assertEqual(merged.relationships[0].override_source, OverrideSource.USER_OVERRIDE)


class TestMergeEngineStateChangeDedupe(unittest.TestCase):
    def setUp(self):
        self.engine = ProfileMergeEngine()

    def test_duplicate_state_change_not_added(self):
        sc = _sc(chapter=2)
        existing = _profile(state_changes=[sc])
        incoming = _profile(state_changes=[_sc(chapter=2)])
        merged = self.engine.merge(existing=existing, incoming=incoming)
        self.assertEqual(len(merged.state_changes), 1)

    def test_different_chapter_state_change_added(self):
        existing = _profile(state_changes=[_sc(chapter=1)])
        incoming = _profile(state_changes=[_sc(chapter=3)])
        merged = self.engine.merge(existing=existing, incoming=incoming)
        self.assertEqual(len(merged.state_changes), 2)


class TestMergeEngineChapterEventDedupe(unittest.TestCase):
    def setUp(self):
        self.engine = ProfileMergeEngine()

    def test_duplicate_event_not_added(self):
        evt = _evt(chapter=1, summary="出场")
        existing = _profile(chapter_events=[evt])
        incoming = _profile(chapter_events=[_evt(chapter=1, summary="出场")])
        merged = self.engine.merge(existing=existing, incoming=incoming)
        self.assertEqual(len(merged.chapter_events), 1)

    def test_different_summary_event_added(self):
        existing = _profile(chapter_events=[_evt(chapter=1, summary="出场")])
        incoming = _profile(chapter_events=[_evt(chapter=1, summary="突破")])
        merged = self.engine.merge(existing=existing, incoming=incoming)
        self.assertEqual(len(merged.chapter_events), 2)


class TestMergeEngineNewProfile(unittest.TestCase):
    def setUp(self):
        self.engine = ProfileMergeEngine()

    def test_merge_with_no_existing_returns_incoming(self):
        incoming = _profile(overview="新角色", personality="活泼")
        merged = self.engine.merge(existing=None, incoming=incoming)
        self.assertEqual(merged.overview, "新角色")
        self.assertEqual(merged.personality, "活泼")


if __name__ == "__main__":
    unittest.main()
