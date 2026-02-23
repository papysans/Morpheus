"""
Tests for L2 Memory Layer Fixes.
Covers: F1-F8 bug fixes for MEMORY.md compression, backup, dedup, weights, regex, threads, logs, template.
"""

import os
import re
import sys
import tempfile
import time
from pathlib import Path

import pytest

# Ensure backend root is on sys.path
_backend_root = str(Path(__file__).resolve().parent.parent)
if _backend_root not in sys.path:
    sys.path.insert(0, _backend_root)

from memory import MemoryStore, ThreeLayerMemory
from models import Layer
from services.memory_context import MemoryContextService


def _make_service(tmp_dir: str):
    """Create a MemoryContextService with fresh ThreeLayerMemory + MemoryStore."""
    tlm = ThreeLayerMemory(tmp_dir)
    db_path = Path(tmp_dir) / "test.db"
    ms = MemoryStore(tmp_dir, str(db_path))
    return MemoryContextService(tlm, ms), tlm, ms


def _make_chapters(n: int) -> list:
    """Create a list of n chapter dicts for testing."""
    return [
        {
            "chapter_number": i,
            "title": f"Chapter {i} Title",
            "status": "approved",
            "word_count": 1000 * i,
            "plan": None,
            "draft": f"Draft text for chapter {i}",
            "final": f"Final text for chapter {i}",
        }
        for i in range(1, n + 1)
    ]


class TestF2LegacyBackup:
    """F2: Legacy backup should be updated on every rewrite, not just the first."""

    def test_legacy_backup_updated_on_second_rewrite(self, tmp_path):
        """第二次 threshold rewrite 应更新 MEMORY.legacy.md，而非保留第一次的备份"""
        svc, tlm, ms = _make_service(str(tmp_path))

        # 第一次 rewrite (chapter 3)
        chapters_3 = _make_chapters(3)
        svc.refresh_memory_after_chapter(3, "Ch3 text", None, chapters_3, mode="consolidated")

        # 记录第一次 rewrite 后的 legacy 内容
        legacy_path = tlm.l2_dir / "MEMORY.legacy.md"
        assert legacy_path.exists(), "MEMORY.legacy.md should exist after first rewrite"
        legacy_after_first = legacy_path.read_text(encoding="utf-8")

        # 手动追加标记到 MEMORY.md，这样第二次 rewrite 前的内容会包含此标记
        memory_after_first = tlm.get_memory()
        marker = "\n### MARKER_BEFORE_SECOND_REWRITE\n"
        tlm.update_memory(memory_after_first + marker)

        # 第二次 rewrite (chapter 6) — reflect() 会先追加 Chapter 6 条目，
        # 然后 _threshold_rewrite 备份当前 MEMORY.md（含标记+reflect追加）再压缩
        chapters_6 = _make_chapters(6)
        svc.refresh_memory_after_chapter(6, "Ch6 text", None, chapters_6, mode="consolidated")

        legacy_content = legacy_path.read_text(encoding="utf-8")
        # 关键断言：legacy 内容应该包含我们的标记（说明第二次 rewrite 更新了备份）
        assert "MARKER_BEFORE_SECOND_REWRITE" in legacy_content, (
            "MEMORY.legacy.md should be updated on second rewrite and contain the marker"
        )
        # 确认 legacy 内容不同于第一次的备份
        assert legacy_content != legacy_after_first, (
            "MEMORY.legacy.md should be different from the first rewrite's backup"
        )


class TestF3LightweightDedup:
    """F3: Lightweight mode should deduplicate same-chapter entries."""

    def test_lightweight_dedup_same_chapter(self, tmp_path):
        """对同一章调用两次 lightweight refresh，MEMORY.md 中只有一个条目"""
        svc, tlm, ms = _make_service(str(tmp_path))
        chapters = _make_chapters(1)
        svc.refresh_memory_after_chapter(1, "text v1", None, chapters, mode="lightweight")
        svc.refresh_memory_after_chapter(1, "text v2", None, chapters, mode="lightweight")
        memory = tlm.get_memory()
        count = memory.count("### Chapter 1")
        assert count == 1, f"Expected 1 entry for Chapter 1, found {count}"

    def test_lightweight_dedup_different_chapters(self, tmp_path):
        """不同章节的条目不应被去重"""
        svc, tlm, ms = _make_service(str(tmp_path))
        chapters = _make_chapters(2)
        svc.refresh_memory_after_chapter(1, "text ch1", None, chapters, mode="lightweight")
        svc.refresh_memory_after_chapter(2, "text ch2", None, chapters, mode="lightweight")
        memory = tlm.get_memory()
        assert memory.count("### Chapter 1") == 1
        assert memory.count("### Chapter 2") == 1


