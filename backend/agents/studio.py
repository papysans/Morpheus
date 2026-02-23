import json
import re
import inspect
import asyncio
import threading
from typing import Any, Callable, Dict, List, Optional
from datetime import datetime
from uuid import uuid4
from enum import Enum

from models import AgentRole, AgentDecision, AgentTrace, ChapterPlan, Chapter
from core.llm_client import create_llm_client
from core.chapter_craft import (
    build_micro_arc_hint,
    collapse_blank_lines,
    compute_length_bounds,
    strip_leading_chapter_heading,
)


class AgentState(str, Enum):
    IDLE = "idle"
    THINKING = "thinking"
    ACTING = "acting"
    WAITING = "waiting"
    DONE = "done"


class Agent:
    def __init__(
        self,
        role: AgentRole,
        name: str,
        description: str,
        system_prompt: str,
        llm_client: Any = None,
    ):
        self.role = role
        self.name = name
        self.description = description
        self.system_prompt = system_prompt
        self.llm_client = llm_client
        self.state = AgentState.IDLE

    async def think(self, context: Dict[str, Any]) -> str:
        self.state = AgentState.THINKING

        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": json.dumps(context, ensure_ascii=False, indent=2, default=str)},
        ]

        result = await asyncio.to_thread(self.llm_client.chat, messages)
        if not isinstance(result, str):
            result = str(result)

        self.state = AgentState.DONE
        return result

    async def think_stream(
        self,
        context: Dict[str, Any],
        on_chunk: Optional[Callable[[str], Any]] = None,
    ) -> str:
        self.state = AgentState.THINKING
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": json.dumps(context, ensure_ascii=False, indent=2, default=str)},
        ]
        chunks: List[str] = []
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Optional[str]] = asyncio.Queue()
        worker_errors: List[Exception] = []

        def stream_worker():
            try:
                for text in self.llm_client.chat_stream_text(messages):
                    if not text:
                        continue
                    loop.call_soon_threadsafe(queue.put_nowait, text)
            except Exception as exc:
                worker_errors.append(exc)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        worker = threading.Thread(target=stream_worker, daemon=True)
        worker.start()
        try:
            while True:
                text = await queue.get()
                if text is None:
                    break
                chunks.append(text)
                if on_chunk:
                    maybe = on_chunk(text)
                    if inspect.isawaitable(maybe):
                        await maybe
        finally:
            await asyncio.to_thread(worker.join, 0.2)

        if worker_errors:
            raise worker_errors[0]

        result = "".join(chunks).strip()
        if not result:
            fallback = await asyncio.to_thread(self.llm_client.chat, messages)
            if not isinstance(fallback, str):
                fallback = str(fallback)
            result = fallback
        self.state = AgentState.DONE
        return result

    def decide(self, context: Dict[str, Any], input_refs: List[str]) -> AgentDecision:
        decision_id = str(uuid4())

        return AgentDecision(
            id=decision_id,
            agent_role=self.role,
            chapter_id=context.get("chapter_id", 0),
            input_refs=input_refs,
            decision_text="",
            rejected_options=[],
            reasoning="",
            timestamp=datetime.now(),
        )


