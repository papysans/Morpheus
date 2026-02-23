"""
Property-based tests for Memory Context Injection feature.

Uses hypothesis to verify invariants across randomized inputs.
"""

import sys
from pathlib import Path

# Ensure backend root is on sys.path so bare imports work (e.g. `from utils.text_cleaner import ...`)
_backend_root = str(Path(__file__).resolve().parent.parent)
if _backend_root not in sys.path:
    sys.path.insert(0, _backend_root)

import string

from hypothesis import given, settings, strategies as st

from utils.text_cleaner import (
    DEFAULT_BLOCKLIST,
    KEYWORD_STOPWORDS,
    MIN_KEYWORD_LENGTH,
    _TOKEN_RE,
    clean_foreshadowing_text,
    extract_keywords,
    is_pseudo_field_line,
)

# ---------------------------------------------------------------------------
# Hypothesis profiles
# ---------------------------------------------------------------------------
settings.register_profile("ci", max_examples=200)
settings.register_profile("dev", max_examples=100)

# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Strategy: a single blocklist word
_blocklist_word = st.sampled_from(sorted(DEFAULT_BLOCKLIST))

# Strategy: a normal (non-blocklist) word — short latin or CJK-ish token
_normal_word = st.text(
    alphabet=st.sampled_from(list(string.ascii_lowercase)),
    min_size=3,
    max_size=8,
).filter(lambda w: w.lower() not in DEFAULT_BLOCKLIST)

# Strategy: a line that mixes normal words and blocklist words
_mixed_line = st.lists(
    st.one_of(_blocklist_word, _normal_word),
    min_size=1,
    max_size=12,
).map(lambda tokens: " ".join(tokens))

# Strategy: multi-line text built from mixed lines
_mixed_text = st.lists(_mixed_line, min_size=1, max_size=10).map(lambda lines: "\n".join(lines))


# ---------------------------------------------------------------------------
# Property 9: Text cleaner filters blocklisted tokens and pseudo-field lines
# **Validates: Requirements 7.1, 7.2**
# ---------------------------------------------------------------------------


class TestProperty9TextCleanerFiltersBlocklisted:
    """Property 9: Text cleaner filters blocklisted tokens and pseudo-field lines."""

    @given(text=_mixed_text)
    @settings(max_examples=100)
    def test_output_has_no_majority_blocklist_lines(self, text: str) -> None:
        """
        **Validates: Requirements 7.1, 7.2**

        For any input text, clean_foreshadowing_text output should not contain
        any non-blank line where blocklisted tokens exceed 50% of total tokens.
        """
        cleaned = clean_foreshadowing_text(text)
        for line in cleaned.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            tokens = _TOKEN_RE.findall(stripped)
            if not tokens:
                continue
            blocked = sum(1 for t in tokens if t.lower() in DEFAULT_BLOCKLIST)
            assert blocked / len(tokens) <= 0.5, (
                f"Line still has >50% blocklist tokens after cleaning: {stripped!r}"
            )

    @given(text=_mixed_text)
    @settings(max_examples=100)
    def test_is_pseudo_field_line_consistency(self, text: str) -> None:
        """
        **Validates: Requirements 7.1, 7.2**

        Every line kept by clean_foreshadowing_text should NOT be classified
        as a pseudo-field line by is_pseudo_field_line.
        """
        cleaned = clean_foreshadowing_text(text)
        for line in cleaned.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            assert not is_pseudo_field_line(stripped), (
                f"Kept line is classified as pseudo-field: {stripped!r}"
            )


# ---------------------------------------------------------------------------
# Strategies for Property 10
# ---------------------------------------------------------------------------

# Strategy: text mixing CJK characters, latin words, stopwords, and short tokens
_cjk_chars = st.sampled_from(
    [chr(c) for c in range(0x4E00, 0x4E00 + 200)]  # common CJK subset
)
_stopword = st.sampled_from(sorted(KEYWORD_STOPWORDS))

_keyword_text = st.lists(
    st.one_of(
        # Normal latin words
        st.text(alphabet=st.sampled_from(list(string.ascii_lowercase)), min_size=1, max_size=8),
        # CJK characters (single — should be filtered by min_length=2)
        _cjk_chars,
        # Stopwords
        _stopword,
        # Multi-char CJK tokens (joined)
        st.lists(_cjk_chars, min_size=2, max_size=5).map(lambda cs: "".join(cs)),
    ),
    min_size=1,
    max_size=20,
).map(lambda tokens: " ".join(tokens))


