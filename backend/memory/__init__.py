import hashlib
import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import NAMESPACE_URL, uuid4, uuid5

import yaml

from models import EntityState, EventEdge, Layer, MemoryItem


class ThreeLayerMemory:
    def __init__(self, project_path: str):
        self.project_path = Path(project_path)
        self.memory_dir = self.project_path / "memory"
        self.l1_dir = self.memory_dir / "L1"
        self.l2_dir = self.memory_dir / "L2"
        self.l3_dir = self.memory_dir / "L3"
        self.logs_dir = self.project_path / "logs" / "daily"
        self._ensure_directories()

    def _ensure_directories(self):
        for directory in [self.l1_dir, self.l2_dir, self.l3_dir, self.logs_dir]:
            directory.mkdir(parents=True, exist_ok=True)

        identity_file = self.l1_dir / "IDENTITY.md"
        if not identity_file.exists():
            identity_file.write_text(
                "# IDENTITY\n\n"
                "## World Rules\n- (补充世界规则)\n\n"
                "## Character Hard Settings\n- (补充角色硬设定)\n\n"
                "## Style Contract\n- (补充写作风格约束)\n\n"
                "## Hard Taboos\n- (补充禁忌)\n",
                encoding="utf-8",
            )

        memory_file = self.l2_dir / "MEMORY.md"
        if not memory_file.exists():
            memory_file.write_text(
                "# MEMORY\n\n"
                "## Chapter Decisions\n\n"
                "## Pending Items\n\n"
                "## Temporary Clues\n\n",
                encoding="utf-8",
            )

    def get_identity(self) -> str:
        return (self.l1_dir / "IDENTITY.md").read_text(encoding="utf-8")

    def update_identity(self, content: str):
        (self.l1_dir / "IDENTITY.md").write_text(content, encoding="utf-8")

    def get_memory(self) -> str:
        return (self.l2_dir / "MEMORY.md").read_text(encoding="utf-8")

    def update_memory(self, content: str):
        (self.l2_dir / "MEMORY.md").write_text(content, encoding="utf-8")

    def add_log(self, content: str, log_name: Optional[str] = None):
        log_name = log_name or datetime.now().strftime("%Y-%m-%d")
        log_file = self.logs_dir / f"{log_name}.md"
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        existing = log_file.read_text(encoding="utf-8") if log_file.exists() else ""
        prefix = "\n\n" if existing.strip() else ""
        log_file.write_text(
            f"{existing}{prefix}## {timestamp}\n\n{content}\n",
            encoding="utf-8",
        )

    def add_l3_item(self, summary: str, content: str, item_type: str = "chapter_summary") -> str:
        item_id = str(uuid4())
        item_file = self.l3_dir / f"{item_id}.md"
        metadata = {
            "id": item_id,
            "type": item_type,
            "created_at": datetime.now().isoformat(),
            "summary": summary,
        }
        header = f"---\n{yaml.safe_dump(metadata, allow_unicode=True)}---\n\n"
        item_file.write_text(header + content, encoding="utf-8")
        return item_id

    def get_l3_items(self, item_type: Optional[str] = None) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        for file_path in sorted(self.l3_dir.glob("*.md")):
            content = file_path.read_text(encoding="utf-8")
            if not content.startswith("---"):
                continue
            parts = content.split("---", 2)
            if len(parts) < 3:
                continue
            metadata = yaml.safe_load(parts[1]) or {}
            entry = {
                "id": metadata.get("id", file_path.stem),
                "type": metadata.get("type", "unknown"),
                "summary": metadata.get("summary", ""),
                "content": parts[2].strip(),
                "created_at": metadata.get("created_at", ""),
            }
            items.append(entry)

        if item_type:
            items = [item for item in items if item.get("type") == item_type]
        return items

    def reflect(self, chapter_content: str, chapter_id: int) -> Dict[str, List[str]]:
        summary = chapter_content[:500].strip()
        if len(chapter_content) > 500:
            summary += "..."

        retains = [f"Chapter {chapter_id} 关键摘要已固化到 L3。"]
        downgrades = []
        new_facts = [
            f"Chapter {chapter_id} 完稿时间 {datetime.now().isoformat()}",
            f"Chapter {chapter_id} 正文字数 {len(chapter_content)}",
        ]

        self.add_l3_item(
            summary=f"Chapter {chapter_id} summary",
            content=chapter_content,
            item_type="chapter_summary",
        )

        memory = self.get_memory()
        memory += (
            f"\n### Chapter {chapter_id}\n"
            f"- 状态: 已完成\n"
            f"- 字数: {len(chapter_content)}\n"
            f"- 更新时间: {datetime.now().isoformat()}\n"
        )
        self.update_memory(memory)

        return {"retains": retains, "downgrades": downgrades, "new_facts": new_facts}


