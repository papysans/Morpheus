#!/usr/bin/env python3
"""
一次性清理脚本：删除 L3 目录中重复的 chapter_summary / chapter_synopsis 文件。
对于同一章节同一类型，只保留 created_at 最新的那份。

用法:
  python scripts/dedup_l3.py --dry-run   # 预览要删除的文件
  python scripts/dedup_l3.py             # 实际删除
"""
import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

import yaml


def scan_and_dedup(projects_root: Path, dry_run: bool = True):
    chapter_pattern = re.compile(
        r"^Chapter\s+(\d+)\s+(summary|synopsis)$", re.IGNORECASE
    )
    total_deleted = 0

    for proj_dir in sorted(projects_root.iterdir()):
        l3_dir = proj_dir / "memory" / "L3"
        if not l3_dir.is_dir():
            continue

        # group: (chapter_number, item_type) -> [(created_at, file_path)]
        groups: dict[tuple[int, str], list[tuple[str, Path]]] = defaultdict(list)

        for md_file in l3_dir.glob("*.md"):
            try:
                content = md_file.read_text(encoding="utf-8")
            except Exception:
                continue
            if not content.startswith("---"):
                continue
            parts = content.split("---", 2)
            if len(parts) < 3:
                continue
            try:
                metadata = yaml.safe_load(parts[1]) or {}
            except Exception:
                continue

            item_type = str(metadata.get("type", "")).strip()
            summary = str(metadata.get("summary", "")).strip()
            created_at = str(metadata.get("created_at", "")).strip()

            m = chapter_pattern.match(summary)
            if not m:
                continue
            if item_type not in ("chapter_summary", "chapter_synopsis"):
                continue

            chapter_no = int(m.group(1))
            groups[(chapter_no, item_type)].append((created_at, md_file))

        # For each group, keep the newest, delete the rest
        proj_deleted = 0
        for key, items in sorted(groups.items()):
            if len(items) <= 1:
                continue
            # Sort by created_at descending, keep first
            items.sort(key=lambda x: x[0], reverse=True)
            keep = items[0]
            to_delete = items[1:]
            chapter_no, item_type = key
            print(f"\n  Chapter {chapter_no} {item_type}: {len(items)} copies")
            print(f"    KEEP: {keep[1].name} ({keep[0]})")
            for created_at, fpath in to_delete:
                print(f"    DELETE: {fpath.name} ({created_at})")
                if not dry_run:
                    fpath.unlink()
                proj_deleted += 1

        if proj_deleted > 0:
            print(f"\n  Project {proj_dir.name}: {'would delete' if dry_run else 'deleted'} {proj_deleted} files")
            total_deleted += proj_deleted

    action = "Would delete" if dry_run else "Deleted"
    print(f"\n{'='*60}")
    print(f"{action} {total_deleted} duplicate L3 files total.")
    if dry_run and total_deleted > 0:
        print("Run without --dry-run to actually delete.")


def main():
    parser = argparse.ArgumentParser(description="Deduplicate L3 memory files")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, don't delete")
    args = parser.parse_args()

    backend_root = Path(__file__).resolve().parent.parent
    projects_root = (backend_root / ".." / "data" / "projects").resolve()

    if not projects_root.is_dir():
        print(f"Projects root not found: {projects_root}")
        sys.exit(1)

    print(f"Scanning: {projects_root}")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE DELETE'}")
    print("=" * 60)

    scan_and_dedup(projects_root, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