class TestF1ThresholdRewriteCompression:
    """F1: Threshold rewrite should compress MEMORY.md to only recent 3 chapters."""

    def test_threshold_rewrite_removes_old_chapters(self, tmp_path):
        """6 章后 threshold rewrite，MEMORY.md 只包含 chapter 4/5/6"""
        svc, tlm, ms = _make_service(str(tmp_path))
        chapters = _make_chapters(6)

        # 先用 lightweight 追加 6 个条目
        for ch in chapters:
            svc.refresh_memory_after_chapter(
                ch["chapter_number"],
                f"Ch{ch['chapter_number']} text",
                None,
                chapters,
                mode="lightweight",
            )

        # Verify all 6 chapters are in MEMORY.md before rewrite
        memory_before = tlm.get_memory()
        assert "Chapter 1" in memory_before
        assert "Chapter 6" in memory_before

        # 触发 threshold rewrite (chapter 6 is divisible by 3)
        svc.refresh_memory_after_chapter(6, "Ch6 final", None, chapters, mode="consolidated")

        memory = tlm.get_memory()
        # Should contain recent 3 chapters
        assert "Chapter 4" in memory
        assert "Chapter 5" in memory
        assert "Chapter 6" in memory
        # Should NOT contain old chapters in the Rolling Window section
        rolling_section = memory.split("## Unresolved")[0] if "## Unresolved" in memory else memory
        assert "### Chapter 1" not in rolling_section
        assert "### Chapter 2" not in rolling_section
        assert "### Chapter 3" not in rolling_section

    def test_threshold_rewrite_file_size_decreases(self, tmp_path):
        """压缩后文件大小应小于或等于压缩前"""
        svc, tlm, ms = _make_service(str(tmp_path))
        chapters = _make_chapters(6)

        # Add lots of content via lightweight mode
        for ch in chapters:
            svc.refresh_memory_after_chapter(
                ch["chapter_number"],
                f"Ch{ch['chapter_number']} " + "x" * 500,
                None,
                chapters,
                mode="lightweight",
            )

        memory_path = tlm.l2_dir / "MEMORY.md"
        pre_size = memory_path.stat().st_size

        # Trigger threshold rewrite
        svc.refresh_memory_after_chapter(6, "Ch6 final", None, chapters, mode="consolidated")

        post_size = memory_path.stat().st_size
        assert post_size <= pre_size, f"Post-rewrite size {post_size} should be <= pre-rewrite size {pre_size}"



class TestF5HeadingShiftRegex:
    """F5: Heading shift should match chapter headings with optional suffixes like (draft)."""

    def test_heading_shift_with_draft_suffix(self, tmp_path):
        """删除 chapter 2 后，'### Chapter 3 (draft)' 应变为 '### Chapter 2 (draft)'"""
        tlm = ThreeLayerMemory(str(tmp_path))
        memory_content = (
            "# MEMORY\n\n"
            "### Chapter 1\n- ok\n\n"
            "### Chapter 3 (draft)\n- draft\n\n"
            "### Chapter 4\n- ok\n"
        )
        tlm.update_memory(memory_content)
        tlm.shift_chapter_indices_after(2)
        result = tlm.get_memory()
        assert "### Chapter 2 (draft)" in result
        assert "### Chapter 3" in result  # was Chapter 4
        assert "### Chapter 3 (draft)" not in result

    def test_heading_shift_with_chinese_suffix(self, tmp_path):
        """删除 chapter 1 后，'### Chapter 2 (已完成)' 应变为 '### Chapter 1 (已完成)'"""
        tlm = ThreeLayerMemory(str(tmp_path))
        memory_content = (
            "# MEMORY\n\n"
            "### Chapter 2 (已完成)\n- done\n\n"
            "### Chapter 3\n- ok\n"
        )
        tlm.update_memory(memory_content)
        tlm.shift_chapter_indices_after(1)
        result = tlm.get_memory()
        assert "### Chapter 1 (已完成)" in result
        assert "### Chapter 2" in result  # was Chapter 3, no suffix
        assert "### Chapter 2 (已完成)" not in result

    def test_heading_shift_plain_headings_still_work(self, tmp_path):
        """Plain headings without suffixes should still shift correctly."""
        tlm = ThreeLayerMemory(str(tmp_path))
        memory_content = (
            "# MEMORY\n\n"
            "### Chapter 1\n- ok\n\n"
            "### Chapter 3\n- ok\n\n"
            "### Chapter 4\n- ok\n"
        )
        tlm.update_memory(memory_content)
        tlm.shift_chapter_indices_after(2)
        result = tlm.get_memory()
        assert "### Chapter 2\n" in result  # was Chapter 3
        assert "### Chapter 3\n" in result  # was Chapter 4