# ---------------------------------------------------------------------------
# Property 10: Keyword extraction respects length threshold and stopwords
# **Validates: Requirements 7.3**
# ---------------------------------------------------------------------------


class TestProperty10KeywordExtractionConstraints:
    """Property 10: Keyword extraction respects length threshold and stopwords."""

    @given(text=_keyword_text)
    @settings(max_examples=100)
    def test_keywords_respect_min_length(self, text: str) -> None:
        """
        **Validates: Requirements 7.3**

        All returned keywords must have length >= MIN_KEYWORD_LENGTH.
        """
        keywords = extract_keywords(text)
        for kw in keywords:
            assert len(kw) >= MIN_KEYWORD_LENGTH, (
                f"Keyword {kw!r} shorter than MIN_KEYWORD_LENGTH={MIN_KEYWORD_LENGTH}"
            )

    @given(text=_keyword_text)
    @settings(max_examples=100)
    def test_keywords_exclude_stopwords(self, text: str) -> None:
        """
        **Validates: Requirements 7.3**

        No returned keyword should be in KEYWORD_STOPWORDS.
        """
        keywords = extract_keywords(text)
        for kw in keywords:
            assert kw not in KEYWORD_STOPWORDS, (
                f"Keyword {kw!r} is a stopword and should have been filtered"
            )

    @given(text=_keyword_text)
    @settings(max_examples=100)
    def test_keywords_are_unique(self, text: str) -> None:
        """
        **Validates: Requirements 7.3**

        Returned keywords should contain no duplicates.
        """
        keywords = extract_keywords(text)
        assert len(keywords) == len(set(keywords)), "Duplicate keywords found"


# ---------------------------------------------------------------------------
# Property 11: Auto-migration creates missing files idempotently
# **Validates: Requirements 9.1**
# ---------------------------------------------------------------------------

import shutil
import tempfile

from memory import ThreeLayerMemory


class TestProperty11AutoMigrationIdempotent:
    """Property 11: Auto-migration creates missing files idempotently."""

    @given(call_count=st.integers(min_value=1, max_value=5))
    @settings(max_examples=50)
    def test_ensure_directories_creates_files_idempotently(self, call_count: int) -> None:
        """
        **Validates: Requirements 9.1**

        Multiple calls to ThreeLayerMemory (which calls _ensure_directories)
        should always result in RUNTIME_STATE.md and OPEN_THREADS.md existing
        with valid structural headers.
        """
        tmp_dir = tempfile.mkdtemp()
        try:
            for _ in range(call_count):
                tlm = ThreeLayerMemory(tmp_dir)

            # After all calls, files must exist
            runtime_state = tlm.l1_dir / "RUNTIME_STATE.md"
            open_threads = tlm.memory_dir / "OPEN_THREADS.md"

            assert runtime_state.exists(), "RUNTIME_STATE.md should exist"
            assert open_threads.exists(), "OPEN_THREADS.md should exist"

            # Validate structural headers
            rs_content = runtime_state.read_text(encoding="utf-8")
            assert rs_content.startswith("# RUNTIME_STATE"), (
                "RUNTIME_STATE.md should start with '# RUNTIME_STATE'"
            )
            assert "## New Characters" in rs_content
            assert "## Character State Changes" in rs_content
            assert "## Recent Mainline Status" in rs_content

            ot_content = open_threads.read_text(encoding="utf-8")
            assert ot_content.startswith("# OPEN_THREADS"), (
                "OPEN_THREADS.md should start with '# OPEN_THREADS'"
            )
            assert "## Open" in ot_content
            assert "## Resolved" in ot_content
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    @given(data=st.data())
    @settings(max_examples=30)
    def test_existing_files_not_overwritten(self, data: st.DataObject) -> None:
        """
        **Validates: Requirements 9.1**

        If RUNTIME_STATE.md and OPEN_THREADS.md already exist, subsequent
        ThreeLayerMemory initializations should NOT overwrite them.
        """
        tmp_dir = tempfile.mkdtemp()
        try:
            # First init creates files
            tlm = ThreeLayerMemory(tmp_dir)

            runtime_state = tlm.l1_dir / "RUNTIME_STATE.md"
            open_threads = tlm.memory_dir / "OPEN_THREADS.md"

            # Record original content
            rs_original = runtime_state.read_text(encoding="utf-8")
            ot_original = open_threads.read_text(encoding="utf-8")

            # Re-init multiple times
            repeat = data.draw(st.integers(min_value=1, max_value=3))
            for _ in range(repeat):
                ThreeLayerMemory(tmp_dir)

            # Content should be unchanged (idempotent — no overwrite)
            assert runtime_state.read_text(encoding="utf-8") == rs_original
            assert open_threads.read_text(encoding="utf-8") == ot_original
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Imports for Property 7, 3, 4 (MemoryContextService tests)
# ---------------------------------------------------------------------------

