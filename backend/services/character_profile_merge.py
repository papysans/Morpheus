"""L4 Profile Merge Engine — field-level override precedence + dedupe."""

from __future__ import annotations

import hashlib
import json
from typing import List, Optional

from models import (
    CharacterProfile,
    CharacterRelationship,
    CharacterStateChange,
    ChapterEvent,
    OverrideSource,
)


def _rel_key(rel: CharacterRelationship) -> str:
    """Deterministic dedup key for a relationship."""
    return hashlib.md5(
        json.dumps(
            [rel.source_character, rel.target_character, rel.relation_type, rel.chapter],
            ensure_ascii=False,
        ).encode()
    ).hexdigest()


def _sc_key(sc: CharacterStateChange) -> str:
    """Deterministic dedup key for a state change."""
    return hashlib.md5(
        json.dumps(
            [sc.character, sc.attribute, sc.to_value, sc.chapter],
            ensure_ascii=False,
        ).encode()
    ).hexdigest()


def _evt_key(evt: ChapterEvent) -> str:
    """Deterministic dedup key for a chapter event."""
    return hashlib.md5(
        json.dumps(
            [evt.character, evt.chapter, evt.event_summary],
            ensure_ascii=False,
        ).encode()
    ).hexdigest()


class ProfileMergeEngine:
    """
    Merge an incoming (LLM-extracted) profile into an existing stored profile.

    Rules:
    - If existing is None, return incoming as-is.
    - Top-level text fields (overview, personality):
        - If existing.override_source == USER_OVERRIDE, keep existing value.
        - Otherwise, use incoming value if non-empty, else keep existing.
    - Relationships / state_changes / chapter_events:
        - Deduplicate by deterministic hash key.
        - User-override items are never replaced by LLM items with same key.
        - New items from incoming are appended.
    - last_updated_chapter: take max of existing and incoming.
    """

    def merge(
        self,
        existing: Optional[CharacterProfile],
        incoming: CharacterProfile,
    ) -> CharacterProfile:
        if existing is None:
            return incoming

        is_user_override = existing.override_source == OverrideSource.USER_OVERRIDE
        # --- Top-level text fields ---
        # Field-level protection: only protect non-empty user-overridden fields
        overview = existing.overview
        if not (is_user_override and existing.overview):
            overview = incoming.overview if incoming.overview else existing.overview
        personality = existing.personality
        if not (is_user_override and existing.personality):
            personality = incoming.personality if incoming.personality else existing.personality
        if not is_user_override:
            personality = incoming.personality if incoming.personality else existing.personality

        # --- Relationships ---
        merged_rels = self._merge_list(
            existing.relationships,
            incoming.relationships,
            key_fn=_rel_key,
        )

        # --- State changes ---
        merged_scs = self._merge_list(
            existing.state_changes,
            incoming.state_changes,
            key_fn=_sc_key,
        )

        # --- Chapter events ---
        merged_evts = self._merge_list(
            existing.chapter_events,
            incoming.chapter_events,
            key_fn=_evt_key,
        )

        # --- last_updated_chapter ---
        last_chapter = max(existing.last_updated_chapter, incoming.last_updated_chapter)

        from datetime import datetime

        return CharacterProfile(
            profile_id=existing.profile_id,
            project_id=existing.project_id,
            character_name=existing.character_name,
            overview=overview,
            personality=personality,
            relationships=merged_rels,
            state_changes=merged_scs,
            chapter_events=merged_evts,
            last_updated_chapter=last_chapter,
            confidence=incoming.confidence,
            override_source=existing.override_source,
            provenance=incoming.provenance or existing.provenance,
            created_at=existing.created_at,
            updated_at=datetime.now(),
        )

    def _merge_list(self, existing_items, incoming_items, key_fn):
        """Merge two lists, deduplicating by key. User-override items win."""
        result = list(existing_items)
        existing_keys = {key_fn(item): item for item in existing_items}

        for item in incoming_items:
            k = key_fn(item)
            if k in existing_keys:
                # Keep existing (user override wins, or same content)
                continue
            result.append(item)
            existing_keys[k] = item

        return result
