import re
from typing import Any, Dict, List
from datetime import datetime
from uuid import uuid4

from models import Conflict, Severity, EventEdge


class ConsistencyRule:
    def __init__(self, rule_id: str, name: str, description: str):
        self.rule_id = rule_id
        self.name = name
        self.description = description

    def check(self, draft: str, context: Dict[str, Any]) -> List[Conflict]:
        raise NotImplementedError


class TimelineRule(ConsistencyRule):
    def __init__(self):
        super().__init__("R1", "时间线一致性", "检查时间顺序、年龄、里程碑")

    def check(self, draft: str, context: Dict[str, Any]) -> List[Conflict]:
        conflicts = []
        chapter_id = context.get("chapter_id", 0)
        events = context.get("events", [])
        
        time_mentions = re.findall(r"(\d{4})[年/\-]\d{1,2}(?:[月/\-]\d{0,2})?", draft)
        
        for i, event in enumerate(events):
            if event.chapter >= chapter_id:
                continue
            for year in time_mentions:
                if self._contradicts(event, int(year)):
                    conflicts.append(Conflict(
                        id=str(uuid4()),
                        severity=Severity.P1,
                        rule_id=self.rule_id,
                        evidence_paths=[f"chapter_{event.chapter}"],
                        reason=f"时间线冲突: 事件发生在第{event.chapter}章，但当前章节时间提及 {year} 可能倒置",
                        suggested_fix="调整时间顺序或更新事件记录",
                        chapter_id=chapter_id
                    ))
        
        return conflicts

    def _contradicts(self, event: EventEdge, mention_year: int) -> bool:
        if not event.timestamp:
            return False
        event_year = event.timestamp.year
        return mention_year < event_year - 1


class CharacterStateRule(ConsistencyRule):
    def __init__(self):
        super().__init__("R2", "角色状态一致性", "检查生死、伤病、立场、能力边界")

    def check(self, draft: str, context: Dict[str, Any]) -> List[Conflict]:
        conflicts = []
        chapter_id = context.get("chapter_id", 0)
        entities = context.get("entities", [])
        
        death_patterns = [
            r"死亡", r"去世", r"死了", r"被杀", r"被刺",
            r"断气", r"咽气", r"心脏停止",
        ]
        
        for entity in entities:
            if entity.entity_type != "character":
                continue
            
            is_dead = entity.attrs.get("is_dead", False)
            last_seen = entity.last_seen_chapter
            
            for pattern in death_patterns:
                if re.search(pattern, draft) and entity.name in draft:
                    if is_dead and last_seen < chapter_id:
                        conflicts.append(Conflict(
                            id=str(uuid4()),
                            severity=Severity.P0,
                            rule_id=self.rule_id,
                            evidence_paths=[f"entity_{entity.entity_id}"],
                            reason=f"角色{entity.name}已被确定死亡，但在本章出现",
                            suggested_fix="移除该角色出场、改为回忆段落，或修正角色状态",
                            chapter_id=chapter_id
                        ))
            
            abilities = entity.attrs.get("abilities", [])
            for ability in abilities:
                if f"{entity.name}不会{ability}" in draft or f"{entity.name}没有{ability}" in draft:
                    if f"{entity.name}会{ability}" in draft or f"{entity.name}有{ability}" in draft:
                        conflicts.append(Conflict(
                            id=str(uuid4()),
                            severity=Severity.P1,
                            rule_id=self.rule_id,
                            evidence_paths=[f"entity_{entity.entity_id}"],
                            reason=f"角色{entity.name}的能力设定冲突",
                            suggested_fix="统一能力描述",
                            chapter_id=chapter_id
                        ))
        
        return conflicts


class RelationRule(ConsistencyRule):
    def __init__(self):
        super().__init__("R3", "关系一致性", "检查亲疏、敌友、承诺与背叛")

    def check(self, draft: str, context: Dict[str, Any]) -> List[Conflict]:
        conflicts = []
        chapter_id = context.get("chapter_id", 0)
        events = context.get("events", [])
        
        hostile_patterns = [r"杀死", r"杀掉", r"消灭", r"对抗", r"敌对", r"背叛"]
        
        for event in events:
            if event.chapter >= chapter_id:
                continue
            if event.relation in ["friend", "ally", "love"]:
                if not event.object:
                    continue
                same_pair_present = event.subject in draft and event.object in draft
                for pattern in hostile_patterns:
                    if same_pair_present and pattern in draft:
                        conflicts.append(Conflict(
                            id=str(uuid4()),
                            severity=Severity.P1,
                            rule_id=self.rule_id,
                            evidence_paths=[f"event_{event.event_id}"],
                            reason=f"关系冲突: {event.subject}和{event.object}在第{event.chapter}章是{event.relation}关系",
                            suggested_fix="确认关系状态",
                            chapter_id=chapter_id
                        ))
        
        return conflicts