from memory import MemoryStore
from services.memory_context import MemoryContextService

# Strategy for Chinese text
_chinese_chars = st.sampled_from([chr(c) for c in range(0x4E00, 0x4E00 + 500)])
_chinese_text = st.lists(_chinese_chars, min_size=50, max_size=500).map(lambda cs: "".join(cs))

# Strategy for optional plan dict
_optional_plan = st.one_of(
    st.none(),
    st.fixed_dictionaries({
        "title": st.text(min_size=1, max_size=50),
        "goal": st.text(min_size=1, max_size=100),
    }),
)


# ---------------------------------------------------------------------------
# Property 7: Chapter synopsis length bound
# **Validates: Requirements 4.1, 4.2, 4.3**
# ---------------------------------------------------------------------------


class TestProperty7ChapterSynopsisLengthBound:
    """Property 7: Chapter synopsis length bound."""

    @given(
        chapter_text=_chinese_text,
        chapter_plan=_optional_plan,
        chapter_number=st.integers(min_value=1, max_value=30),
    )
    @settings(max_examples=100)
    def test_synopsis_length_and_non_empty(self, chapter_text, chapter_plan, chapter_number):
        """Validates: Requirements 4.1, 4.2, 4.3"""
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            db_path = Path(tmp_dir) / "test.db"
            ms = MemoryStore(tmp_dir, str(db_path))
            svc = MemoryContextService(tlm, ms)
            synopsis = svc.generate_chapter_synopsis(chapter_number, chapter_text, chapter_plan)
            assert synopsis, "Synopsis must be non-empty"
            assert len(synopsis) <= 300, f"Synopsis too long: {len(synopsis)} chars"
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Strategies for Property 3 and 4
# ---------------------------------------------------------------------------

# Strategy for chapter plans with foreshadowing
_foreshadowing_text = st.text(
    alphabet=st.sampled_from([chr(c) for c in range(0x4E00, 0x4E00 + 200)] + list("abcdefghij")),
    min_size=5,
    max_size=50,
)

_chapter_plan_with_fs = st.fixed_dictionaries({
    "title": st.text(min_size=1, max_size=20),
    "goal": st.text(min_size=1, max_size=30),
    "foreshadowing": st.lists(_foreshadowing_text, min_size=1, max_size=5),
    "callback_targets": st.lists(st.text(min_size=3, max_size=30), min_size=0, max_size=3),
})

_project_chapters = st.lists(
    st.fixed_dictionaries({
        "chapter_number": st.integers(min_value=1, max_value=20),
        "plan": st.one_of(st.none(), _chapter_plan_with_fs),
        "draft": st.one_of(st.none(), st.text(min_size=10, max_size=200)),
        "final": st.one_of(st.none(), st.text(min_size=10, max_size=200)),
    }),
    min_size=1,
    max_size=8,
).map(lambda chs: sorted(chs, key=lambda c: c["chapter_number"]))


# ---------------------------------------------------------------------------
# Property 3: Open thread recompute produces valid, complete entries
# **Validates: Requirements 2.2, 2.5**
# ---------------------------------------------------------------------------


