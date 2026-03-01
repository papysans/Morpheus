"""Tests for L4 extraction prompt spec and parser validator (TDD - Task 4)."""

import json
import unittest

from services.character_profile_extraction import (
    EXTRACTION_PROMPT_TEMPLATE,
    ExtractionParser,
    ExtractionResult,
)


VALID_LLM_OUTPUT = json.dumps(
    {
        "characters": [
            {
                "character_name": "张三",
                "overview": "主角，修炼者",
                "personality": "坚毅沉稳",
                "relationships": [
                    {
                        "target_character": "李四",
                        "relation_type": "师徒",
                        "description": "张三是李四的弟子",
                    }
                ],
                "state_changes": [
                    {
                        "attribute": "实力",
                        "from_value": "练气期",
                        "to_value": "筑基期",
                        "trigger_event": "突破",
                    }
                ],
                "chapter_events": [
                    {
                        "event_summary": "与李四初次相遇",
                        "significance": "major",
                        "related_characters": ["李四"],
                    }
                ],
            }
        ]
    },
    ensure_ascii=False,
)

MALFORMED_JSON = '{"characters": [{"character_name": "张三", "overview": "主角"'  # truncated

EMPTY_CHARACTERS = json.dumps({"characters": []})

MISSING_CHARACTERS_KEY = json.dumps({"result": "ok"})

WRONG_TYPE_OUTPUT = json.dumps({"characters": "not a list"})


class TestExtractionPromptTemplate(unittest.TestCase):
    def test_template_is_string(self):
        self.assertIsInstance(EXTRACTION_PROMPT_TEMPLATE, str)

    def test_template_has_placeholder(self):
        self.assertIn("{chapter_text}", EXTRACTION_PROMPT_TEMPLATE)

    def test_template_mentions_required_fields(self):
        for field in [
            "character_name",
            "overview",
            "personality",
            "relationships",
            "state_changes",
            "chapter_events",
        ]:
            self.assertIn(field, EXTRACTION_PROMPT_TEMPLATE)

    def test_template_format(self):
        rendered = EXTRACTION_PROMPT_TEMPLATE.format(chapter_text="测试章节内容")
        self.assertIn("测试章节内容", rendered)


class TestExtractionParser(unittest.TestCase):
    def setUp(self):
        self.parser = ExtractionParser()

    def test_parse_valid_output(self):
        result = self.parser.parse(VALID_LLM_OUTPUT, chapter=3, project_id="p1")
        self.assertIsInstance(result, ExtractionResult)
        self.assertTrue(result.success)
        self.assertEqual(len(result.profiles), 1)
        profile = result.profiles[0]
        self.assertEqual(profile.character_name, "张三")
        self.assertEqual(profile.overview, "主角，修炼者")
        self.assertEqual(len(profile.relationships), 1)
        self.assertEqual(len(profile.state_changes), 1)
        self.assertEqual(len(profile.chapter_events), 1)

    def test_parse_sets_chapter_on_relationships(self):
        result = self.parser.parse(VALID_LLM_OUTPUT, chapter=5, project_id="p1")
        self.assertEqual(result.profiles[0].relationships[0].chapter, 5)

    def test_parse_sets_chapter_on_state_changes(self):
        result = self.parser.parse(VALID_LLM_OUTPUT, chapter=5, project_id="p1")
        self.assertEqual(result.profiles[0].state_changes[0].chapter, 5)

    def test_parse_sets_chapter_on_events(self):
        result = self.parser.parse(VALID_LLM_OUTPUT, chapter=5, project_id="p1")
        self.assertEqual(result.profiles[0].chapter_events[0].chapter, 5)

    def test_parse_malformed_json_returns_fallback(self):
        result = self.parser.parse(MALFORMED_JSON, chapter=1, project_id="p1")
        self.assertIsInstance(result, ExtractionResult)
        self.assertFalse(result.success)
        self.assertEqual(result.profiles, [])
        self.assertIsNotNone(result.error)

    def test_parse_empty_characters(self):
        result = self.parser.parse(EMPTY_CHARACTERS, chapter=1, project_id="p1")
        self.assertTrue(result.success)
        self.assertEqual(result.profiles, [])

    def test_parse_missing_characters_key(self):
        result = self.parser.parse(MISSING_CHARACTERS_KEY, chapter=1, project_id="p1")
        self.assertFalse(result.success)
        self.assertEqual(result.profiles, [])

    def test_parse_wrong_type_characters(self):
        result = self.parser.parse(WRONG_TYPE_OUTPUT, chapter=1, project_id="p1")
        self.assertFalse(result.success)
        self.assertEqual(result.profiles, [])

    def test_parse_no_crash_on_none(self):
        result = self.parser.parse(None, chapter=1, project_id="p1")
        self.assertFalse(result.success)
        self.assertEqual(result.profiles, [])

    def test_parse_no_crash_on_empty_string(self):
        result = self.parser.parse("", chapter=1, project_id="p1")
        self.assertFalse(result.success)

    def test_profile_id_is_deterministic(self):
        result1 = self.parser.parse(VALID_LLM_OUTPUT, chapter=1, project_id="p1")
        result2 = self.parser.parse(VALID_LLM_OUTPUT, chapter=2, project_id="p1")
        self.assertEqual(result1.profiles[0].profile_id, result2.profiles[0].profile_id)

    def test_partial_character_missing_optional_fields(self):
        minimal = json.dumps({"characters": [{"character_name": "王五"}]})
        result = self.parser.parse(minimal, chapter=1, project_id="p1")
        self.assertTrue(result.success)
        self.assertEqual(len(result.profiles), 1)
        self.assertEqual(result.profiles[0].character_name, "王五")
        self.assertEqual(result.profiles[0].overview, "")

    def test_character_missing_name_is_skipped(self):
        no_name = json.dumps({"characters": [{"overview": "无名角色"}]})
        result = self.parser.parse(no_name, chapter=1, project_id="p1")
        self.assertTrue(result.success)
        self.assertEqual(len(result.profiles), 0)


if __name__ == "__main__":
    unittest.main()
