"""
Memory Context Service — builds Context Packs for generation and manages
chapter-end writeback operations.
"""

import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, TypedDict

from memory import ThreeLayerMemory, MemoryStore
from utils.text_cleaner import clean_foreshadowing_text, extract_keywords

logger = logging.getLogger(__name__)
_logger = logging.getLogger("novelist.memory_context")


class BudgetStats(TypedDict):
    identity_core_budget: int
    identity_core_used: int
    runtime_state_budget: int
    runtime_state_used: int
    memory_compact_budget: int
    memory_compact_used: int
    previous_synopsis_budget: int
    previous_synopsis_used: int
    open_threads_budget: int
    open_threads_used: int
    previous_chapters_budget: int
    previous_chapters_used: int
    total_budget: int
    total_used: int


class ContextPack(TypedDict):
    identity_core: str
    runtime_state: str
    memory_compact: str
    previous_chapter_synopsis: str
    open_threads: list  # list of OpenThread dicts
    previous_chapters_compact: list  # list of dicts
    budget_stats: BudgetStats


class OpenThread(TypedDict):
    source_chapter: int
    text: str
    status: str  # "open" | "resolved"
    resolved_by_chapter: Optional[int]
    evidence: str


class MemoryContextService:
    """Core service for Context Pack construction, writeback orchestration, and thread management."""

    # Token budget allocation ratios (from design doc)
    _BUDGET_RATIOS = {
        "identity_core": 0.15,
        "runtime_state": 0.10,
        "memory_compact": 0.15,
        "previous_synopsis": 0.10,
        "open_threads": 0.10,
        "previous_chapters": 0.35,
        "budget_stats": 0.05,
    }
    _MIN_FIELD_BUDGET = 512  # minimum tokens per field

    def __init__(
        self,
        three_layer: ThreeLayerMemory,
        memory_store: MemoryStore,
        context_window_tokens: int = 32768,
        input_budget_ratio: float = 0.6,
    ):
        self.three_layer = three_layer
        self.memory_store = memory_store
        self.context_window_tokens = context_window_tokens
        self.input_budget_ratio = input_budget_ratio

    def _compute_field_budgets(self, chapter_number: int, input_budget_tokens: int | None = None) -> dict:
        """Compute per-field token budgets based on context window and input budget ratio.

        Ensures total budget never exceeds input_budget_tokens by scaling down
        when per-field minimums would otherwise blow the cap.
        """
        if input_budget_tokens is None:
            input_budget_tokens = int(self.context_window_tokens * self.input_budget_ratio)

        budgets = {}
        for field, ratio in self._BUDGET_RATIOS.items():
            raw = int(input_budget_tokens * ratio)
            budgets[field] = max(raw, self._MIN_FIELD_BUDGET)

        # Clamp: if sum of minimums exceeds the cap, scale proportionally
        total = sum(budgets.values())
        if total > input_budget_tokens and input_budget_tokens > 0:
            scale = input_budget_tokens / total
            budgets = {k: max(1, int(v * scale)) for k, v in budgets.items()}

        return budgets

    def _truncate_to_budget(self, text: str, budget_tokens: int) -> tuple[str, int]:
        """Truncate text to approximate token budget (1 token ≈ 2 Chinese chars or 4 English chars)."""
        # Rough estimate: average 2 chars per token for mixed CJK/Latin
        max_chars = budget_tokens * 2
        used_chars = len(text)
        if used_chars <= max_chars:
            return text, used_chars // 2  # approximate tokens used
        return text[:max_chars], budget_tokens

    def _read_file_safe(self, path: Path) -> str:
        """Read a file safely, returning empty string on error."""
        try:
            if path.exists():
                return path.read_text(encoding="utf-8")
        except Exception as e:
            logger.warning(f"Failed to read {path}: {e}")
        return ""

    @staticmethod
    def _file_size_safe(path: Path) -> int:
        """Return file size in bytes, 0 on error."""
        try:
            return path.stat().st_size if path.exists() else 0
        except Exception:
            return 0

    def build_generation_context_pack(
        self,
        chapter_number: int,
        project_chapters: list[dict],
        top_k_threads: int = 10,
        read_only: bool = False,
    ) -> dict:
        """
        Build a Context_Pack with 7 fields for generation injection.

        If read_only=True, open threads are read from disk without recomputing/writing.

        Returns a ContextPack dict with: identity_core, runtime_state, memory_compact,
        previous_chapter_synopsis, open_threads, previous_chapters_compact, budget_stats.
        """
        budgets = self._compute_field_budgets(chapter_number)
        total_budget = sum(budgets.values())

        # 1. identity_core
        identity_raw = self.three_layer.get_identity()
        identity_core, identity_used = self._truncate_to_budget(identity_raw, budgets["identity_core"])

        # 2. runtime_state
        rs_raw = self._read_file_safe(self.three_layer.l1_dir / "RUNTIME_STATE.md")
        runtime_state, rs_used = self._truncate_to_budget(rs_raw, budgets["runtime_state"])

        # 3. memory_compact
        memory_raw = self.three_layer.get_memory()
        memory_compact, mem_used = self._truncate_to_budget(memory_raw, budgets["memory_compact"])

        # 4. previous_chapter_synopsis
        prev_synopsis = ""
        prev_syn_used = 0
        if chapter_number > 1:
            synopses = self.three_layer.get_l3_items("chapter_synopsis")
            # Find the most recent synopsis for chapter_number - 1
            for item in reversed(synopses):
                if str(chapter_number - 1) in item.get("summary", ""):
                    prev_synopsis = item.get("content", "")
                    break
            if not prev_synopsis:
                # Fallback: use the last synopsis available
                if synopses:
                    prev_synopsis = synopses[-1].get("content", "")
        prev_synopsis, prev_syn_used = self._truncate_to_budget(prev_synopsis, budgets["previous_synopsis"])

        # 5. open_threads (confidence-scored, then top-k)
        if read_only:
            all_threads = self._read_open_threads_from_disk()
        else:
            all_threads = self.recompute_open_threads(project_chapters)
        open_only = [t for t in all_threads if t.get("status") == "open"]
        selected_threads = self._select_threads_by_confidence(
            open_only, chapter_number, top_k=top_k_threads,
        )
        # Estimate tokens for threads
        threads_text = str(selected_threads)
        _, threads_used = self._truncate_to_budget(threads_text, budgets["open_threads"])

        # 6. previous_chapters_compact
        prev_chapters = []
        prev_ch_used = 0
        recent_chapters = [c for c in project_chapters if c.get("chapter_number", 0) < chapter_number]
        recent_chapters = sorted(recent_chapters, key=lambda c: c.get("chapter_number", 0))[-5:]  # last 5
        for ch in recent_chapters:
            compact = {
                "chapter_number": ch.get("chapter_number"),
                "title": ch.get("title", ""),
                "status": ch.get("status", ""),
                "word_count": ch.get("word_count", 0),
            }
            prev_chapters.append(compact)
        prev_ch_text = str(prev_chapters)
        _, prev_ch_used = self._truncate_to_budget(prev_ch_text, budgets["previous_chapters"])

        # 7. budget_stats
        budget_stats: dict = {
            "identity_core_budget": budgets["identity_core"],
            "identity_core_used": identity_used,
            "runtime_state_budget": budgets["runtime_state"],
            "runtime_state_used": rs_used,
            "memory_compact_budget": budgets["memory_compact"],
            "memory_compact_used": mem_used,
            "previous_synopsis_budget": budgets["previous_synopsis"],
            "previous_synopsis_used": prev_syn_used,
            "open_threads_budget": budgets["open_threads"],
            "open_threads_used": threads_used,
            "previous_chapters_budget": budgets["previous_chapters"],
            "previous_chapters_used": prev_ch_used,
            "total_budget": total_budget,
            "total_used": identity_used + rs_used + mem_used + prev_syn_used + threads_used + prev_ch_used,
        }

        pack = {
            "identity_core": identity_core,
            "runtime_state": runtime_state,
            "memory_compact": memory_compact,
            "previous_chapter_synopsis": prev_synopsis,
            "open_threads": selected_threads,
            "previous_chapters_compact": prev_chapters,
            "budget_stats": budget_stats,
        }

        _logger.info(
            "context_pack_built chapter=%d budget_total=%d total_used=%d "
            "source_counts identity=%d runtime=%d memory=%d synopsis=%d threads=%d prev_chapters=%d "
            "truncation_amounts identity=%d runtime=%d memory=%d synopsis=%d threads=%d prev_chapters=%d",
            chapter_number,
            pack["budget_stats"]["total_budget"],
            pack["budget_stats"]["total_used"],
            len(identity_raw), len(rs_raw), len(memory_raw), len(prev_synopsis), len(threads_text), len(prev_ch_text),
            max(0, len(identity_raw) // 2 - identity_used),
            max(0, len(rs_raw) // 2 - rs_used),
            max(0, len(memory_raw) // 2 - mem_used),
            max(0, len(prev_synopsis) // 2 - prev_syn_used),
            max(0, len(threads_text) // 2 - threads_used),
            max(0, len(prev_ch_text) // 2 - prev_ch_used),
        )

        return pack


    @staticmethod
    def _normalize_plan(chapter_plan) -> dict | None:
        """Normalize ChapterPlan (Pydantic model or dict) to plain dict."""
        if chapter_plan is None:
            return None
        if isinstance(chapter_plan, dict):
            return chapter_plan
        # Pydantic BaseModel
        if hasattr(chapter_plan, "model_dump"):
            return chapter_plan.model_dump()
        if hasattr(chapter_plan, "dict"):
            return chapter_plan.dict()
        return None

    def generate_chapter_synopsis(
        self,
        chapter_number: int,
        chapter_text: str,
        chapter_plan: dict | None,
    ) -> str:
        """
        Generate a ≤300 character chapter synopsis.
        Priority: plan + text extraction. Fallback: first-and-last paragraph extraction.
        Always returns a non-empty string.
        """
        MAX_LEN = 300

        # Normalize plan to dict (handles Pydantic models)
        chapter_plan = self._normalize_plan(chapter_plan)

        # Try plan-based extraction first
        plan_synopsis = ""
        if chapter_plan:
            parts = []
            title = chapter_plan.get("title", "")
            goal = chapter_plan.get("goal", "")
            if title:
                parts.append(title)
            if goal:
                parts.append(goal)
            if parts:
                plan_synopsis = "；".join(parts)

        # Extract text-based synopsis
        text_synopsis = ""
        if chapter_text:
            paragraphs = [p.strip() for p in chapter_text.split("\n\n") if p.strip()]
            if paragraphs:
                first = paragraphs[0]
                last = paragraphs[-1] if len(paragraphs) > 1 else ""
                if last and last != first:
                    text_synopsis = first[:120] + "…" + last[:120]
                else:
                    text_synopsis = first[:MAX_LEN]

        # Fuse: plan context + text extract when both available
        if plan_synopsis and text_synopsis:
            fused = plan_synopsis[:120] + "｜" + text_synopsis[:178]
            if len(fused) > MAX_LEN:
                fused = fused[:MAX_LEN - 1] + "…"
            return fused
        elif plan_synopsis:
            if len(plan_synopsis) > MAX_LEN:
                plan_synopsis = plan_synopsis[:MAX_LEN - 1] + "…"
            return plan_synopsis
        elif text_synopsis:
            if len(text_synopsis) > MAX_LEN:
                text_synopsis = text_synopsis[:MAX_LEN - 1] + "…"
            return text_synopsis

        # Ultimate fallback
        return f"第{chapter_number}章摘要"

    def recompute_open_threads(
        self,
        project_chapters: list[dict],
    ) -> list[dict]:
        """
        Scan all chapter plans' foreshadowing fields, apply TextCleaner,
        determine resolution via callback_targets priority + keyword fallback,
        write OPEN_THREADS.md, and return the complete thread list.
        """
        threads: list[dict] = []

        # Collect all foreshadowing items
        for ch in project_chapters:
            plan = ch.get("plan")
            if not plan:
                continue
            plan_dict = plan if isinstance(plan, dict) else (plan.model_dump() if hasattr(plan, "model_dump") else {})
            foreshadowing_items = plan_dict.get("foreshadowing", [])
            chapter_number = ch.get("chapter_number", 0)

            for fs_text in foreshadowing_items:
                if not fs_text or not isinstance(fs_text, str):
                    continue
                cleaned = clean_foreshadowing_text(fs_text)
                if not cleaned.strip():
                    continue

                thread: dict = {
                    "source_chapter": chapter_number,
                    "text": cleaned.strip(),
                    "status": "open",
                    "resolved_by_chapter": None,
                    "evidence": "",
                }

                # Check resolution: callback_targets priority
                fs_keywords = extract_keywords(cleaned)
                resolved = False

                for later_ch in project_chapters:
                    later_num = later_ch.get("chapter_number", 0)
                    if later_num <= chapter_number:
                        continue

                    later_plan = later_ch.get("plan")
                    if later_plan:
                        later_plan_dict = later_plan if isinstance(later_plan, dict) else (
                            later_plan.model_dump() if hasattr(later_plan, "model_dump") else {}
                        )
                        callbacks = later_plan_dict.get("callback_targets", [])
                        for cb in callbacks:
                            if cb and cleaned.strip() in cb or (cb and cb in cleaned.strip()):
                                thread["status"] = "resolved"
                                thread["resolved_by_chapter"] = later_num
                                thread["evidence"] = f"callback_target: {cb}"
                                resolved = True
                                break
                            # Also check keyword overlap with callback
                            cb_keywords = extract_keywords(str(cb))
                            if fs_keywords and cb_keywords:
                                overlap = set(fs_keywords) & set(cb_keywords)
                                if len(overlap) >= 2 or (len(overlap) == 1 and len(fs_keywords) <= 2):
                                    thread["status"] = "resolved"
                                    thread["resolved_by_chapter"] = later_num
                                    thread["evidence"] = f"callback_target keyword match: {overlap}"
                                    resolved = True
                                    break
                    if resolved:
                        break

                    # Keyword fallback: check chapter text
                    if not resolved and fs_keywords:
                        later_text = later_ch.get("final") or later_ch.get("draft") or ""
                        if later_text:
                            matched_kw = [kw for kw in fs_keywords if kw in later_text]
                            if len(matched_kw) >= 2 or (len(matched_kw) == 1 and len(fs_keywords) <= 2):
                                thread["status"] = "resolved"
                                thread["resolved_by_chapter"] = later_num
                                thread["evidence"] = f"keyword match in text: {matched_kw}"
                                resolved = True
                                break

                threads.append(thread)

        # Write OPEN_THREADS.md
        self._write_open_threads_file(threads)
        return threads

    def _write_open_threads_file(self, threads: list[dict]) -> None:
        """Write the OPEN_THREADS.md file from thread list."""
        open_items = [t for t in threads if t["status"] == "open"]
        resolved_items = [t for t in threads if t["status"] == "resolved"]

        lines = ["# OPEN_THREADS\n"]
        lines.append("## Open")
        if open_items:
            for t in open_items:
                lines.append(f"- [Ch.{t['source_chapter']}] {t['text']} | evidence: {t['evidence'] or 'pending'}")
        else:
            lines.append("- (暂无)")

        MAX_RESOLVED_KEPT = 20

        lines.append("\n## Resolved")
        if resolved_items:
            # Keep only the most recent resolved threads
            sorted_resolved = sorted(
                resolved_items,
                key=lambda t: t.get("resolved_by_chapter", 0) or 0,
                reverse=True,
            )[:MAX_RESOLVED_KEPT]
            for t in sorted_resolved:
                lines.append(
                    f"- [Ch.{t['source_chapter']}→Ch.{t['resolved_by_chapter']}] "
                    f"{t['text']} | evidence: {t['evidence']}"
                )
        else:
            lines.append("- (暂无)")

        lines.append(f"\n---")
        lines.append(f"_Last recomputed: {datetime.now().isoformat()}_")
        lines.append(f"_Total: {len(open_items)} open, {len(resolved_items)} resolved_")

        open_threads_path = self.three_layer.memory_dir / "OPEN_THREADS.md"
        open_threads_path.write_text("\n".join(lines), encoding="utf-8")

    def _read_open_threads_from_disk(self) -> list[dict]:
        """Read OPEN_THREADS.md and return a minimal thread list (for read-only mode)."""
        path = self.three_layer.memory_dir / "OPEN_THREADS.md"
        if not path.exists():
            return []
        content = path.read_text(encoding="utf-8")
        threads: list[dict] = []
        current_status = "open"
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("## Open"):
                current_status = "open"
            elif stripped.startswith("## Resolved"):
                current_status = "resolved"
            elif stripped.startswith("- [Ch.") and stripped != "- (暂无)":
                threads.append({"text": stripped, "status": current_status})
        return threads

    @staticmethod
    def _score_thread_confidence(
        thread: dict,
        current_chapter: int,
        *,
        recency_weight: float = 0.5,
        evidence_weight: float = 0.3,
        length_weight: float = 0.2,
    ) -> float:
        """Score an open thread's relevance confidence in [0, 1].

        Factors:
        - recency: how close the source chapter is to current chapter (closer = higher)
        - evidence: threads with non-empty evidence get a boost
        - length: longer thread text (more detail) scores slightly higher
        """
        source = thread.get("source_chapter", 0)
        distance = max(1, current_chapter - source)
        # Recency: 1.0 for same chapter, decays with distance
        recency = 1.0 / distance

        # Evidence: 1.0 if evidence present, 0.3 otherwise
        evidence_str = thread.get("evidence", "")
        evidence_score = 1.0 if evidence_str and evidence_str != "pending" else 0.3

        # Length: normalize thread text length (cap at 200 chars)
        text_len = len(thread.get("text", ""))
        length_score = min(text_len / 200.0, 1.0)

        return (
            recency_weight * recency
            + evidence_weight * evidence_score
            + length_weight * length_score
        )

    def _select_threads_by_confidence(
        self,
        open_threads: list[dict],
        current_chapter: int,
        top_k: int = 10,
        min_confidence: float = 0.15,
    ) -> list[dict]:
        """Select open threads by confidence score, filtering below threshold then taking top-k."""
        if not open_threads:
            return []
        scored = [
            (t, self._score_thread_confidence(t, current_chapter))
            for t in open_threads
        ]
        # Filter by minimum confidence
        filtered = [(t, s) for t, s in scored if s >= min_confidence]
        # Sort descending by score
        filtered.sort(key=lambda x: x[1], reverse=True)
        return [t for t, _ in filtered[:top_k]]

    def _update_runtime_state(
        self,
        chapter_number: int,
        chapter_text: str,
        project_chapters: list[dict],
    ) -> None:
        """Update RUNTIME_STATE.md with new character appearances, state changes, and mainline status."""
        new_chars = []
        state_changes = []
        mainline_status = []

        if chapter_text:
            lines = chapter_text.split("\n")
            for line in lines[:20]:
                line = line.strip()
                if not line:
                    continue
                if any(kw in line for kw in ["登场", "出现", "来到", "走进", "第一次"]):
                    new_chars.append(line[:50])

            # Extract state changes: emotional shifts, status changes, revelations
            for line in lines:
                line = line.strip()
                if not line or len(line) < 5:
                    continue
                if any(kw in line for kw in ["变成", "转变", "觉醒", "死亡", "离开", "背叛",
                                              "受伤", "恢复", "获得", "失去", "决定", "发现了",
                                              "揭露", "暴露", "改变了", "不再是"]):
                    state_changes.append(line[:80])
                    if len(state_changes) >= 10:
                        break

            mainline_status.append(f"第{chapter_number}章已完成")

        rs_lines = ["# RUNTIME_STATE\n"]
        rs_lines.append("## New Characters")
        if new_chars:
            for nc in new_chars[:10]:
                rs_lines.append(f"- {nc}")
        else:
            rs_lines.append("- (暂无)")

        rs_lines.append("\n## Character State Changes")
        if state_changes:
            for sc in state_changes[:10]:
                rs_lines.append(f"- {sc}")
        else:
            rs_lines.append("- (暂无)")

        rs_lines.append("\n## Recent Mainline Status")
        if mainline_status:
            for ms in mainline_status[:10]:
                rs_lines.append(f"- {ms}")
        else:
            rs_lines.append("- (暂无)")

        rs_lines.append(f"\n---")
        rs_lines.append(f"_Last updated: {datetime.now().isoformat()}_")
        rs_lines.append(f"_Source chapters: 1-{chapter_number}_")

        rs_path = self.three_layer.l1_dir / "RUNTIME_STATE.md"
        rs_path.write_text("\n".join(rs_lines), encoding="utf-8")

    def _threshold_rewrite(
        self,
        chapter_number: int,
        project_chapters: list[dict],
    ) -> dict:
        """
        Every 3 chapters: compress MEMORY.md + rebuild RUNTIME_STATE.md.
        Every rewrite backs up current MEMORY.md to MEMORY.legacy.md.
        Returns: {"memory_rewritten": bool, "runtime_rebuilt": bool, "duration_s": float}
        """
        import time
        start = time.time()

        memory_path = self.three_layer.l2_dir / "MEMORY.md"
        legacy_path = self.three_layer.l2_dir / "MEMORY.legacy.md"

        # Backup before every rewrite
        if memory_path.exists():
            try:
                import shutil
                shutil.copy2(memory_path, legacy_path)
            except Exception as e:
                logger.warning(f"Failed to backup MEMORY.md: {e}")

        # Compress MEMORY.md — rolling window of recent 3 chapters
        recent = sorted(project_chapters, key=lambda c: c.get("chapter_number", 0))
        recent_3 = recent[-3:] if len(recent) >= 3 else recent

        compressed_lines = ["# MEMORY\n"]
        compressed_lines.append("## Rolling Window (Recent 3 Chapters)")
        for ch in recent_3:
            ch_num = ch.get("chapter_number", 0)
            compressed_lines.append(f"### Chapter {ch_num}")
            compressed_lines.append(f"- 状态: {ch.get('status', '未知')}")
            compressed_lines.append(f"- 关键决策: {ch.get('title', '无')}")
            compressed_lines.append(f"- 字数: {ch.get('word_count', 0)}")
            compressed_lines.append("")

        compressed_lines.append("## Unresolved Mainline Threads")
        # Get open threads
        threads = self.recompute_open_threads(project_chapters)
        open_threads = [t for t in threads if t["status"] == "open"]
        if open_threads:
            for t in open_threads[:5]:
                compressed_lines.append(f"- [Ch.{t['source_chapter']}] {t['text']}")
        else:
            compressed_lines.append("- (暂无)")

        compressed_lines.append("\n## Recent Key Decisions")
        compressed_lines.append("- (从章节计划中提取)")

        compressed_lines.append(f"\n---")
        compressed_lines.append(f"_Compressed at: {datetime.now().isoformat()}_")
        ch_nums = [c.get("chapter_number", 0) for c in project_chapters]
        if ch_nums:
            compressed_lines.append(f"_Covers chapters: 1-{max(ch_nums)}_")

        pre_size = self._file_size_safe(memory_path)
        self.three_layer.update_memory("\n".join(compressed_lines))
        post_size = self._file_size_safe(memory_path)
        _logger.info(
            "threshold_rewrite_compression pre_size=%d post_size=%d ratio=%.2f",
            pre_size, post_size,
            post_size / pre_size if pre_size > 0 else 0,
        )

        # Rebuild RUNTIME_STATE.md
        last_ch = recent[-1] if recent else {}
        last_text = last_ch.get("final") or last_ch.get("draft") or ""
        self._update_runtime_state(chapter_number, last_text, project_chapters)

        duration = time.time() - start
        return {
            "memory_rewritten": True,
            "runtime_rebuilt": True,
            "duration_s": round(duration, 3),
        }

    def refresh_memory_after_chapter(
        self,
        chapter_number: int,
        chapter_text: str,
        chapter_plan: dict | None,
        project_chapters: list[dict],
        mode: str = "lightweight",
    ) -> dict:
        """
        Chapter-end writeback entry point.
        - lightweight: L3 draft memory + synopsis + open_threads recompute + sync
        - consolidated: + reflect() + RUNTIME_STATE refresh + threshold check
        Returns: writeback operation summary dict.
        """
        result: dict = {"mode": mode, "chapter_number": chapter_number}

        # Common: remove old L3 items for this chapter before adding new ones
        self.three_layer.delete_l3_items_for_chapter(chapter_number)

        # Common: generate synopsis and add as L3 item
        synopsis = self.generate_chapter_synopsis(chapter_number, chapter_text, chapter_plan)
        self.three_layer.add_l3_item(
            summary=f"Chapter {chapter_number} synopsis",
            content=synopsis,
            item_type="chapter_synopsis",
        )
        result["synopsis_generated"] = True

        # Common: recompute open threads
        threads = self.recompute_open_threads(project_chapters)
        result["open_threads_count"] = len([t for t in threads if t["status"] == "open"])
        result["resolved_threads_count"] = len([t for t in threads if t["status"] == "resolved"])

        if mode == "lightweight":
            # Lightweight: append or replace entry in MEMORY.md
            memory = self.three_layer.get_memory()
            new_entry = (
                f"\n### Chapter {chapter_number} (draft)\n"
                f"- 状态: 草稿完成\n"
                f"- 摘要: {synopsis[:100]}\n"
                f"- 更新时间: {datetime.now().isoformat()}\n"
            )

            # Dedup: if an entry for this chapter already exists, replace it
            pattern = re.compile(
                rf"(\n###\s*Chapter\s+{chapter_number}\b.*?)(?=\n###\s|\n##\s|\Z)",
                re.DOTALL,
            )
            if pattern.search(memory):
                memory = pattern.sub(new_entry.rstrip(), memory)
            else:
                memory += new_entry

            self.three_layer.update_memory(memory)
            result["memory_appended"] = True

        elif mode == "consolidated":
            # Consolidated: reflect + RUNTIME_STATE + threshold check
            if chapter_text:
                self.three_layer.reflect(chapter_text, chapter_number)
                result["reflected"] = True

            self._update_runtime_state(chapter_number, chapter_text, project_chapters)
            result["runtime_state_updated"] = True

            # Threshold rewrite check: every 3 chapters
            if chapter_number > 0 and chapter_number % 3 == 0:
                rewrite_result = self._threshold_rewrite(chapter_number, project_chapters)
                result["threshold_rewrite"] = rewrite_result
            else:
                result["threshold_rewrite"] = None

        # Sync FTS index
        try:
            self.memory_store.sync_file_memories()
            result["sync_completed"] = True
        except Exception as e:
            logger.error(f"Failed to sync file memories: {e}")
            result["sync_completed"] = False

        _logger.info(
            "memory_refresh_done chapter=%d mode=%s threshold_rewrite_triggered=%s "
            "rewrite_duration_s=%.2f runtime_state_bytes=%d memory_bytes=%d open_threads_bytes=%d",
            chapter_number,
            mode,
            result.get("threshold_rewrite") is not None,
            result.get("threshold_rewrite", {}).get("duration_s", 0.0) if isinstance(result.get("threshold_rewrite"), dict) else 0.0,
            self._file_size_safe(self.three_layer.l1_dir / "RUNTIME_STATE.md"),
            self._file_size_safe(self.three_layer.l2_dir / "MEMORY.md"),
            self._file_size_safe(self.three_layer.memory_dir / "OPEN_THREADS.md"),
        )

        return result