class TestProperty3OpenThreadRecomputeValid:
    """Property 3: Open thread recompute produces valid, complete entries."""

    @given(chapters=_project_chapters)
    @settings(max_examples=100)
    def test_all_threads_have_required_fields(self, chapters):
        """Validates: Requirements 2.2, 2.5"""
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            db_path = Path(tmp_dir) / "test.db"
            ms = MemoryStore(tmp_dir, str(db_path))
            svc = MemoryContextService(tlm, ms)
            threads = svc.recompute_open_threads(chapters)
            required_fields = {"source_chapter", "text", "status", "resolved_by_chapter", "evidence"}
            for t in threads:
                assert required_fields.issubset(t.keys()), f"Missing fields in thread: {t.keys()}"
                assert t["status"] in ("open", "resolved"), f"Invalid status: {t['status']}"
                if t["status"] == "resolved":
                    assert t["resolved_by_chapter"] is not None
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Property 4: Thread resolution priority
# **Validates: Requirements 2.3, 2.4**
# ---------------------------------------------------------------------------


class TestProperty4ThreadResolutionPriority:
    """Property 4: Thread resolution with callback_targets priority and keyword fallback."""

    @given(data=st.data())
    @settings(max_examples=50)
    def test_callback_targets_take_priority(self, data):
        """Validates: Requirements 2.3, 2.4"""
        # Create a scenario where both callback_targets and keyword match exist
        fs_text = data.draw(st.text(
            alphabet=st.sampled_from([chr(c) for c in range(0x4E00, 0x4E00 + 100)]),
            min_size=5, max_size=30,
        ))

        chapters = [
            {
                "chapter_number": 1,
                "plan": {
                    "title": "Ch1",
                    "goal": "Goal1",
                    "foreshadowing": [fs_text],
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
                    "callback_targets": [fs_text],  # exact match callback
                },
                "draft": fs_text * 3,  # also contains keywords
                "final": None,
            },
        ]

        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            db_path = Path(tmp_dir) / "test.db"
            ms = MemoryStore(tmp_dir, str(db_path))
            svc = MemoryContextService(tlm, ms)
            threads = svc.recompute_open_threads(chapters)

            resolved = [t for t in threads if t["status"] == "resolved"]
            for t in resolved:
                if t["source_chapter"] == 1:
                    # Should be resolved by callback_target, not keyword
                    assert "callback_target" in t["evidence"], (
                        f"Expected callback_target evidence, got: {t['evidence']}"
                    )
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Property 8: Context_Pack structural completeness and budget invariant
# **Validates: Requirements 5.1, 5.2**
# ---------------------------------------------------------------------------


class TestProperty8ContextPackStructuralCompleteness:
    """Property 8: Context_Pack structural completeness and budget invariant."""

    @given(
        chapter_number=st.integers(min_value=1, max_value=20),
        chapters=_project_chapters,
    )
    @settings(max_examples=100)
    def test_context_pack_has_all_keys_and_budget_invariant(self, chapter_number, chapters):
        """Validates: Requirements 5.1, 5.2"""
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            db_path = Path(tmp_dir) / "test.db"
            ms = MemoryStore(tmp_dir, str(db_path))
            svc = MemoryContextService(tlm, ms)
            pack = svc.build_generation_context_pack(chapter_number, chapters)

            # All 7 required keys
            required_keys = {
                "identity_core", "runtime_state", "memory_compact",
                "previous_chapter_synopsis", "open_threads",
                "previous_chapters_compact", "budget_stats",
            }
            assert required_keys.issubset(pack.keys()), f"Missing keys: {required_keys - pack.keys()}"

            # Budget invariant: sum of *_used <= total_budget
            bs = pack["budget_stats"]
            used_fields = [
                bs["identity_core_used"], bs["runtime_state_used"],
                bs["memory_compact_used"], bs["previous_synopsis_used"],
                bs["open_threads_used"], bs["previous_chapters_used"],
            ]
            total_used = sum(used_fields)
            assert total_used <= bs["total_budget"], (
                f"Total used {total_used} exceeds total budget {bs['total_budget']}"
            )
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Property 5: Open threads injection respects top-k limit
# **Validates: Requirements 2.6**
# ---------------------------------------------------------------------------