AGENT_PROMPTS = {
    AgentRole.DIRECTOR: {
        "name": "导演",
        "description": "分解章节目标，控制节奏与冲突推进",
        "system_prompt": """你是一位资深小说导演Agent。你的职责是：
1. 将章节目标拆分为可执行节拍（开场触发→推进对抗→反转/新信息→余震钩子）
2. 设计“人物主动决策导致代价上升”的关键节点
3. 规划伏笔埋入与局部回收，不得单章终结主线
4. 给核心角色分配可验证的本章目标

输出必须是 JSON 对象，不要解释，不要 Markdown：
{
  "beats": ["..."],
  "conflicts": ["..."],
  "foreshadowing": ["..."],
  "callback_targets": ["..."],
  "role_goals": {"角色A":"..."}
}

要求：
- beats 3-6条，按时间顺序，且至少包含一次“反转或信息位移”
- conflicts 至少2条，必须有外部阻力与内部价值冲突
- callback_targets 至少1条，且不可回收全部伏笔
""",
    },
    AgentRole.SETTER: {
        "name": "设定官",
        "description": "维护世界观与角色硬约束",
        "system_prompt": """你是一位设定官Agent。你的职责是：
1. 确保本章内容符合世界观规则
2. 维护角色硬设定（能力边界、性格、背景）
3. 检查是否有违禁忌约束
4. 提取本章新设定并记录

请严格检查一致性，如果发现问题请明确指出。""",
    },
    AgentRole.CONTINUITY: {
        "name": "连续性审校",
        "description": "执行时间线、关系链、事实冲突检查",
        "system_prompt": """你是一位连续性审校Agent。你的职责是：
1. 检查时间线一致性（先后顺序、年龄、里程碑）
2. 检查角色状态一致性（生死、伤病、立场、能力边界）
3. 检查关系一致性（亲疏、敌友、承诺与背叛）
4. 检查世界规则一致性（魔法/科技/制度约束）
5. 检查伏笔兑现一致性

请输出每个检查项的结果，如有冲突请详细说明。""",
    },
    AgentRole.STYLIST: {
        "name": "文风润色",
        "description": "在不破坏事实前提下优化叙事表现",
        "system_prompt": """你是一位文风润色Agent。你的职责是：
1. 优化叙事节奏和表现力
2. 保持角色对话风格一致
3. 增强场景描写和氛围
4. 在不改变事实的前提下提升文字质量

请在不破坏原有设定和情节的前提下进行润色。""",
    },
    AgentRole.ARBITER: {
        "name": "裁决器",
        "description": "合并意见并输出最终草稿建议",
        "system_prompt": """你是一位裁决器Agent。你的职责是：
1. 综合各Agent的意见
2. 解决Agent之间的分歧
3. 生成最终草稿
4. 做出最终决策

请权衡各方意见，给出最佳方案。
输出正文时必须：
- 只输出小说正文，不要解释，不要标题行（如“第X章”）
- 保留章节节奏：开场触发、对抗升级、反转或新信息、章尾钩子
- 不得在单章内解决全部核心矛盾
""",
    },
}


class AgentStudio:
    def __init__(
        self,
        provider: str = "minimax",
        model: Optional[str] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        chat_max_tokens: Optional[int] = None,
        chat_temperature: Optional[float] = None,
        context_window_tokens: Optional[int] = None,
    ):
        self.provider = provider
        self.llm_client = create_llm_client(
            provider=provider,
            api_key=api_key,
            model=model,
            base_url=base_url,
            chat_max_tokens=chat_max_tokens,
            chat_temperature=chat_temperature,
            context_window_tokens=context_window_tokens,
        )
        self.agents: Dict[AgentRole, Agent] = {}
        self.trace: Optional[AgentTrace] = None
        self._init_agents()

    def _init_agents(self):
        for role, config in AGENT_PROMPTS.items():
            self.agents[role] = Agent(
                role=role,
                name=config["name"],
                description=config["description"],
                system_prompt=config["system_prompt"],
                llm_client=self.llm_client,
            )

    def get_agent(self, role: AgentRole) -> Optional[Agent]:
        return self.agents.get(role)

    def start_trace(self, chapter_id: int) -> AgentTrace:
        self.trace = AgentTrace(
            id=str(uuid4()),
            chapter_id=chapter_id,
            decisions=[],
            memory_hits=[],
            conflicts_detected=[],
            final_draft=None,
            created_at=datetime.now(),
        )
        return self.trace

    def add_decision(self, decision: AgentDecision):
        if self.trace:
            self.trace.decisions.append(decision)

    def add_memory_hits(self, hits: List[Dict[str, Any]]):
        if self.trace:
            self.trace.memory_hits.extend(hits)

    def add_conflict(self, conflict):
        if self.trace:
            self.trace.conflicts_detected.append(conflict)

    def set_final_draft(self, draft: str):
        if self.trace:
            self.trace.final_draft = draft

    def get_trace(self) -> Optional[AgentTrace]:
        return self.trace


