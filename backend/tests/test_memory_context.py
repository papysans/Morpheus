"""
Unit tests for Memory Context Injection feature.

Covers: TextCleaner, ThreeLayerMemory initialization, MemoryContextService,
debug endpoint schema, legacy backup, chapter deletion, and writeback call chain.
"""

import ast
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

# Ensure backend root is on sys.path
_backend_root = str(Path(__file__).resolve().parent.parent)
if _backend_root not in sys.path:
    sys.path.insert(0, _backend_root)

from memory import MemoryStore, ThreeLayerMemory
from services.memory_context import MemoryContextService
from utils.text_cleaner import (
    DEFAULT_BLOCKLIST,
    clean_foreshadowing_text,
    extract_keywords,
    is_pseudo_field_line,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SOURCE_PATH = Path(__file__).resolve().parent.parent / "api" / "main.py"


def _make_service(tmp_dir: str):
    """Create a MemoryContextService with fresh ThreeLayerMemory + MemoryStore."""
    tlm = ThreeLayerMemory(tmp_dir)
    db_path = Path(tmp_dir) / "test.db"
    ms = MemoryStore(tmp_dir, str(db_path))
    return MemoryContextService(tlm, ms), tlm, ms


# ===========================================================================
# 12.1 — Core unit tests
# ===========================================================================


class TestTextCleanerBlocklistFiltering:
    """TextCleaner blocklist filtering with specific examples."""

    def test_pure_blocklist_line_removed(self):
        """A line consisting entirely of blocklist words should be removed."""
        text = "id description type goal"
        result = clean_foreshadowing_text(text)
        assert result.strip() == "", f"Expected empty, got: {result!r}"

    def test_majority_blocklist_line_removed(self):
        """A line where >50% tokens are blocklist words should be removed."""
        # 3 blocklist words out of 5 tokens = 60%
        text = "id target source_chapter hello world"
        result = clean_foreshadowing_text(text)
        assert result.strip() == "", f"Expected empty, got: {result!r}"

    def test_minority_blocklist_line_kept(self):
        """A line where <=50% tokens are blocklist words should be kept."""
        # 1 blocklist word out of 4 tokens = 25%
        text = "the hero found a hidden treasure id"
        result = clean_foreshadowing_text(text)
        assert "hero" in result or "treasure" in result

    def test_mixed_multiline(self):
        """Multi-line text: blocklist-dominated lines removed, others kept."""
        text = "id description item target\n这是一段正常的伏笔文本关于角色命运"
        result = clean_foreshadowing_text(text)
        lines = [l.strip() for l in result.splitlines() if l.strip()]
        assert len(lines) == 1
        assert "伏笔" in lines[0] or "角色" in lines[0]

    def test_empty_input(self):
        result = clean_foreshadowing_text("")
        assert result == ""

    def test_is_pseudo_field_line_true(self):
        assert is_pseudo_field_line("id description type") is True

    def test_is_pseudo_field_line_false(self):
        assert is_pseudo_field_line("the hero saved the world") is False


class TestRuntimeStateInitialization:
    """RUNTIME_STATE.md initialization structure verification."""

    def test_runtime_state_exists_and_has_headers(self):
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            rs_path = tlm.l1_dir / "RUNTIME_STATE.md"
            assert rs_path.exists(), "RUNTIME_STATE.md should exist after init"

            content = rs_path.read_text(encoding="utf-8")
            assert content.startswith("# RUNTIME_STATE")
            assert "## New Characters" in content
            assert "## Character State Changes" in content
            assert "## Recent Mainline Status" in content
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


class TestOpenThreadsInitialization:
    """OPEN_THREADS.md initialization structure verification."""

    def test_open_threads_exists_and_has_headers(self):
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            ot_path = tlm.memory_dir / "OPEN_THREADS.md"
            assert ot_path.exists(), "OPEN_THREADS.md should exist after init"

            content = ot_path.read_text(encoding="utf-8")
            assert content.startswith("# OPEN_THREADS")
            assert "## Open" in content
            assert "## Resolved" in content
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


class TestContextPackFieldNonEmpty:
    """Context_Pack field non-empty verification."""

    def test_all_seven_keys_exist(self):
        tmp_dir = tempfile.mkdtemp()
        try:
            svc, tlm, ms = _make_service(tmp_dir)
            chapters = [
                {"chapter_number": 1, "plan": None, "draft": "第一章内容", "final": None},
            ]
            pack = svc.build_generation_context_pack(chapter_number=2, project_chapters=chapters)

            required_keys = {
                "identity_core", "runtime_state", "memory_compact",
                "previous_chapter_synopsis", "open_threads",
                "previous_chapters_compact", "budget_stats",
            }
            assert required_keys.issubset(pack.keys()), f"Missing: {required_keys - pack.keys()}"

            # budget_stats should have all required fields
            bs = pack["budget_stats"]
            for field in [
                "identity_core_budget", "identity_core_used",
                "runtime_state_budget", "runtime_state_used",
                "memory_compact_budget", "memory_compact_used",
                "previous_synopsis_budget", "previous_synopsis_used",
                "open_threads_budget", "open_threads_used",
                "previous_chapters_budget", "previous_chapters_used",
                "total_budget", "total_used",
            ]:
                assert field in bs, f"budget_stats missing field: {field}"
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


class TestThresholdRewriteLegacyBackup:
    """First MEMORY.md rewrite legacy backup exists."""

    def test_legacy_backup_created_on_first_rewrite(self):
        tmp_dir = tempfile.mkdtemp()
        try:
            svc, tlm, ms = _make_service(tmp_dir)
            chapters = [
                {"chapter_number": i, "plan": None, "draft": f"Ch {i} text", "final": None}
                for i in range(1, 4)
            ]
            # Chapter 3 is a multiple of 3 → triggers threshold rewrite
            svc.refresh_memory_after_chapter(
                chapter_number=3,
                chapter_text="Chapter 3 content",
                chapter_plan=None,
                project_chapters=chapters,
                mode="consolidated",
            )
            legacy_path = tlm.l2_dir / "MEMORY.legacy.md"
            assert legacy_path.exists(), "MEMORY.legacy.md should be created on first rewrite"
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


class TestChapterDeletionOpenThreadsRecompute:
    """Chapter deletion triggers open_threads recompute."""

    def test_recompute_changes_after_chapter_removal(self):
        tmp_dir = tempfile.mkdtemp()
        try:
            svc, tlm, ms = _make_service(tmp_dir)
            chapters = [
                {
                    "chapter_number": 1,
                    "plan": {
                        "title": "Ch1",
                        "goal": "Goal1",
                        "foreshadowing": ["神秘人物在暗处观察主角"],
                        "callback_targets": [],
                    },
                    "draft": None,
                    "final": None,
                },
                {
                    "chapter_number": 2,
                    "plan": {
                        "title": "Ch2",
                        "goal": "Goal2",
                        "foreshadowing": [],
                        "callback_targets": ["神秘人物在暗处观察主角"],
                    },
                    "draft": "神秘人物在暗处观察主角的后续",
                    "final": None,
                },
            ]

            threads_before = svc.recompute_open_threads(chapters)

            # Simulate deletion of chapter 2 (the resolving chapter)
            chapters_after = [chapters[0]]
            threads_after = svc.recompute_open_threads(chapters_after)

            # With chapter 2 removed, the thread from ch1 should no longer be resolved
            resolved_before = [t for t in threads_before if t["status"] == "resolved"]
            open_after = [t for t in threads_after if t["status"] == "open"]

            # The thread list should change — specifically, threads that were resolved
            # by chapter 2 should now be open
            assert len(threads_after) > 0, "Should still have threads from ch1"
            if resolved_before:
                assert len(open_after) >= len(resolved_before), (
                    "Previously resolved threads should become open after resolving chapter removed"
                )
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ===========================================================================
# 12.2 — Debug endpoint unit tests
# ===========================================================================


class TestDebugEndpointSchema:
    """Debug endpoint returns correct schema (tested at service level)."""

    def test_build_context_pack_returns_all_keys_and_budget_fields(self):
        """The underlying service method returns a dict with 7 required keys
        and budget_stats has all required fields."""
        tmp_dir = tempfile.mkdtemp()
        try:
            svc, tlm, ms = _make_service(tmp_dir)
            chapters = [
                {"chapter_number": 1, "plan": None, "draft": "内容", "final": None},
            ]
            pack = svc.build_generation_context_pack(chapter_number=1, project_chapters=chapters)

            required_keys = {
                "identity_core", "runtime_state", "memory_compact",
                "previous_chapter_synopsis", "open_threads",
                "previous_chapters_compact", "budget_stats",
            }
            assert required_keys == set(pack.keys()) & required_keys

            bs = pack["budget_stats"]
            assert "total_budget" in bs
            assert "total_used" in bs
            assert isinstance(bs["total_budget"], (int, float))
            assert isinstance(bs["total_used"], (int, float))
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def test_project_not_found_raises_error(self):
        """The debug endpoint in main.py should handle missing project_id with 404.
        We verify this at the source-code level by checking the endpoint function."""
        source = _SOURCE_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        found = False
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name == "get_memory_context_pack":
                    func_lines = source.splitlines()[node.lineno - 1 : node.end_lineno]
                    func_source = "\n".join(func_lines)
                    assert "404" in func_source or "HTTPException" in func_source, (
                        "get_memory_context_pack should handle project not found with 404"
                    )
                    found = True
                    break
        assert found, "get_memory_context_pack endpoint not found in api/main.py"


# ===========================================================================
# 12.3 — Integration tests: writeback call chain verification (AST-based)
# ===========================================================================


class TestWritebackCallChainVerification:
    """Structural/AST-based tests verifying integration points in api/main.py."""

    def _read_source(self) -> str:
        return _SOURCE_PATH.read_text(encoding="utf-8")

    def _extract_function_source(self, source: str, func_name: str) -> str:
        """Extract the source code of a top-level async/sync function by name."""
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name == func_name:
                    lines = source.splitlines()
                    return "\n".join(lines[node.lineno - 1 : node.end_lineno])
        raise ValueError(f"Function {func_name!r} not found in source")

    def test_finalize_calls_lightweight_refresh(self):
        """finalize_generated_draft calls refresh_memory_after_chapter with mode='lightweight'."""
        source = self._read_source()
        func_source = self._extract_function_source(source, "finalize_generated_draft")
        assert "refresh_memory_after_chapter" in func_source, (
            "finalize_generated_draft does not call refresh_memory_after_chapter"
        )
        assert 'mode="lightweight"' in func_source, (
            'finalize_generated_draft should use mode="lightweight"'
        )

    def test_review_chapter_approve_calls_consolidated_refresh(self):
        """review_chapter APPROVE calls refresh_memory_after_chapter with mode='consolidated'."""
        source = self._read_source()
        func_source = self._extract_function_source(source, "review_chapter")
        assert "refresh_memory_after_chapter" in func_source, (
            "review_chapter does not call refresh_memory_after_chapter"
        )
        assert 'mode="consolidated"' in func_source, (
            'review_chapter should use mode="consolidated"'
        )

    def test_one_shot_auto_approve_calls_consolidated_refresh(self):
        """run_one_shot_book_generation calls refresh_memory_after_chapter with mode='consolidated'."""
        source = self._read_source()
        func_source = self._extract_function_source(source, "run_one_shot_book_generation")
        assert "refresh_memory_after_chapter" in func_source, (
            "run_one_shot_book_generation does not call refresh_memory_after_chapter"
        )
        assert 'mode="consolidated"' in func_source, (
            'run_one_shot_book_generation should use mode="consolidated"'
        )

    def test_commit_memory_calls_consolidated_refresh(self):
        """commit_memory calls refresh_memory_after_chapter with mode='consolidated'."""
        source = self._read_source()
        func_source = self._extract_function_source(source, "commit_memory")
        assert "refresh_memory_after_chapter" in func_source, (
            "commit_memory does not call refresh_memory_after_chapter"
        )
        assert 'mode="consolidated"' in func_source, (
            'commit_memory should use mode="consolidated"'
        )