class TestProperty5OpenThreadsTopKLimit:
    """Property 5: Open threads injection respects top-k limit."""

    @given(
        chapter_number=st.integers(min_value=1, max_value=20),
        chapters=_project_chapters,
        top_k=st.integers(min_value=1, max_value=15),
    )
    @settings(max_examples=100)
    def test_open_threads_respects_top_k(self, chapter_number, chapters, top_k):
        """Validates: Requirements 2.6"""
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            db_path = Path(tmp_dir) / "test.db"
            ms = MemoryStore(tmp_dir, str(db_path))
            svc = MemoryContextService(tlm, ms)
            pack = svc.build_generation_context_pack(chapter_number, chapters, top_k_threads=top_k)

            assert len(pack["open_threads"]) <= top_k, (
                f"open_threads has {len(pack['open_threads'])} entries, exceeds top_k={top_k}"
            )
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Property 2: Threshold rewrite triggers at chapter multiples of 3
# **Validates: Requirements 1.4, 3.1, 6.3**
# ---------------------------------------------------------------------------


class TestProperty2ThresholdRewriteTriggersAt3:
    """Property 2: Threshold rewrite triggers at chapter multiples of 3."""

    @given(chapter_number=st.integers(min_value=1, max_value=30))
    @settings(max_examples=100)
    def test_threshold_rewrite_trigger_condition(self, chapter_number):
        """Validates: Requirements 1.4, 3.1, 6.3"""
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            db_path = Path(tmp_dir) / "test.db"
            ms = MemoryStore(tmp_dir, str(db_path))
            svc = MemoryContextService(tlm, ms)

            chapters = [{"chapter_number": i, "plan": None, "draft": f"Text for ch {i}", "final": None}
                        for i in range(1, chapter_number + 1)]

            result = svc.refresh_memory_after_chapter(
                chapter_number=chapter_number,
                chapter_text=f"Chapter {chapter_number} text content",
                chapter_plan=None,
                project_chapters=chapters,
                mode="consolidated",
            )

            if chapter_number % 3 == 0:
                assert result.get("threshold_rewrite") is not None, (
                    f"Threshold rewrite should trigger at chapter {chapter_number} (multiple of 3)"
                )
                assert result["threshold_rewrite"]["memory_rewritten"] is True
            else:
                assert result.get("threshold_rewrite") is None, (
                    f"Threshold rewrite should NOT trigger at chapter {chapter_number}"
                )
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Property 6: Lightweight refresh appends without compression
# **Validates: Requirements 3.3**
# ---------------------------------------------------------------------------


class TestProperty6LightweightRefreshAppends:
    """Property 6: Lightweight refresh appends without compression."""

    @given(chapter_number=st.integers(min_value=1, max_value=10))
    @settings(max_examples=50)
    def test_lightweight_memory_monotonic_growth(self, chapter_number):
        """Validates: Requirements 3.3"""
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            db_path = Path(tmp_dir) / "test.db"
            ms = MemoryStore(tmp_dir, str(db_path))
            svc = MemoryContextService(tlm, ms)

            memory_path = tlm.l2_dir / "MEMORY.md"
            sizes = []

            for i in range(1, chapter_number + 1):
                chapters = [{"chapter_number": j, "plan": None, "draft": None, "final": None}
                            for j in range(1, i + 1)]
                svc.refresh_memory_after_chapter(
                    chapter_number=i,
                    chapter_text=f"Chapter {i} content",
                    chapter_plan=None,
                    project_chapters=chapters,
                    mode="lightweight",
                )
                sizes.append(memory_path.stat().st_size)

            # Monotonic growth
            for j in range(1, len(sizes)):
                assert sizes[j] >= sizes[j - 1], (
                    f"MEMORY.md size decreased from {sizes[j-1]} to {sizes[j]} at step {j}"
                )
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Property 1: IDENTITY.md preservation invariant
# **Validates: Requirements 1.2**
# ---------------------------------------------------------------------------


class TestProperty1IdentityPreservation:
    """Property 1: IDENTITY.md preservation invariant."""

    @given(
        call_count=st.integers(min_value=1, max_value=5),
        mode=st.sampled_from(["lightweight", "consolidated"]),
    )
    @settings(max_examples=50)
    def test_identity_unchanged_after_operations(self, call_count, mode):
        """Validates: Requirements 1.2"""
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            db_path = Path(tmp_dir) / "test.db"
            ms = MemoryStore(tmp_dir, str(db_path))
            svc = MemoryContextService(tlm, ms)

            identity_before = tlm.get_identity()

            for i in range(1, call_count + 1):
                chapters = [{"chapter_number": j, "plan": None, "draft": None, "final": None}
                            for j in range(1, i + 1)]
                svc.refresh_memory_after_chapter(
                    chapter_number=i,
                    chapter_text=f"Chapter {i} text",
                    chapter_plan=None,
                    project_chapters=chapters,
                    mode=mode,
                )
                svc.recompute_open_threads(chapters)

            identity_after = tlm.get_identity()
            assert identity_after == identity_before, "IDENTITY.md was modified!"
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Property 12: Consolidated refresh is triggered by all approval pathways
# **Validates: Requirements 6.2**
# ---------------------------------------------------------------------------