class StudioWorkflow:
    def __init__(self, studio: AgentStudio, memory_search_func: Callable):
        self.studio = studio
        self.memory_search = memory_search_func

    async def generate_plan(self, chapter: Chapter, context: Dict[str, Any]) -> ChapterPlan:
        director = self.studio.get_agent(AgentRole.DIRECTOR)

        memory_query = f"{chapter.title} {chapter.goal}".strip()
        search_results = self.memory_search(memory_query, fts_top_k=20)
        self.studio.add_memory_hits(search_results)

        ctx = {
            "chapter_id": chapter.chapter_number,
            "chapter_goal": chapter.goal,
            "previous_chapters": context.get("previous_chapters", []),
            "memory_hits": search_results[:10],
            "project_info": context.get("project_info", {}),
        }

        plan_text = await director.think(ctx)
        parsed_plan = self._extract_plan_payload(plan_text, chapter)

        plan = ChapterPlan(
            id=str(uuid4()),
            chapter_id=chapter.chapter_number,
            title=chapter.title,
            goal=chapter.goal,
            beats=parsed_plan["beats"],
            conflicts=parsed_plan["conflicts"],
            foreshadowing=parsed_plan["foreshadowing"],
            callback_targets=parsed_plan["callback_targets"],
            role_goals=parsed_plan["role_goals"],
        )

        decision = director.decide(ctx, [r["item_id"] for r in search_results[:5]])
        decision.decision_text = plan_text
        self.studio.add_decision(decision)

        return plan

    async def generate_draft(self, chapter: Chapter, plan: ChapterPlan, context: Dict[str, Any]) -> str:
        director = self.studio.get_agent(AgentRole.DIRECTOR)
        setter = self.studio.get_agent(AgentRole.SETTER)
        stylist = self.studio.get_agent(AgentRole.STYLIST)
        arbiter = self.studio.get_agent(AgentRole.ARBITER)
        target_words = context.get("target_words")
        length_instruction = self._build_length_instruction(target_words)
        rhythm_hint = build_micro_arc_hint(
            chapter_number=chapter.chapter_number,
            target_words=int(target_words or 1600),
            continuation_mode=bool(context.get("continuation_mode", False)),
        )

        memory_query = f"{chapter.title} {chapter.goal}".strip()
        memory_hits = self.memory_search(memory_query, fts_top_k=25)
        self.studio.add_memory_hits(memory_hits)

        draft_context = {
            "chapter_id": chapter.chapter_number,
            "title": chapter.title,
            "goal": chapter.goal,
            "plan": plan.model_dump(),
            "identity": context.get("identity", ""),
            "project_style": context.get("project_style", ""),
            "memory_hits": memory_hits[:12],
            "previous_chapters": context.get("previous_chapters", []),
            "rhythm_hint": rhythm_hint,
        }

        director_text = await director.think(
            {
                **draft_context,
                "instruction": (
                    "请基于计划写出章节初稿，输出纯正文。严格执行 rhythm_hint 的四段节奏，"
                    "且不得输出“第X章”标题行。"
                    f"{length_instruction}"
                ),
            }
        )
        director_decision = director.decide(
            draft_context, [item["item_id"] for item in memory_hits[:5]]
        )
        director_decision.decision_text = director_text
        self.studio.add_decision(director_decision)

        setter_text = await setter.think(
            {
                **draft_context,
                "draft": director_text,
                "instruction": "请指出本稿可能违反设定的点，并给出修订建议。",
            }
        )
        setter_decision = setter.decide(
            draft_context, [item["item_id"] for item in memory_hits[:5]]
        )
        setter_decision.decision_text = setter_text
        self.studio.add_decision(setter_decision)

        stylist_text = await stylist.think(
            {
                **draft_context,
                "draft": director_text,
                "setter_feedback": setter_text,
                "instruction": (
                    "请在不改事实的前提下润色正文。"
                    "保持节奏推进，避免把动作改成纯解释。"
                    f"{length_instruction}"
                ),
            }
        )
        stylist_decision = stylist.decide(
            draft_context, [item["item_id"] for item in memory_hits[:5]]
        )
        stylist_decision.decision_text = stylist_text
        self.studio.add_decision(stylist_decision)

        final_text = await arbiter.think(
            {
                **draft_context,
                "draft": director_text,
                "setter_feedback": setter_text,
                "stylist_draft": stylist_text,
                "instruction": (
                    "请输出最终章节正文。要求：保留事实一致性，尽量吸收润色建议，"
                    "只输出正文，不要解释，不要标题。"
                    f"{length_instruction}"
                ),
            }
        )
        arbiter_decision = arbiter.decide(
            draft_context, [item["item_id"] for item in memory_hits[:5]]
        )
        arbiter_decision.decision_text = final_text
        self.studio.add_decision(arbiter_decision)

        self.studio.set_final_draft(final_text)
        return self._sanitize_draft(final_text, chapter, plan)

    async def generate_draft_stream(
        self,
        chapter: Chapter,
        plan: ChapterPlan,
        context: Dict[str, Any],
        on_chunk: Callable[[str], Any],
    ) -> str:
        director = self.studio.get_agent(AgentRole.DIRECTOR)
        setter = self.studio.get_agent(AgentRole.SETTER)
        stylist = self.studio.get_agent(AgentRole.STYLIST)
        arbiter = self.studio.get_agent(AgentRole.ARBITER)
        target_words = context.get("target_words")
        length_instruction = self._build_length_instruction(target_words)
        rhythm_hint = build_micro_arc_hint(
            chapter_number=chapter.chapter_number,
            target_words=int(target_words or 1600),
            continuation_mode=bool(context.get("continuation_mode", False)),
        )

        memory_query = f"{chapter.title} {chapter.goal}".strip()
        memory_hits = self.memory_search(memory_query, fts_top_k=25)
        self.studio.add_memory_hits(memory_hits)

        draft_context = {
            "chapter_id": chapter.chapter_number,
            "title": chapter.title,
            "goal": chapter.goal,
            "plan": plan.model_dump(),
            "identity": context.get("identity", ""),
            "project_style": context.get("project_style", ""),
            "memory_hits": memory_hits[:12],
            "previous_chapters": context.get("previous_chapters", []),
            "rhythm_hint": rhythm_hint,
        }

        # Keep director output internal. Director prompt is structured-planning oriented
        # and may emit JSON-like content that should not be shown to readers.
        director_text = await director.think(
            {
                **draft_context,
                "instruction": (
                    "请基于计划写出章节初稿，输出纯正文。严格执行 rhythm_hint 的四段节奏，"
                    "且不得输出“第X章”标题行。"
                    f"{length_instruction}"
                ),
            },
        )
        director_decision = director.decide(
            draft_context, [item["item_id"] for item in memory_hits[:5]]
        )
        director_decision.decision_text = director_text
        self.studio.add_decision(director_decision)

        setter_text = await setter.think(
            {
                **draft_context,
                "draft": director_text,
                "instruction": "请指出本稿可能违反设定的点，并给出修订建议。",
            }
        )
        setter_decision = setter.decide(
            draft_context, [item["item_id"] for item in memory_hits[:5]]
        )
        setter_decision.decision_text = setter_text
        self.studio.add_decision(setter_decision)

        stylist_text = await stylist.think(
            {
                **draft_context,
                "draft": director_text,
                "setter_feedback": setter_text,
                "instruction": (
                    "请在不改事实的前提下润色正文。"
                    "保持节奏推进，避免把动作改成纯解释。"
                    f"{length_instruction}"
                ),
            }
        )
        stylist_decision = stylist.decide(
            draft_context, [item["item_id"] for item in memory_hits[:5]]
        )
        stylist_decision.decision_text = stylist_text
        self.studio.add_decision(stylist_decision)

        # Stream only the final arbiter output to avoid leaking intermediate planning text.
        final_text = await arbiter.think_stream(
            {
                **draft_context,
                "draft": director_text,
                "setter_feedback": setter_text,
                "stylist_draft": stylist_text,
                "instruction": (
                    "请输出最终章节正文。要求：保留事实一致性，尽量吸收润色建议，"
                    "只输出正文，不要解释，不要标题。"
                    f"{length_instruction}"
                ),
            },
            on_chunk=on_chunk,
        )
        arbiter_decision = arbiter.decide(
            draft_context, [item["item_id"] for item in memory_hits[:5]]
        )
        arbiter_decision.decision_text = final_text
        self.studio.add_decision(arbiter_decision)

        self.studio.set_final_draft(final_text)
        return self._sanitize_draft(final_text, chapter, plan)

    async def check_consistency(
        self, draft: str, chapter: Chapter, context: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        continuity = self.studio.get_agent(AgentRole.CONTINUITY)
        setter = self.studio.get_agent(AgentRole.SETTER)

        search_results = self.memory_search(draft, fts_top_k=30)
        self.studio.add_memory_hits(search_results)

        ctx = {
            "draft": draft,
            "chapter_id": chapter.chapter_number,
            "memory_hits": search_results[:15],
            "entities": context.get("entities", []),
            "events": context.get("events", []),
        }

        consistency_result = await continuity.think(ctx)

        setter_result = await setter.think(ctx)

        results = [
            {"agent": "continuity", "result": consistency_result},
            {"agent": "setter", "result": setter_result},
        ]

        return results

    async def polish(self, draft: str, context: Dict[str, Any]) -> str:
        stylist = self.studio.get_agent(AgentRole.STYLIST)

        ctx = {
            "draft": draft,
            "style_guide": context.get("style_guide", ""),
            "project_style": context.get("project_style", ""),
        }

        polished = await stylist.think(ctx)

        return polished

    async def finalize(self, draft: str, context: Dict[str, Any]) -> str:
        arbiter = self.studio.get_agent(AgentRole.ARBITER)

        ctx = {
            "draft": draft,
            "consistency_results": context.get("consistency_results", []),
            "polish_suggestions": context.get("polish_suggestions", ""),
            "memory_hits": self.studio.trace.memory_hits if self.studio.trace else [],
        }

        final = await arbiter.think(ctx)

        self.studio.set_final_draft(final)

        return final

    def _extract_list(self, text: str, key: str) -> List[str]:
        try:
            import re

            pattern = rf'"{key}"\s*:\s*\[(.*?)\]'
            match = re.search(pattern, text, re.DOTALL)
            if match:
                items = re.findall(r'"([^"]+)"', match.group(1))
                return items
        except Exception:
            pass
        return []

    def _strip_json_fence(self, text: str) -> str:
        payload = (text or "").strip()
        payload = re.sub(r"^```(?:json)?", "", payload).strip()
        payload = re.sub(r"```$", "", payload).strip()
        return payload

    def _load_json_object_payload(self, text: str) -> Optional[Dict[str, Any]]:
        payload = self._strip_json_fence(text)
        if not payload:
            return None

        candidates = [payload]
        start = payload.find("{")
        end = payload.rfind("}")
        if start >= 0 and end > start:
            candidates.append(payload[start : end + 1])

        for candidate in candidates:
            try:
                parsed = json.loads(candidate)
            except Exception:
                continue
            if isinstance(parsed, dict):
                return parsed
        return None

    def _extract_dict(self, text: str, key: str) -> Dict[str, str]:
        try:
            import re

            pattern = rf'"{key}"\s*:\s*\{{(.*?)\}}'
            match = re.search(pattern, text, re.DOTALL)
            if match:
                pairs = re.findall(r'"([^"]+)"\s*:\s*"([^"]+)"', match.group(1))
                return dict(pairs)
        except Exception:
            pass
        return {}

    def _normalize_role_goals(self, value: Any) -> Dict[str, str]:
        if not isinstance(value, dict):
            return {}
        ignored_keys = {
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
        normalized: Dict[str, str] = {}
        for raw_key, raw_goal in value.items():
            key = str(raw_key).strip()
            goal = str(raw_goal).strip() if raw_goal is not None else ""
            if not key or not goal:
                continue
            if key.lower() in ignored_keys:
                continue
            normalized[key] = goal
        return normalized

    def _extract_plan_payload(self, text: str, chapter: Chapter) -> Dict[str, Any]:
        payload = self._load_json_object_payload(text)
        if payload:
            return {
                "beats": self._normalize_list(payload.get("beats")),
                "conflicts": self._normalize_list(payload.get("conflicts")),
                "foreshadowing": self._normalize_list(payload.get("foreshadowing")),
                "callback_targets": self._normalize_list(payload.get("callback_targets")),
                "role_goals": self._normalize_role_goals(payload.get("role_goals")),
            }

        beats = self._extract_list(text, "beats")
        conflicts = self._extract_list(text, "conflicts")
        foreshadowing = self._extract_list(text, "foreshadowing")
        callback_targets = self._extract_list(text, "callback_targets")
        role_goals = self._normalize_role_goals(self._extract_dict(text, "role_goals"))

        if not beats:
            beats = [
                f"开场建立章节目标：{chapter.goal}",
                "中段制造冲突并推进人物关系",
                "结尾留下悬念或下一章引子",
            ]
        if not conflicts:
            conflicts = ["主角目标与外部阻力发生碰撞", "内部价值观冲突抬升"]
        if not foreshadowing:
            foreshadowing = [f"围绕“{chapter.title}”埋下可回收细节"]
        if not callback_targets:
            callback_targets = ["回收上一章未决事项至少一项"]

        return {
            "beats": beats,
            "conflicts": conflicts,
            "foreshadowing": foreshadowing,
            "callback_targets": callback_targets,
            "role_goals": role_goals,
        }

    def _normalize_list(self, value: Any) -> List[str]:
        if not value:
            return []
        if isinstance(value, list):
            normalized: List[str] = []
            for item in value:
                text = ""
                if isinstance(item, str):
                    text = item.strip()
                elif isinstance(item, dict):
                    for key in (
                        "description",
                        "beat",
                        "content",
                        "text",
                        "goal",
                        "item",
                        "target",
                        "name",
                        "potential_use",
                    ):
                        raw = item.get(key)
                        if raw is None:
                            continue
                        candidate = str(raw).strip()
                        if candidate:
                            text = candidate
                            break
                else:
                    candidate = str(item).strip()
                    if candidate and candidate.lower() not in {"none", "null"}:
                        text = candidate

                if text and text not in normalized:
                    normalized.append(text)
            return normalized
        return []

    def _sanitize_draft(self, draft: str, chapter: Chapter, plan: ChapterPlan) -> str:
        content = (draft or "").strip()
        if "离线模式输出" in content or "请基于以下上下文继续创作并补全结构化内容" in content:
            content = ""

        # Remove common reasoning wrappers that occasionally leak into model output.
        content = re.sub(
            r"(?is)<\s*think(?:ing)?\s*>.*?<\s*/\s*think(?:ing)?\s*>",
            "",
            content,
        )
        content = re.sub(r"(?im)^\s*(thinking|thoughts?)\s*[:：].*(?:\n|$)", "", content)
        content = re.sub(r"(?is)```(?:thinking|reasoning)\s*[\s\S]*?```", "", content)

        if len(content) < 80:
            content = self._build_fallback_draft(chapter, plan)
        # Trim known wrapper labels from model outputs.
        content = re.sub(r"^```(?:markdown|md)?", "", content).strip()
        content = re.sub(r"```$", "", content).strip()
        content = strip_leading_chapter_heading(content)
        content = collapse_blank_lines(content, max_consecutive_blank=1)
        return content.strip()

    def _build_fallback_draft(self, chapter: Chapter, plan: ChapterPlan) -> str:
        beat_a = plan.beats[0] if plan.beats else "开场建立冲突"
        beat_b = plan.beats[1] if len(plan.beats) > 1 else "中段推进人物关系"
        beat_c = plan.beats[2] if len(plan.beats) > 2 else "结尾留下悬念"
        return (
            f"雪夜压城，主角在风口停住脚步，心里反复确认本章目标：{chapter.goal}。"
            "街灯被雪粒打得忽明忽暗，他意识到今晚每一个选择都会留下代价。\n\n"
            f"{beat_a}。随之而来的变故让他不得不直面最不愿触碰的真相。"
            f"{beat_b}，旧有信任开始出现裂缝，话语与沉默同样锋利。\n\n"
            f"{beat_c}。他在最后一刻看见那个关键细节，知道真正的反转仍在下一章。"
        )

    def _build_length_instruction(self, target_words: Any) -> str:
        try:
            target = int(target_words)
        except Exception:
            return ""
        if target <= 0:
            return ""
        bounds = compute_length_bounds(target)
        return (
            f" 目标字数约 {bounds['target']}，建议区间 {bounds['ideal_low']}-{bounds['ideal_high']}。"
            f" 低于 {bounds['lower']} 视为信息不足，高于 {bounds['soft_upper']} 视为冗长。"
        )