class MemoryStore:
    def __init__(self, project_path: str, db_path: str):
        self.project_path = Path(project_path)
        self.db_path = Path(db_path)
        self.three_layer = ThreeLayerMemory(project_path)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            conn = sqlite3.connect(self.db_path, timeout=10.0)
        except sqlite3.OperationalError as exc:
            raise sqlite3.OperationalError(f"{exc} (db_path={self.db_path})") from exc
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    @contextmanager
    def _connection(self):
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as conn:
            cursor = conn.cursor()

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS memory_items (
                    id TEXT PRIMARY KEY,
                    layer TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    content TEXT NOT NULL,
                    entities TEXT,
                    time_span TEXT,
                    importance INTEGER DEFAULT 5,
                    recency INTEGER DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    metadata TEXT
                )
                """
            )
            cursor.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
                    summary, content, content='memory_items', content_rowid='rowid'
                )
                """
            )
            cursor.execute(
                """
                CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
                  INSERT INTO memory_fts(rowid, summary, content) VALUES (new.rowid, new.summary, new.content);
                END;
                """
            )
            cursor.execute(
                """
                CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
                  INSERT INTO memory_fts(memory_fts, rowid, summary, content) VALUES('delete', old.rowid, old.summary, old.content);
                END;
                """
            )
            cursor.execute(
                """
                CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
                  INSERT INTO memory_fts(memory_fts, rowid, summary, content) VALUES('delete', old.rowid, old.summary, old.content);
                  INSERT INTO memory_fts(rowid, summary, content) VALUES (new.rowid, new.summary, new.content);
                END;
                """
            )

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS entities (
                    entity_id TEXT PRIMARY KEY,
                    entity_type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    attrs TEXT,
                    constraints TEXT,
                    first_seen_chapter INTEGER DEFAULT 0,
                    last_seen_chapter INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS events (
                    event_id TEXT PRIMARY KEY,
                    subject TEXT NOT NULL,
                    relation TEXT NOT NULL,
                    object TEXT,
                    chapter INTEGER NOT NULL,
                    timestamp TEXT,
                    confidence REAL DEFAULT 1.0,
                    description TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def _file_item_id(self, source_path: Path) -> str:
        normalized = source_path.resolve().as_posix()
        return str(uuid5(NAMESPACE_URL, normalized))

    def add_memory_item(self, item: MemoryItem):
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO memory_items
                (id, layer, source_path, summary, content, entities, time_span,
                 importance, recency, created_at, updated_at, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.id,
                    item.layer.value,
                    item.source_path,
                    item.summary,
                    item.content,
                    json.dumps(item.entities, ensure_ascii=False),
                    json.dumps(item.time_span, ensure_ascii=False) if item.time_span else None,
                    item.importance,
                    item.recency,
                    item.created_at.isoformat(),
                    item.updated_at.isoformat(),
                    json.dumps(item.metadata, ensure_ascii=False),
                ),
            )
            conn.commit()

    def _extract_search_terms(self, query: str, limit: int = 12) -> List[str]:
        raw = str(query or "").strip()
        if not raw:
            return []

        terms = [term.strip() for term in raw.split() if term.strip()]
        if len(terms) <= 1:
            # Chinese prompts often have no whitespace; split by punctuation and
            # further chunk long fragments so FTS can match meaningful pieces.
            fragments = [frag.strip() for frag in re.split(r"[^\w\u4e00-\u9fff]+", raw) if frag.strip()]
            expanded: List[str] = []
            for frag in fragments:
                if len(frag) <= 8:
                    expanded.append(frag)
                    continue

                pieces = [p for p in re.split(r"[的了和与在并及且将被把对从向为是有再又都而并且]", frag) if p]
                if pieces:
                    expanded.extend(piece[:8] for piece in pieces if len(piece) >= 2)
                    continue

                # Last resort: chunk to short windows to avoid a single giant token.
                expanded.extend(frag[idx : idx + 6] for idx in range(0, min(len(frag), 30), 6))

            terms.extend(expanded)

        deduped: List[str] = []
        for term in terms:
            cleaned = term.strip()
            if len(cleaned) < 2:
                continue
            if cleaned in deduped:
                continue
            deduped.append(cleaned)
            if len(deduped) >= 12:
                break

        return deduped[: max(limit, 1)]

    def _fts_query(self, query: str) -> str:
        terms = self._extract_search_terms(query)
        if not terms:
            return '""'
        return " OR ".join(f'"{term}"' for term in terms)

    def _search_like_terms(self, cursor: sqlite3.Cursor, query: str, top_k: int):
        terms = self._extract_search_terms(query)
        if not terms:
            terms = [str(query or "").strip()]
        terms = [term for term in terms if term]
        if not terms:
            return []

        where = " OR ".join("(summary LIKE ? OR content LIKE ?)" for _ in terms)
        params: List[Any] = []
        for term in terms:
            like_term = f"%{term}%"
            params.extend([like_term, like_term])
        params.append(top_k)
        cursor.execute(
            f"""
            SELECT id, layer, source_path, summary, content, 0.0 AS score, '' AS evidence
            FROM memory_items
            WHERE {where}
            LIMIT ?
            """,
            params,
        )
        return cursor.fetchall()

    def search_fts(self, query: str, top_k: int = 30) -> List[Dict[str, Any]]:
        with self._connection() as conn:
            cursor = conn.cursor()
            sql = """
                SELECT
                    m.id,
                    m.layer,
                    m.source_path,
                    m.summary,
                    m.content,
                    bm25(memory_fts) AS score,
                    snippet(memory_fts, 1, '[[H]]', '[[/H]]', ' ... ', 24) AS evidence
                FROM memory_fts
                JOIN memory_items m ON m.rowid = memory_fts.rowid
                WHERE memory_fts MATCH ?
                ORDER BY score
                LIMIT ?
            """
            try:
                cursor.execute(sql, (self._fts_query(query), top_k))
                rows = cursor.fetchall()
                if not rows:
                    rows = self._search_like_terms(cursor, query, top_k)
            except sqlite3.OperationalError:
                rows = self._search_like_terms(cursor, query, top_k)

            results: List[Dict[str, Any]] = []
            for row in rows:
                results.append(
                    {
                        "item_id": row["id"],
                        "layer": row["layer"],
                        "source_path": row["source_path"],
                        "summary": row["summary"],
                        "content": row["content"],
                        "score": float(abs(row["score"])) if row["score"] is not None else 0.0,
                        "evidence": row["evidence"] or "",
                    }
                )
            return results

    def get_all_items(self, layer: Optional[Layer] = None) -> List[MemoryItem]:
        with self._connection() as conn:
            cursor = conn.cursor()
            if layer:
                cursor.execute("SELECT * FROM memory_items WHERE layer = ?", (layer.value,))
            else:
                cursor.execute("SELECT * FROM memory_items")

            items: List[MemoryItem] = []
            for row in cursor.fetchall():
                items.append(
                    MemoryItem(
                        id=row["id"],
                        layer=Layer(row["layer"]),
                        source_path=row["source_path"],
                        summary=row["summary"],
                        content=row["content"],
                        entities=json.loads(row["entities"]) if row["entities"] else [],
                        time_span=json.loads(row["time_span"]) if row["time_span"] else None,
                        importance=row["importance"],
                        recency=row["recency"],
                        created_at=datetime.fromisoformat(row["created_at"]),
                        updated_at=datetime.fromisoformat(row["updated_at"]),
                        metadata=json.loads(row["metadata"]) if row["metadata"] else {},
                    )
                )
            return items

    def add_entity(self, entity: EntityState):
        entity.updated_at = datetime.now()
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO entities
                (entity_id, entity_type, name, attrs, constraints,
                 first_seen_chapter, last_seen_chapter, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entity.entity_id,
                    entity.entity_type,
                    entity.name,
                    json.dumps(entity.attrs, ensure_ascii=False),
                    json.dumps(entity.constraints, ensure_ascii=False),
                    entity.first_seen_chapter,
                    entity.last_seen_chapter,
                    entity.created_at.isoformat(),
                    entity.updated_at.isoformat(),
                ),
            )
            conn.commit()

    def get_entity(self, entity_id: str) -> Optional[EntityState]:
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM entities WHERE entity_id = ?", (entity_id,))
            row = cursor.fetchone()
            if not row:
                return None
            return EntityState(
                entity_id=row["entity_id"],
                entity_type=row["entity_type"],
                name=row["name"],
                attrs=json.loads(row["attrs"]) if row["attrs"] else {},
                constraints=json.loads(row["constraints"]) if row["constraints"] else [],
                first_seen_chapter=row["first_seen_chapter"],
                last_seen_chapter=row["last_seen_chapter"],
                created_at=datetime.fromisoformat(row["created_at"]),
                updated_at=datetime.fromisoformat(row["updated_at"]),
            )

    def get_all_entities(self) -> List[EntityState]:
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM entities ORDER BY last_seen_chapter DESC, name ASC")
            entities: List[EntityState] = []
            for row in cursor.fetchall():
                entities.append(
                    EntityState(
                        entity_id=row["entity_id"],
                        entity_type=row["entity_type"],
                        name=row["name"],
                        attrs=json.loads(row["attrs"]) if row["attrs"] else {},
                        constraints=json.loads(row["constraints"]) if row["constraints"] else [],
                        first_seen_chapter=row["first_seen_chapter"],
                        last_seen_chapter=row["last_seen_chapter"],
                        created_at=datetime.fromisoformat(row["created_at"]),
                        updated_at=datetime.fromisoformat(row["updated_at"]),
                    )
                )
            return entities

    def add_event(self, event: EventEdge):
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO events
                (event_id, subject, relation, object, chapter, timestamp,
                 confidence, description, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event.event_id,
                    event.subject,
                    event.relation,
                    event.object,
                    event.chapter,
                    event.timestamp.isoformat() if event.timestamp else None,
                    event.confidence,
                    event.description,
                    event.created_at.isoformat(),
                ),
            )
            conn.commit()

    def get_events(self, subject: Optional[str] = None, chapter: Optional[int] = None) -> List[EventEdge]:
        with self._connection() as conn:
            cursor = conn.cursor()
            query = "SELECT * FROM events WHERE 1=1"
            params: List[Any] = []

            if subject:
                query += " AND subject = ?"
                params.append(subject)
            if chapter is not None:
                query += " AND chapter = ?"
                params.append(chapter)

            query += " ORDER BY chapter ASC, created_at ASC"
            cursor.execute(query, params)

            events: List[EventEdge] = []
            for row in cursor.fetchall():
                events.append(
                    EventEdge(
                        event_id=row["event_id"],
                        subject=row["subject"],
                        relation=row["relation"],
                        object=row["object"],
                        chapter=row["chapter"],
                        timestamp=datetime.fromisoformat(row["timestamp"]) if row["timestamp"] else None,
                        confidence=row["confidence"],
                        description=row["description"] or "",
                        created_at=datetime.fromisoformat(row["created_at"]),
                    )
                )
            return events

    def get_all_events(self) -> List[EventEdge]:
        return self.get_events()

    def delete_events_for_chapter(self, chapter: int):
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM events WHERE chapter = ?", (chapter,))
            conn.commit()

    def _count_rows(self, table: str) -> int:
        sql = f"SELECT COUNT(*) AS total FROM {table}"
        try:
            with self._connection() as conn:
                cursor = conn.cursor()
                cursor.execute(sql)
                row = cursor.fetchone()
                return int(row["total"] if row and row["total"] is not None else 0)
        except sqlite3.OperationalError as exc:
            if "no such table" not in str(exc).lower():
                raise
            # Self-heal older/broken DB files that miss required schema tables.
            self._init_db()
            with self._connection() as conn:
                cursor = conn.cursor()
                cursor.execute(sql)
                row = cursor.fetchone()
                return int(row["total"] if row and row["total"] is not None else 0)

    def get_entity_count(self) -> int:
        return self._count_rows("entities")

    def get_event_count(self) -> int:
        return self._count_rows("events")

    def sync_file_memories(self):
        now = datetime.now()
        source_files: List[tuple[Layer, Path]] = [
            (Layer.L1, self.three_layer.l1_dir / "IDENTITY.md"),
            (Layer.L2, self.three_layer.l2_dir / "MEMORY.md"),
        ]

        source_files.extend((Layer.L2, path) for path in sorted(self.three_layer.logs_dir.glob("*.md"))[-30:])
        source_files.extend((Layer.L3, path) for path in sorted(self.three_layer.l3_dir.glob("*.md"))[-200:])

        for layer, file_path in source_files:
            if not file_path.exists():
                continue
            content = file_path.read_text(encoding="utf-8").strip()
            if not content:
                continue
            summary_seed = content.splitlines()[0] if content.splitlines() else file_path.name
            # L3 items use frontmatter; prefer its human-readable summary field.
            if layer == Layer.L3 and content.startswith("---"):
                try:
                    parts = content.split("---", 2)
                    if len(parts) >= 3:
                        metadata = yaml.safe_load(parts[1]) or {}
                        summary_seed = str(
                            metadata.get("summary")
                            or metadata.get("type")
                            or file_path.stem
                        )
                except Exception:
                    pass
            digest = hashlib.sha1(content.encode("utf-8")).hexdigest()[:10]
            item = MemoryItem(
                id=self._file_item_id(file_path),
                layer=layer,
                source_path=str(file_path.relative_to(self.project_path)),
                summary=f"{summary_seed[:80]} [{digest}]",
                content=content,
                entities=[],
                time_span=None,
                importance=8 if layer == Layer.L1 else (6 if layer == Layer.L3 else 5),
                recency=8 if layer == Layer.L2 else (6 if layer == Layer.L3 else 4),
                created_at=now,
                updated_at=now,
                metadata={"synced_from_file": True},
            )
            self.add_memory_item(item)
