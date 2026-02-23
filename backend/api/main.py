import json
import hashlib
import shutil
import asyncio
import re
import threading
import time
import logging
import os
import inspect
import tempfile
import sqlite3
from enum import Enum
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from uuid import uuid4, uuid5, NAMESPACE_URL

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from agents.studio import AGENT_PROMPTS, AgentStudio, StudioWorkflow
from core.chapter_craft import (
    build_micro_arc_hint,
    build_outline_phase_hints,
    collapse_blank_lines,
    compute_length_bounds,
    derive_title_from_goal,
    normalize_outline_items,
    strip_leading_chapter_heading,
)
from core.story_templates import get_story_template, list_story_templates
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
    deepseek_api_key: Optional[str] = None
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"
    llm_temperature: float = 1.5
    llm_max_tokens: int = 4000
    deepseek_max_tokens: int = 8192
    llm_context_window_tokens: int = 32768
    deepseek_context_window_tokens: int = 131072

    embedding_model: str = "embo-01"
    embedding_dimension: int = 1024
    remote_embedding_enabled: bool = False
    fts_top_k: int = 30
    vector_top_k: int = 20
    hybrid_top_k: int = 30
    log_level: str = "INFO"
    enable_http_logging: bool = True
    log_file: Optional[str] = None
    graph_feature_enabled: bool = False

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


THINK_BLOCK_PATTERN = re.compile(
    r"(?is)<\s*think(?:ing)?\s*>.*?<\s*/\s*think(?:ing)?\s*>"
)
THINKING_BLOCK_PATTERN = re.compile(r"(?is)```(?:thinking|reasoning)\s*[\s\S]*?```")
THINKING_LINE_PATTERN = re.compile(r"(?im)^\s*(thinking|thoughts?|reasoning)\s*[:：].*(?:\n|$)")
EDITORIAL_NOTE_BRACKET_PATTERN = re.compile(r"[（(]([^（）()]{1,80})[）)]")
EDITORIAL_NOTE_TEXT_PATTERNS = (
    re.compile(r"^反转(?:[：:、，,\-\s].*)?$", re.IGNORECASE),
    re.compile(r"^余震(?:[：:、，,\-\s].*)?$", re.IGNORECASE),
    re.compile(r"^(?:章尾)?钩子(?:[：:、，,\-\s].*)?$", re.IGNORECASE),
    re.compile(r"^(?:与|和).{0,40}呼应$", re.IGNORECASE),
    re.compile(r"^呼应.{0,40}$", re.IGNORECASE),
    re.compile(r"^callback(?:[：:、，,\-\s].*)?$", re.IGNORECASE),
    re.compile(r"^回收(?:[：:、，,\-\s].*)?$", re.IGNORECASE),
)


def sanitize_trace_text(value: Optional[str]) -> str:
    text = (value or "").strip()
    if not text:
        return ""

    text = THINK_BLOCK_PATTERN.sub("", text)
    text = THINKING_BLOCK_PATTERN.sub("", text)
    text = THINKING_LINE_PATTERN.sub("", text)
    return text.strip()


def _is_editorial_note_text(value: str) -> bool:
    candidate = re.sub(r"\s+", " ", str(value or "")).strip()
    if not candidate or len(candidate) > 60:
        return False
    return any(pattern.match(candidate) for pattern in EDITORIAL_NOTE_TEXT_PATTERNS)


def sanitize_narrative_for_export(text: Optional[str]) -> str:
    content = str(text or "")
    if not content.strip():
        return ""

    def _replace(match: re.Match[str]) -> str:
        inner = match.group(1)
        return "" if _is_editorial_note_text(inner) else match.group(0)

    cleaned = EDITORIAL_NOTE_BRACKET_PATTERN.sub(_replace, content)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def sanitize_trace_payload(trace: AgentTrace) -> Dict[str, Any]:
    payload = trace.model_dump(mode="json")
    decisions = payload.get("decisions") or []
    for decision in decisions:
        decision["decision_text"] = sanitize_trace_text(decision.get("decision_text"))
        decision["reasoning"] = sanitize_trace_text(decision.get("reasoning"))
    return payload


def _normalize_provider(provider: str) -> str:
    candidate = (provider or "openai").strip().lower()
    if candidate not in {"openai", "minimax", "deepseek"}:
        logger.warning("invalid llm provider configured=%s fallback=openai", provider)
        return "openai"
    return candidate


def resolve_llm_runtime() -> Dict[str, Any]:
    requested_provider = _normalize_provider(settings.llm_provider)
    openai_key = (settings.openai_api_key or "").strip()
    minimax_key = (settings.minimax_api_key or "").strip()
    deepseek_key = (settings.deepseek_api_key or "").strip()
    has_openai_key = bool(openai_key)
    has_minimax_key = bool(minimax_key)
    has_deepseek_key = bool(deepseek_key)

    remote_requested = settings.remote_llm_enabled
    remote_env_raw = os.getenv("REMOTE_LLM_ENABLED")
    auto_enabled = False
    remote_effective = remote_requested
    if remote_env_raw is None and not remote_requested and (
        has_openai_key or has_minimax_key or has_deepseek_key
    ):
        # Auto-enable remote mode if keys are present and REMOTE_LLM_ENABLED was not explicitly set.
        remote_effective = True
        auto_enabled = True

    provider_has_key = {
        "openai": has_openai_key,
        "minimax": has_minimax_key,
        "deepseek": has_deepseek_key,
    }
    provider_fallback_order = {
        "openai": ["deepseek", "minimax"],
        "minimax": ["deepseek", "openai"],
        "deepseek": ["openai", "minimax"],
    }

    effective_provider = requested_provider
    provider_switch_reason = "configured"
    if not provider_has_key[requested_provider]:
        for candidate in provider_fallback_order[requested_provider]:
            if provider_has_key[candidate]:
                effective_provider = candidate
                provider_switch_reason = f"switched_to_{candidate}_missing_{requested_provider}_key"
                break

    if effective_provider == "minimax":
        provider_key = minimax_key
        effective_model = settings.minimax_model
        effective_base_url = "https://api.minimaxi.com/v1"
    elif effective_provider == "deepseek":
        provider_key = deepseek_key
        effective_model = settings.deepseek_model
        effective_base_url = settings.deepseek_base_url
    else:
        provider_key = openai_key
        effective_model = settings.openai_model
        effective_base_url = "https://api.openai.com/v1"

    remote_ready = remote_effective and bool(provider_key)
    return {
        "requested_provider": requested_provider,
        "effective_provider": effective_provider,
        "provider_switch_reason": provider_switch_reason,
        "effective_model": effective_model,
        "effective_base_url": effective_base_url,
        "provider_key": provider_key,
        "remote_requested": remote_requested,
        "remote_effective": remote_effective,
        "remote_ready": remote_ready,
        "remote_auto_enabled": auto_enabled,
        "has_openai_key": has_openai_key,
        "has_minimax_key": has_minimax_key,
        "has_deepseek_key": has_deepseek_key,
    }


def resolve_embedding_runtime(runtime: Dict[str, Any]) -> Dict[str, str]:
    provider_name = runtime["effective_provider"]
    provider_key = runtime["provider_key"]
    provider_base_url = runtime["effective_base_url"]

    if provider_name == "deepseek":
        minimax_key = (settings.minimax_api_key or "").strip()
        openai_key = (settings.openai_api_key or "").strip()
        if minimax_key:
            return {
                "provider_name": "minimax",
                "provider_key": minimax_key,
                "provider_base_url": "https://api.minimaxi.com/v1",
            }
        if openai_key:
            return {
                "provider_name": "openai",
                "provider_key": openai_key,
                "provider_base_url": "https://api.openai.com/v1",
            }

    return {
        "provider_name": provider_name,
        "provider_key": provider_key,
        "provider_base_url": provider_base_url,
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
    "llm runtime requested_provider=%s effective_provider=%s model=%s remote_requested=%s remote_effective=%s remote_ready=%s auto_enabled=%s keys(openai=%s,minimax=%s,deepseek=%s)",
    llm_runtime["requested_provider"],
    llm_runtime["effective_provider"],
    llm_runtime["effective_model"],
    llm_runtime["remote_requested"],
    llm_runtime["remote_effective"],
    llm_runtime["remote_ready"],
    llm_runtime["remote_auto_enabled"],
    llm_runtime["has_openai_key"],
    llm_runtime["has_minimax_key"],
    llm_runtime["has_deepseek_key"],
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
    configured = Path(settings.data_dir)
    if configured.is_absolute():
        root = configured.resolve()
    else:
        root = (BACKEND_ROOT / configured).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


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


def atomic_write_text(path: Path, content: str, encoding: str = "utf-8") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding=encoding,
        dir=str(path.parent),
        delete=False,
    ) as tmp:
        tmp.write(content)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)


def save_project(project: Project):
    atomic_write_text(
        project_file(project.id),
        json.dumps(project.model_dump(mode="json"), ensure_ascii=False, indent=2),
    )


def save_chapter(chapter: Chapter):
    chapter.updated_at = datetime.now()
    atomic_write_text(
        chapter_file(chapter.project_id, chapter.id),
        json.dumps(chapter.model_dump(mode="json"), ensure_ascii=False, indent=2),
    )


