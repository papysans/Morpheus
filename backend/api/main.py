import json
import hashlib
import shutil
import asyncio
import re
import time
import logging
import os
import inspect
import tempfile
from enum import Enum
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from uuid import uuid4, uuid5, NAMESPACE_URL

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from agents.studio import AGENT_PROMPTS, AgentStudio, StudioWorkflow
from memory import MemoryStore
from memory.search import EmbeddingProvider, HybridSearchEngine, VectorStore
from models import (
    AgentDecision,
    AgentRole,
    AgentTrace,
    Chapter,
    ChapterPlan,
    ChapterStatus,
    Conflict,
    EntityState,
    EventEdge,
    Layer,
    MemoryItem,
    Metrics,
    Project,
    ProjectStatus,
    ReviewAction,
)
from services.consistency import ConsistencyEngine

BACKEND_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    data_dir: str = "../data"

    llm_provider: str = "minimax"
    remote_llm_enabled: bool = False
    openai_api_key: Optional[str] = None
    openai_model: str = "gpt-4-turbo-preview"
    minimax_api_key: Optional[str] = None
    minimax_model: str = "MiniMax-M2.5"

    embedding_model: str = "embo-01"
    embedding_dimension: int = 1024
    remote_embedding_enabled: bool = False
    fts_top_k: int = 30
    vector_top_k: int = 20
    hybrid_top_k: int = 30
    log_level: str = "INFO"
    enable_http_logging: bool = True
    log_file: Optional[str] = None

    model_config = SettingsConfigDict(
        extra="ignore",
        env_file=str(BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8",
    )


settings = Settings()
app = FastAPI(title="Morpheus API", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("novelist.api")
if settings.log_file:
    log_path = Path(settings.log_file).expanduser().resolve()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if not any(
        isinstance(handler, logging.FileHandler) and getattr(handler, "baseFilename", None) == str(log_path)
        for handler in logger.handlers
    ):
        file_handler = logging.FileHandler(log_path, encoding="utf-8")
        file_handler.setLevel(getattr(logging, settings.log_level.upper(), logging.INFO))
        file_handler.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s"))
        logger.addHandler(file_handler)
        logger.info("file logging enabled path=%s", log_path)

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _normalize_provider(provider: str) -> str:
    candidate = (provider or "openai").strip().lower()
    if candidate not in {"openai", "minimax"}:
        logger.warning("invalid llm provider configured=%s fallback=openai", provider)
        return "openai"
    return candidate


def resolve_llm_runtime() -> Dict[str, Any]:
    requested_provider = _normalize_provider(settings.llm_provider)
    openai_key = (settings.openai_api_key or "").strip()
    minimax_key = (settings.minimax_api_key or "").strip()
    has_openai_key = bool(openai_key)
    has_minimax_key = bool(minimax_key)

    remote_requested = settings.remote_llm_enabled
    remote_env_raw = os.getenv("REMOTE_LLM_ENABLED")
    auto_enabled = False
    remote_effective = remote_requested
    if remote_env_raw is None and not remote_requested and (has_openai_key or has_minimax_key):
        # Auto-enable remote mode if keys are present and REMOTE_LLM_ENABLED was not explicitly set.
        remote_effective = True
        auto_enabled = True

    effective_provider = requested_provider
    provider_switch_reason = "configured"
    if requested_provider == "minimax" and not has_minimax_key and has_openai_key:
        effective_provider = "openai"
        provider_switch_reason = "switched_to_openai_missing_minimax_key"
    elif requested_provider == "openai" and not has_openai_key and has_minimax_key:
        effective_provider = "minimax"
        provider_switch_reason = "switched_to_minimax_missing_openai_key"

    if effective_provider == "minimax":
        provider_key = minimax_key
        effective_model = settings.minimax_model
    else:
        provider_key = openai_key
        effective_model = settings.openai_model

    remote_ready = remote_effective and bool(provider_key)
    return {
        "requested_provider": requested_provider,
        "effective_provider": effective_provider,
        "provider_switch_reason": provider_switch_reason,
        "effective_model": effective_model,
        "provider_key": provider_key,
        "remote_requested": remote_requested,
        "remote_effective": remote_effective,
        "remote_ready": remote_ready,
        "remote_auto_enabled": auto_enabled,
        "has_openai_key": has_openai_key,
        "has_minimax_key": has_minimax_key,
    }

projects: Dict[str, Project] = {}
chapters: Dict[str, Chapter] = {}
memory_stores: Dict[str, MemoryStore] = {}
studios: Dict[str, AgentStudio] = {}
traces: Dict[str, AgentTrace] = {}
metrics_history: List[Metrics] = []
vector_index_signatures: Dict[str, str] = {}

llm_runtime = resolve_llm_runtime()
logger.info(
    "llm runtime requested_provider=%s effective_provider=%s model=%s remote_requested=%s remote_effective=%s remote_ready=%s auto_enabled=%s keys(openai=%s,minimax=%s)",
    llm_runtime["requested_provider"],
    llm_runtime["effective_provider"],
    llm_runtime["effective_model"],
    llm_runtime["remote_requested"],
    llm_runtime["remote_effective"],
    llm_runtime["remote_ready"],
    llm_runtime["remote_auto_enabled"],
    llm_runtime["has_openai_key"],
    llm_runtime["has_minimax_key"],
)
if llm_runtime["provider_switch_reason"] != "configured":
    logger.warning(
        "llm provider switched reason=%s requested=%s effective=%s",
        llm_runtime["provider_switch_reason"],
        llm_runtime["requested_provider"],
        llm_runtime["effective_provider"],
    )
if llm_runtime["remote_effective"] and not llm_runtime["remote_ready"]:
    logger.warning(
        "remote llm requested/effective but no matching api key; falling back to offline outputs"
    )


@app.middleware("http")
async def http_access_log_middleware(request: Request, call_next):
    if not settings.enable_http_logging:
        return await call_next(request)

    request_id = uuid4().hex[:8]
    started = time.perf_counter()
    logger.info(
        "REQ start id=%s method=%s path=%s query=%s",
        request_id,
        request.method,
        request.url.path,
        request.url.query or "-",
    )
    try:
        response = await call_next(request)
    except Exception:
        elapsed = (time.perf_counter() - started) * 1000
        logger.exception("REQ failed id=%s duration_ms=%.2f", request_id, elapsed)
        raise

    elapsed = (time.perf_counter() - started) * 1000
    response.headers["X-Request-ID"] = request_id
    logger.info(
        "REQ end id=%s status=%s duration_ms=%.2f",
        request_id,
        response.status_code,
        elapsed,
    )
    return response


def data_root() -> Path:
    return Path(settings.data_dir).resolve()


def projects_root() -> Path:
    root = data_root() / "projects"
    root.mkdir(parents=True, exist_ok=True)
    return root


def project_path(project_id: str) -> Path:
    path = projects_root() / project_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def project_file(project_id: str) -> Path:
    return project_path(project_id) / "project.json"


def chapter_file(project_id: str, chapter_id: str) -> Path:
    chapter_dir = project_path(project_id) / "chapters"
    chapter_dir.mkdir(parents=True, exist_ok=True)
    return chapter_dir / f"{chapter_id}.json"


def trace_file(project_id: str, chapter_id: str) -> Path:
    trace_dir = project_path(project_id) / "traces"
    trace_dir.mkdir(parents=True, exist_ok=True)
    return trace_dir / f"{chapter_id}.json"


def save_project(project: Project):
    project_file(project.id).write_text(
        json.dumps(project.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def save_chapter(chapter: Chapter):
    chapter.updated_at = datetime.now()
    chapter_file(chapter.project_id, chapter.id).write_text(
        json.dumps(chapter.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def save_trace(project_id: str, chapter_id: str, trace: AgentTrace):
    trace_file(project_id, chapter_id).write_text(
        json.dumps(trace.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def cleanup_export_file(zip_path: str, temp_dir: str):
    try:
        path = Path(zip_path)
        if path.exists():
            path.unlink()
    except Exception:
        logger.exception("export cleanup failed zip_path=%s", zip_path)
    try:
        dir_path = Path(temp_dir)
        if dir_path.exists():
            shutil.rmtree(dir_path, ignore_errors=True)
    except Exception:
        logger.exception("export cleanup failed temp_dir=%s", temp_dir)


def purge_project_state(project_id: str):
    global metrics_history
    projects.pop(project_id, None)
    memory_stores.pop(project_id, None)
    studios.pop(project_id, None)
    vector_index_signatures.pop(project_id, None)

    chapter_ids = [chapter_id for chapter_id, chapter in chapters.items() if chapter.project_id == project_id]
    for chapter_id in chapter_ids:
        chapters.pop(chapter_id, None)
        traces.pop(chapter_id, None)

    metrics_history = [metric for metric in metrics_history if metric.project_id != project_id]


def bootstrap_state():
    for project_dir in projects_root().glob("*"):
        if not project_dir.is_dir():
            continue
        pf = project_dir / "project.json"
        if not pf.exists():
            continue
        try:
            project_data = json.loads(pf.read_text(encoding="utf-8"))
            project = Project.model_validate(project_data)
            projects[project.id] = project
        except Exception:
            continue

        chapter_dir = project_dir / "chapters"
        if chapter_dir.exists():
            for file in chapter_dir.glob("*.json"):
                try:
                    chapter_data = json.loads(file.read_text(encoding="utf-8"))
                    chapter = Chapter.model_validate(chapter_data)
                    chapters[chapter.id] = chapter
                except Exception:
                    continue

        trace_dir = project_dir / "traces"
        if trace_dir.exists():
            for file in trace_dir.glob("*.json"):
                try:
                    trace_data = json.loads(file.read_text(encoding="utf-8"))
                    chapter_id = file.stem
                    traces[chapter_id] = AgentTrace.model_validate(trace_data)
                except Exception:
                    continue

    logger.info(
        "bootstrap complete projects=%d chapters=%d traces=%d",
        len(projects),
        len(chapters),
        len(traces),
    )


def get_or_create_store(project_id: str) -> MemoryStore:
    if project_id not in memory_stores:
        path = project_path(project_id)
        memory_stores[project_id] = MemoryStore(str(path), str(path / "novelist.db"))
        logger.info("memory store initialized project_id=%s db=%s", project_id, path / "novelist.db")
    return memory_stores[project_id]


def get_project_graph_counts(project_id: str) -> tuple[int, int]:
    try:
        store = get_or_create_store(project_id)
        entities = store.get_all_entities()
        events = store.get_all_events()
        return len(entities), len(events)
    except Exception as exc:
        # Keep project listing available even if one project's DB is broken/missing.
        logger.warning(
            "project graph count fallback project_id=%s error=%s",
            project_id,
            exc,
        )
        logger.exception("project graph count failed project_id=%s", project_id)
        memory_stores.pop(project_id, None)
        return 0, 0


def inspect_project_health(project: Project) -> Dict[str, Any]:
    project_dir = projects_root() / project.id
    project_json_path = project_dir / "project.json"
    chapter_dir = project_dir / "chapters"
    trace_dir = project_dir / "traces"
    db_path = project_dir / "novelist.db"

    issues: List[str] = []
    project_json_valid = False
    project_json_id: Optional[str] = None

    if not project_dir.exists():
        issues.append("missing_project_dir")
    if not project_json_path.exists():
        issues.append("missing_project_json")
    else:
        try:
            project_payload = json.loads(project_json_path.read_text(encoding="utf-8"))
            project_json_valid = True
            project_json_id = str(project_payload.get("id") or "")
            if project_json_id != project.id:
                issues.append("project_json_id_mismatch")
        except Exception:
            issues.append("invalid_project_json")

    db_ok = False
    db_error: Optional[str] = None
    try:
        store = get_or_create_store(project.id)
        _ = store.get_all_entities()
        _ = store.get_all_events()
        db_ok = True
    except Exception as exc:
        db_error = str(exc)
        issues.append("db_unavailable")
        memory_stores.pop(project.id, None)

    chapter_file_count = len(list(chapter_dir.glob("*.json"))) if chapter_dir.exists() else 0
    trace_file_count = len(list(trace_dir.glob("*.json"))) if trace_dir.exists() else 0

    return {
        "project_id": project.id,
        "project_name": project.name,
        "healthy": len(issues) == 0,
        "issues": issues,
        "project_dir": str(project_dir),
        "project_dir_exists": project_dir.exists(),
        "project_json_path": str(project_json_path),
        "project_json_valid": project_json_valid,
        "project_json_id": project_json_id,
        "db_path": str(db_path),
        "db_exists": db_path.exists(),
        "db_ok": db_ok,
        "db_error": db_error,
        "chapter_file_count": chapter_file_count,
        "trace_file_count": trace_file_count,
        "store_cached": project.id in memory_stores,
    }


def repair_project_storage(project: Project, dry_run: bool = False) -> Dict[str, Any]:
    actions: List[str] = []
    errors: List[str] = []
    project_dir = projects_root() / project.id

    if not project_dir.exists():
        actions.append("create_project_dir")
        if not dry_run:
            project_dir.mkdir(parents=True, exist_ok=True)

    project_json_path = project_dir / "project.json"
    should_rewrite_project_json = True
    if project_json_path.exists():
        try:
            payload = json.loads(project_json_path.read_text(encoding="utf-8"))
            if str(payload.get("id") or "") == project.id:
                should_rewrite_project_json = False
        except Exception:
            should_rewrite_project_json = True
    if should_rewrite_project_json:
        actions.append("rewrite_project_json")
        if not dry_run:
            save_project(project)

    for folder_name in ("chapters", "traces", "logs/daily", "memory"):
        path = project_dir / folder_name
        if not path.exists():
            actions.append(f"create_{folder_name.replace('/', '_')}")
            if not dry_run:
                path.mkdir(parents=True, exist_ok=True)

    if project.id in memory_stores:
        actions.append("evict_memory_store_cache")
        if not dry_run:
            memory_stores.pop(project.id, None)

    actions.append("rebuild_memory_store")
    if not dry_run:
        try:
            store = get_or_create_store(project.id)
            _ = store.get_all_entities()
            _ = store.get_all_events()
        except Exception as exc:
            errors.append(str(exc))
            memory_stores.pop(project.id, None)

    health = inspect_project_health(project)
    return {
        "project_id": project.id,
        "project_name": project.name,
        "actions": actions,
        "errors": errors,
        "healthy_after": bool(health.get("healthy")),
        "health": health,
    }


def get_or_create_studio(project_id: str) -> AgentStudio:
    if project_id not in studios:
        runtime = resolve_llm_runtime()
        provider_key = runtime["provider_key"] if runtime["remote_effective"] else ""
        studios[project_id] = AgentStudio(
            provider=runtime["effective_provider"],
            model=runtime["effective_model"],
            api_key=provider_key,
        )
        logger.info(
            "studio initialized project_id=%s requested_provider=%s effective_provider=%s model=%s remote_requested=%s remote_effective=%s remote_ready=%s auto_enabled=%s",
            project_id,
            runtime["requested_provider"],
            runtime["effective_provider"],
            runtime["effective_model"],
            runtime["remote_requested"],
            runtime["remote_effective"],
            runtime["remote_ready"],
            runtime["remote_auto_enabled"],
        )
        if runtime["provider_switch_reason"] != "configured":
            logger.warning(
                "studio provider switched project_id=%s reason=%s",
                project_id,
                runtime["provider_switch_reason"],
            )
        if runtime["remote_effective"] and not runtime["remote_ready"]:
            logger.warning(
                "studio remote llm not ready project_id=%s reason=no_matching_api_key",
                project_id,
            )
    return studios[project_id]


def chapter_list(project_id: str) -> List[Chapter]:
    return sorted(
        [chapter for chapter in chapters.values() if chapter.project_id == project_id],
        key=lambda ch: ch.chapter_number,
    )


def collect_project_metrics(project_id: Optional[str] = None) -> Dict[str, Any]:
    selected = metrics_history
    if project_id:
        selected = [m for m in metrics_history if m.project_id == project_id]
    if not selected:
        return {
            "chapter_generation_time": 0,
            "search_time": 0,
            "conflicts_per_chapter": 0,
            "p0_ratio": 0,
            "first_pass_rate": 0,
            "exemption_rate": 0,
            "recall_hit_rate": 0,
        }
    total = len(selected)
    return {
        "chapter_generation_time": sum(m.chapter_generation_time for m in selected) / total,
        "search_time": sum(m.search_time for m in selected) / total,
        "conflicts_per_chapter": sum(m.conflicts_per_chapter for m in selected) / total,
        "p0_ratio": sum(m.p0_ratio for m in selected) / total,
        "first_pass_rate": sum(m.first_pass_rate for m in selected) / total,
        "exemption_rate": sum(m.exemption_rate for m in selected) / total,
        "recall_hit_rate": sum(m.recall_hit_rate for m in selected) / total,
    }


def write_metric(metric: Metrics):
    metrics_history.append(metric)


def build_memory_signature(items: List[MemoryItem]) -> str:
    digest_source = "|".join(f"{item.id}:{item.updated_at.isoformat()}" for item in items)
    return hashlib.sha1(digest_source.encode("utf-8")).hexdigest()


def upsert_graph_from_chapter(store: MemoryStore, chapter: Chapter):
    if not chapter.draft:
        return
    now = datetime.now()

    role_names = list((chapter.plan.role_goals or {}).keys()) if chapter.plan else []
    if not role_names:
        role_names = ["主角"]

    for name in role_names[:10]:
        entity_id = str(uuid5(NAMESPACE_URL, f"{chapter.project_id}:character:{name}"))
        existing = store.get_entity(entity_id)
        first_seen = chapter.chapter_number
        created_at = now
        if existing:
            first_seen = existing.first_seen_chapter
            created_at = existing.created_at
        store.add_entity(
            EntityState(
                entity_id=entity_id,
                entity_type="character",
                name=name,
                attrs={"is_dead": False},
                constraints=[],
                first_seen_chapter=first_seen,
                last_seen_chapter=chapter.chapter_number,
                created_at=created_at,
                updated_at=now,
            )
        )

    draft = chapter.draft
    subject = role_names[0]
    conflict_markers = ["对抗", "背叛", "冲突", "追击", "谈判"]
    relation = "progress"
    for marker in conflict_markers:
        if marker in draft:
            relation = marker
            break
    event = EventEdge(
        event_id=str(uuid5(NAMESPACE_URL, f"{chapter.id}:{relation}:{chapter.chapter_number}")),
        subject=subject,
        relation=relation,
        object=role_names[1] if len(role_names) > 1 else None,
        chapter=chapter.chapter_number,
        timestamp=now,
        confidence=0.6,
        description=summarize_event_description(draft),
    )
    store.add_event(event)


def summarize_event_description(text: str, max_len: int = 140) -> str:
    compact = " ".join((text or "").split()).strip()
    if not compact:
        return ""
    if "离线模式输出" in compact or "请基于以下上下文继续创作并补全结构化内容" in compact:
        return "离线草稿事件摘要：需在联机模型下生成完整事件描述。"
    compact = re.sub(r"^#\s*第?\d+章[^\s]*\s*", "", compact)
    compact = re.sub(r"^正文[:：]\s*", "", compact)
    return compact[:max_len]


def upsert_chapter_memory(store: MemoryStore, chapter: Chapter):
    if not chapter.draft:
        return
    now = datetime.now()
    store.add_memory_item(
        MemoryItem(
            id=f"chapter-draft-{chapter.id}",
            layer=Layer.L3,
            source_path=f"chapters/{chapter.id}.md",
            summary=f"第{chapter.chapter_number}章草稿：{chapter.title}",
            content=chapter.draft,
            entities=list((chapter.plan.role_goals or {}).keys()) if chapter.plan else [],
            importance=7,
            recency=9,
            created_at=now,
            updated_at=now,
            metadata={"kind": "chapter_draft"},
        )
    )


def ensure_minimal_plan(chapter: Chapter, premise: str):
    if chapter.plan:
        return
    chapter.plan = ChapterPlan(
        id=str(uuid4()),
        chapter_id=chapter.chapter_number,
        title=chapter.title,
        goal=chapter.goal,
        beats=[
            f"开场建立目标：{premise}",
            "中段抬升冲突并推进人物关系",
            "结尾留下强钩子推进下一章",
        ],
        conflicts=["外部阻力与角色目标碰撞", "角色内在价值冲突升级"],
        foreshadowing=["埋入可在后文回收的关键细节"],
        callback_targets=["至少回收一项前文未决信息"],
        role_goals={"主角": "在冲突中主动做出选择并承担代价"},
    )


def parse_outline_json(text: str) -> List[Dict[str, str]]:
    payload = (text or "").strip()
    if not payload:
        return []
    payload = re.sub(r"^```(?:json)?", "", payload).strip()
    payload = re.sub(r"```$", "", payload).strip()
    start = payload.find("[")
    end = payload.rfind("]")
    if start >= 0 and end > start:
        payload = payload[start : end + 1]
    try:
        parsed = json.loads(payload)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    outline: List[Dict[str, str]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        goal = str(item.get("goal", "")).strip()
        if title and goal:
            outline.append({"title": title, "goal": goal})
    return outline


def build_fallback_outline(prompt: str, chapter_count: int) -> List[Dict[str, str]]:
    phase = [
        "引爆主冲突",
        "扩大代价",
        "误导与反转伏笔",
        "关系破裂",
        "真相逼近",
        "局势失控",
        "抉择时刻",
        "收束并留钩子",
    ]
    result: List[Dict[str, str]] = []
    for index in range(chapter_count):
        p = phase[index % len(phase)]
        number = index + 1
        result.append(
            {
                "title": f"{p}·{number}",
                "goal": f"{prompt}（第{number}章：{p}）",
            }
        )
    return result


def build_outline_messages(
    *,
    prompt: str,
    chapter_count: int,
    scope: str,
    project: Project,
    identity: str,
) -> List[Dict[str, str]]:
    return [
        {
            "role": "system",
            "content": (
                "你是长篇小说策划编辑。仅输出 JSON 数组，不要解释。"
                "数组每项格式：{\"title\":\"...\",\"goal\":\"...\"}。"
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "task": "根据一句话梗概拆成章节蓝图",
                    "scope": scope,
                    "chapter_count": chapter_count,
                    "prompt": prompt,
                    "genre": project.genre,
                    "style": project.style,
                    "identity": identity,
                    "constraints": [
                        "每章 title 简洁有辨识度",
                        "每章 goal 要推动主线并含冲突动作",
                        "章节之间有递进关系",
                    ],
                },
                ensure_ascii=False,
            ),
        },
    ]


def build_chapter_outline(
    *,
    prompt: str,
    chapter_count: int,
    scope: str,
    project: Project,
    store: MemoryStore,
    studio: AgentStudio,
) -> List[Dict[str, str]]:
    identity = store.three_layer.get_identity()[:2500]
    messages = build_outline_messages(
        prompt=prompt,
        chapter_count=chapter_count,
        scope=scope,
        project=project,
        identity=identity,
    )
    raw = studio.llm_client.chat(messages, temperature=0.5, max_tokens=3000)
    if not isinstance(raw, str):
        raw = str(raw)
    outline = parse_outline_json(raw)
    if len(outline) >= chapter_count:
        logger.info(
            "outline generated via model scope=%s chapters=%d",
            scope,
            chapter_count,
        )
        return outline[:chapter_count]
    fallback = build_fallback_outline(prompt, chapter_count)
    if not outline:
        logger.warning(
            "outline parse failed using fallback scope=%s chapters=%d",
            scope,
            chapter_count,
        )
        return fallback
    logger.warning(
        "outline partially generated model_count=%d fallback_count=%d",
        len(outline),
        chapter_count - len(outline),
    )
    merged = outline[:]
    for item in fallback:
        if len(merged) >= chapter_count:
            break
        merged.append(item)
    return merged[:chapter_count]


ProgressReporter = Optional[Callable[[str, Dict[str, Any]], Any]]


async def emit_progress(reporter: ProgressReporter, event: str, payload: Dict[str, Any]):
    if reporter is None:
        return
    try:
        maybe = reporter(event, payload)
        if inspect.isawaitable(maybe):
            await maybe
    except Exception:
        logger.exception("progress reporter failed event=%s", event)


def build_one_shot_messages(
    *,
    req: "OneShotDraftRequest",
    chapter: Chapter,
    project: Project,
    store: MemoryStore,
    premise: str,
    previous_chapters: List[str],
) -> List[Dict[str, str]]:
    mode_instruction = {
        GenerationMode.QUICK: "快速模式：直接产出完整章节，节奏紧凑，信息密度高。",
        GenerationMode.CINEMATIC: "电影模式：强调场景调度、对白张力和镜头感，篇幅更饱满。",
    }[req.mode]
    return [
        {
            "role": "system",
            "content": (
                "你是中文长篇小说写作助手。请只输出章节正文，不要输出解释、JSON、标题栏、提示词。"
                "必须遵守世界规则与禁忌约束，保持人物行为一致。"
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "mode": req.mode.value,
                    "instruction": mode_instruction,
                    "chapter_number": chapter.chapter_number,
                    "chapter_title": chapter.title,
                    "chapter_goal": chapter.goal,
                    "one_line_premise": premise,
                    "target_words": req.target_words,
                    "project_style": project.style,
                    "taboo_constraints": project.taboo_constraints,
                    "identity": store.three_layer.get_identity()[:2000],
                    "previous_chapters": previous_chapters,
                },
                ensure_ascii=False,
            ),
        },
    ]


def iter_text_chunks(text: str, chunk_size: int = 260):
    if chunk_size <= 0:
        chunk_size = 260
    for idx in range(0, len(text), chunk_size):
        yield idx, text[idx : idx + chunk_size]


def finalize_generated_draft(
    *,
    chapter: Chapter,
    project: Project,
    store: MemoryStore,
    studio: AgentStudio,
    trace: AgentTrace,
    draft: str,
    started: datetime,
    source_label: str,
) -> Dict[str, Any]:
    chapter.draft = draft
    chapter.word_count = len(draft)
    chapter.status = ChapterStatus.REVIEWING

    consistency_engine = ConsistencyEngine()
    consistency = consistency_engine.check(
        draft,
        {
            "chapter_id": chapter.chapter_number,
            "entities": store.get_all_entities(),
            "events": store.get_all_events(),
            "identity": store.three_layer.get_identity(),
            "taboo_constraints": project.taboo_constraints,
        },
    )
    chapter.conflicts = [Conflict.model_validate(item) for item in consistency["conflicts"]]
    for conflict in chapter.conflicts:
        studio.add_conflict(conflict)

    upsert_graph_from_chapter(store, chapter)
    upsert_chapter_memory(store, chapter)
    store.sync_file_memories()
    traces[chapter.id] = trace
    save_trace(chapter.project_id, chapter.id, trace)
    save_chapter(chapter)

    elapsed = (datetime.now() - started).total_seconds()
    write_metric(
        Metrics(
            chapter_generation_time=elapsed,
            search_time=max(elapsed * 0.2, 0.01),
            conflict_check_time=max(elapsed * 0.1, 0.01),
            conflicts_per_chapter=float(consistency["total_conflicts"]),
            p0_ratio=float(consistency["p0_count"] > 0),
            first_pass_rate=1.0 if consistency["can_submit"] else 0.0,
            chapter_id=chapter.chapter_number,
            project_id=chapter.project_id,
        )
    )
    store.three_layer.add_log(
        f"章节 {chapter.chapter_number} {source_label}完成，冲突数: {consistency['total_conflicts']}"
    )
    logger.info(
        "draft finalized project_id=%s chapter_id=%s chapter_no=%d source=%s words=%d conflicts_total=%d p0=%d p1=%d p2=%d elapsed_s=%.2f",
        chapter.project_id,
        chapter.id,
        chapter.chapter_number,
        source_label,
        chapter.word_count,
        consistency["total_conflicts"],
        consistency["p0_count"],
        consistency["p1_count"],
        consistency["p2_count"],
        elapsed,
    )
    return {
        "draft": chapter.draft,
        "word_count": chapter.word_count,
        "consistency": consistency,
        "can_submit": consistency["can_submit"],
    }


async def generate_one_shot_draft_text(
    *,
    chapter: Chapter,
    project: Project,
    store: MemoryStore,
    studio: AgentStudio,
    req: "OneShotDraftRequest",
    progress: ProgressReporter = None,
    stream_chunk: Optional[Callable[[str], Any]] = None,
) -> tuple[str, AgentTrace]:
    premise = req.prompt.strip()
    if not premise:
        raise HTTPException(status_code=400, detail="prompt is required")

    if req.override_goal:
        chapter.goal = premise

    workflow = StudioWorkflow(
        studio, lambda query, **kwargs: store.search_fts(query, kwargs.get("fts_top_k", 20))
    )

    if req.mode == GenerationMode.STUDIO:
        await emit_progress(
            progress,
            "chapter_stage",
            {"chapter_number": chapter.chapter_number, "stage": "plan", "mode": req.mode.value},
        )
        if req.rewrite_plan or not chapter.plan:
            chapter.plan = await workflow.generate_plan(
                chapter,
                {
                    "project_info": project.model_dump(mode="json"),
                    "previous_chapters": [
                        c.model_dump(mode="json")
                        for c in chapter_list(chapter.project_id)
                        if c.chapter_number < chapter.chapter_number
                    ],
                },
            )
        await emit_progress(
            progress,
            "chapter_stage",
            {"chapter_number": chapter.chapter_number, "stage": "draft", "mode": req.mode.value},
        )
        trace = studio.start_trace(chapter.chapter_number)
        draft_context = {
            "identity": store.three_layer.get_identity(),
            "project_style": project.style,
            "previous_chapters": [
                c.final or c.draft or ""
                for c in chapter_list(chapter.project_id)
                if c.chapter_number < chapter.chapter_number
            ][-5:],
        }
        if stream_chunk:
            draft = await workflow.generate_draft_stream(
                chapter,
                chapter.plan,
                draft_context,
                on_chunk=stream_chunk,
            )
        else:
            draft = await workflow.generate_draft(chapter, chapter.plan, draft_context)
        await emit_progress(
            progress,
            "chapter_stage",
            {"chapter_number": chapter.chapter_number, "stage": "consistency", "mode": req.mode.value},
        )
        return draft, trace

    ensure_minimal_plan(chapter, premise)
    trace = studio.start_trace(chapter.chapter_number)
    previous_chapters = [
        c.final or c.draft or ""
        for c in chapter_list(chapter.project_id)
        if c.chapter_number < chapter.chapter_number
    ][-3:]
    messages = build_one_shot_messages(
        req=req,
        chapter=chapter,
        project=project,
        store=store,
        premise=premise,
        previous_chapters=previous_chapters,
    )
    await emit_progress(
        progress,
        "chapter_stage",
        {"chapter_number": chapter.chapter_number, "stage": "draft", "mode": req.mode.value},
    )
    if stream_chunk:
        streamed_parts: List[str] = []
        for delta in studio.llm_client.chat_stream_text(messages, temperature=0.8, max_tokens=4096):
            if not delta:
                continue
            streamed_parts.append(delta)
            maybe = stream_chunk(delta)
            if inspect.isawaitable(maybe):
                await maybe
        raw = "".join(streamed_parts)
        if not raw:
            fallback_raw = studio.llm_client.chat(messages, temperature=0.8, max_tokens=4096)
            raw = fallback_raw if isinstance(fallback_raw, str) else str(fallback_raw)
    else:
        raw = studio.llm_client.chat(messages, temperature=0.8, max_tokens=4096)
        if not isinstance(raw, str):
            raw = str(raw)
    draft = workflow._sanitize_draft(raw, chapter, chapter.plan)
    await emit_progress(
        progress,
        "chapter_stage",
        {"chapter_number": chapter.chapter_number, "stage": "consistency", "mode": req.mode.value},
    )

    decision = AgentDecision(
        id=str(uuid4()),
        agent_role=AgentRole.ARBITER,
        chapter_id=chapter.chapter_number,
        input_refs=["one-shot", req.mode.value],
        decision_text=draft[:1200],
        rejected_options=[],
        reasoning=f"mode={req.mode.value}, target_words={req.target_words}",
        timestamp=datetime.now(),
    )
    studio.add_decision(decision)
    studio.set_final_draft(draft)
    return draft, trace


class CreateProjectRequest(BaseModel):
    name: str
    genre: str
    style: str
    target_length: int = 300000
    taboo_constraints: List[str] = Field(default_factory=list)


class CreateChapterRequest(BaseModel):
    project_id: str
    chapter_number: int
    title: str
    goal: str


class ConsistencyCheckRequest(BaseModel):
    project_id: str
    chapter_id: int
    draft: str


class MemoryCommitRequest(BaseModel):
    chapter_id: str


class ReviewRequest(BaseModel):
    chapter_id: str
    action: ReviewAction
    comment: str = ""


class IdentityUpdateRequest(BaseModel):
    content: str


class UpdateDraftRequest(BaseModel):
    draft: str


class GenerationMode(str, Enum):
    STUDIO = "studio"
    QUICK = "quick"
    CINEMATIC = "cinematic"


class OneShotDraftRequest(BaseModel):
    prompt: str
    mode: GenerationMode = GenerationMode.STUDIO
    target_words: int = Field(default=1600, ge=300, le=12000)
    override_goal: bool = True
    rewrite_plan: bool = True


class GenerationScope(str, Enum):
    VOLUME = "volume"
    BOOK = "book"


class OneShotBookRequest(BaseModel):
    prompt: str
    mode: GenerationMode = GenerationMode.STUDIO
    scope: GenerationScope = GenerationScope.VOLUME
    chapter_count: Optional[int] = Field(default=None, ge=1, le=60)
    words_per_chapter: int = Field(default=1600, ge=300, le=12000)
    start_chapter_number: Optional[int] = Field(default=None, ge=1)
    auto_approve: bool = False


class PromptPreviewRequest(BaseModel):
    prompt: str
    mode: GenerationMode = GenerationMode.STUDIO
    scope: GenerationScope = GenerationScope.VOLUME
    chapter_count: int = Field(default=8, ge=1, le=60)
    target_words: int = Field(default=1600, ge=300, le=12000)
    chapter_number: int = Field(default=1, ge=1)
    chapter_title: str = Field(default="第一章")
    chapter_goal: Optional[str] = None


class ProjectHealthRepairRequest(BaseModel):
    project_id: Optional[str] = None
    dry_run: bool = False


bootstrap_state()


@app.get("/api/projects")
async def list_projects():
    response = []
    for project in sorted(projects.values(), key=lambda p: p.created_at, reverse=True):
        entity_count, event_count = get_project_graph_counts(project.id)
        response.append(
            {
                "id": project.id,
                "name": project.name,
                "genre": project.genre,
                "style": project.style,
                "status": project.status.value,
                "target_length": project.target_length,
                "chapter_count": len(chapter_list(project.id)),
                "entity_count": entity_count,
                "event_count": event_count,
                "created_at": project.created_at.isoformat(),
            }
        )
    return response


@app.get("/api/projects/health")
async def projects_health(only_unhealthy: bool = False):
    health_items: List[Dict[str, Any]] = []
    for project in sorted(projects.values(), key=lambda p: p.created_at, reverse=True):
        item = inspect_project_health(project)
        if only_unhealthy and item.get("healthy"):
            continue
        health_items.append(item)

    loaded_ids = set(projects.keys())
    orphan_dirs: List[Dict[str, Any]] = []
    for project_dir in sorted(projects_root().glob("*")):
        if not project_dir.is_dir():
            continue
        project_json = project_dir / "project.json"
        if not project_json.exists():
            orphan_dirs.append(
                {
                    "dir": str(project_dir),
                    "issue": "missing_project_json",
                }
            )
            continue
        try:
            payload = json.loads(project_json.read_text(encoding="utf-8"))
            project_id = str(payload.get("id") or "")
            if not project_id:
                orphan_dirs.append({"dir": str(project_dir), "issue": "empty_project_id"})
                continue
            if project_id not in loaded_ids:
                orphan_dirs.append(
                    {
                        "dir": str(project_dir),
                        "issue": "project_not_loaded",
                        "project_id": project_id,
                    }
                )
            elif project_id != project_dir.name:
                orphan_dirs.append(
                    {
                        "dir": str(project_dir),
                        "issue": "dir_name_id_mismatch",
                        "project_id": project_id,
                    }
                )
        except Exception:
            orphan_dirs.append({"dir": str(project_dir), "issue": "invalid_project_json"})

    healthy_count = sum(1 for item in health_items if item.get("healthy"))
    return {
        "summary": {
            "total_projects": len(projects),
            "reported_projects": len(health_items),
            "healthy_projects": healthy_count,
            "unhealthy_projects": max(len(health_items) - healthy_count, 0),
            "orphan_dirs": len(orphan_dirs),
        },
        "items": health_items,
        "orphans": orphan_dirs,
    }


@app.post("/api/projects/health/repair")
async def repair_projects_health(req: ProjectHealthRepairRequest):
    if req.project_id:
        project = projects.get(req.project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        targets = [project]
    else:
        targets = sorted(projects.values(), key=lambda p: p.created_at, reverse=True)

    results = [repair_project_storage(project, dry_run=req.dry_run) for project in targets]
    repaired = sum(1 for item in results if item.get("healthy_after"))
    return {
        "dry_run": req.dry_run,
        "target_count": len(results),
        "healthy_after_count": repaired,
        "results": results,
    }


@app.get("/api/runtime/llm")
async def llm_runtime_status():
    runtime = resolve_llm_runtime()
    return {
        "requested_provider": runtime["requested_provider"],
        "effective_provider": runtime["effective_provider"],
        "effective_model": runtime["effective_model"],
        "provider_switch_reason": runtime["provider_switch_reason"],
        "remote_requested": runtime["remote_requested"],
        "remote_effective": runtime["remote_effective"],
        "remote_ready": runtime["remote_ready"],
        "remote_auto_enabled": runtime["remote_auto_enabled"],
        "has_openai_key": runtime["has_openai_key"],
        "has_minimax_key": runtime["has_minimax_key"],
    }


@app.post("/api/projects/{project_id}/prompt-preview")
async def prompt_preview(project_id: str, req: PromptPreviewRequest):
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    store = get_or_create_store(project_id)
    runtime = resolve_llm_runtime()
    identity = store.three_layer.get_identity()
    chapter_goal = req.chapter_goal or req.prompt

    preview_chapter = Chapter(
        id=f"preview-{uuid4().hex[:8]}",
        project_id=project_id,
        chapter_number=req.chapter_number,
        title=req.chapter_title.strip() or "第一章",
        goal=chapter_goal.strip() or "根据梗概生成章节正文",
        status=ChapterStatus.DRAFT,
    )
    one_shot_req = OneShotDraftRequest(
        prompt=req.prompt,
        mode=req.mode,
        target_words=req.target_words,
        override_goal=True,
        rewrite_plan=True,
    )
    outline_messages = build_outline_messages(
        prompt=req.prompt,
        chapter_count=req.chapter_count,
        scope=req.scope.value,
        project=project,
        identity=identity[:2500],
    )
    one_shot_messages = build_one_shot_messages(
        req=one_shot_req,
        chapter=preview_chapter,
        project=project,
        store=store,
        premise=req.prompt,
        previous_chapters=[],
    )
    agent_prompts = {
        role.value: {
            "name": config["name"],
            "description": config["description"],
            "system_prompt": config["system_prompt"],
        }
        for role, config in AGENT_PROMPTS.items()
    }
    return {
        "runtime": {
            "requested_provider": runtime["requested_provider"],
            "effective_provider": runtime["effective_provider"],
            "effective_model": runtime["effective_model"],
            "remote_effective": runtime["remote_effective"],
            "remote_ready": runtime["remote_ready"],
        },
        "constraints": {
            "taboo_constraints": project.taboo_constraints,
            "identity_excerpt": identity[:3000],
            "consistency_rules": ["R1", "R2", "R3", "R4", "R5"],
            "p0_blocking": True,
        },
        "outline_messages": outline_messages,
        "one_shot_messages": one_shot_messages,
        "studio_agent_prompts": agent_prompts,
    }


@app.post("/api/projects")
async def create_project(req: CreateProjectRequest):
    project_id = str(uuid4())
    project = Project(
        id=project_id,
        name=req.name,
        genre=req.genre,
        style=req.style,
        target_length=req.target_length,
        taboo_constraints=req.taboo_constraints,
        status=ProjectStatus.INIT,
    )
    projects[project_id] = project
    save_project(project)

    base = project_path(project_id)
    (base / "chapters").mkdir(parents=True, exist_ok=True)
    (base / "traces").mkdir(parents=True, exist_ok=True)
    (base / "graph").mkdir(parents=True, exist_ok=True)
    (base / "index" / "lancedb").mkdir(parents=True, exist_ok=True)

    store = get_or_create_store(project_id)
    identity = (
        f"# {req.name} - IDENTITY\n\n"
        "## World Rules\n"
        f"- Genre: {req.genre}\n"
        f"- Style: {req.style}\n\n"
        "## Character Hard Settings\n- (待补充)\n\n"
        "## Style Contract\n"
        f"- {req.style}\n\n"
        "## Hard Taboos\n"
    )
    if req.taboo_constraints:
        identity += "".join(f"- {item}\n" for item in req.taboo_constraints)
    else:
        identity += "- (无)\n"
    store.three_layer.update_identity(identity)
    store.sync_file_memories()
    logger.info(
        "project created project_id=%s name=%s genre=%s style=%s taboo_count=%d",
        project.id,
        project.name,
        project.genre,
        project.style,
        len(project.taboo_constraints),
    )

    return {
        "id": project.id,
        "name": project.name,
        "status": project.status.value,
        "created_at": project.created_at.isoformat(),
    }


@app.get("/api/projects/{project_id}/export")
async def export_project(project_id: str):
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    base = projects_root() / project_id
    if not base.exists():
        raise HTTPException(status_code=404, detail="Project directory not found")

    tmp_dir = Path(tempfile.mkdtemp(prefix="novelist-export-"))
    archive_base = tmp_dir / f"project-{project_id}"
    archive_path = Path(shutil.make_archive(str(archive_base), "zip", root_dir=str(base)))

    safe_name = re.sub(r"[\\/:*?\"<>|]+", "_", project.name).strip() or "project"
    download_name = f"{safe_name}-{project_id}.zip"
    logger.info(
        "project exported project_id=%s path=%s",
        project_id,
        archive_path,
    )
    return FileResponse(
        path=str(archive_path),
        media_type="application/zip",
        filename=download_name,
        background=BackgroundTask(cleanup_export_file, str(archive_path), str(tmp_dir)),
    )


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str):
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    base = projects_root() / project_id
    purge_project_state(project_id)

    try:
        if base.exists():
            shutil.rmtree(base)
    except Exception as exc:
        logger.exception("project delete failed project_id=%s", project_id)
        raise HTTPException(status_code=500, detail=f"Failed to delete project files: {exc}") from exc

    logger.info("project deleted project_id=%s name=%s", project_id, project.name)
    return {"status": "deleted", "project_id": project_id, "name": project.name}


@app.post("/api/projects/{project_id}/delete")
async def delete_project_compat(project_id: str):
    # Compatibility fallback for environments that do not pass through DELETE.
    return await delete_project(project_id)


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str):
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    chapters_for_project = chapter_list(project_id)
    entity_count, event_count = get_project_graph_counts(project_id)
    return {
        "id": project.id,
        "name": project.name,
        "genre": project.genre,
        "style": project.style,
        "target_length": project.target_length,
        "taboo_constraints": project.taboo_constraints,
        "status": project.status.value,
        "chapter_count": len(chapters_for_project),
        "entity_count": entity_count,
        "event_count": event_count,
        "created_at": project.created_at.isoformat(),
        "updated_at": project.updated_at.isoformat(),
    }


@app.get("/api/projects/{project_id}/chapters")
async def list_chapters(project_id: str):
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    return [
        {
            "id": chapter.id,
            "chapter_number": chapter.chapter_number,
            "title": chapter.title,
            "goal": chapter.goal,
            "status": chapter.status.value,
            "word_count": chapter.word_count,
            "conflict_count": len(chapter.conflicts),
            "updated_at": chapter.updated_at.isoformat(),
        }
        for chapter in chapter_list(project_id)
    ]


async def run_one_shot_book_generation(
    *,
    project_id: str,
    project: Project,
    store: MemoryStore,
    studio: AgentStudio,
    req: OneShotBookRequest,
    progress: ProgressReporter = None,
    stream_markdown: bool = False,
) -> Dict[str, Any]:
    await emit_progress(
        progress,
        "start",
        {
            "project_id": project_id,
            "scope": req.scope.value,
            "mode": req.mode.value,
            "chapter_count": req.chapter_count,
            "words_per_chapter": req.words_per_chapter,
            "auto_approve": req.auto_approve,
        },
    )

    chapter_count = req.chapter_count
    if chapter_count is None:
        chapter_count = 8 if req.scope == GenerationScope.VOLUME else 20
    chapter_count = max(1, min(chapter_count, 60))

    existing = chapter_list(project_id)
    existing_numbers = {c.chapter_number for c in existing}
    next_number = req.start_chapter_number or ((max(existing_numbers) + 1) if existing_numbers else 1)

    await emit_progress(
        progress,
        "outline_start",
        {"scope": req.scope.value, "chapter_count": chapter_count},
    )
    outline = build_chapter_outline(
        prompt=req.prompt.strip(),
        chapter_count=chapter_count,
        scope=req.scope.value,
        project=project,
        store=store,
        studio=studio,
    )
    await emit_progress(
        progress,
        "outline_ready",
        {"count": len(outline), "outline": outline},
    )

    created: List[Dict[str, Any]] = []
    started = datetime.now()
    for idx, item in enumerate(outline, start=1):
        while next_number in existing_numbers:
            next_number += 1
        chapter = Chapter(
            id=str(uuid4()),
            project_id=project_id,
            chapter_number=next_number,
            title=item["title"][:80],
            goal=item["goal"][:300],
            status=ChapterStatus.DRAFT,
        )
        chapters[chapter.id] = chapter
        save_chapter(chapter)
        existing_numbers.add(next_number)
        logger.info(
            "one-shot-book chapter created project_id=%s chapter_id=%s chapter_no=%d title=%s",
            project_id,
            chapter.id,
            chapter.chapter_number,
            chapter.title,
        )
        await emit_progress(
            progress,
            "chapter_start",
            {
                "index": idx,
                "total": len(outline),
                "chapter_id": chapter.id,
                "chapter_number": chapter.chapter_number,
                "title": chapter.title,
                "goal": chapter.goal,
            },
        )
        if stream_markdown:
            await emit_progress(
                progress,
                "chapter_markdown_start",
                {
                    "chapter_id": chapter.id,
                    "chapter_number": chapter.chapter_number,
                    "title": chapter.title,
                },
            )
        streamed_offset = 0
        streamed_fragments: List[str] = []
        streamed_raw = ""
        in_think_block = False

        def sanitize_stream_piece(piece: str) -> str:
            nonlocal in_think_block
            text = piece or ""
            if not text:
                return ""

            output: List[str] = []
            cursor = text
            while cursor:
                lower = cursor.lower()
                if in_think_block:
                    end_positions = []
                    for close_tag in ("</think>", "</thinking>"):
                        pos = lower.find(close_tag)
                        if pos >= 0:
                            end_positions.append((pos, close_tag))
                    if not end_positions:
                        return ""
                    pos, close_tag = min(end_positions, key=lambda item: item[0])
                    cursor = cursor[pos + len(close_tag) :]
                    in_think_block = False
                    continue

                start_positions = []
                for open_tag in ("<think>", "<thinking>"):
                    pos = lower.find(open_tag)
                    if pos >= 0:
                        start_positions.append((pos, open_tag))
                if not start_positions:
                    output.append(cursor)
                    break
                pos, open_tag = min(start_positions, key=lambda item: item[0])
                if pos > 0:
                    output.append(cursor[:pos])
                cursor = cursor[pos + len(open_tag) :]
                in_think_block = True

            cleaned = "".join(output)
            cleaned = re.sub(r"(?im)^\s*(thinking|thoughts?)\s*[:：].*(?:\n|$)", "", cleaned)
            cleaned = re.sub(r"```(?:thinking|reasoning)\s*", "", cleaned, flags=re.IGNORECASE)
            return cleaned

        async def push_draft_chunk(text: str):
            nonlocal streamed_offset, streamed_raw
            if not text:
                return
            chunk_text = text
            # Some providers emit cumulative chunks (full text so far). Convert to real delta.
            if (
                streamed_raw
                and len(chunk_text) > 16
                and len(chunk_text) > len(streamed_raw)
                and chunk_text.startswith(streamed_raw)
            ):
                chunk_text = chunk_text[len(streamed_raw) :]
                streamed_raw = text
            else:
                if (
                    streamed_raw
                    and len(chunk_text) > 16
                    and len(chunk_text) <= len(streamed_raw)
                    and streamed_raw.endswith(chunk_text)
                ):
                    return
                streamed_raw += chunk_text

            cleaned = sanitize_stream_piece(chunk_text)
            if not cleaned:
                return

            streamed_fragments.append(cleaned)
            for ch in cleaned:
                await emit_progress(
                    progress,
                    "chapter_chunk",
                    {
                        "chapter_id": chapter.id,
                        "chapter_number": chapter.chapter_number,
                        "offset": streamed_offset,
                        "chunk": ch,
                    },
                )
                streamed_offset += 1

        one_shot_req = OneShotDraftRequest(
            prompt=item["goal"],
            mode=req.mode,
            target_words=req.words_per_chapter,
            override_goal=True,
            rewrite_plan=True,
        )
        chapter_started = datetime.now()
        draft, trace = await generate_one_shot_draft_text(
            chapter=chapter,
            project=project,
            store=store,
            studio=studio,
            req=one_shot_req,
            progress=progress,
            stream_chunk=push_draft_chunk if stream_markdown else None,
        )
        result = finalize_generated_draft(
            chapter=chapter,
            project=project,
            store=store,
            studio=studio,
            trace=trace,
            draft=draft,
            started=chapter_started,
            source_label=f"整{req.scope.value}生成[{req.mode.value}]",
        )

        streamed_text = "".join(streamed_fragments)
        if stream_markdown and streamed_offset > 0 and chapter.draft and chapter.draft != streamed_text:
            await emit_progress(
                progress,
                "chapter_replace",
                {
                    "chapter_id": chapter.id,
                    "chapter_number": chapter.chapter_number,
                    "title": chapter.title,
                    "body": chapter.draft,
                },
            )
            streamed_offset = len(chapter.draft)

        if stream_markdown and chapter.draft and streamed_offset <= 0:
            for offset, chunk in iter_text_chunks(chapter.draft, chunk_size=1):
                await emit_progress(
                    progress,
                    "chapter_chunk",
                    {
                        "chapter_id": chapter.id,
                        "chapter_number": chapter.chapter_number,
                        "offset": offset,
                        "chunk": chunk,
                    },
                )
                await asyncio.sleep(0)
            await emit_progress(
                progress,
                "chapter_markdown_end",
                {"chapter_id": chapter.id, "chapter_number": chapter.chapter_number},
            )
        elif stream_markdown:
            await emit_progress(
                progress,
                "chapter_markdown_end",
                {"chapter_id": chapter.id, "chapter_number": chapter.chapter_number},
            )

        if req.auto_approve and result["can_submit"]:
            chapter.final = chapter.draft
            chapter.status = ChapterStatus.APPROVED
            store.three_layer.reflect(chapter.final or "", chapter.chapter_number)
            store.sync_file_memories()
            save_chapter(chapter)
            logger.info(
                "one-shot-book chapter auto-approved project_id=%s chapter_id=%s chapter_no=%d",
                project_id,
                chapter.id,
                chapter.chapter_number,
            )
            await emit_progress(
                progress,
                "chapter_auto_approved",
                {
                    "chapter_id": chapter.id,
                    "chapter_number": chapter.chapter_number,
                },
            )

        item_result = {
            "id": chapter.id,
            "chapter_number": chapter.chapter_number,
            "title": chapter.title,
            "goal": chapter.goal,
            "status": chapter.status.value,
            "word_count": chapter.word_count,
            "can_submit": result["can_submit"],
            "p0_count": result["consistency"]["p0_count"],
        }
        created.append(item_result)
        await emit_progress(
            progress,
            "chapter_done",
            {
                **item_result,
                "index": idx,
                "total": len(outline),
                "elapsed_s": (datetime.now() - chapter_started).total_seconds(),
            },
        )
        next_number += 1

    project.status = ProjectStatus.WRITING
    project.updated_at = datetime.now()
    save_project(project)
    store.three_layer.add_log(
        f"整{req.scope.value}生成完成：{len(created)}章，mode={req.mode.value}，耗时{(datetime.now() - started).total_seconds():.2f}s"
    )
    elapsed = (datetime.now() - started).total_seconds()
    logger.info(
        "one-shot-book done project_id=%s generated=%d elapsed_s=%.2f",
        project_id,
        len(created),
        elapsed,
    )

    response_payload = {
        "project_id": project_id,
        "scope": req.scope.value,
        "mode": req.mode.value,
        "prompt": req.prompt.strip(),
        "generated_chapters": len(created),
        "chapters": created,
        "elapsed_s": elapsed,
    }
    await emit_progress(progress, "done", response_payload)
    return response_payload


@app.post("/api/projects/{project_id}/one-shot-book")
async def generate_one_shot_book(project_id: str, req: OneShotBookRequest):
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    store = get_or_create_store(project_id)
    studio = get_or_create_studio(project_id)
    store.sync_file_memories()
    logger.info(
        "one-shot-book start project_id=%s scope=%s mode=%s chapter_count=%s words_per_chapter=%d auto_approve=%s",
        project_id,
        req.scope.value,
        req.mode.value,
        req.chapter_count if req.chapter_count is not None else "default",
        req.words_per_chapter,
        req.auto_approve,
    )
    return await run_one_shot_book_generation(
        project_id=project_id,
        project=project,
        store=store,
        studio=studio,
        req=req,
    )


@app.post("/api/projects/{project_id}/one-shot-book/stream")
async def generate_one_shot_book_stream(project_id: str, req: OneShotBookRequest):
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    store = get_or_create_store(project_id)
    studio = get_or_create_studio(project_id)
    store.sync_file_memories()
    logger.info(
        "one-shot-book stream start project_id=%s scope=%s mode=%s chapter_count=%s words_per_chapter=%d auto_approve=%s",
        project_id,
        req.scope.value,
        req.mode.value,
        req.chapter_count if req.chapter_count is not None else "default",
        req.words_per_chapter,
        req.auto_approve,
    )

    queue: asyncio.Queue[tuple[str, Dict[str, Any]]] = asyncio.Queue()

    async def report(event: str, payload: Dict[str, Any]):
        await queue.put((event, payload))

    async def worker():
        try:
            await run_one_shot_book_generation(
                project_id=project_id,
                project=project,
                store=store,
                studio=studio,
                req=req,
                progress=report,
                stream_markdown=True,
            )
        except Exception as exc:
            logger.exception("one-shot-book stream failed project_id=%s", project_id)
            await queue.put(("error", {"detail": str(exc)}))
        finally:
            await queue.put(("__end__", {}))

    worker_task = asyncio.create_task(worker())

    async def event_stream():
        heartbeat = 0
        try:
            while True:
                try:
                    event, payload = await asyncio.wait_for(queue.get(), timeout=2.0)
                except asyncio.TimeoutError:
                    heartbeat += 1
                    heartbeat_payload = {
                        "seq": heartbeat,
                        "timestamp": datetime.now().isoformat(),
                    }
                    yield f"event: heartbeat\ndata: {json.dumps(heartbeat_payload, ensure_ascii=False)}\n\n"
                    continue

                if event == "__end__":
                    break
                yield f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
        finally:
            if not worker_task.done():
                worker_task.cancel()
                try:
                    await worker_task
                except asyncio.CancelledError:
                    pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@app.post("/api/chapters")
async def create_chapter(req: CreateChapterRequest):
    if req.project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    for existing in chapter_list(req.project_id):
        if existing.chapter_number == req.chapter_number:
            raise HTTPException(status_code=400, detail="chapter_number already exists")

    chapter = Chapter(
        id=str(uuid4()),
        project_id=req.project_id,
        chapter_number=req.chapter_number,
        title=req.title,
        goal=req.goal,
        status=ChapterStatus.DRAFT,
    )
    chapters[chapter.id] = chapter
    save_chapter(chapter)
    logger.info(
        "chapter created project_id=%s chapter_id=%s chapter_no=%d title=%s",
        chapter.project_id,
        chapter.id,
        chapter.chapter_number,
        chapter.title,
    )
    return chapter.model_dump(mode="json")


@app.get("/api/chapters/{chapter_id}")
async def get_chapter(chapter_id: str):
    chapter = chapters.get(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    return chapter.model_dump(mode="json")


@app.put("/api/chapters/{chapter_id}/draft")
async def update_draft(chapter_id: str, payload: UpdateDraftRequest):
    chapter = chapters.get(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    project = projects.get(chapter.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    store = get_or_create_store(chapter.project_id)
    chapter.draft = payload.draft
    chapter.word_count = len(payload.draft)
    chapter.status = ChapterStatus.REVIEWING

    consistency = ConsistencyEngine().check(
        payload.draft,
        {
            "chapter_id": chapter.chapter_number,
            "entities": store.get_all_entities(),
            "events": store.get_all_events(),
            "identity": store.three_layer.get_identity(),
            "taboo_constraints": project.taboo_constraints,
        },
    )
    chapter.conflicts = [Conflict.model_validate(item) for item in consistency["conflicts"]]
    save_chapter(chapter)
    logger.info(
        "draft updated manually chapter_id=%s project_id=%s words=%d conflicts_total=%d p0=%d",
        chapter.id,
        chapter.project_id,
        chapter.word_count,
        consistency["total_conflicts"],
        consistency["p0_count"],
    )
    return {"chapter": chapter.model_dump(mode="json"), "consistency": consistency}


@app.post("/api/chapters/{chapter_id}/plan")
async def generate_plan(chapter_id: str):
    chapter = chapters.get(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    project = projects.get(chapter.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    store = get_or_create_store(chapter.project_id)
    studio = get_or_create_studio(chapter.project_id)
    store.sync_file_memories()
    store.three_layer.add_log(f"开始生成章节 {chapter.chapter_number} 蓝图")
    logger.info(
        "plan generation start chapter_id=%s project_id=%s chapter_no=%d",
        chapter.id,
        chapter.project_id,
        chapter.chapter_number,
    )

    workflow = StudioWorkflow(studio, lambda query, **kwargs: store.search_fts(query, kwargs.get("fts_top_k", 20)))
    trace = studio.start_trace(chapter.chapter_number)

    plan = await workflow.generate_plan(
        chapter,
        {
            "project_info": project.model_dump(mode="json"),
            "previous_chapters": [c.model_dump(mode="json") for c in chapter_list(chapter.project_id) if c.chapter_number < chapter.chapter_number],
        },
    )
    chapter.plan = plan
    chapter.status = ChapterStatus.DRAFT
    save_chapter(chapter)

    traces[chapter.id] = trace
    save_trace(chapter.project_id, chapter.id, trace)
    store.three_layer.add_log(f"章节 {chapter.chapter_number} 蓝图生成完成")
    logger.info(
        "plan generation done chapter_id=%s beats=%d conflicts=%d",
        chapter.id,
        len(plan.beats),
        len(plan.conflicts),
    )
    return {"plan": plan.model_dump(mode="json"), "trace_id": trace.id}


@app.post("/api/chapters/{chapter_id}/draft")
async def generate_draft(chapter_id: str):
    return await _generate_draft_internal(chapter_id, force=True)


@app.post("/api/chapters/{chapter_id}/one-shot")
async def generate_one_shot_draft(chapter_id: str, req: OneShotDraftRequest):
    chapter = chapters.get(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    project = projects.get(chapter.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    started = datetime.now()
    store = get_or_create_store(chapter.project_id)
    studio = get_or_create_studio(chapter.project_id)
    store.sync_file_memories()
    store.three_layer.add_log(
        f"开始一句话整篇生成（mode={req.mode.value}）章节 {chapter.chapter_number}"
    )
    logger.info(
        "one-shot start chapter_id=%s project_id=%s mode=%s target_words=%d",
        chapter.id,
        chapter.project_id,
        req.mode.value,
        req.target_words,
    )

    draft, trace = await generate_one_shot_draft_text(
        chapter=chapter,
        project=project,
        store=store,
        studio=studio,
        req=req,
    )
    result = finalize_generated_draft(
        chapter=chapter,
        project=project,
        store=store,
        studio=studio,
        trace=trace,
        draft=draft,
        started=started,
        source_label=f"一句话整篇生成[{req.mode.value}]",
    )
    return {
        **result,
        "mode": req.mode.value,
        "chapter": chapter.model_dump(mode="json"),
    }


async def _generate_draft_internal(chapter_id: str, force: bool = False) -> Dict[str, Any]:
    chapter = chapters.get(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    project = projects.get(chapter.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if chapter.draft and not force:
        consistency_cached = {
            "can_submit": not any(c.severity.value == "P0" and not c.exempted for c in chapter.conflicts),
            "total_conflicts": len(chapter.conflicts),
            "p0_count": len([c for c in chapter.conflicts if c.severity.value == "P0"]),
            "p1_count": len([c for c in chapter.conflicts if c.severity.value == "P1"]),
            "p2_count": len([c for c in chapter.conflicts if c.severity.value == "P2"]),
            "conflicts": [c.model_dump(mode="json") for c in chapter.conflicts],
            "p0_conflicts": [c.model_dump(mode="json") for c in chapter.conflicts if c.severity.value == "P0"],
            "p1_conflicts": [c.model_dump(mode="json") for c in chapter.conflicts if c.severity.value == "P1"],
            "p2_conflicts": [c.model_dump(mode="json") for c in chapter.conflicts if c.severity.value == "P2"],
        }
        return {
            "draft": chapter.draft,
            "word_count": chapter.word_count,
            "consistency": consistency_cached,
            "can_submit": consistency_cached["can_submit"],
            "cached": True,
        }

    logger.info(
        "draft generation start chapter_id=%s project_id=%s chapter_no=%d force=%s",
        chapter.id,
        chapter.project_id,
        chapter.chapter_number,
        force,
    )

    started = datetime.now()
    store = get_or_create_store(chapter.project_id)
    studio = get_or_create_studio(chapter.project_id)
    store.sync_file_memories()
    store.three_layer.add_log(f"开始生成章节 {chapter.chapter_number} 草稿")

    if not chapter.plan:
        workflow_for_plan = StudioWorkflow(studio, lambda query, **kwargs: store.search_fts(query, kwargs.get("fts_top_k", 20)))
        chapter.plan = await workflow_for_plan.generate_plan(
            chapter,
            {"project_info": project.model_dump(mode="json"), "previous_chapters": []},
        )

    workflow = StudioWorkflow(studio, lambda query, **kwargs: store.search_fts(query, kwargs.get("fts_top_k", 20)))
    trace = studio.start_trace(chapter.chapter_number)
    draft = await workflow.generate_draft(
        chapter,
        chapter.plan,
        {
            "identity": store.three_layer.get_identity(),
            "project_style": project.style,
            "previous_chapters": [c.final or c.draft or "" for c in chapter_list(chapter.project_id) if c.chapter_number < chapter.chapter_number][-5:],
        },
    )
    return finalize_generated_draft(
        chapter=chapter,
        project=project,
        store=store,
        studio=studio,
        trace=trace,
        draft=draft,
        started=started,
        source_label="草稿生成",
    )


@app.get("/api/chapters/{chapter_id}/draft/stream")
async def stream_draft(chapter_id: str, force: bool = False, resume_from: int = 0):
    result = await _generate_draft_internal(chapter_id, force=force)
    chapter = chapters.get(chapter_id)
    if not chapter or not chapter.draft:
        raise HTTPException(status_code=404, detail="Draft not found")

    draft_text = chapter.draft
    start = max(0, min(resume_from, len(draft_text)))
    chunk_size = 220

    async def event_stream():
        meta = {
            "chapter_id": chapter_id,
            "word_count": chapter.word_count,
            "start": start,
            "can_submit": result.get("can_submit", True),
        }
        yield f"event: meta\ndata: {json.dumps(meta, ensure_ascii=False)}\n\n"

        cursor = start
        while cursor < len(draft_text):
            next_cursor = min(cursor + chunk_size, len(draft_text))
            chunk = draft_text[cursor:next_cursor]
            payload = {"offset": next_cursor, "chunk": chunk, "done": False}
            yield f"event: chunk\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            cursor = next_cursor
            await asyncio.sleep(0.01)

        done = {
            "offset": len(draft_text),
            "done": True,
            "consistency": result.get("consistency", {}),
            "can_submit": result.get("can_submit", True),
        }
        yield f"event: done\ndata: {json.dumps(done, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@app.post("/api/consistency/check")
async def check_consistency(req: ConsistencyCheckRequest):
    project = projects.get(req.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    store = get_or_create_store(req.project_id)
    engine = ConsistencyEngine()
    result = engine.check(
        req.draft,
        {
            "chapter_id": req.chapter_id,
            "entities": store.get_all_entities(),
            "events": store.get_all_events(),
            "identity": store.three_layer.get_identity(),
            "taboo_constraints": project.taboo_constraints,
        },
    )
    return result


@app.post("/api/memory/commit")
async def commit_memory(req: MemoryCommitRequest):
    chapter = chapters.get(req.chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    if not chapter.final:
        raise HTTPException(status_code=400, detail="No final draft to commit")

    store = get_or_create_store(chapter.project_id)
    reflection = store.three_layer.reflect(chapter.final, chapter.chapter_number)
    store.sync_file_memories()
    store.three_layer.add_log(
        f"章节 {chapter.chapter_number} 已提交。保留: {len(reflection['retains'])}，降权: {len(reflection['downgrades'])}，新事实: {len(reflection['new_facts'])}"
    )
    return {"reflection": reflection, "status": chapter.status.value}


@app.get("/api/memory/query")
async def query_memory(project_id: str, query: str, layers: Optional[str] = None):
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    store = get_or_create_store(project_id)
    store.sync_file_memories()

    items = store.get_all_items()
    signature = build_memory_signature(items)
    vector_dir = project_path(project_id) / "index" / "lancedb"
    signature_changed = vector_index_signatures.get(project_id) != signature or not vector_dir.exists()
    if signature_changed and vector_dir.exists():
        shutil.rmtree(vector_dir, ignore_errors=True)
    if signature_changed:
        vector_index_signatures[project_id] = signature

    query_embedding = None
    runtime = resolve_llm_runtime()
    embedding_remote_requested = settings.remote_embedding_enabled
    embedding_remote_effective = embedding_remote_requested
    if os.getenv("REMOTE_EMBEDDING_ENABLED") is None and not embedding_remote_requested:
        embedding_remote_effective = runtime["remote_effective"]

    provider_key = runtime["provider_key"] if embedding_remote_effective else ""
    embedding_provider_name = runtime["effective_provider"]
    logger.info(
        "memory query runtime project_id=%s embedding_remote_requested=%s embedding_remote_effective=%s provider=%s key_ready=%s",
        project_id,
        embedding_remote_requested,
        embedding_remote_effective,
        embedding_provider_name,
        bool(provider_key),
    )
    if provider_key:
        embedding_provider = EmbeddingProvider(
            model_name=settings.embedding_model,
            api_key=provider_key,
            provider=embedding_provider_name,
        )
        query_embedding = embedding_provider.embed_text(query)

    vector_store = VectorStore(str(vector_dir), settings.embedding_dimension)
    if query_embedding is not None and signature_changed:
        embedding_provider = EmbeddingProvider(
            model_name=settings.embedding_model,
            api_key=provider_key,
            provider=embedding_provider_name,
        )
        for item in items:
            text_for_embedding = f"{item.summary}\n{item.content[:400]}"
            vector = embedding_provider.embed_text(text_for_embedding)
            vector_store.add_embedding(
                item.id,
                vector,
                {
                    "layer": item.layer.value,
                    "source_path": item.source_path,
                    "summary": item.summary,
                    "content": item.content[:1200],
                    "entities": item.entities,
                    "importance": item.importance,
                    "recency": item.recency,
                },
            )

    engine = HybridSearchEngine(store.search_fts, vector_store)
    filter_layers = [layer.strip() for layer in layers.split(",")] if layers else None
    try:
        results = engine.search(
            query=query,
            query_embedding=query_embedding,
            fts_top_k=settings.fts_top_k,
            vector_top_k=settings.vector_top_k,
            hybrid_top_k=settings.hybrid_top_k,
            filter_layers=filter_layers,
        )
    finally:
        db = getattr(vector_store, "db", None)
        if db and hasattr(db, "close"):
            try:
                db.close()
            except Exception:
                pass
    return {"query": query, "results": results, "total": len(results)}


@app.get("/api/trace/{chapter_id}")
async def get_trace(chapter_id: str):
    trace = traces.get(chapter_id)
    if not trace:
        chapter = chapters.get(chapter_id)
        if chapter:
            file = trace_file(chapter.project_id, chapter_id)
            if file.exists():
                trace_data = json.loads(file.read_text(encoding="utf-8"))
                trace = AgentTrace.model_validate(trace_data)
                traces[chapter_id] = trace
    if not trace:
        raise HTTPException(status_code=404, detail="Trace not found")
    return trace.model_dump(mode="json")


@app.post("/api/review")
async def review_chapter(req: ReviewRequest):
    chapter = chapters.get(req.chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")

    if req.action == ReviewAction.APPROVE:
        p0_conflicts = [conflict for conflict in chapter.conflicts if conflict.severity.value == "P0" and not conflict.exempted]
        if p0_conflicts:
            logger.warning(
                "review blocked by P0 chapter_id=%s p0_count=%d",
                chapter.id,
                len(p0_conflicts),
            )
            raise HTTPException(status_code=400, detail="P0 conflicts must be resolved or exempted before approval")
        chapter.final = chapter.draft
        chapter.status = ChapterStatus.APPROVED
        if chapter.final:
            store = get_or_create_store(chapter.project_id)
            store.three_layer.reflect(chapter.final, chapter.chapter_number)
            store.sync_file_memories()
    elif req.action == ReviewAction.REJECT:
        chapter.status = ChapterStatus.DRAFT
    elif req.action == ReviewAction.REWRITE:
        chapter.status = ChapterStatus.DRAFT
        chapter.draft = None
    elif req.action == ReviewAction.RESCAN:
        chapter.status = ChapterStatus.REVIEWING
    elif req.action == ReviewAction.EXEMPT:
        for conflict in chapter.conflicts:
            if conflict.severity.value == "P1":
                conflict.exempted = True
                conflict.resolution = req.comment or "manual exemption"

    save_chapter(chapter)
    logger.info(
        "review applied chapter_id=%s action=%s status=%s comment_len=%d",
        chapter.id,
        req.action.value,
        chapter.status.value,
        len(req.comment or ""),
    )
    return {"status": chapter.status.value, "action": req.action.value, "comment": req.comment}


@app.get("/api/metrics")
async def get_metrics(project_id: Optional[str] = None):
    return collect_project_metrics(project_id)


@app.get("/api/entities/{project_id}")
async def get_entities(project_id: str):
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    return [entity.model_dump(mode="json") for entity in get_or_create_store(project_id).get_all_entities()]


@app.get("/api/events/{project_id}")
async def get_events(project_id: str):
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    return [event.model_dump(mode="json") for event in get_or_create_store(project_id).get_all_events()]


@app.get("/api/identity/{project_id}")
async def get_identity(project_id: str):
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    store = get_or_create_store(project_id)
    return {"content": store.three_layer.get_identity()}


@app.put("/api/identity/{project_id}")
async def update_identity(project_id: str, payload: IdentityUpdateRequest):
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    store = get_or_create_store(project_id)
    store.three_layer.update_identity(payload.content)
    store.sync_file_memories()
    return {"status": "updated"}


@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "projects": len(projects),
        "chapters": len(chapters),
        "timestamp": datetime.now().isoformat(),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.api_host, port=settings.api_port)
