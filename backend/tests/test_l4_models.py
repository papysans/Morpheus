"""Tests for L4 Character Profile domain models (RED phase)."""

import unittest
from datetime import datetime
from pydantic import ValidationError

from models import (
    Layer,
    OverrideSource,
    CharacterRelationship,
    CharacterStateChange,
    ChapterEvent,
    CharacterProfile,
)


class TestL4Enums(unittest.TestCase):
    def test_layer_l4_exists(self):
        self.assertEqual(Layer.L4.value, "L4")

    def test_layer_all_values(self):
        self.assertEqual(Layer.L1.value, "L1")
        self.assertEqual(Layer.L2.value, "L2")
        self.assertEqual(Layer.L3.value, "L3")
        self.assertEqual(Layer.L4.value, "L4")

    def test_override_source_llm_extracted(self):
        self.assertEqual(OverrideSource.LLM_EXTRACTED.value, "llm_extracted")

    def test_override_source_user_override(self):
        self.assertEqual(OverrideSource.USER_OVERRIDE.value, "user_override")


class TestCharacterRelationship(unittest.TestCase):
    def test_serialization_roundtrip(self):
        rel = CharacterRelationship(
            source_character="张三",
            target_character="李四",
            relation_type="师徒",
            chapter=3,
        )
        data = rel.model_dump()
        restored = CharacterRelationship(**data)
        self.assertEqual(restored.source_character, "张三")
        self.assertEqual(restored.relation_type, "师徒")
        self.assertEqual(restored.chapter, 3)

    def test_json_roundtrip(self):
        rel = CharacterRelationship(
            source_character="A", target_character="B", relation_type="敌对", chapter=1
        )
        json_str = rel.model_dump_json()
        restored = CharacterRelationship.model_validate_json(json_str)
        self.assertEqual(restored.target_character, "B")

    def test_defaults(self):
        rel = CharacterRelationship(
            source_character="A", target_character="B", relation_type="友人", chapter=1
        )
        self.assertEqual(rel.description, "")
        self.assertEqual(rel.confidence, 1.0)
        self.assertEqual(rel.override_source, OverrideSource.LLM_EXTRACTED)
        self.assertEqual(rel.provenance, "")
        self.assertIsInstance(rel.created_at, datetime)

    def test_missing_required_fields(self):
        with self.assertRaises(ValidationError):
            CharacterRelationship(source_character="A")

    def test_confidence_out_of_bounds(self):
        with self.assertRaises(ValidationError):
            CharacterRelationship(
                source_character="A",
                target_character="B",
                relation_type="x",
                chapter=1,
                confidence=2.0,
            )


class TestCharacterStateChange(unittest.TestCase):
    def test_serialization_roundtrip(self):
        sc = CharacterStateChange(
            character="张三", attribute="实力", to_value="突破金丹期", chapter=5
        )
        data = sc.model_dump()
        restored = CharacterStateChange(**data)
        self.assertEqual(restored.character, "张三")
        self.assertEqual(restored.to_value, "突破金丹期")

    def test_defaults(self):
        sc = CharacterStateChange(character="A", attribute="性格", to_value="变得冷酷", chapter=2)
        self.assertEqual(sc.from_value, "")
        self.assertEqual(sc.trigger_event, "")
        self.assertEqual(sc.confidence, 1.0)
        self.assertEqual(sc.override_source, OverrideSource.LLM_EXTRACTED)

    def test_missing_required(self):
        with self.assertRaises(ValidationError):
            CharacterStateChange(character="A")


class TestChapterEvent(unittest.TestCase):
    def test_serialization_roundtrip(self):
        evt = ChapterEvent(character="张三", chapter=3, event_summary="与李四决斗并获胜")
        data = evt.model_dump()
        restored = ChapterEvent(**data)
        self.assertEqual(restored.event_summary, "与李四决斗并获胜")

    def test_defaults(self):
        evt = ChapterEvent(character="A", chapter=1, event_summary="出场")
        self.assertEqual(evt.significance, "minor")
        self.assertEqual(evt.related_characters, [])
        self.assertEqual(evt.confidence, 1.0)

    def test_missing_required(self):
        with self.assertRaises(ValidationError):
            ChapterEvent(character="A")


class TestCharacterProfile(unittest.TestCase):
    def test_serialization_roundtrip(self):
        profile = CharacterProfile(
            profile_id="proj1_张三",
            project_id="proj1",
            character_name="张三",
            overview="主角，性格坚毅",
            personality="沉稳内敛",
        )
        json_str = profile.model_dump_json()
        restored = CharacterProfile.model_validate_json(json_str)
        self.assertEqual(restored.character_name, "张三")
        self.assertEqual(restored.overview, "主角，性格坚毅")

    def test_nested_collections(self):
        profile = CharacterProfile(
            profile_id="p1_a",
            project_id="p1",
            character_name="A",
            relationships=[
                CharacterRelationship(
                    source_character="A",
                    target_character="B",
                    relation_type="师徒",
                    chapter=1,
                )
            ],
            state_changes=[
                CharacterStateChange(character="A", attribute="实力", to_value="提升", chapter=2)
            ],
            chapter_events=[ChapterEvent(character="A", chapter=1, event_summary="初次登场")],
        )
        data = profile.model_dump()
        restored = CharacterProfile(**data)
        self.assertEqual(len(restored.relationships), 1)
        self.assertEqual(len(restored.state_changes), 1)
        self.assertEqual(len(restored.chapter_events), 1)

    def test_defaults(self):
        profile = CharacterProfile(profile_id="x", project_id="p", character_name="C")
        self.assertEqual(profile.overview, "")
        self.assertEqual(profile.personality, "")
        self.assertEqual(profile.relationships, [])
        self.assertEqual(profile.state_changes, [])
        self.assertEqual(profile.chapter_events, [])
        self.assertEqual(profile.last_updated_chapter, 0)
        self.assertEqual(profile.confidence, 1.0)
        self.assertEqual(profile.override_source, OverrideSource.LLM_EXTRACTED)

    def test_missing_required_fields(self):
        with self.assertRaises(ValidationError):
            CharacterProfile(profile_id="x")

    def test_confidence_too_high(self):
        with self.assertRaises(ValidationError):
            CharacterProfile(
                profile_id="x",
                project_id="p",
                character_name="C",
                confidence=1.5,
            )

    def test_confidence_negative(self):
        with self.assertRaises(ValidationError):
            CharacterProfile(
                profile_id="x",
                project_id="p",
                character_name="C",
                confidence=-0.1,
            )


if __name__ == "__main__":
    unittest.main()
