from datetime import datetime
from enum import Enum
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field


class Layer(str, Enum):
    L1 = "L1"
    L2 = "L2"
    L3 = "L3"


class Severity(str, Enum):
    P0 = "P0"
    P1 = "P1"
    P2 = "P2"


class ProjectStatus(str, Enum):
    INIT = "init"
    PLANNING = "planning"
    WRITING = "writing"
    REVIEWING = "reviewing"
    COMPLETED = "completed"


class ChapterStatus(str, Enum):
    DRAFT = "draft"
    REVIEWING = "reviewing"
    REVISED = "revised"
    APPROVED = "approved"


class AgentRole(str, Enum):
    DIRECTOR = "director"
    SETTER = "setter"
    CONTINUITY = "continuity"
    STYLIST = "stylist"
    ARBITER = "arbiter"


class MemoryItem(BaseModel):
    id: str
    layer: Layer
    source_path: str
    summary: str
    content: str
    embedding: Optional[List[float]] = None
    entities: List[str] = Field(default_factory=list)
    time_span: Optional[Dict[str, str]] = None
    importance: int = Field(default=5, ge=1, le=10)
    recency: int = Field(default=1, ge=1, le=10)
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class EntityState(BaseModel):
    entity_id: str
    entity_type: str
    name: str
    attrs: Dict[str, Any] = Field(default_factory=dict)
    constraints: List[str] = Field(default_factory=list)
    first_seen_chapter: int = 0
    last_seen_chapter: int = 0
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)


class EventEdge(BaseModel):
    event_id: str
    subject: str
    relation: str
    object: Optional[str] = None
    chapter: int
    timestamp: Optional[datetime] = None
    confidence: float = Field(default=1.0, ge=0, le=1)
    description: str = ""
    created_at: datetime = Field(default_factory=datetime.now)


class Conflict(BaseModel):
    id: str
    severity: Severity
    rule_id: str
    evidence_paths: List[str] = Field(default_factory=list)
    reason: str
    suggested_fix: Optional[str] = None
    chapter_id: int
    resolved: bool = False
    exempted: bool = False
    resolution: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.now)
    resolved_at: Optional[datetime] = None


class Project(BaseModel):
    id: str
    name: str
    genre: str
    style: str
    template_id: Optional[str] = None
    fanqie_book_id: Optional[str] = None
    target_length: int = 300000
    taboo_constraints: List[str] = Field(default_factory=list)
    status: ProjectStatus = ProjectStatus.INIT
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)


class ChapterPlan(BaseModel):
    id: str
    chapter_id: int
    title: str
    goal: str
    beats: List[str] = Field(default_factory=list)
    conflicts: List[str] = Field(default_factory=list)
    foreshadowing: List[str] = Field(default_factory=list)
    callback_targets: List[str] = Field(default_factory=list)
    role_goals: Dict[str, str] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=datetime.now)


class Chapter(BaseModel):
    id: str
    project_id: str
    chapter_number: int
    title: str
    goal: str
    plan: Optional[ChapterPlan] = None
    draft: Optional[str] = None
    final: Optional[str] = None
    status: ChapterStatus = ChapterStatus.DRAFT
    word_count: int = 0
    first_pass_ok: Optional[bool] = None
    memory_hit_count: int = 0
    p0_conflict_count: int = 0
    conflicts: List[Conflict] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)


class AgentDecision(BaseModel):
    id: str
    agent_role: AgentRole
    chapter_id: int
    input_refs: List[str] = Field(default_factory=list)
    decision_text: str
    rejected_options: List[str] = Field(default_factory=list)
    reasoning: str = ""
    timestamp: datetime = Field(default_factory=datetime.now)


class AgentTrace(BaseModel):
    id: str
    chapter_id: int
    decisions: List[AgentDecision] = Field(default_factory=list)
    memory_hits: List[Dict[str, Any]] = Field(default_factory=list)
    conflicts_detected: List[Conflict] = Field(default_factory=list)
    final_draft: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.now)


class SearchResult(BaseModel):
    item_id: str
    layer: Layer
    source_path: str
    summary: str
    score: float
    evidence: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class HybridSearchResult(BaseModel):
    results: List[SearchResult]
    total_score: float
    sources: Dict[str, int] = Field(default_factory=dict)


class ReviewAction(str, Enum):
    APPROVE = "approve"
    REJECT = "reject"
    REWRITE = "rewrite"
    EXEMPT = "exempt"
    RESCAN = "rescan"


class ReviewRecord(BaseModel):
    id: str
    chapter_id: int
    action: ReviewAction
    comment: str = ""
    conflicts_resolved: List[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.now)


class Metrics(BaseModel):
    chapter_generation_time: float = 0
    search_time: float = 0
    conflict_check_time: float = 0
    conflicts_per_chapter: float = 0
    p0_ratio: float = 0
    exemption_rate: float = 0
    recall_hit_rate: float = 0
    false_recall_rate: float = 0
    rework_rate: float = 0
    first_pass_rate: float = 0
    chapter_id: Optional[int] = None
    project_id: Optional[str] = None
    recorded_at: datetime = Field(default_factory=datetime.now)