class TestF4SyncWeights:
    """F4: L2 sync weights should be differentiated by file type."""

    def test_sync_weights_memory_md(self, tmp_path):
        """MEMORY.md 同步后 importance=5, recency=5"""
        tlm = ThreeLayerMemory(str(tmp_path))
        ms = MemoryStore(str(tmp_path), str(tmp_path / "test.db"))
        ms.sync_file_memories()
        items = ms.get_all_items(Layer.L2)
        memory_items = [i for i in items if "MEMORY" in i.source_path and "OPEN_THREADS" not in i.source_path]
        assert len(memory_items) > 0, "Should have synced MEMORY.md"
        for item in memory_items:
            assert item.importance == 5, f"MEMORY.md importance should be 5, got {item.importance}"
            assert item.recency == 5, f"MEMORY.md recency should be 5, got {item.recency}"

    def test_sync_weights_open_threads(self, tmp_path):
        """OPEN_THREADS.md 同步后 importance=6, recency=6"""
        tlm = ThreeLayerMemory(str(tmp_path))
        ms = MemoryStore(str(tmp_path), str(tmp_path / "test.db"))
        ms.sync_file_memories()
        items = ms.get_all_items(Layer.L2)
        thread_items = [i for i in items if "OPEN_THREADS" in i.source_path]
        assert len(thread_items) > 0, "Should have synced OPEN_THREADS.md"
        for item in thread_items:
            assert item.importance == 6, f"OPEN_THREADS.md importance should be 6, got {item.importance}"
            assert item.recency == 6, f"OPEN_THREADS.md recency should be 6, got {item.recency}"

    def test_sync_weights_identity(self, tmp_path):
        """IDENTITY.md 同步后 importance=8, recency=4"""
        tlm = ThreeLayerMemory(str(tmp_path))
        ms = MemoryStore(str(tmp_path), str(tmp_path / "test.db"))
        ms.sync_file_memories()
        items = ms.get_all_items(Layer.L1)
        identity_items = [i for i in items if "IDENTITY" in i.source_path]
        assert len(identity_items) > 0, "Should have synced IDENTITY.md"
        for item in identity_items:
            assert item.importance == 8, f"IDENTITY.md importance should be 8, got {item.importance}"
            assert item.recency == 4, f"IDENTITY.md recency should be 4, got {item.recency}"

    def test_sync_weights_runtime_state(self, tmp_path):
        """RUNTIME_STATE.md 同步后 importance=7, recency=7"""
        tlm = ThreeLayerMemory(str(tmp_path))
        ms = MemoryStore(str(tmp_path), str(tmp_path / "test.db"))
        ms.sync_file_memories()
        items = ms.get_all_items(Layer.L1)
        rs_items = [i for i in items if "RUNTIME_STATE" in i.source_path]
        assert len(rs_items) > 0, "Should have synced RUNTIME_STATE.md"
        for item in rs_items:
            assert item.importance == 7, f"RUNTIME_STATE.md importance should be 7, got {item.importance}"
            assert item.recency == 7, f"RUNTIME_STATE.md recency should be 7, got {item.recency}"



