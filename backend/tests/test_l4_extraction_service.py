"""Tests for L4 LLM extraction service (TDD - Task 6)."""

import json
import unittest
from unittest.mock import MagicMock, patch

from services.character_profile_extraction import (
    CharacterProfileExtractionService,
    ExtractionResult,
)

VALID_LLM_RESPONSE = json.dumps(
    {
        "characters": [
            {
                "character_name": "张三",
                "overview": "主角",
                "personality": "坚毅",
                "relationships": [{"target_character": "李四", "relation_type": "师徒"}],
                "state_changes": [{"attribute": "实力", "to_value": "筑基期"}],
                "chapter_events": [{"event_summary": "突破筑基期", "significance": "major"}],
            }
        ]
    },
    ensure_ascii=False,
)


def _make_service(mock_response: str = VALID_LLM_RESPONSE, raise_exc=None):
    """Create service with mocked LLM client."""
    mock_client = MagicMock()
    if raise_exc:
        mock_client.chat.side_effect = raise_exc
    else:
        mock_client.chat.return_value = mock_response
    return CharacterProfileExtractionService(llm_client=mock_client), mock_client


class TestCharacterProfileExtractionService(unittest.TestCase):
    def test_extract_returns_result(self):
        svc, _ = _make_service()
        result = svc.extract(chapter_text="第三章内容", chapter=3, project_id="p1")
        self.assertIsInstance(result, ExtractionResult)

    def test_extract_success_with_valid_llm_output(self):
        svc, _ = _make_service()
        result = svc.extract(chapter_text="第三章内容", chapter=3, project_id="p1")
        self.assertTrue(result.success)
        self.assertEqual(len(result.profiles), 1)
        self.assertEqual(result.profiles[0].character_name, "张三")

    def test_extract_calls_llm_with_chapter_text(self):
        svc, mock_client = _make_service()
        svc.extract(chapter_text="独特章节内容", chapter=1, project_id="p1")
        mock_client.chat.assert_called_once()
        call_args = mock_client.chat.call_args
        messages = call_args[1].get("messages") or call_args[0][0]
        prompt_text = str(messages)
        self.assertIn("独特章节内容", prompt_text)

    def test_extract_sets_provenance(self):
        svc, _ = _make_service()
        result = svc.extract(chapter_text="内容", chapter=2, project_id="p1")
        self.assertTrue(result.success)
        profile = result.profiles[0]
        self.assertNotEqual(profile.provenance, "")

    def test_extract_sets_chapter_on_nested_items(self):
        svc, _ = _make_service()
        result = svc.extract(chapter_text="内容", chapter=5, project_id="p1")
        profile = result.profiles[0]
        self.assertEqual(profile.relationships[0].chapter, 5)
        self.assertEqual(profile.state_changes[0].chapter, 5)
        self.assertEqual(profile.chapter_events[0].chapter, 5)

    def test_extract_timeout_returns_fallback(self):
        svc, _ = _make_service(raise_exc=TimeoutError("LLM timeout"))
        result = svc.extract(chapter_text="内容", chapter=1, project_id="p1")
        self.assertIsInstance(result, ExtractionResult)
        self.assertFalse(result.success)
        self.assertEqual(result.profiles, [])
        self.assertIsNotNone(result.error)
        self.assertIn("timeout", result.error.lower())

    def test_extract_generic_exception_returns_fallback(self):
        svc, _ = _make_service(raise_exc=RuntimeError("connection refused"))
        result = svc.extract(chapter_text="内容", chapter=1, project_id="p1")
        self.assertFalse(result.success)
        self.assertEqual(result.profiles, [])
        self.assertIsNotNone(result.error)

    def test_extract_malformed_llm_output_returns_fallback(self):
        svc, _ = _make_service(mock_response='{"broken": json')
        result = svc.extract(chapter_text="内容", chapter=1, project_id="p1")
        self.assertFalse(result.success)
        self.assertEqual(result.profiles, [])

    def test_extract_empty_chapter_text_still_calls_llm(self):
        svc, mock_client = _make_service()
        result = svc.extract(chapter_text="", chapter=1, project_id="p1")
        mock_client.chat.assert_called_once()

    def test_extract_profiles_have_last_updated_chapter(self):
        svc, _ = _make_service()
        result = svc.extract(chapter_text="内容", chapter=7, project_id="p1")
        self.assertEqual(result.profiles[0].last_updated_chapter, 7)

    def test_extract_no_crash_on_none_llm_response(self):
        svc, _ = _make_service(mock_response=None)
        result = svc.extract(chapter_text="内容", chapter=1, project_id="p1")
        self.assertFalse(result.success)
        self.assertEqual(result.profiles, [])


if __name__ == "__main__":
    unittest.main()