def save_trace(project_id: str, chapter_id: str, trace: AgentTrace):
    atomic_write_text(
        trace_file(project_id, chapter_id),
        json.dumps(trace.model_dump(mode="json"), ensure_ascii=False, indent=2),
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


def project_dir_path(project_id: str) -> Path:
    return projects_root() / project_id


def project_json_path(project_id: str) -> Path:
    return project_dir_path(project_id) / "project.json"


def chapter_dir_path(project_id: str) -> Path:
    return project_dir_path(project_id) / "chapters"


def chapter_json_path(project_id: str, chapter_id: str) -> Path:
    return chapter_dir_path(project_id) / f"{chapter_id}.json"


def load_project_from_disk(project_id: str) -> Optional[Project]:
    path = project_json_path(project_id)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return Project.model_validate(payload)
    except Exception:
        return None


def load_chapter_from_disk(project_id: str, chapter_id: str) -> Optional[Chapter]:
    path = chapter_json_path(project_id, chapter_id)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        chapter = Chapter.model_validate(payload)
    except Exception:
        return None
    if chapter.project_id != project_id or chapter.id != chapter_id:
        return None
    return chapter


def sync_project_chapters_from_disk(project_id: str) -> None:
    if not project_json_path(project_id).exists():
        purge_project_state(project_id)
        return

    chapter_dir = chapter_dir_path(project_id)
    disk_chapters: Dict[str, Chapter] = {}
    if chapter_dir.exists():
        for file in chapter_dir.glob("*.json"):
            try:
                payload = json.loads(file.read_text(encoding="utf-8"))
                chapter = Chapter.model_validate(payload)
            except Exception:
                continue
            if chapter.project_id != project_id:
                continue
            disk_chapters[chapter.id] = chapter

    stale_chapter_ids = [
        chapter_id
        for chapter_id, chapter in list(chapters.items())
        if chapter.project_id == project_id and chapter_id not in disk_chapters
    ]
    for chapter_id in stale_chapter_ids:
        chapters.pop(chapter_id, None)
        traces.pop(chapter_id, None)

    for chapter_id, disk_chapter in disk_chapters.items():
        cached = chapters.get(chapter_id)
        if (
            cached
            and cached.project_id == project_id
            and cached.updated_at >= disk_chapter.updated_at
        ):
            continue
        chapters[chapter_id] = disk_chapter


def resolve_chapter(chapter_id: str) -> Optional[Chapter]:
    chapter = chapters.get(chapter_id)
    if chapter:
        if not resolve_project(chapter.project_id):
            chapters.pop(chapter_id, None)
            traces.pop(chapter_id, None)
            return None
        disk_chapter = load_chapter_from_disk(chapter.project_id, chapter_id)
        if disk_chapter:
            chapters[chapter_id] = disk_chapter
            return disk_chapter
        chapters.pop(chapter_id, None)
        traces.pop(chapter_id, None)

    root = projects_root()
    for file in root.glob(f"*/chapters/{chapter_id}.json"):
        try:
            payload = json.loads(file.read_text(encoding="utf-8"))
            chapter = Chapter.model_validate(payload)
        except Exception:
            continue
        if not resolve_project(chapter.project_id):
            continue
        chapters[chapter.id] = chapter
        return chapter
    return None


def sync_projects_index_from_disk() -> None:
    disk_projects: Dict[str, Project] = {}
    root = projects_root()
    for project_json in root.glob("*/project.json"):
        try:
            payload = json.loads(project_json.read_text(encoding="utf-8"))
            project = Project.model_validate(payload)
        except Exception:
            continue
        disk_projects[project.id] = project

    stale_ids = [project_id for project_id in list(projects.keys()) if project_id not in disk_projects]
    for stale_id in stale_ids:
        logger.warning("purging stale in-memory project project_id=%s reason=missing_on_disk", stale_id)
        purge_project_state(stale_id)

    for project_id, project in disk_projects.items():
        projects[project_id] = project


def resolve_project(project_id: str) -> Optional[Project]:
    disk_project = load_project_from_disk(project_id)
    if disk_project:
        projects[project_id] = disk_project
        return disk_project
    project = projects.get(project_id)
    if project:
        purge_project_state(project_id)
    sync_projects_index_from_disk()
    return projects.get(project_id)


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


GRAPH_ROLE_NAME_ALIASES = {
    "primary": "主角",
    "protagonist": "主角",
    "secondary": "关键配角",
    "supporting": "关键配角",
    "antagonist": "反派",
}

GRAPH_ROLE_NAME_IGNORES = {
    "hidden",
    "secret",
    "unknown",
    "none",
    "null",
    "goal",
    "goals",
    "id",
    "description",
    "type",
    "item",
    "target",
    "source_chapter",
    "potential_use",
}

GRAPH_ROLE_TEXT_STOPWORDS = {
    "主角",
    "章节",
    "章末",
    "目标",
    "冲突",
    "线索",
    "伏笔",
    "回收",
    "开场",
    "结尾",
    "剧情",
    "故事",
    "万事屋",
    "猪肉铺",
    "猪肉铺2号",
    "长城路",
    "长城路猪肉铺",
    "长城路猪肉铺2号",
    "黑衣人",
    "器官库",
    "数据碎片",
    "都市传",
    "都市怪",
    "都没",
    "后者正",
    "胡说八",
    "任凭赵老板",
    "任谁",
    "后者",
    "前者",
    "通风管",
    "从管",
    "冷静",
}
GRAPH_ROLE_PLACEHOLDER_NAMES = {"主角", "关键配角", "反派"}
GRAPH_ROLE_COMPOUND_TOKEN_BLOCKLIST = {
    "传说",
    "都市传说",
    "都市传闻",
    "都市怪谈",
    "神话传说",
    "民间传说",
    "江湖传说",
    "据说",
    "听说",
}
GRAPH_ROLE_PREFIX_BLOCKLIST = {
    "后者",
    "前者",
    "任凭",
    "都没",
    "胡说",
    "据说",
    "听说",
    "如果",
    "但是",
    "只是",
    "这个",
    "那个",
}
GRAPH_ROLE_INVALID_TRAILING_CHARS = {"没", "不", "了", "着", "过", "都", "也", "正", "谁", "啥", "么"}
GRAPH_ROLE_INVALID_INTERNAL_CHARS = {"者", "说", "没"}

GRAPH_TITLE_SUFFIXES = ("教授", "医生", "老板", "队长", "先生", "小姐", "同学")
GRAPH_COMMON_SURNAMES = set(
    "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦许何吕施张孔曹严华金魏陶姜戚谢邹柏窦章云苏潘葛范彭鲁韦马苗凤方俞任袁柳鲍史唐费廉岑薛雷贺倪汤殷罗毕郝邬安常乐于傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路江童颜郭梅盛林钟徐邱骆高夏蔡田樊胡霍虞万支柯管卢莫房缪丁宣邓单杭洪包左石崔吉龚程邢裴陆荣翁荀惠甄曲封芮靳汲段富巫乌焦巴弓车侯班仰仲伊宫宁仇栾甘厉戎祖武符刘景詹龙叶司黎薄印白蒲从鄂索赖卓蔺屠蒙池乔阴胥闻党翟谭贡姬申扶堵冉宰郦桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎连茹习艾鱼容向古易慎戈廖衡步都耿满弘匡文寇广禄阙欧殳沃利蔚越隆师巩聂晁勾敖融冷辛阚那简饶曾关蒯相查后荆红游竺权逯盖益桓公"
)


def normalize_graph_role_name(name: str) -> str:
    raw = str(name or "").strip()
    if not raw:
        return ""
    key = raw.lower()
    if key in GRAPH_ROLE_NAME_IGNORES:
        return ""
    return GRAPH_ROLE_NAME_ALIASES.get(key, raw)


def validate_graph_role_name(name: str, *, allow_placeholders: bool = True) -> str:
    normalized = normalize_graph_role_name(name)
    normalized = re.sub(r"^(?:连|那|这|把|对|向|跟|让|与|和)", "", normalized)
    normalized = re.sub(r"(?:喊|问|说|看|听|追|知|苦|笑|道|叫|答|想|盯|望)$", "", normalized)
    normalized = normalized.strip()
    if not normalized:
        return ""
    if any(ch.isdigit() for ch in normalized):
        return ""
    if len(normalized) < 2 or len(normalized) > 8:
        return ""
    if "第" in normalized and "章" in normalized:
        return ""
    if normalized in GRAPH_ROLE_PLACEHOLDER_NAMES:
        return normalized if allow_placeholders else ""
    if normalized in GRAPH_ROLE_TEXT_STOPWORDS:
        return ""
    if any(normalized.startswith(prefix) for prefix in GRAPH_ROLE_PREFIX_BLOCKLIST):
        return ""
    if len(normalized) == 2 and normalized[1] in GRAPH_ROLE_INVALID_TRAILING_CHARS:
        return ""
    if len(normalized) >= 3 and any(ch in normalized[1:] for ch in GRAPH_ROLE_INVALID_INTERNAL_CHARS):
        return ""
    if len(normalized) >= 3 and normalized[-1] in GRAPH_ROLE_INVALID_TRAILING_CHARS:
        return ""
    matched_title = next((suffix for suffix in GRAPH_TITLE_SUFFIXES if normalized.endswith(suffix)), None)
    if matched_title:
        stem = normalized[: -len(matched_title)]
        if not stem or len(stem) > 2:
            return ""
        if stem[0] not in GRAPH_COMMON_SURNAMES:
            return ""
        return normalized
    if normalized[0] not in GRAPH_COMMON_SURNAMES:
        return ""
    if len(normalized) > 4:
        return ""
    return normalized


def extract_graph_role_names(text: str, max_names: int = 8) -> List[str]:
    source = str(text or "").strip()
    if not source:
        return []

    names: List[str] = []
    patterns: List[Tuple[str, bool]] = [
        (
            r"([\u4e00-\u9fff]{2,6})[（(](?:男主(?:一)?|女主(?:一)?|男二|女二|反派|配角|导师|主角|老板娘|角色)[^）)]*[）)]",
            False,
        ),
        (
            r"(?:男主(?:一)?|女主(?:一)?|男二|女二|导师|老板娘|反派|主角)[：:是为]\s*([\u4e00-\u9fff]{2,6})",
            False,
        ),
        (
            r"(?:^|[，。！？、“”\\s])([\u4e00-\u9fff]{2,4})(?:低声|轻声|冷声)?(说|问|喊|笑|看着|看向|盯着|回答|嘀咕|点头)",
            True,
        ),
        (
            r"(?:^|[，。！？、“”\\s])([\u4e00-\u9fff]{1,3}(?:教授|医生|老板|队长|先生|小姐|同学))",
            False,
        ),
    ]
    for pattern, has_action in patterns:
        for match in re.finditer(pattern, source):
            raw_candidate = match.group(1)
            candidate = validate_graph_role_name(raw_candidate, allow_placeholders=False)
            if has_action and candidate:
                action = match.group(2)
                if action and f"{candidate}{action}" in GRAPH_ROLE_COMPOUND_TOKEN_BLOCKLIST:
                    continue
            if not candidate or candidate in names:
                continue
            names.append(candidate)
            if len(names) >= max_names:
                return names
    return names


def sanitize_graph_entities(entities: List[EntityState]) -> List[EntityState]:
    merged: Dict[Tuple[str, str], EntityState] = {}
    for entity in entities:
        normalized_name = validate_graph_role_name(entity.name, allow_placeholders=True)
        if not normalized_name:
            continue
        key = (entity.entity_type, normalized_name)
        if key not in merged:
            merged_entity = entity.model_copy(deep=True)
            merged_entity.name = normalized_name
            merged[key] = merged_entity
            continue

        existing = merged[key]
        existing.first_seen_chapter = min(existing.first_seen_chapter, entity.first_seen_chapter)
        existing.last_seen_chapter = max(existing.last_seen_chapter, entity.last_seen_chapter)
        existing.updated_at = max(existing.updated_at, entity.updated_at)
        existing.attrs = {**existing.attrs, **entity.attrs}
        if entity.constraints:
            existing.constraints = list(dict.fromkeys([*existing.constraints, *entity.constraints]))

    return sorted(merged.values(), key=lambda item: (-item.last_seen_chapter, item.name))


def sanitize_graph_events(events: List[EventEdge]) -> List[EventEdge]:
    normalized: List[EventEdge] = []
    for event in events:
        subject = validate_graph_role_name(event.subject, allow_placeholders=True)
        if not subject:
            continue
        obj = validate_graph_role_name(event.object, allow_placeholders=True) if event.object else None
        if obj == subject:
            obj = None
        copied = event.model_copy(deep=True)
        copied.subject = subject
        copied.object = obj
        normalized.append(copied)
    return normalized


def get_project_graph_counts(project_id: str) -> tuple[int, int]:
    if not settings.graph_feature_enabled:
        return 0, 0
    try:
        store = get_or_create_store(project_id)
        return store.get_entity_count(), store.get_event_count()
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc).lower():
            logger.warning(
                "project graph count schema missing project_id=%s error=%s attempting_repair=true",
                project_id,
                exc,
            )
            memory_stores.pop(project_id, None)
            try:
                repaired = get_or_create_store(project_id)
                return repaired.get_entity_count(), repaired.get_event_count()
            except Exception as repair_exc:
                logger.warning(
                    "project graph count repair failed project_id=%s error=%s",
                    project_id,
                    repair_exc,
                )
    except Exception as exc:
        # Keep project listing available even if one project's DB is broken/missing.
        logger.warning(
            "project graph count fallback project_id=%s error=%s",
            project_id,
            exc,
        )
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
        effective_provider = runtime["effective_provider"]
        chat_max_tokens = settings.deepseek_max_tokens if effective_provider == "deepseek" else settings.llm_max_tokens
        context_window_tokens = (
            settings.deepseek_context_window_tokens
            if effective_provider == "deepseek"
            else settings.llm_context_window_tokens
        )
        studios[project_id] = AgentStudio(
            provider=effective_provider,
            model=runtime["effective_model"],
            api_key=provider_key,
            base_url=runtime["effective_base_url"],
            chat_max_tokens=chat_max_tokens,
            chat_temperature=settings.llm_temperature,
            context_window_tokens=context_window_tokens,
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
    sync_project_chapters_from_disk(project_id)
    return sorted(
        [chapter for chapter in chapters.values() if chapter.project_id == project_id],
        key=lambda ch: ch.chapter_number,
    )


def load_trace_from_disk(project_id: str, chapter_id: str) -> Optional[AgentTrace]:
    file = trace_file(project_id, chapter_id)
    if not file.exists():
        return None
    try:
        payload = json.loads(file.read_text(encoding="utf-8"))
        return AgentTrace.model_validate(payload)
    except Exception:
        return None


def resolve_trace_for_chapter(chapter: Chapter) -> Optional[AgentTrace]:
    trace = traces.get(chapter.id)
    if trace:
        return trace
    trace = load_trace_from_disk(chapter.project_id, chapter.id)
    if trace:
        traces[chapter.id] = trace
    return trace


def is_generated_chapter(chapter: Chapter) -> bool:
    return (
        bool(chapter.draft)
        or bool(chapter.final)
        or chapter.word_count > 0
        or chapter.status in {ChapterStatus.REVIEWING, ChapterStatus.REVISED, ChapterStatus.APPROVED}
    )


def collect_project_metrics(project_id: Optional[str] = None) -> Dict[str, Any]:
    selected_runtime_metrics = metrics_history
    if project_id:
        selected_runtime_metrics = [m for m in metrics_history if m.project_id == project_id]

    project_name_map: Dict[str, str] = {}
    if project_id:
        resolved = resolve_project(project_id)
        project_ids = [project_id] if resolved else []
        if resolved:
            project_name_map[project_id] = resolved.name
    else:
        sync_projects_index_from_disk()
        project_ids = list(projects.keys())
        project_name_map = {item.id: item.name for item in projects.values()}

    generated_chapters: List[Chapter] = []
    for pid in project_ids:
        for chapter in chapter_list(pid):
            if is_generated_chapter(chapter):
                generated_chapters.append(chapter)

    generated_total = len(generated_chapters)
    p0_chapter_count = 0
    first_pass_ok_count = 0
    recall_hit_count = 0
    total_conflicts = 0
    p1_exempted = 0
    p1_total = 0
    p0_conflict_chapters: List[Dict[str, Any]] = []
    first_pass_failed_chapters: List[Dict[str, Any]] = []
    recall_missed_chapters: List[Dict[str, Any]] = []

    for chapter in generated_chapters:
        chapter_conflicts = chapter.conflicts or []
        total_conflicts += len(chapter_conflicts)
        p0_count = len(
            [
                conflict
                for conflict in chapter_conflicts
                if conflict.severity.value == "P0" and not conflict.exempted
            ]
        )
        has_unresolved_p0 = any(
            conflict.severity.value == "P0" and not conflict.exempted
            for conflict in chapter_conflicts
        )
        if has_unresolved_p0:
            p0_chapter_count += 1

        first_pass_ok = chapter.first_pass_ok
        if first_pass_ok is None:
            first_pass_ok = not has_unresolved_p0
        if first_pass_ok:
            first_pass_ok_count += 1

        p1_total += len([conflict for conflict in chapter_conflicts if conflict.severity.value == "P1"])
        p1_exempted += len(
            [
                conflict
                for conflict in chapter_conflicts
                if conflict.severity.value == "P1" and conflict.exempted
            ]
        )

        trace = resolve_trace_for_chapter(chapter)
        memory_hit_count = len(trace.memory_hits or []) if trace else 0
        has_memory_hits = memory_hit_count > 0
        if has_memory_hits:
            recall_hit_count += 1

        detail = {
            "project_id": chapter.project_id,
            "project_name": project_name_map.get(chapter.project_id, chapter.project_id),
            "chapter_id": chapter.id,
            "chapter_number": chapter.chapter_number,
            "chapter_title": chapter.title,
            "chapter_status": chapter.status.value,
            "p0_count": p0_count,
            "first_pass_ok": bool(first_pass_ok),
            "memory_hit_count": memory_hit_count,
            "has_unresolved_p0": bool(has_unresolved_p0),
        }
        if has_unresolved_p0:
            p0_conflict_chapters.append(detail)
        if not first_pass_ok:
            first_pass_failed_chapters.append(detail)
        if not has_memory_hits:
            recall_missed_chapters.append(detail)

    runtime_total = len(selected_runtime_metrics)
    chapter_generation_time = 0.0
    search_time = 0.0
    if runtime_total > 0:
        chapter_generation_time = (
            sum(m.chapter_generation_time for m in selected_runtime_metrics) / runtime_total
        )
        search_time = sum(m.search_time for m in selected_runtime_metrics) / runtime_total

    conflicts_per_chapter = (total_conflicts / generated_total) if generated_total else 0.0
    p0_ratio = (p0_chapter_count / generated_total) if generated_total else 0.0
    first_pass_rate = (first_pass_ok_count / generated_total) if generated_total else 0.0
    recall_hit_rate = (recall_hit_count / generated_total) if generated_total else 0.0
    exemption_rate = (p1_exempted / p1_total) if p1_total else 0.0

    return {
        "chapter_generation_time": chapter_generation_time,
        "search_time": search_time,
        "conflicts_per_chapter": conflicts_per_chapter,
        "p0_ratio": p0_ratio,
        "first_pass_rate": first_pass_rate,
        "exemption_rate": exemption_rate,
        "recall_hit_rate": recall_hit_rate,
        "sample_size": generated_total,
        "chapters_with_p0": p0_chapter_count,
        "chapters_first_pass_ok": first_pass_ok_count,
        "chapters_with_memory_hits": recall_hit_count,
        "quality_details": {
            "p0_conflict_chapters": p0_conflict_chapters,
            "first_pass_failed_chapters": first_pass_failed_chapters,
            "recall_missed_chapters": recall_missed_chapters,
        },
    }


def write_metric(metric: Metrics):
    metrics_history.append(metric)


def build_memory_signature(items: List[MemoryItem]) -> str:
    digest_source = "|".join(f"{item.id}:{item.updated_at.isoformat()}" for item in items)
    return hashlib.sha1(digest_source.encode("utf-8")).hexdigest()


GRAPH_RELATION_MARKERS: List[Tuple[str, List[str]]] = [
    ("背叛", ["背叛", "出卖", "反叛"]),
    ("冲突", ["冲突", "对抗", "追击", "威胁", "围攻", "交锋"]),
    ("合作", ["合作", "联手", "同盟", "并肩", "协作", "结盟"]),
    ("调查", ["调查", "追查", "寻找", "线索", "潜入", "侦查"]),
    ("保护", ["保护", "营救", "救下", "掩护", "守住"]),
    ("交易", ["交易", "委托", "订单", "买卖", "交换"]),
    ("揭露", ["揭露", "曝光", "真相", "证据"]),
]


def infer_graph_relation(text: str, fallback: str = "关联") -> str:
    source = str(text or "")
    for relation, markers in GRAPH_RELATION_MARKERS:
        if any(marker in source for marker in markers):
            return relation
    return fallback


def pick_relation_context(text: str, subject: str, target: Optional[str]) -> str:
    source = str(text or "")
    if not source:
        return ""
    if not subject or not target:
        return source
    segments = [seg.strip() for seg in re.split(r"[。！？\n]", source) if seg.strip()]
    for seg in segments:
        if subject in seg and target in seg:
            return seg
    for seg in segments:
        if target in seg:
            return seg
    return source


def upsert_graph_from_chapter(store: MemoryStore, chapter: Chapter):
    if not settings.graph_feature_enabled:
        return
    if not chapter.draft:
        return
    now = datetime.now()

    role_names_raw = list((chapter.plan.role_goals or {}).keys()) if chapter.plan else []
    role_names: List[str] = []
    for role_name in role_names_raw:
        normalized = validate_graph_role_name(role_name, allow_placeholders=True)
        if normalized and normalized not in role_names:
            role_names.append(normalized)
    for text_source in (chapter.title, chapter.goal, chapter.draft):
        for candidate in extract_graph_role_names(text_source, max_names=8):
            if candidate not in role_names:
                role_names.append(candidate)
            if len(role_names) >= 10:
                break
        if len(role_names) >= 10:
            break
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

    store.delete_events_for_chapter(chapter.chapter_number)

    subject = role_names[0]
    targets = [name for name in role_names[1:5] if name != subject]
    if not targets:
        targets = [None]

    conflict_hint = " ".join(chapter.plan.conflicts or []) if chapter.plan else ""
    combined_text = "\n".join(
        part
        for part in (
            chapter.title,
            chapter.goal,
            conflict_hint,
            chapter.draft[:3600],
        )
        if part
    )

    for idx, target in enumerate(targets):
        ctx = pick_relation_context(combined_text, subject, target)
        if idx == 0 and conflict_hint:
            ctx = f"{conflict_hint}\n{ctx}"
        relation = infer_graph_relation(ctx, fallback="关联")
        event = EventEdge(
            event_id=str(
                uuid5(
                    NAMESPACE_URL,
                    f"{chapter.id}:{chapter.chapter_number}:{idx}:{subject}:{target or ''}:{relation}",
                )
            ),
            subject=subject,
            relation=relation,
            object=target,
            chapter=chapter.chapter_number,
            timestamp=now,
            confidence=0.65,
            description=summarize_event_description(ctx or combined_text),
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


def build_fallback_outline(
    prompt: str,
    chapter_count: int,
    continuation_mode: bool = False,
) -> List[Dict[str, str]]:
    phase = build_outline_phase_hints(chapter_count, continuation_mode=continuation_mode)
    result: List[Dict[str, str]] = []
    for index in range(chapter_count):
        number = index + 1
        p = phase[index % len(phase)]
        goal = f"围绕“{prompt}”推进：{p['focus']}"
        title = derive_title_from_goal(goal, number, phase=None)
        result.append(
            {
                "title": title,
                "goal": goal,
            }
        )
    return result


def build_serial_continuation_constraints() -> List[str]:
    return [
        "本批次为连载续写：禁止在单章或本批次内终结全书主线。",
        "每章主线仅推进 1 个关键动作（推进但不完结）。",
        "每章最多推进 1 条支线，且必须与当前主线因果相关。",
        "每章最多回收 1 个伏笔，同时至少保留 2 个未决事项。",
        "主线/支线叙事重心建议约 70/30，避免全是日常或全是主线宣讲。",
        "每 3-5 章安排一次中等兑现（局部胜负、局部真相或关系位移）。",
    ]


def build_outline_messages(
    *,
    prompt: str,
    chapter_count: int,
    scope: str,
    project: Project,
    identity: str,
    continuation_mode: bool = False,
) -> List[Dict[str, str]]:
    phase_hints = build_outline_phase_hints(chapter_count, continuation_mode)
    constraints = [
        "每章 title 2-14 字，禁止写“第X章”前缀",
        "每章 title 必须具体且可区分，避免“开端/发展/继续”之类空泛命名",
        "每章 title 禁止使用阶段标签（如“起势递进/代价扩张/阶段收束”）及其编号变体",
        "每章 title 禁止直接复述流程指令词（如“里程碑/阶段收束/第二阶段钩子”）",
        "每章 title 必须像小说章名（名词短语或意象短语），不要写成动作句或说明句",
        "每章 goal 必须包含明确行动和阻力，不能只写情绪或设定介绍",
        "章节之间要形成因果递进，后章必须承接前章代价",
    ]
    if continuation_mode:
        constraints.extend(build_serial_continuation_constraints())
    return [
        {
            "role": "system",
            "content": (
                "你是长篇小说策划编辑。仅输出 JSON 数组，不要解释。"
                "数组每项格式：{\"title\":\"...\",\"goal\":\"...\"}。"
                "标题不允许包含“第X章”。"
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
                    "continuation_mode": continuation_mode,
                    "constraints": constraints,
                    "forbidden_title_keywords": ["起势递进", "代价扩张", "阶段收束", "里程碑", "第二阶段钩子"],
                    "title_style_examples": ["镜城残响", "雪夜压城", "盲域余震", "风暴前兆"],
                    "phase_hints": phase_hints,
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
    continuation_mode: bool = False,
    start_chapter_number: int = 1,
) -> List[Dict[str, str]]:
    identity = store.three_layer.get_identity()[:2500]
    messages = build_outline_messages(
        prompt=prompt,
        chapter_count=chapter_count,
        scope=scope,
        project=project,
        identity=identity,
        continuation_mode=continuation_mode,
    )
    raw = studio.llm_client.chat(
        messages,
        temperature=resolve_llm_temperature(studio.llm_client),
        max_tokens=3000,
    )
    if not isinstance(raw, str):
        raw = str(raw)
    outline = parse_outline_json(raw)
    if len(outline) >= chapter_count:
        normalized = normalize_outline_items(
            outline=outline[:chapter_count],
            prompt=prompt,
            chapter_count=chapter_count,
            start_chapter_number=start_chapter_number,
            continuation_mode=continuation_mode,
        )
        logger.info(
            "outline generated via model scope=%s chapters=%d",
            scope,
            chapter_count,
        )
        return normalized
    fallback = build_fallback_outline(prompt, chapter_count, continuation_mode=continuation_mode)
    if not outline:
        normalized_fallback = normalize_outline_items(
            outline=fallback,
            prompt=prompt,
            chapter_count=chapter_count,
            start_chapter_number=start_chapter_number,
            continuation_mode=continuation_mode,
        )
        logger.warning(
            "outline parse failed using fallback scope=%s chapters=%d",
            scope,
            chapter_count,
        )
        return normalized_fallback
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
    return normalize_outline_items(
        outline=merged[:chapter_count],
        prompt=prompt,
        chapter_count=chapter_count,
        start_chapter_number=start_chapter_number,
        continuation_mode=continuation_mode,
    )


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


async def stream_chat_text_async(
    llm_client: Any,
    messages: List[Dict[str, str]],
    *,
    temperature: float,
    max_tokens: int,
):
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Optional[str]] = asyncio.Queue()
    worker_errors: List[Exception] = []

    def stream_worker():
        try:
            for delta in llm_client.chat_stream_text(
                messages,
                temperature=temperature,
                max_tokens=max_tokens,
            ):
                if not delta:
                    continue
                loop.call_soon_threadsafe(queue.put_nowait, delta)
        except Exception as exc:
            worker_errors.append(exc)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    worker = threading.Thread(target=stream_worker, daemon=True)
    worker.start()
    try:
        while True:
            delta = await queue.get()
            if delta is None:
                break
            yield delta
    finally:
        await asyncio.to_thread(worker.join, 0.2)

    if worker_errors:
        raise worker_errors[0]


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
    continuation_constraints = build_serial_continuation_constraints() if req.continuation_mode else []
    rhythm_hint = build_micro_arc_hint(
        chapter_number=chapter.chapter_number,
        target_words=req.target_words,
        continuation_mode=req.continuation_mode,
    )
    length_bounds = compute_length_bounds(req.target_words)
    return [
        {
            "role": "system",
            "content": (
                "你是中文长篇小说写作助手。请只输出章节正文，不要输出解释、JSON、标题栏、提示词。"
                "必须遵守世界规则与禁忌约束，保持人物行为一致。"
                "若为续写模式，不得在单章内结束全书主线，章尾必须保留下一章触发点。"
                "正文不得包含“第X章/Chapter X”标题行。"
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
                    "length_bounds": length_bounds,
                    "rhythm_hint": rhythm_hint,
                    "project_style": project.style,
                    "taboo_constraints": project.taboo_constraints,
                    "identity": store.three_layer.get_identity()[:2000],
                    "previous_chapters": previous_chapters,
                    "continuation_mode": req.continuation_mode,
                    "continuation_constraints": continuation_constraints,
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


def resolve_draft_max_tokens(llm_client: Any, target_words: int) -> int:
    target = max(int(target_words or 0), 300)
    # Chinese long-form drafts typically need >1 token per target "word"/character.
    desired = max(1024, target * 2)
    configured_cap = 4096
    config = getattr(llm_client, "config", None)
    if config is not None:
        configured_cap = max(512, int(getattr(config, "chat_max_tokens", 4096) or 4096))
    return min(desired, configured_cap)


def resolve_target_word_upper_bound(target_words: int) -> int:
    return compute_length_bounds(target_words)["soft_upper"]


def resolve_project_target_words(project: Project, project_id: str) -> int:
    template_words: Optional[int] = None
    if project.template_id:
        template = get_story_template(project.template_id)
        if template:
            structure = template.get("recommended_structure", {})
            if isinstance(structure, dict):
                raw_words = structure.get("words_per_chapter")
                if raw_words:
                    try:
                        template_words = int(raw_words)
                    except Exception:
                        template_words = None

    if template_words and template_words >= 300:
        return min(max(template_words, 300), 12000)

    existing_word_counts = [
        c.word_count
        for c in chapter_list(project_id)
        if c.word_count and c.word_count >= 300
    ]
    if existing_word_counts:
        existing_word_counts.sort()
        median = existing_word_counts[len(existing_word_counts) // 2]
        return min(max(int(median), 300), 12000)

    estimated_total_chapters = 24
    if project.target_length > 0:
        estimated_total_chapters = max(12, min(60, int(project.target_length / 12000) + 1))
    fallback = int(project.target_length / estimated_total_chapters) if project.target_length > 0 else 1800
    return min(max(fallback, 1200), 4200)


def _clip_text_at_sentence_boundary(text: str, upper_bound: int) -> str:
    if len(text) <= upper_bound:
        return text
    clipped = text[:upper_bound]
    # Prefer clipping on paragraph/sentence boundary to reduce abrupt truncation artifacts.
    boundary = max(
        clipped.rfind("\n\n"),
        clipped.rfind("。"),
        clipped.rfind("！"),
        clipped.rfind("？"),
        clipped.rfind("."),
        clipped.rfind("!"),
        clipped.rfind("?"),
    )
    if boundary >= int(upper_bound * 0.7):
        clipped = clipped[: boundary + 1]
    return clipped.rstrip()


def enforce_draft_target_words(draft: str, target_words: int) -> str:
    text = (draft or "").strip()
    if not text:
        return text
    upper_bound = resolve_target_word_upper_bound(target_words)
    if len(text) > upper_bound:
        logger.info(
            "draft length exceeds soft target target_words=%d upper_bound=%d actual=%d",
            int(target_words or 0),
            upper_bound,
            len(text),
        )
    # Soft limit only: do not hard-clip model output.
    return text


def _normalize_generated_draft_text(text: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        return ""
    cleaned = strip_leading_chapter_heading(cleaned)
    cleaned = collapse_blank_lines(cleaned, max_consecutive_blank=1)
    return cleaned.strip()


def _looks_like_full_rewrite(candidate: str, baseline: str) -> bool:
    if not candidate or not baseline:
        return False
    if len(candidate) < int(len(baseline) * 0.85):
        return False
    head = baseline[: min(120, len(baseline))]
    return head and head in candidate[: min(len(candidate), 500)]


async def rebalance_draft_length_if_needed(
    *,
    llm_client: Any,
    chapter: Chapter,
    project: Project,
    draft: str,
    target_words: int,
) -> str:
    text = _normalize_generated_draft_text(draft)
    if not text:
        return text

    bounds = compute_length_bounds(target_words)
    lower = bounds["lower"]
    upper = bounds["soft_upper"]
    target = bounds["target"]

    if lower <= len(text) <= upper:
        return text

    base_temperature = resolve_llm_temperature(llm_client)
    append_rounds = 0

    while len(text) < lower and append_rounds < 2:
        deficit = lower - len(text)
        messages = [
            {
                "role": "system",
                "content": (
                    "你是小说续写编辑。请在不改写既有段落的前提下续写后文。"
                    "只输出新增内容，不要重复已有正文，不要输出标题。"
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "chapter_number": chapter.chapter_number,
                        "chapter_title": chapter.title,
                        "chapter_goal": chapter.goal,
                        "project_style": project.style,
                        "target_words": target,
                        "target_range": [bounds["ideal_low"], bounds["ideal_high"]],
                        "deficit_words": deficit,
                        "current_draft": text,
                        "requirements": [
                            "延续当前场景与人物动机",
                            "至少新增一个推进动作和一个后续钩子",
                            "不要复述前文，不要输出说明",
                        ],
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        extra_max_tokens = min(
            max(768, deficit * 3),
            max(resolve_draft_max_tokens(llm_client, target), 768),
        )
        raw = await asyncio.to_thread(
            llm_client.chat,
            messages,
            temperature=max(0.6, base_temperature - 0.25),
            max_tokens=extra_max_tokens,
        )
        addition = _normalize_generated_draft_text(raw if isinstance(raw, str) else str(raw))
        if not addition:
            break

        if _looks_like_full_rewrite(addition, text):
            text = addition
        else:
            text = f"{text}\\n\\n{addition}".strip()
        append_rounds += 1

    if len(text) > upper:
        shrink_messages = [
            {
                "role": "system",
                "content": (
                    "你是小说压缩编辑。请在不改变剧情事实和因果关系的前提下压缩文本。"
                    "只输出压缩后的正文，不要说明。"
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "target_range": [bounds["ideal_low"], bounds["ideal_high"]],
                        "chapter_number": chapter.chapter_number,
                        "chapter_title": chapter.title,
                        "draft": text,
                        "requirements": [
                            "保留关键冲突与反转",
                            "删除重复表述和解释性赘述",
                            "结尾保留下一章触发点",
                        ],
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        raw = await asyncio.to_thread(
            llm_client.chat,
            shrink_messages,
            temperature=max(0.4, base_temperature - 0.35),
            max_tokens=resolve_draft_max_tokens(llm_client, target),
        )
        compressed = _normalize_generated_draft_text(raw if isinstance(raw, str) else str(raw))
        if compressed and len(compressed) >= max(300, int(bounds["lower"] * 0.75)):
            text = compressed

    if len(text) < lower or len(text) > upper:
        logger.warning(
            "draft length remains out of bound chapter_no=%d target=%d lower=%d upper=%d actual=%d",
            chapter.chapter_number,
            target,
            lower,
            upper,
            len(text),
        )
    else:
        logger.info(
            "draft length rebalanced chapter_no=%d target=%d actual=%d range=%d-%d",
            chapter.chapter_number,
            target,
            len(text),
            bounds["ideal_low"],
            bounds["ideal_high"],
        )
    return text


def resolve_llm_temperature(llm_client: Any) -> float:
    configured = 1.5
    config = getattr(llm_client, "config", None)
    if config is not None:
        try:
            configured = float(getattr(config, "chat_temperature", configured) or configured)
        except Exception:
            configured = 1.5
    return max(0.0, min(configured, 2.0))


def resolve_context_window_tokens(llm_client: Any) -> int:
    configured = 32768
    config = getattr(llm_client, "config", None)
    if config is not None:
        configured = max(4096, int(getattr(config, "context_window_tokens", configured) or configured))
    return configured


def compact_previous_chapters(previous: List[str], max_total_chars: int) -> List[str]:
    if max_total_chars <= 0:
        return []
    kept: List[str] = []
    remaining = max_total_chars
    for raw in reversed(previous):
        text = (raw or "").strip()
        if not text:
            continue
        if remaining <= 0:
            break
        if len(text) > remaining:
            text = text[-remaining:]
        kept.append(text)
        remaining -= len(text)
    kept.reverse()
    return kept


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
    chapter.first_pass_ok = bool(consistency["can_submit"])
    chapter.memory_hit_count = len(trace.memory_hits or [])
    chapter.p0_conflict_count = int(consistency["p0_count"])
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
            recall_hit_rate=1.0 if (trace.memory_hits and len(trace.memory_hits) > 0) else 0.0,
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
    draft_max_tokens = resolve_draft_max_tokens(studio.llm_client, req.target_words)
    draft_temperature = resolve_llm_temperature(studio.llm_client)
    context_window_tokens = resolve_context_window_tokens(studio.llm_client)
    # Reserve completion + safety buffer, then spend the rest on prior chapter context.
    input_budget = max(4096, context_window_tokens - draft_max_tokens - 2048)

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
            "target_words": req.target_words,
            "previous_chapters": compact_previous_chapters(
                [
                    c.final or c.draft or ""
                    for c in chapter_list(chapter.project_id)
                    if c.chapter_number < chapter.chapter_number
                ][-5:],
                max_total_chars=int(input_budget * 0.55),
            ),
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
        draft = enforce_draft_target_words(draft, req.target_words)
        draft = await rebalance_draft_length_if_needed(
            llm_client=studio.llm_client,
            chapter=chapter,
            project=project,
            draft=draft,
            target_words=req.target_words,
        )
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
    previous_chapters = compact_previous_chapters(
        previous_chapters,
        max_total_chars=int(input_budget * 0.65),
    )
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
        async for delta in stream_chat_text_async(
            studio.llm_client,
            messages,
            temperature=draft_temperature,
            max_tokens=draft_max_tokens,
        ):
            if not delta:
                continue
            streamed_parts.append(delta)
            maybe = stream_chunk(delta)
            if inspect.isawaitable(maybe):
                await maybe
        raw = "".join(streamed_parts)
        if not raw:
            fallback_raw = await asyncio.to_thread(
                studio.llm_client.chat,
                messages,
                temperature=draft_temperature,
                max_tokens=draft_max_tokens,
            )
            raw = fallback_raw if isinstance(fallback_raw, str) else str(fallback_raw)
    else:
        raw = await asyncio.to_thread(
            studio.llm_client.chat,
            messages,
            temperature=draft_temperature,
            max_tokens=draft_max_tokens,
        )
        if not isinstance(raw, str):
            raw = str(raw)
    draft = workflow._sanitize_draft(raw, chapter, chapter.plan)
    draft = enforce_draft_target_words(draft, req.target_words)
    draft = await rebalance_draft_length_if_needed(
        llm_client=studio.llm_client,
        chapter=chapter,
        project=project,
        draft=draft,
        target_words=req.target_words,
    )
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
    template_id: Optional[str] = None
    target_length: int = 300000
    taboo_constraints: List[str] = Field(default_factory=list)


class BatchDeleteProjectsRequest(BaseModel):
    project_ids: List[str] = Field(default_factory=list)


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


class ExternalPublishRequest(BaseModel):
    book_id: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    timeout_sec: int = Field(default=300, ge=30, le=900)


class ExternalCreateBookRequest(BaseModel):
    title: Optional[str] = None
    intro: Optional[str] = None
    protagonist1: Optional[str] = None
    protagonist2: Optional[str] = None
    target_reader: str = Field(default="male")
    timeout_sec: int = Field(default=300, ge=30, le=900)


class FanqieCreateSuggestionRequest(BaseModel):
    prompt: Optional[str] = None


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
    continuation_mode: bool = False


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
    continuation_mode: bool = False


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


def _tail_text(value: str, max_chars: int = 4000) -> str:
    text = (value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[-max_chars:]


def _resolve_book_id_from_automation_config(automation_dir: Path) -> str:
    candidates = [
        automation_dir / "config" / "local.json",
        automation_dir / "config" / "example.json",
    ]
    for path in candidates:
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        chapter_cfg = payload.get("chapter") if isinstance(payload, dict) else None
        if isinstance(chapter_cfg, dict):
            book_id = str(chapter_cfg.get("bookId") or "").strip()
            if book_id:
                return book_id
    return ""


def _resolve_book_id_from_state_file(automation_dir: Path) -> str:
    state_path = automation_dir / "state" / "book-ids.json"
    if not state_path.exists():
        return ""
    try:
        payload = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    if not isinstance(payload, dict):
        return ""
    latest = str(payload.get("latestBookId") or "").strip()
    if latest:
        return latest
    history = payload.get("history")
    if not isinstance(history, list):
        return ""
    for item in reversed(history):
        if not isinstance(item, dict):
            continue
        book_id = str(item.get("bookId") or "").strip()
        if book_id:
            return book_id
    return ""


def _persist_book_id_to_automation_config(automation_dir: Path, book_id: str) -> None:
    normalized = str(book_id or "").strip()
    if not normalized:
        return

    local_cfg = automation_dir / "config" / "local.json"
    payload: Dict[str, Any] = {}
    if local_cfg.exists():
        try:
            payload = json.loads(local_cfg.read_text(encoding="utf-8"))
        except Exception:
            payload = {}
    if not isinstance(payload, dict):
        payload = {}
    chapter_cfg = payload.get("chapter")
    if not isinstance(chapter_cfg, dict):
        chapter_cfg = {}
    chapter_cfg["bookId"] = normalized
    payload["chapter"] = chapter_cfg
    local_cfg.parent.mkdir(parents=True, exist_ok=True)
    local_cfg.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    state_path = automation_dir / "state" / "book-ids.json"
    state_payload: Dict[str, Any] = {}
    if state_path.exists():
        try:
            state_payload = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            state_payload = {}
    if not isinstance(state_payload, dict):
        state_payload = {}
    history_raw = state_payload.get("history")
    history: List[Dict[str, Any]] = []
    if isinstance(history_raw, list):
        for item in history_raw[-49:]:
            if isinstance(item, dict):
                history.append(item)
    history.append(
        {
            "bookId": normalized,
            "at": datetime.now().isoformat(),
            "mode": "backend-detect",
            "source": "api.publish.auto-detect",
            "status": None,
            "title": "",
        }
    )
    state_payload["latestBookId"] = normalized
    state_payload["history"] = history[-50:]
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _extract_book_id_from_create_output(stdout: str) -> str:
    text = str(stdout or "")
    patterns = [
        r"persisted_book_id=(\d+)",
        r'"latestBookId"\s*:\s*"(\d+)"',
        r'"book_id"\s*:\s*"(\d+)"',
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return str(match.group(1) or "").strip()
    return ""


def _build_fanqie_intro(project: Project, provided_intro: Optional[str] = None) -> str:
    intro = str(provided_intro or "").strip()
    fallback = (
        f"《{project.name}》是一部{project.genre}题材的中长篇小说，整体文风偏{project.style}。"
        "故事围绕核心人物在连续危机中的选择与代价展开，兼具悬念推进、世界观铺陈与人物弧光，"
        "以稳定节奏持续输出剧情张力。"
    )
    if len(intro) >= 50:
        return intro[:500]
    if intro:
        merged = f"{intro}\n\n{fallback}".strip()
        return merged[:500]
    return fallback[:500]


def _extract_first_json_object(text: str) -> Dict[str, Any]:
    raw = str(text or "").strip()
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        pass

    start = raw.find("{")
    if start < 0:
        return {}
    depth = 0
    for idx in range(start, len(raw)):
        ch = raw[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = raw[start : idx + 1]
                try:
                    payload = json.loads(candidate)
                    return payload if isinstance(payload, dict) else {}
                except Exception:
                    return {}
    return {}


def _normalize_fanqie_target_reader(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return "male"
    if text in {"female", "f", "0", "女", "女频"}:
        return "female"
    if "女" in text:
        return "female"
    return "male"


def _normalize_fanqie_role_name(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.split(r"[，。,.!?！？\s]+", text)[0].strip()
    return text[:5]


def _derive_fanqie_role_candidates(project_id: str) -> List[str]:
    names: List[str] = []
    try:
        for chapter in chapter_list(project_id):
            for source in [chapter.title, chapter.goal, chapter.final or chapter.draft or ""]:
                for name in extract_graph_role_names(source, max_names=8):
                    if name and name not in names:
                        names.append(name)
                    if len(names) >= 6:
                        return names
    except Exception:
        return names
    return names


def _bind_project_fanqie_book_id(project: Project, book_id: str) -> bool:
    normalized = str(book_id or "").strip()
    if not normalized:
        return False
    if getattr(project, "fanqie_book_id", None) == normalized:
        return False
    project.fanqie_book_id = normalized
    project.updated_at = datetime.now()
    save_project(project)
    return True


async def _detect_book_id_via_playwright(automation_dir: Path, timeout_sec: int = 45) -> str:
    env = os.environ.copy()
    env["FANQIE_NON_INTERACTIVE"] = "1"
    proc = await asyncio.create_subprocess_exec(
        "node",
        "src/run.js",
        "detect-book-id",
        cwd=str(automation_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        stdout_bytes, _stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return ""
    if proc.returncode != 0:
        return ""

    stdout = (stdout_bytes or b"").decode("utf-8", errors="replace")
    match = re.search(r"detect_book_ids=(\{.*\})", stdout)
    if not match:
        return ""
    try:
        payload = json.loads(match.group(1))
    except Exception:
        return ""
    ids = payload.get("bookIds") if isinstance(payload, dict) else None
    latest = ""
    if isinstance(payload, dict):
        latest = str(payload.get("latestBookId") or "").strip()
    if latest:
        return latest
    if isinstance(ids, list) and ids:
        normalized_ids: List[str] = []
        for item in ids:
            candidate = str(item or "").strip()
            if candidate:
                normalized_ids.append(candidate)
        if not normalized_ids:
            return ""
        numeric_ids = [x for x in normalized_ids if x.isdigit()]
        if numeric_ids:
            return max(numeric_ids, key=lambda x: int(x))
        return normalized_ids[-1]
    return ""


bootstrap_state()


@app.get("/api/story-templates")
async def get_story_templates():
    return {"templates": list_story_templates()}


@app.get("/api/projects")
async def list_projects():
    sync_projects_index_from_disk()
    response = []
    for project in sorted(projects.values(), key=lambda p: p.created_at, reverse=True):
        entity_count, event_count = get_project_graph_counts(project.id)
        response.append(
            {
                "id": project.id,
                "name": project.name,
                "genre": project.genre,
                "style": project.style,
                "template_id": project.template_id,
                "fanqie_book_id": project.fanqie_book_id,
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
    sync_projects_index_from_disk()
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
    sync_projects_index_from_disk()
    if req.project_id:
        project = resolve_project(req.project_id)
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
        "effective_base_url": runtime["effective_base_url"],
        "provider_switch_reason": runtime["provider_switch_reason"],
        "remote_requested": runtime["remote_requested"],
        "remote_effective": runtime["remote_effective"],
        "remote_ready": runtime["remote_ready"],
        "remote_auto_enabled": runtime["remote_auto_enabled"],
        "has_openai_key": runtime["has_openai_key"],
        "has_minimax_key": runtime["has_minimax_key"],
        "has_deepseek_key": runtime["has_deepseek_key"],
        "llm_temperature": settings.llm_temperature,
        "llm_max_tokens": settings.llm_max_tokens,
        "llm_context_window_tokens": settings.llm_context_window_tokens,
        "deepseek_max_tokens": settings.deepseek_max_tokens,
        "deepseek_context_window_tokens": settings.deepseek_context_window_tokens,
    }


@app.post("/api/projects/{project_id}/prompt-preview")
async def prompt_preview(project_id: str, req: PromptPreviewRequest):
    project = resolve_project(project_id)
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
        continuation_mode=False,
    )
    outline_messages = build_outline_messages(
        prompt=req.prompt,
        chapter_count=req.chapter_count,
        scope=req.scope.value,
        project=project,
        identity=identity[:2500],
        continuation_mode=False,
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
    selected_template = get_story_template(req.template_id)
    if req.template_id and not selected_template:
        raise HTTPException(status_code=400, detail="Unknown story template")

    template_taboos = selected_template.get("default_taboos", []) if selected_template else []
    merged_taboos = list(dict.fromkeys([*req.taboo_constraints, *template_taboos]))

    recommended_target_length = (
        selected_template.get("recommended", {}).get("target_length")
        if selected_template
        else None
    )
    resolved_target_length = (
        int(recommended_target_length)
        if isinstance(recommended_target_length, int) and req.target_length <= 0
        else req.target_length
    )

    project_id = str(uuid4())
    project = Project(
        id=project_id,
        name=req.name,
        genre=req.genre,
        style=req.style,
        template_id=selected_template["id"] if selected_template else None,
        target_length=resolved_target_length,
        taboo_constraints=merged_taboos,
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
        "## Story Template\n"
    )
    if selected_template:
        identity += f"- {selected_template['name']} ({selected_template['category']})\n\n"
        identity += "## Template Rules\n"
        identity += "".join(f"- {rule}\n" for rule in selected_template.get("identity_rules", []))
        identity += "\n## Template Prompt Hint\n"
        identity += f"- {selected_template.get('prompt_hint', '')}\n\n"
    else:
        identity += "- (未指定)\n\n"
    identity += (
        "## Hard Taboos\n"
    )
    if merged_taboos:
        identity += "".join(f"- {item}\n" for item in merged_taboos)
    else:
        identity += "- (无)\n"
    store.three_layer.update_identity(identity)
    store.sync_file_memories()
    logger.info(
        "project created project_id=%s name=%s genre=%s style=%s template=%s taboo_count=%d",
        project.id,
        project.name,
        project.genre,
        project.style,
        project.template_id,
        len(project.taboo_constraints),
    )

    return {
        "id": project.id,
        "name": project.name,
        "template_id": project.template_id,
        "fanqie_book_id": project.fanqie_book_id,
        "status": project.status.value,
        "created_at": project.created_at.isoformat(),
    }


@app.get("/api/projects/{project_id}/export")
async def export_project(project_id: str):
    project = resolve_project(project_id)
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
    return _delete_project_internal(project_id)


def _delete_project_internal(project_id: str, *, allow_missing: bool = False) -> Dict[str, Any]:
    project = resolve_project(project_id)
    base = project_dir_path(project_id)
    if not project and not base.exists():
        if allow_missing:
            return {"status": "missing", "project_id": project_id, "name": project_id}
        raise HTTPException(status_code=404, detail="Project not found")

    purge_project_state(project_id)

    try:
        if base.exists():
            shutil.rmtree(base)
    except Exception as exc:
        logger.exception("project delete failed project_id=%s", project_id)
        raise HTTPException(status_code=500, detail=f"Failed to delete project files: {exc}") from exc

    project_name = project.name if project else project_id
    logger.info("project deleted project_id=%s name=%s", project_id, project_name)
    return {"status": "deleted", "project_id": project_id, "name": project_name}


@app.delete("/api/projects")
async def batch_delete_projects(req: BatchDeleteProjectsRequest):
    requested = [str(project_id).strip() for project_id in req.project_ids if str(project_id).strip()]
    if not requested:
        raise HTTPException(status_code=400, detail="project_ids is required")

    unique_ids = list(dict.fromkeys(requested))
    deleted: List[Dict[str, Any]] = []
    missing: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []

    for project_id in unique_ids:
        try:
            result = _delete_project_internal(project_id, allow_missing=True)
            if result.get("status") == "deleted":
                deleted.append(result)
            else:
                missing.append(result)
        except HTTPException as exc:
            failed.append(
                {
                    "project_id": project_id,
                    "status": "failed",
                    "detail": str(exc.detail),
                }
            )
        except Exception as exc:
            logger.exception("project batch delete failed project_id=%s", project_id)
            failed.append(
                {
                    "project_id": project_id,
                    "status": "failed",
                    "detail": str(exc),
                }
            )

    return {
        "requested_count": len(unique_ids),
        "deleted_count": len(deleted),
        "missing_count": len(missing),
        "failed_count": len(failed),
        "deleted": deleted,
        "missing": missing,
        "failed": failed,
    }


@app.post("/api/projects/{project_id}/delete")
async def delete_project_compat(project_id: str):
    # Compatibility fallback for environments that do not pass through DELETE.
    return await delete_project(project_id)


@app.post("/api/projects/batch-delete")
async def batch_delete_projects_compat(req: BatchDeleteProjectsRequest):
    # Compatibility fallback for environments that do not pass through DELETE with request body.
    return await batch_delete_projects(req)


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str):
    project = resolve_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    chapters_for_project = chapter_list(project_id)
    entity_count, event_count = get_project_graph_counts(project_id)
    return {
        "id": project.id,
        "name": project.name,
        "genre": project.genre,
        "style": project.style,
        "template_id": project.template_id,
        "fanqie_book_id": project.fanqie_book_id,
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
    project = resolve_project(project_id)
    if not project:
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
            "continuation_mode": req.continuation_mode,
            "start_chapter_number": req.start_chapter_number,
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
        {
            "scope": req.scope.value,
            "chapter_count": chapter_count,
            "continuation_mode": req.continuation_mode,
        },
    )
    outline = await asyncio.to_thread(
        build_chapter_outline,
        prompt=req.prompt.strip(),
        chapter_count=chapter_count,
        scope=req.scope.value,
        project=project,
        store=store,
        studio=studio,
        continuation_mode=req.continuation_mode,
        start_chapter_number=next_number,
    )
    await emit_progress(
        progress,
        "outline_ready",
        {"count": len(outline), "outline": outline},
    )

    created: List[Dict[str, Any]] = []
    first_assigned_number: Optional[int] = None
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
        if first_assigned_number is None:
            first_assigned_number = chapter.chapter_number
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
            continuation_mode=req.continuation_mode,
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
        "continuation_mode": req.continuation_mode,
        "start_chapter_number": first_assigned_number,
        "generated_chapters": len(created),
        "chapters": created,
        "elapsed_s": elapsed,
    }
    await emit_progress(progress, "done", response_payload)
    return response_payload


@app.post("/api/projects/{project_id}/one-shot-book")
async def generate_one_shot_book(project_id: str, req: OneShotBookRequest):
    project = resolve_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    store = get_or_create_store(project_id)
    studio = get_or_create_studio(project_id)
    store.sync_file_memories()
    logger.info(
        "one-shot-book start project_id=%s scope=%s mode=%s chapter_count=%s words_per_chapter=%d auto_approve=%s continuation_mode=%s start_chapter=%s",
        project_id,
        req.scope.value,
        req.mode.value,
        req.chapter_count if req.chapter_count is not None else "default",
        req.words_per_chapter,
        req.auto_approve,
        req.continuation_mode,
        req.start_chapter_number if req.start_chapter_number is not None else "auto",
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
    project = resolve_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    store = get_or_create_store(project_id)
    studio = get_or_create_studio(project_id)
    store.sync_file_memories()
    logger.info(
        "one-shot-book stream start project_id=%s scope=%s mode=%s chapter_count=%s words_per_chapter=%d auto_approve=%s continuation_mode=%s start_chapter=%s",
        project_id,
        req.scope.value,
        req.mode.value,
        req.chapter_count if req.chapter_count is not None else "default",
        req.words_per_chapter,
        req.auto_approve,
        req.continuation_mode,
        req.start_chapter_number if req.start_chapter_number is not None else "auto",
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


def _delete_chapter_internal(chapter_id: str, *, allow_missing: bool = False) -> Dict[str, Any]:
    chapter = resolve_chapter(chapter_id)
    if not chapter:
        if allow_missing:
            return {"status": "missing", "chapter_id": chapter_id}
        raise HTTPException(status_code=404, detail="Chapter not found")

    project_id = chapter.project_id
    chapter_number = chapter.chapter_number
    chapter_title = chapter.title

    chapter_path = chapter_json_path(project_id, chapter_id)
    trace_path = trace_file(project_id, chapter_id)

    chapters.pop(chapter_id, None)
    traces.pop(chapter_id, None)

    for file_path in (chapter_path, trace_path):
        try:
            if file_path.exists():
                file_path.unlink()
        except Exception as exc:
            logger.exception("chapter delete failed file=%s chapter_id=%s", file_path, chapter_id)
            raise HTTPException(status_code=500, detail=f"Failed to delete chapter file: {exc}") from exc

    try:
        store = get_or_create_store(project_id)
        store.delete_events_for_chapter(chapter_number)
        store.delete_chapter_memory_artifacts(chapter_id, chapter_number)
        deleted_l3 = store.three_layer.delete_l3_items_for_chapter(chapter_number)
        store.sync_file_memories()
    except Exception:
        deleted_l3 = []
        logger.exception(
            "chapter delete memory cleanup failed project_id=%s chapter_id=%s chapter_no=%d",
            project_id,
            chapter_id,
            chapter_number,
        )

    project = resolve_project(project_id)
    if project:
        if not chapter_list(project_id):
            project.status = ProjectStatus.INIT
        project.updated_at = datetime.now()
        save_project(project)

    logger.info(
        "chapter deleted project_id=%s chapter_id=%s chapter_no=%d title=%s l3_deleted=%d",
        project_id,
        chapter_id,
        chapter_number,
        chapter_title,
        len(deleted_l3),
    )
    return {
        "status": "deleted",
        "project_id": project_id,
        "chapter_id": chapter_id,
        "chapter_number": chapter_number,
        "title": chapter_title,
    }


@app.delete("/api/chapters/{chapter_id}")
async def delete_chapter(chapter_id: str):
    return _delete_chapter_internal(chapter_id)


@app.post("/api/chapters/{chapter_id}/delete")
async def delete_chapter_compat(chapter_id: str):
    # Compatibility fallback for environments that do not pass through DELETE.
    return await delete_chapter(chapter_id)


@app.post("/api/chapters")
async def create_chapter(req: CreateChapterRequest):
    if not resolve_project(req.project_id):
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
    chapter = resolve_chapter(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    return chapter.model_dump(mode="json")


@app.put("/api/chapters/{chapter_id}/draft")
async def update_draft(chapter_id: str, payload: UpdateDraftRequest):
    chapter = resolve_chapter(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    project = resolve_project(chapter.project_id)
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
    chapter.p0_conflict_count = int(consistency["p0_count"])
    if chapter.first_pass_ok is None:
        chapter.first_pass_ok = bool(consistency["can_submit"])
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
    chapter = resolve_chapter(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    project = resolve_project(chapter.project_id)
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
    chapter = resolve_chapter(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    project = resolve_project(chapter.project_id)
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
    chapter = resolve_chapter(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    project = resolve_project(chapter.project_id)
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
    target_words = resolve_project_target_words(project, chapter.project_id)
    draft = await workflow.generate_draft(
        chapter,
        chapter.plan,
        {
            "identity": store.three_layer.get_identity(),
            "project_style": project.style,
            "target_words": target_words,
            "previous_chapters": [c.final or c.draft or "" for c in chapter_list(chapter.project_id) if c.chapter_number < chapter.chapter_number][-5:],
        },
    )
    draft = await rebalance_draft_length_if_needed(
        llm_client=studio.llm_client,
        chapter=chapter,
        project=project,
        draft=draft,
        target_words=target_words,
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
    chapter = resolve_chapter(chapter_id)
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
    project = resolve_project(req.project_id)
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
    chapter = resolve_chapter(req.chapter_id)
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
    if not resolve_project(project_id):
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

    embedding_runtime = resolve_embedding_runtime(runtime)
    provider_key = embedding_runtime["provider_key"] if embedding_remote_effective else ""
    embedding_provider_name = embedding_runtime["provider_name"]
    embedding_provider_base_url = embedding_runtime["provider_base_url"]
    logger.info(
        "memory query runtime project_id=%s embedding_remote_requested=%s embedding_remote_effective=%s provider=%s llm_provider=%s key_ready=%s",
        project_id,
        embedding_remote_requested,
        embedding_remote_effective,
        embedding_provider_name,
        runtime["effective_provider"],
        bool(provider_key),
    )
    if provider_key:
        embedding_provider = EmbeddingProvider(
            model_name=settings.embedding_model,
            api_key=provider_key,
            provider=embedding_provider_name,
            base_url=embedding_provider_base_url,
        )
        query_embedding = embedding_provider.embed_text(query)

    vector_store = VectorStore(str(vector_dir), settings.embedding_dimension)
    if query_embedding is not None and signature_changed:
        embedding_provider = EmbeddingProvider(
            model_name=settings.embedding_model,
            api_key=provider_key,
            provider=embedding_provider_name,
            base_url=embedding_provider_base_url,
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


@app.get("/api/projects/{project_id}/memory/source")
async def get_memory_source_file(project_id: str, source_path: str):
    if not resolve_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")

    project_root = project_dir_path(project_id).resolve()
    candidate = (project_root / source_path).resolve()
    try:
        candidate.relative_to(project_root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid source_path") from exc

    if candidate.suffix.lower() != ".md":
        raise HTTPException(status_code=400, detail="only markdown sources are supported")
    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail="source file not found")

    return FileResponse(
        str(candidate),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'inline; filename="{candidate.name}"'},
    )


@app.get("/api/trace/{chapter_id}")
async def get_trace(chapter_id: str):
    trace = traces.get(chapter_id)
    if not trace:
        chapter = resolve_chapter(chapter_id)
        if chapter:
            file = trace_file(chapter.project_id, chapter_id)
            if file.exists():
                trace_data = json.loads(file.read_text(encoding="utf-8"))
                trace = AgentTrace.model_validate(trace_data)
                traces[chapter_id] = trace
    if not trace:
        raise HTTPException(status_code=404, detail="Trace not found")
    return sanitize_trace_payload(trace)


@app.post("/api/review")
async def review_chapter(req: ReviewRequest):
    chapter = resolve_chapter(req.chapter_id)
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


@app.post("/api/projects/{project_id}/fanqie/create-book")
async def create_fanqie_book(project_id: str, req: ExternalCreateBookRequest):
    project = resolve_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    automation_dir = Path(
        os.getenv("FANQIE_AUTOMATION_DIR", str((BACKEND_ROOT.parent / "automation" / "fanqie-playwright")))
    ).expanduser().resolve()
    if not automation_dir.exists():
        raise HTTPException(status_code=500, detail=f"Automation dir not found: {automation_dir}")

    title = str(req.title or project.name or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="book title is required")
    title_trimmed = False
    if len(title) > 15:
        title = title[:15]
        title_trimmed = True

    intro = _build_fanqie_intro(project, req.intro)
    protagonist1 = str(req.protagonist1 or "").strip()[:5]
    protagonist2 = str(req.protagonist2 or "").strip()[:5]
    target_reader = str(req.target_reader or "male").strip().lower()
    if target_reader not in {"male", "female"}:
        target_reader = "male"

    config_payload = {
        "book": {
            "title": title,
            "tags": [],
            "clearExistingTags": False,
            "intro": intro,
            "protagonist1": protagonist1,
            "protagonist2": protagonist2,
            "targetReader": target_reader,
            "coverPath": "",
            "autoSubmit": True,
            "persistBookId": True,
            "persistDetectedBookId": True,
        },
        "manual": {
            "pauseAfterOpenCreate": False,
            "pauseBeforeSubmit": False,
            "fillKeepOpen": False,
        },
    }

    config_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".json",
            prefix=f"fanqie-create-{project_id}-",
            encoding="utf-8",
            delete=False,
        ) as tmp:
            json.dump(config_payload, tmp, ensure_ascii=False, indent=2)
            config_path = tmp.name

        env = os.environ.copy()
        env["FANQIE_CONFIG"] = config_path
        env["FANQIE_NON_INTERACTIVE"] = "1"
        proc = await asyncio.create_subprocess_exec(
            "node",
            "src/run.js",
            "create-book",
            cwd=str(automation_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(),
                timeout=req.timeout_sec,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise HTTPException(
                status_code=504,
                detail=f"Create book timeout after {req.timeout_sec}s",
            )

        stdout = (stdout_bytes or b"").decode("utf-8", errors="replace")
        stderr = (stderr_bytes or b"").decode("utf-8", errors="replace")
        stdout_tail = _tail_text(stdout, 5000)
        stderr_tail = _tail_text(stderr, 5000)
        book_id = _extract_book_id_from_create_output(stdout)
        success = proc.returncode == 0 and bool(book_id)

        if not success:
            logger.error(
                "external create book failed project_id=%s code=%s stdout_tail=%s stderr_tail=%s",
                project_id,
                proc.returncode,
                stdout_tail,
                stderr_tail,
            )
            raise HTTPException(
                status_code=500,
                detail={
                    "message": "External create book failed",
                    "exit_code": proc.returncode,
                    "stdout_tail": stdout_tail,
                    "stderr_tail": stderr_tail,
                },
            )

        try:
            _persist_book_id_to_automation_config(automation_dir, book_id)
        except Exception:
            logger.warning("persist create book_id failed book_id=%s automation_dir=%s", book_id, automation_dir)
        _bind_project_fanqie_book_id(project, book_id)

        logger.info(
            "external create book success project_id=%s book_id=%s title=%s",
            project_id,
            book_id,
            title,
        )
        return {
            "success": True,
            "project_id": project_id,
            "book_id": book_id,
            "title": title,
            "title_trimmed": title_trimmed,
            "request_applied": {
                "title": title,
                "target_reader": target_reader,
                "protagonist1": protagonist1,
                "protagonist2": protagonist2,
                "intro_length": len(intro),
            },
            "stdout_tail": stdout_tail,
        }
    finally:
        if config_path:
            try:
                temp_config = Path(config_path)
                if temp_config.exists():
                    temp_config.unlink()
            except Exception:
                logger.warning("temp config cleanup failed path=%s", config_path)


@app.post("/api/projects/{project_id}/fanqie/create-book/suggest")
async def suggest_fanqie_create_book(project_id: str, req: FanqieCreateSuggestionRequest):
    project = resolve_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    title_reference = str(project.name or "").strip()[:15]
    role_candidates = _derive_fanqie_role_candidates(project_id)
    fallback_intro = _build_fanqie_intro(project, "")
    fallback_target_reader = "male"

    chapters = chapter_list(project_id)
    recent_chapters = [
        {
            "chapter_number": ch.chapter_number,
            "title": ch.title,
            "goal": ch.goal,
            "excerpt": (ch.final or ch.draft or "")[:200],
        }
        for ch in chapters[-3:]
    ]

    prompt = str(req.prompt or "").strip()
    studio = get_or_create_studio(project_id)
    messages = [
        {
            "role": "system",
            "content": (
                "你是番茄小说创作后台助手，负责补全创建书本表单。"
                "只输出 JSON 对象，字段为 intro, protagonist1, protagonist2, target_reader。"
                "不要输出 title；title 已固定由外部引用。"
                "约束：intro 50-500 字；protagonist1/2 各<=5 字；target_reader 只能 male 或 female。"
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "title_reference": title_reference,
                    "project_name": project.name,
                    "genre": project.genre,
                    "style": project.style,
                    "taboo_constraints": project.taboo_constraints[:8],
                    "role_candidates": role_candidates,
                    "recent_chapters": recent_chapters,
                    "extra_instruction": prompt,
                },
                ensure_ascii=False,
            ),
        },
    ]
    raw = await asyncio.to_thread(
        studio.llm_client.chat,
        messages,
        temperature=0.7,
        max_tokens=900,
    )
    parsed = _extract_first_json_object(raw if isinstance(raw, str) else str(raw))

    intro = _build_fanqie_intro(project, str(parsed.get("intro") or "").strip())[:500]
    protagonist1 = _normalize_fanqie_role_name(parsed.get("protagonist1"))
    protagonist2 = _normalize_fanqie_role_name(parsed.get("protagonist2"))
    if not protagonist1 and role_candidates:
        protagonist1 = _normalize_fanqie_role_name(role_candidates[0])
    if not protagonist2 and len(role_candidates) > 1:
        protagonist2 = _normalize_fanqie_role_name(role_candidates[1])
    target_reader = _normalize_fanqie_target_reader(parsed.get("target_reader") or fallback_target_reader)

    logger.info(
        "fanqie create suggestion generated project_id=%s title_reference=%s target_reader=%s",
        project_id,
        title_reference,
        target_reader,
    )
    return {
        "success": True,
        "title_reference": title_reference,
        "intro": intro,
        "protagonist1": protagonist1,
        "protagonist2": protagonist2,
        "target_reader": target_reader,
        "source": "llm",
    }


@app.post("/api/chapters/{chapter_id}/publish")
async def publish_chapter_external(chapter_id: str, req: ExternalPublishRequest):
    chapter = resolve_chapter(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found")
    project = resolve_project(chapter.project_id)

    content = sanitize_narrative_for_export(req.content or chapter.final or chapter.draft or "")
    if not content:
        raise HTTPException(status_code=400, detail="No chapter content to publish")

    chapter_title = (req.title or f"第{chapter.chapter_number}章 {chapter.title}").strip()
    automation_dir = Path(
        os.getenv("FANQIE_AUTOMATION_DIR", str((BACKEND_ROOT.parent / "automation" / "fanqie-playwright")))
    ).expanduser().resolve()
    if not automation_dir.exists():
        raise HTTPException(status_code=500, detail=f"Automation dir not found: {automation_dir}")

    book_id = (req.book_id or "").strip()
    book_id_source = "request"
    if not book_id and project and project.fanqie_book_id:
        book_id = str(project.fanqie_book_id).strip()
        if book_id:
            book_id_source = "project.binding"
    if not book_id:
        env_book_id = (os.getenv("FANQIE_BOOK_ID") or "").strip()
        if env_book_id:
            book_id = env_book_id
            book_id_source = "env"
    if not book_id:
        book_id = _resolve_book_id_from_automation_config(automation_dir)
        if book_id:
            book_id_source = "config.local"
    if not book_id:
        book_id = _resolve_book_id_from_state_file(automation_dir)
        if book_id:
            book_id_source = "state.book-ids"
    if not book_id:
        book_id = await _detect_book_id_via_playwright(automation_dir)
        if book_id:
            book_id_source = "detect-book-id"
            try:
                _persist_book_id_to_automation_config(automation_dir, book_id)
                logger.info("persisted detected book_id=%s automation_dir=%s", book_id, automation_dir)
            except Exception:
                logger.warning("persist detected book_id failed book_id=%s automation_dir=%s", book_id, automation_dir)
    if not book_id:
        raise HTTPException(
            status_code=400,
            detail=(
                "book_id is required and auto-detect failed. "
                "请在请求里传 book_id，或设置 FANQIE_BOOK_ID，或在 "
                "automation/fanqie-playwright/config/local.json 里配置 chapter.bookId，"
                "也可先运行 create-book / detect-book-id 持久化 bookId"
            ),
        )

    config_payload = {
        "chapter": {
            "bookId": book_id,
            "number": str(chapter.chapter_number),
            "title": chapter_title,
            "content": content,
            "autoPublish": True,
            "clearBeforeInput": True,
            "collapseParagraphBlankLines": True,
        },
        "manual": {
            "pauseAfterOpenPublish": False,
            "pauseBeforePublish": False,
        },
        "selectors": {
            "publishButton": [
                "button:has-text('下一步')",
                "button:has-text('发布章节')",
                "button:has-text('发布')",
            ],
            "publishConfirmButton": [
                "button:has-text('确认发布')",
                "button:has-text('确定发布')",
                "button:has-text('确认')",
            ],
        },
    }

    config_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".json",
            prefix=f"fanqie-publish-{chapter_id}-",
            encoding="utf-8",
            delete=False,
        ) as tmp:
            json.dump(config_payload, tmp, ensure_ascii=False, indent=2)
            config_path = tmp.name

        env = os.environ.copy()
        env["FANQIE_CONFIG"] = config_path
        env["FANQIE_NON_INTERACTIVE"] = "1"
        proc = await asyncio.create_subprocess_exec(
            "node",
            "src/run.js",
            "publish-chapter",
            cwd=str(automation_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(),
                timeout=req.timeout_sec,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise HTTPException(
                status_code=504,
                detail=f"Publish timeout after {req.timeout_sec}s",
            )

        stdout = (stdout_bytes or b"").decode("utf-8", errors="replace")
        stderr = (stderr_bytes or b"").decode("utf-8", errors="replace")
        stdout_tail = _tail_text(stdout, 5000)
        stderr_tail = _tail_text(stderr, 5000)
        success = proc.returncode == 0 and "publish_article status=200 code=0" in stdout

        if not success:
            logger.error(
                "external publish failed chapter_id=%s code=%s stdout_tail=%s stderr_tail=%s",
                chapter_id,
                proc.returncode,
                stdout_tail,
                stderr_tail,
            )
            raise HTTPException(
                status_code=500,
                detail={
                    "message": "External publish failed",
                    "exit_code": proc.returncode,
                    "stdout_tail": stdout_tail,
                    "stderr_tail": stderr_tail,
                },
            )

        logger.info(
            "external publish success chapter_id=%s chapter_no=%d book_id=%s source=%s",
            chapter.id,
            chapter.chapter_number,
            book_id,
            book_id_source,
        )
        if project:
            _bind_project_fanqie_book_id(project, book_id)
        return {
            "success": True,
            "chapter_id": chapter.id,
            "chapter_number": chapter.chapter_number,
            "book_id": book_id,
            "book_id_source": book_id_source,
            "stdout_tail": stdout_tail,
        }
    finally:
        if config_path:
            try:
                temp_config = Path(config_path)
                if temp_config.exists():
                    temp_config.unlink()
            except Exception:
                logger.warning("temp config cleanup failed path=%s", config_path)


@app.get("/api/metrics")
async def get_metrics(project_id: Optional[str] = None):
    return collect_project_metrics(project_id)


@app.get("/api/entities/{project_id}")
async def get_entities(project_id: str):
    if not resolve_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    if not settings.graph_feature_enabled:
        return []
    store = get_or_create_store(project_id)
    entities = sanitize_graph_entities(store.get_all_entities())
    return [entity.model_dump(mode="json") for entity in entities]


@app.get("/api/events/{project_id}")
async def get_events(project_id: str):
    if not resolve_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    if not settings.graph_feature_enabled:
        return []
    store = get_or_create_store(project_id)
    events = sanitize_graph_events(store.get_all_events())
    return [event.model_dump(mode="json") for event in events]


@app.get("/api/identity/{project_id}")
async def get_identity(project_id: str):
    if not resolve_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    store = get_or_create_store(project_id)
    return {"content": store.three_layer.get_identity()}


@app.put("/api/identity/{project_id}")
async def update_identity(project_id: str, payload: IdentityUpdateRequest):
    if not resolve_project(project_id):
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