import ast
import textwrap


class TestProperty12ConsolidatedRefreshAllApprovalPathways:
    """Property 12: Consolidated refresh is triggered by all approval pathways.

    Since review_chapter, run_one_shot_book_generation (auto_approve), and
    commit_memory are complex async FastAPI endpoints with many dependencies,
    we verify the integration at the source-code level: each approval pathway
    must contain a call to refresh_memory_after_chapter with mode="consolidated".

    This is a structural property test that ensures the integration points
    exist and are correctly configured.
    """

    _SOURCE_PATH = Path(__file__).resolve().parent.parent / "api" / "main.py"

    def _read_source(self) -> str:
        return self._SOURCE_PATH.read_text(encoding="utf-8")

    def _extract_function_source(self, source: str, func_name: str) -> str:
        """Extract the source code of a top-level async/sync function by name."""
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name == func_name:
                    lines = source.splitlines()
                    return "\n".join(lines[node.lineno - 1 : node.end_lineno])
        raise ValueError(f"Function {func_name!r} not found in source")

    @given(pathway=st.sampled_from(["review_chapter", "run_one_shot_book_generation", "commit_memory"]))
    @settings(max_examples=10)
    def test_approval_pathways_call_consolidated_refresh(self, pathway: str):
        """
        **Validates: Requirements 6.2**

        For each approval pathway function, verify that:
        1. It contains a call to refresh_memory_after_chapter
        2. The call uses mode="consolidated"
        """
        source = self._read_source()
        func_source = self._extract_function_source(source, pathway)

        # Must contain refresh_memory_after_chapter call
        assert "refresh_memory_after_chapter" in func_source, (
            f"{pathway} does not call refresh_memory_after_chapter"
        )

        # Must use mode="consolidated"
        assert 'mode="consolidated"' in func_source, (
            f'{pathway} does not pass mode="consolidated" to refresh_memory_after_chapter'
        )

    @given(data=st.data())
    @settings(max_examples=10)
    def test_finalize_uses_lightweight_not_consolidated(self, data):
        """
        **Validates: Requirements 6.1**

        finalize_generated_draft should use mode="lightweight", NOT "consolidated".
        """
        source = self._read_source()
        func_source = self._extract_function_source(source, "finalize_generated_draft")

        assert "refresh_memory_after_chapter" in func_source, (
            "finalize_generated_draft does not call refresh_memory_after_chapter"
        )
        assert 'mode="lightweight"' in func_source, (
            'finalize_generated_draft should use mode="lightweight"'
        )

    @given(data=st.data())
    @settings(max_examples=10)
    def test_delete_chapter_calls_recompute_open_threads(self, data):
        """
        **Validates: Requirements 6.4**

        _delete_chapter_internal should call recompute_open_threads.
        """
        source = self._read_source()
        func_source = self._extract_function_source(source, "_delete_chapter_internal")

        assert "recompute_open_threads" in func_source, (
            "_delete_chapter_internal does not call recompute_open_threads"
        )

    def test_all_three_consolidated_pathways_present(self):
        """
        **Validates: Requirements 6.2**

        Non-property sanity check: all three approval pathways exist and
        each calls refresh_memory_after_chapter(mode="consolidated").
        """
        source = self._read_source()
        pathways = ["review_chapter", "run_one_shot_book_generation", "commit_memory"]

        for pathway in pathways:
            func_source = self._extract_function_source(source, pathway)
            assert "refresh_memory_after_chapter" in func_source, (
                f"{pathway} missing refresh_memory_after_chapter call"
            )
            assert 'mode="consolidated"' in func_source, (
                f'{pathway} missing mode="consolidated"'
            )


