"""L4 character profile extraction service — prompt spec, parser, validator."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import List, Optional

from memory import MemoryStore
from models import (
    CharacterProfile,
    CharacterRelationship,
    CharacterStateChange,
    ChapterEvent,
    OverrideSource,
)

logger = logging.getLogger("novelist.extraction")

# ---------------------------------------------------------------------------
# Prompt contract
# ---------------------------------------------------------------------------

EXTRACTION_PROMPT_TEMPLATE = """\
你是一个专业的小说人物档案提取助手。请仔细阅读以下章节内容，提取其中出现的所有角色信息。

章节内容：
{chapter_text}

请以 JSON 格式返回提取结果，格式如下：
{{
  "characters": [
    {{
      "character_name": "角色名称（必填）",
      "overview": "角色概述（可选）",
      "personality": "性格特点（可选）",
      "relationships": [
        {{
          "target_character": "关系对象角色名",
          "relation_type": "关系类型（如：师徒、敌对、恋人、朋友等）",
          "description": "关系描述（可选）"
        }}
      ],
      "state_changes": [
        {{
          "attribute": "变化属性（如：实力、性格、立场）",
          "from_value": "变化前状态（可选）",
          "to_value": "变化后状态（必填）",
          "trigger_event": "触发事件（可选）"
        }}
      ],
      "chapter_events": [
        {{
          "event_summary": "事件摘要（必填）",
          "significance": "重要程度：minor/major/critical（默认 minor）",
          "related_characters": ["相关角色名列表"]
        }}
      ]
    }}
  ]
}}

注意：
- 只提取本章节中明确出现或被提及的角色
- character_name 是必填字段，没有名字的角色请跳过
- 如果某个字段没有信息，可以省略或留空
- 请确保返回合法的 JSON 格式
"""


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class ExtractionResult:
    success: bool
    profiles: List[CharacterProfile] = field(default_factory=list)
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Parser / validator
# ---------------------------------------------------------------------------


class ExtractionParser:
    """Parse and validate LLM extraction output into CharacterProfile objects."""

    def parse(
        self,
        raw_output: Optional[str],
        chapter: int,
        project_id: str,
        provenance: str = "",
    ) -> ExtractionResult:
        if not raw_output:
            return ExtractionResult(success=False, error="Empty LLM output")

        # Strip markdown code fences if present
        text = raw_output.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            # Remove first and last fence lines
            inner = []
            in_block = False
            for line in lines:
                if line.startswith("```") and not in_block:
                    in_block = True
                    continue
                if line.startswith("```") and in_block:
                    break
                if in_block:
                    inner.append(line)
            text = "\n".join(inner)

        try:
            data = json.loads(text)
        except (json.JSONDecodeError, ValueError) as exc:
            return ExtractionResult(
                success=False,
                error=f"JSON parse error: {exc}",
            )

        if not isinstance(data, dict):
            return ExtractionResult(success=False, error="Root must be a JSON object")

        characters_raw = data.get("characters")
        if characters_raw is None:
            return ExtractionResult(success=False, error="Missing 'characters' key")

        if not isinstance(characters_raw, list):
            return ExtractionResult(success=False, error="'characters' must be a list")

        profiles: List[CharacterProfile] = []
        for char_data in characters_raw:
            if not isinstance(char_data, dict):
                continue
            name = char_data.get("character_name", "").strip()
            if not name:
                continue  # skip nameless characters

            profile_id = MemoryStore.make_profile_id(project_id, name)

            relationships = []
            for rel in char_data.get("relationships", []) or []:
                if not isinstance(rel, dict):
                    continue
                target = rel.get("target_character", "").strip()
                rel_type = rel.get("relation_type", "").strip()
                if not target or not rel_type:
                    continue
                try:
                    relationships.append(
                        CharacterRelationship(
                            source_character=name,
                            target_character=target,
                            relation_type=rel_type,
                            description=rel.get("description", "") or "",
                            chapter=chapter,
                            provenance=provenance,
                        )
                    )
                except Exception as e:
                    logger.warning("Skipping invalid relationship: %s", e)

            state_changes = []
            for sc in char_data.get("state_changes", []) or []:
                if not isinstance(sc, dict):
                    continue
                attribute = sc.get("attribute", "").strip()
                to_value = sc.get("to_value", "").strip()
                if not attribute or not to_value:
                    continue
                try:
                    state_changes.append(
                        CharacterStateChange(
                            character=name,
                            attribute=attribute,
                            from_value=sc.get("from_value", "") or "",
                            to_value=to_value,
                            chapter=chapter,
                            trigger_event=sc.get("trigger_event", "") or "",
                        )
                    )
                except Exception as e:
                    logger.warning("Skipping invalid state_change: %s", e)

            chapter_events = []
            for evt in char_data.get("chapter_events", []) or []:
                if not isinstance(evt, dict):
                    continue
                summary = evt.get("event_summary", "").strip()
                if not summary:
                    continue
                try:
                    chapter_events.append(
                        ChapterEvent(
                            character=name,
                            chapter=chapter,
                            event_summary=summary,
                            significance=evt.get("significance", "minor") or "minor",
                            related_characters=evt.get("related_characters", []) or [],
                        )
                    )
                except Exception as e:
                    logger.warning("Skipping invalid chapter_event: %s", e)

            try:
                profile = CharacterProfile(
                    profile_id=profile_id,
                    project_id=project_id,
                    character_name=name,
                    overview=char_data.get("overview", "") or "",
                    personality=char_data.get("personality", "") or "",
                    relationships=relationships,
                    state_changes=state_changes,
                    chapter_events=chapter_events,
                    last_updated_chapter=chapter,
                    provenance=provenance,
                )
                profiles.append(profile)
            except Exception as e:
                logger.warning("Skipping invalid profile for '%s': %s", name, e)

        return ExtractionResult(success=True, profiles=profiles)
class CharacterProfileExtractionService:
    """High-level service: calls LLM, parses result, returns ExtractionResult."""
    def __init__(self, llm_client):
        self._llm = llm_client
        self._parser = ExtractionParser()
    def extract(
        self,
        chapter_text: str,
        chapter: int,
        project_id: str,
    ) -> ExtractionResult:
        provenance = f"llm_extraction:chapter_{chapter}"
        prompt = EXTRACTION_PROMPT_TEMPLATE.format(chapter_text=chapter_text)
        messages = [{"role": "user", "content": prompt}]
        try:
            raw = self._llm.chat(messages=messages)
        except TimeoutError as exc:
            logger.warning("LLM extraction timeout chapter=%d: %s", chapter, exc)
            return ExtractionResult(success=False, error=f"timeout: {exc}")
        except Exception as exc:
            logger.warning("LLM extraction failed chapter=%d: %s", chapter, exc)
            return ExtractionResult(success=False, error=str(exc))
        result = self._parser.parse(raw, chapter=chapter, project_id=project_id, provenance=provenance)
        return result