class WorldRule(ConsistencyRule):
    def __init__(self):
        super().__init__("R4", "世界规则一致性", "检查魔法/科技/制度硬约束")

    def check(self, draft: str, context: Dict[str, Any]) -> List[Conflict]:
        conflicts = []
        chapter_id = context.get("chapter_id", 0)
        identity = context.get("identity", "")
        
        forbidden_statements = []
        for line in identity.splitlines():
            stripped = line.strip("-* ").strip()
            if "不能" in stripped or "禁止" in stripped:
                forbidden_statements.append(stripped)

        normalized_draft = self._normalize_for_match(draft)
        for rule in forbidden_statements:
            for candidate in self._extract_forbidden_candidates(rule):
                if len(candidate) < 2:
                    continue
                if candidate in normalized_draft:
                    conflicts.append(
                        Conflict(
                            id=str(uuid4()),
                            severity=Severity.P0,
                            rule_id=self.rule_id,
                            evidence_paths=["IDENTITY.md"],
                            reason=f"违反世界规则: {rule}",
                            suggested_fix="改写该段，确保不违反世界规则",
                            chapter_id=chapter_id,
                        )
                    )
                    break
        
        taboo = context.get("taboo_constraints", [])
        for t in taboo:
            if t and t in draft:
                conflicts.append(Conflict(
                    id=str(uuid4()),
                    severity=Severity.P0,
                    rule_id=self.rule_id,
                    evidence_paths=["IDENTITY.md"],
                    reason=f"触发禁忌: {t}",
                    suggested_fix="移除禁忌内容",
                    chapter_id=chapter_id
                ))
        
        return conflicts

    def _normalize_for_match(self, text: str) -> str:
        normalized = re.sub(r"[\s\[\]【】()（）:：,，。；;!！?？\"'`]+", "", text)
        return normalized.strip()

    def _extract_forbidden_candidates(self, rule: str) -> List[str]:
        normalized_rule = self._normalize_for_match(rule)
        if not normalized_rule:
            return []

        candidates: List[str] = []
        if "不能" in normalized_rule:
            left, right = normalized_rule.split("不能", 1)
            if right:
                candidates.append(right)
            if left and right:
                tail = left[-2:] if len(left) > 2 else left
                candidates.append(f"{tail}{right}")
        if "禁止" in normalized_rule:
            left, right = normalized_rule.split("禁止", 1)
            if right:
                candidates.append(right)
            if left and right:
                tail = left[-2:] if len(left) > 2 else left
                candidates.append(f"{tail}{right}")

        if not candidates:
            candidates.append(normalized_rule.replace("不能", "").replace("禁止", ""))

        # Deduplicate while preserving order.
        unique: List[str] = []
        for item in candidates:
            if item and item not in unique:
                unique.append(item)
        return unique


class ForeshadowRule(ConsistencyRule):
    def __init__(self):
        super().__init__("R5", "伏笔兑现一致性", "检查埋点、回收、未决项追踪")

    def check(self, draft: str, context: Dict[str, Any]) -> List[Conflict]:
        conflicts = []
        chapter_id = context.get("chapter_id", 0)
        
        foreshadowings = context.get("foreshadowings", [])
        callbacks = context.get("callbacks", [])
        
        for fs in foreshadowings:
            if fs.get("target_chapter") == chapter_id:
                keyword = fs.get("keyword", "")
                if keyword and not any(keyword in cb for cb in callbacks):
                    conflicts.append(Conflict(
                        id=str(uuid4()),
                        severity=Severity.P2,
                        rule_id=self.rule_id,
                        evidence_paths=[f"chapter_{fs.get('source_chapter')}"],
                        reason=f"伏笔待回收: {fs.get('keyword', '')}",
                        suggested_fix="在本章中回收伏笔",
                        chapter_id=chapter_id
                    ))
        
        return conflicts


class ConsistencyEngine:
    def __init__(self):
        self.rules: List[ConsistencyRule] = [
            TimelineRule(),
            CharacterStateRule(),
            RelationRule(),
            WorldRule(),
            ForeshadowRule()
        ]

    def check(
        self,
        draft: str,
        context: Dict[str, Any]
    ) -> Dict[str, Any]:
        all_conflicts = []
        
        for rule in self.rules:
            conflicts = rule.check(draft, context)
            all_conflicts.extend(conflicts)
        
        p0_conflicts = [c for c in all_conflicts if c.severity == Severity.P0]
        p1_conflicts = [c for c in all_conflicts if c.severity == Severity.P1]
        p2_conflicts = [c for c in all_conflicts if c.severity == Severity.P2]
        
        can_submit = len(p0_conflicts) == 0
        
        return {
            "can_submit": can_submit,
            "total_conflicts": len(all_conflicts),
            "p0_count": len(p0_conflicts),
            "p1_count": len(p1_conflicts),
            "p2_count": len(p2_conflicts),
            "conflicts": [c.model_dump() for c in all_conflicts],
            "p0_conflicts": [c.model_dump() for c in p0_conflicts],
            "p1_conflicts": [c.model_dump() for c in p1_conflicts],
            "p2_conflicts": [c.model_dump() for c in p2_conflicts]
        }

    def resolve_conflict(self, conflict: Conflict, resolution: str) -> Conflict:
        conflict.resolved = True
        conflict.resolution = resolution
        conflict.resolved_at = datetime.now()
        return conflict

    def exempt_conflict(self, conflict: Conflict, reason: str) -> Conflict:
        conflict.exempted = True
        conflict.resolution = f"Exempted: {reason}"
        conflict.resolved_at = datetime.now()
        return conflict