class TestF6ResolvedThreadPruning:
    """F6: Resolved threads should be pruned to max 20 in OPEN_THREADS.md."""

    def test_resolved_threads_pruned_to_20(self, tmp_path):
        """30 个 resolved 线程写入后，文件只保留 20 个"""
        svc, tlm, ms = _make_service(str(tmp_path))
        threads = []
        for i in range(1, 31):
            threads.append({
                "source_chapter": i,
                "text": f"Thread {i}",
                "status": "resolved",
                "resolved_by_chapter": i + 1,
                "evidence": f"test {i}",
            })
        svc._write_open_threads_file(threads)
        content = (tlm.memory_dir / "OPEN_THREADS.md").read_text(encoding="utf-8")
        # Count resolved entries (they contain "→Ch.")
        resolved_count = content.count("→Ch.")
        assert resolved_count == 20, f"Expected 20 resolved threads, found {resolved_count}"

    def test_resolved_threads_keeps_most_recent(self, tmp_path):
        """保留的 20 个 resolved 线程应是最近的（按 resolved_by_chapter 降序）"""
        svc, tlm, ms = _make_service(str(tmp_path))
        threads = []
        for i in range(1, 31):
            threads.append({
                "source_chapter": i,
                "text": f"Thread-{i}-end",
                "status": "resolved",
                "resolved_by_chapter": i + 1,
                "evidence": f"test {i}",
            })
        svc._write_open_threads_file(threads)
        content = (tlm.memory_dir / "OPEN_THREADS.md").read_text(encoding="utf-8")
        # Thread 30 (resolved_by_chapter=31) should be kept (most recent)
        assert "Thread-30-end" in content
        # Thread 11 (resolved_by_chapter=12) should be kept (20th most recent)
        assert "Thread-11-end" in content
        # Thread 10 (resolved_by_chapter=11) should be pruned (21st, too old)
        assert "Thread-10-end" not in content
        # Thread 1 (resolved_by_chapter=2) should be pruned (oldest)
        assert "Thread-1-end" not in content

    def test_open_threads_not_affected_by_pruning(self, tmp_path):
        """Open threads should not be affected by resolved pruning."""
        svc, tlm, ms = _make_service(str(tmp_path))
        threads = []
        # 5 open threads
        for i in range(1, 6):
            threads.append({
                "source_chapter": i,
                "text": f"Open thread {i}",
                "status": "open",
                "resolved_by_chapter": None,
                "evidence": "",
            })
        # 25 resolved threads
        for i in range(1, 26):
            threads.append({
                "source_chapter": i,
                "text": f"Resolved thread {i}",
                "status": "resolved",
                "resolved_by_chapter": i + 1,
                "evidence": f"test {i}",
            })
        svc._write_open_threads_file(threads)
        content = (tlm.memory_dir / "OPEN_THREADS.md").read_text(encoding="utf-8")
        # All 5 open threads should be present
        for i in range(1, 6):
            assert f"Open thread {i}" in content
        # Only 20 resolved threads should be present
        resolved_count = content.count("→Ch.")
        assert resolved_count == 20



class TestF7LogRetention:
    """F7: Log files older than 30 days should be purged during sync."""

    def test_old_logs_purged(self, tmp_path):
        """超过 30 天的日志文件应被删除"""
        tlm = ThreeLayerMemory(str(tmp_path))
        ms = MemoryStore(str(tmp_path), str(tmp_path / "test.db"))

        # 创建一个 "旧" 日志文件
        old_log = tlm.logs_dir / "2025-12-01.md"
        old_log.write_text("old log", encoding="utf-8")
        old_time = time.time() - (31 * 86400)
        os.utime(old_log, (old_time, old_time))

        # 创建一个 "新" 日志文件
        new_log = tlm.logs_dir / "2026-02-20.md"
        new_log.write_text("new log", encoding="utf-8")

        ms.sync_file_memories()

        assert not old_log.exists(), "Old log should be purged"
        assert new_log.exists(), "New log should be kept"

    def test_purge_only_md_files(self, tmp_path):
        """Only .md files should be purged."""
        tlm = ThreeLayerMemory(str(tmp_path))
        ms = MemoryStore(str(tmp_path), str(tmp_path / "test.db"))

        # Create an old non-md file
        old_txt = tlm.logs_dir / "old.txt"
        old_txt.write_text("old txt", encoding="utf-8")
        old_time = time.time() - (31 * 86400)
        os.utime(old_txt, (old_time, old_time))

        ms.sync_file_memories()

        assert old_txt.exists(), "Non-md files should not be purged"



class TestF8MemoryInitTemplate:
    """F8: New project MEMORY.md should have structured sections."""

    def test_memory_init_template_structured(self, tmp_path):
        """新项目的 MEMORY.md 应包含结构化 sections"""
        tlm = ThreeLayerMemory(str(tmp_path))
        content = tlm.get_memory()
        assert "Rolling Window" in content
        assert "Unresolved Mainline Threads" in content
        assert "Recent Key Decisions" in content

    def test_memory_init_template_compatible_with_rewrite(self, tmp_path):
        """初始模板应与 _threshold_rewrite 的压缩格式兼容"""
        tlm = ThreeLayerMemory(str(tmp_path))
        content = tlm.get_memory()
        # Should have the same section headers that _threshold_rewrite produces
        assert "## Rolling Window" in content
        assert "## Unresolved Mainline Threads" in content
        assert "## Recent Key Decisions" in content