# ---------------------------------------------------------------------------
# Property 13: Pre-generation context logging is complete
# **Validates: Requirements 8.2**
# ---------------------------------------------------------------------------


class TestProperty13PreGenerationContextLogging:
    """Property 13: Pre-generation context logging is complete."""

    @given(
        chapter_number=st.integers(min_value=1, max_value=20),
        chapters=_project_chapters,
    )
    @settings(max_examples=50)
    def test_budget_stats_has_all_logging_fields(self, chapter_number, chapters):
        """Validates: Requirements 8.2"""
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            db_path = Path(tmp_dir) / "test.db"
            ms = MemoryStore(tmp_dir, str(db_path))
            svc = MemoryContextService(tlm, ms)
            pack = svc.build_generation_context_pack(chapter_number, chapters)

            bs = pack["budget_stats"]
            required_logging_fields = [
                "total_budget", "identity_core_used", "runtime_state_used",
                "memory_compact_used", "previous_synopsis_used",
                "open_threads_used", "previous_chapters_used",
            ]
            for field in required_logging_fields:
                assert field in bs, f"budget_stats missing logging field: {field}"
                assert isinstance(bs[field], (int, float)), f"budget_stats[{field}] should be numeric"

            assert isinstance(pack["open_threads"], list), "open_threads should be a list"
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Property 14: Writeback logging reports threshold and file outputs
# **Validates: Requirements 8.3**
# ---------------------------------------------------------------------------


class TestProperty14WritebackLoggingFields:
    """Property 14: Writeback logging reports threshold and file outputs."""

    @given(
        chapter_number=st.integers(min_value=1, max_value=15),
        mode=st.sampled_from(["lightweight", "consolidated"]),
    )
    @settings(max_examples=50)
    def test_refresh_result_has_logging_fields(self, chapter_number, mode):
        """Validates: Requirements 8.3"""
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            db_path = Path(tmp_dir) / "test.db"
            ms = MemoryStore(tmp_dir, str(db_path))
            svc = MemoryContextService(tlm, ms)

            chapters = [{"chapter_number": i, "plan": None, "draft": f"Ch {i}", "final": None}
                        for i in range(1, chapter_number + 1)]

            result = svc.refresh_memory_after_chapter(
                chapter_number=chapter_number,
                chapter_text=f"Chapter {chapter_number} text",
                chapter_plan=None,
                project_chapters=chapters,
                mode=mode,
            )

            assert isinstance(result, dict), "refresh result should be a dict"
            assert "mode" in result, "result should contain 'mode'"
            assert result["mode"] == mode

            if mode == "consolidated" and chapter_number % 3 == 0:
                tr = result.get("threshold_rewrite")
                assert tr is not None, "threshold_rewrite should be present at multiples of 3"
                assert "duration_s" in tr, "threshold_rewrite should have duration_s"
                assert "memory_rewritten" in tr, "threshold_rewrite should have memory_rewritten"
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Property 15: Plan quality warnings include context-pack stats
# **Validates: Requirements 8.4**
# ---------------------------------------------------------------------------


class TestProperty15PlanQualityWarningContextPackStats:
    """Property 15: Plan quality warnings include context-pack stats."""

    @given(
        chapter_number=st.integers(min_value=1, max_value=20),
        chapters=_project_chapters,
    )
    @settings(max_examples=50)
    def test_context_pack_has_plan_quality_warning_fields(self, chapter_number, chapters):
        """Validates: Requirements 8.4"""
        tmp_dir = tempfile.mkdtemp()
        try:
            tlm = ThreeLayerMemory(tmp_dir)
            db_path = Path(tmp_dir) / "test.db"
            ms = MemoryStore(tmp_dir, str(db_path))
            svc = MemoryContextService(tlm, ms)
            pack = svc.build_generation_context_pack(chapter_number, chapters)

            # The plan quality warning log references these fields
            assert "budget_stats" in pack
            assert "total_budget" in pack["budget_stats"]
            assert "open_threads" in pack
            assert "identity_core_used" in pack["budget_stats"]

            # All referenced fields should be accessible without KeyError
            _ = pack["budget_stats"]["total_budget"]
            _ = len(pack["open_threads"])
            _ = pack["budget_stats"]["identity_core_used"]
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
