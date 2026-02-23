#!/usr/bin/env python3
"""
Manual full L1/L2/L3 memory refresh for the "备份神谕" project.

Run from backend/:
    python3 scripts/refresh_memory.py
"""

import json
import os
import sys
from pathlib import Path

# ── ensure backend root is on sys.path so bare imports work ──
BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

from memory import ThreeLayerMemory, MemoryStore  # noqa: E402
from services.memory_context import MemoryContextService  # noqa: E402

# ── project paths (relative to backend/) ──
PROJECT_ID = "e1064023-e555-4ef0-bd4c-77358d3b6df4"
PROJECT_PATH = str(BACKEND_ROOT / ".." / "data" / "projects" / PROJECT_ID)
DB_PATH = os.path.join(PROJECT_PATH, "novelist.db")
CHAPTERS_DIR = os.path.join(PROJECT_PATH, "chapters")


def load_chapters() -> list[dict]:
    """Load all chapter JSON files, parse, and sort by chapter_number."""
    chapters = []
    for fname in os.listdir(CHAPTERS_DIR):
        if not fname.endswith(".json"):
            continue
        fpath = os.path.join(CHAPTERS_DIR, fname)
        with open(fpath, "r", encoding="utf-8") as f:
            ch = json.load(f)
        chapters.append(ch)
    chapters.sort(key=lambda c: c["chapter_number"])
    return chapters


def build_project_chapters(chapters: list[dict]) -> list[dict]:
    """Build the project_chapters list expected by refresh_memory_after_chapter."""
    result = []
    for ch in chapters:
        result.append({
            "chapter_number": ch["chapter_number"],
            "plan": ch.get("plan"),
            "draft": ch.get("draft"),
            "final": ch.get("final"),
            "title": ch.get("title", ""),
            "status": ch.get("status", ""),
            "word_count": ch.get("word_count", 0),
        })
    return result


def clear_old_l3_synopses(l3_dir: str) -> int:
    """Delete existing L3 .md files with type=chapter_synopsis to avoid duplicates."""
    import yaml

    l3_path = Path(l3_dir)
    removed = 0
    for md_file in list(l3_path.glob("*.md")):
        try:
            content = md_file.read_text(encoding="utf-8")
            if not content.startswith("---"):
                continue
            parts = content.split("---", 2)
            if len(parts) < 3:
                continue
            metadata = yaml.safe_load(parts[1]) or {}
            if metadata.get("type") == "chapter_synopsis":
                md_file.unlink()
                removed += 1
        except Exception as e:
            print(f"  ⚠ Error reading {md_file.name}: {e}")
    return removed


def main():
    print("=" * 60)
    print("  备份神谕 — Full Memory Refresh (L1/L2/L3)")
    print("=" * 60)
    print(f"Project: {PROJECT_ID}")
    print(f"Path:    {PROJECT_PATH}")
    print()

    # 1. Load chapters
    chapters = load_chapters()
    print(f"✓ Loaded {len(chapters)} chapters")

    # 2. Build project_chapters
    project_chapters = build_project_chapters(chapters)

    # 3. Create service instances
    three_layer = ThreeLayerMemory(PROJECT_PATH)
    memory_store = MemoryStore(PROJECT_PATH, DB_PATH)
    mem_ctx = MemoryContextService(three_layer, memory_store)
    print("✓ Memory services initialized")

    # 4. Clear old L3 chapter_synopsis items
    l3_dir = os.path.join(PROJECT_PATH, "memory", "L3")
    removed = clear_old_l3_synopses(l3_dir)
    print(f"✓ Cleared {removed} old chapter_synopsis L3 files")
    print()

    # 5. Iterate chapters and refresh
    total = len(chapters)
    for i, ch in enumerate(chapters, 1):
        ch_num = ch["chapter_number"]
        title = ch.get("title", "Untitled")
        chapter_text = ch.get("final") or ch.get("draft") or ""
        chapter_plan = ch.get("plan")

        result = mem_ctx.refresh_memory_after_chapter(
            chapter_number=ch_num,
            chapter_text=chapter_text,
            chapter_plan=chapter_plan,
            project_chapters=project_chapters,
            mode="consolidated",
        )
        threshold_info = ""
        if result.get("threshold_rewrite"):
            threshold_info = " (threshold rewrite triggered)"
        print(f"  [{i}/{total}] Chapter {ch_num}: {title} — done{threshold_info}")

    # 6. Final sync
    print()
    print("Running final sync_file_memories()...")
    memory_store.sync_file_memories()
    print("✓ Final sync complete")

    # 7. Summary
    print()
    print("=" * 60)
    print(f"  Summary: {total} chapters processed")
    print("=" * 60)

    # List generated memory files
    memory_dir = Path(PROJECT_PATH) / "memory"
    for layer in ["L1", "L2", "L3"]:
        layer_dir = memory_dir / layer
        if layer_dir.exists():
            files = sorted(layer_dir.glob("*"))
            print(f"\n{layer}/ ({len(files)} files):")
            for f in files:
                size = f.stat().st_size
                print(f"  {f.name}  ({size:,} bytes)")

    # OPEN_THREADS.md
    ot = memory_dir / "OPEN_THREADS.md"
    if ot.exists():
        print(f"\nOPEN_THREADS.md ({ot.stat().st_size:,} bytes)")

    print("\n✅ Done!")


if __name__ == "__main__":
    main()
