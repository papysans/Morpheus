import ast
import json
import re
import inspect
import asyncio
import threading
import logging
from typing import Any, Callable, Dict, List, Optional, Tuple
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

logger = logging.getLogger("novelist.studio")


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
- beats 每条必须是“具体事件”，包含角色动作与情境变化，禁止使用抽象流程句
- conflicts 至少2条，必须有外部阻力与内部价值冲突
- callback_targets 至少1条，且不可回收全部伏笔
- 禁止模板句：如“开场建立章节目标”“中段制造冲突”“结尾留下悬念”
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
        enforce_remote_mode: bool = False,
    ):
        self.provider = provider
        self.enforce_remote_mode = bool(enforce_remote_mode)
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
        self.last_plan_quality: Dict[str, Any] = {}
        self.last_plan_debug: Dict[str, Any] = {}

    def get_last_plan_quality(self) -> Dict[str, Any]:
        return dict(self.last_plan_quality or {})

    def get_last_plan_debug(self) -> Dict[str, Any]:
        return dict(self.last_plan_debug or {})

    def _preview_text(self, text: Any, limit: int = 420) -> str:
        payload = str(text or "")
        payload = payload.replace("\r", " ").replace("\n", " ").strip()
        if len(payload) <= limit:
            return payload
        return payload[:limit] + "..."

    def _compact_plan_previous_chapters(self, previous_chapters: Any) -> List[Dict[str, Any]]:
        if not isinstance(previous_chapters, list):
            return []

        compacted: List[Dict[str, Any]] = []
        # Keep latest chapters only; planning does not need full historical drafts.
        candidates = previous_chapters[-8:]
        remaining_budget = 14000
        for item in candidates:
            if not isinstance(item, dict):
                continue
            body = str(item.get("final") or item.get("draft") or "").strip()
            excerpt = body[-520:] if body else ""
            compact_item = {
                "chapter_number": item.get("chapter_number"),
                "title": str(item.get("title") or "").strip(),
                "goal": str(item.get("goal") or "").strip(),
                "status": item.get("status"),
                "word_count": int(item.get("word_count") or 0),
                "ending_excerpt": excerpt,
            }
            serialized = json.dumps(compact_item, ensure_ascii=False)
            if len(serialized) > remaining_budget:
                excerpt_budget = max(120, remaining_budget // 3)
                compact_item["ending_excerpt"] = excerpt[-excerpt_budget:]
                serialized = json.dumps(compact_item, ensure_ascii=False)
                if len(serialized) > remaining_budget:
                    break
            compacted.append(compact_item)
            remaining_budget -= len(serialized)
            if remaining_budget <= 200:
                break
        return compacted

    def _get_agent_llm_meta(self, agent: Optional[Agent]) -> Dict[str, Any]:
        client = getattr(agent, "llm_client", None)
        getter = getattr(client, "get_last_chat_meta", None)
        if callable(getter):
            try:
                meta = getter()
                if isinstance(meta, dict):
                    return meta
            except Exception:
                return {}
        return {}

    def _contains_offline_placeholder(self, text: str) -> bool:
        content = str(text or "")
        return "离线占位输出" in content or "未配置可用模型" in content

    async def generate_plan(self, chapter: Chapter, context: Dict[str, Any]) -> ChapterPlan:
        director = self.studio.get_agent(AgentRole.DIRECTOR)

        memory_query = f"{chapter.title} {chapter.goal}".strip()
        search_results = self.memory_search(memory_query, fts_top_k=20)
        self.studio.add_memory_hits(search_results)

        previous_chapters_raw = context.get("previous_chapters", [])
        previous_chapters = self._compact_plan_previous_chapters(previous_chapters_raw)
        try:
            raw_chars = len(json.dumps(previous_chapters_raw, ensure_ascii=False))
        except Exception:
            raw_chars = len(str(previous_chapters_raw or ""))
        compact_chars = len(json.dumps(previous_chapters, ensure_ascii=False))
        logger.info(
            "plan context compact chapter_no=%s prev_raw_count=%s prev_compact_count=%s raw_chars=%s compact_chars=%s",
            chapter.chapter_number,
            len(previous_chapters_raw) if isinstance(previous_chapters_raw, list) else -1,
            len(previous_chapters),
            raw_chars,
            compact_chars,
        )

        ctx = {
            "chapter_id": chapter.chapter_number,
            "chapter_goal": chapter.goal,
            "previous_chapters": previous_chapters,
            "memory_hits": search_results[:10],
            "project_info": context.get("project_info", {}),
            # Context Pack fields
            "identity_core": context.get("identity_core", ""),
            "runtime_state": context.get("runtime_state", ""),
            "memory_compact": context.get("memory_compact", ""),
            "open_threads": context.get("open_threads", []),
        }

        plan_text = await director.think(ctx)
        initial_llm_meta = self._get_agent_llm_meta(director)
        parsed_plan, quality = self._extract_plan_payload_with_quality(plan_text, chapter)
        selected_text = plan_text

        initial_quality = dict(quality)
        retry_quality: Optional[Dict[str, Any]] = None
        retry_text = ""
        retry_llm_meta: Dict[str, Any] = {}
        selected_source = "initial"

        if "离线占位输出" in plan_text:
            logger.warning(
                "plan generation got offline placeholder chapter_no=%s text=%s",
                chapter.chapter_number,
                self._preview_text(plan_text, limit=180),
            )

        if self._should_retry_plan(quality):
            retry_ctx = {
                **ctx,
                "previous_output": plan_text,
                "quality_issues": quality.get("issues", []),
                "instruction": (
                    "上次蓝图质量不足，请完整重写。"
                    "只允许输出严格 JSON 对象，字段固定为 beats/conflicts/foreshadowing/callback_targets/role_goals。"
                    "beats 必须 3-6 条，每条都要包含具体人物动作与场景推进。"
                    "禁止使用“开场建立章节目标”“中段制造冲突”“结尾留下悬念”等模板句。"
                    "conflicts 至少 2 条，分别体现外部阻力与内部价值冲突。"
                ),
            }
            retry_text = await director.think(retry_ctx)
            retry_llm_meta = self._get_agent_llm_meta(director)
            retry_plan, retry_quality = self._extract_plan_payload_with_quality(retry_text, chapter)
            retry_quality["attempt"] = 2

            first_score = int(quality.get("score", 0))
            retry_score = int(retry_quality.get("score", 0))
            if retry_score >= first_score:
                parsed_plan = retry_plan
                quality = retry_quality
                selected_text = retry_text
                selected_source = "retry"
            quality["attempts"] = 2
            quality["retried"] = True
        else:
            quality["attempts"] = 1
            quality["retried"] = False

        self.last_plan_quality = quality
        self.last_plan_debug = {
            "selected_source": selected_source,
            "initial_output_length": len(str(plan_text or "")),
            "initial_output_preview": self._preview_text(plan_text),
            "initial_quality": initial_quality,
            "initial_llm_meta": initial_llm_meta,
            "retry_output_length": len(str(retry_text or "")),
            "retry_output_preview": self._preview_text(retry_text),
            "retry_llm_meta": retry_llm_meta,
            "retry_quality": retry_quality or {},
            "selected_quality": quality,
        }

        if self._contains_offline_placeholder(selected_text) and bool(getattr(self.studio, "enforce_remote_mode", False)):
            hints: List[str] = []
            for tag, meta in (("初次", initial_llm_meta), ("重试", retry_llm_meta)):
                if not meta:
                    continue
                reason = str(meta.get("reason") or "unknown")
                mode = str(meta.get("mode") or "unknown")
                err = str(meta.get("error") or "").strip()
                if err:
                    hints.append(f"{tag}[mode={mode}, reason={reason}, error={err}]")
                else:
                    hints.append(f"{tag}[mode={mode}, reason={reason}]")
            hint_text = "；".join(hints) if hints else "未采集到底层错误信息"
            error_message = (
                "蓝图生成失败：当前模型调用处于离线占位模式（请检查 API Key/模型配置或账单额度）。"
                f" 诊断：{hint_text}"
            )
            logger.error(
                "plan generation aborted chapter_no=%s reason=offline_placeholder initial_meta=%s retry_meta=%s",
                chapter.chapter_number,
                initial_llm_meta,
                retry_llm_meta,
            )
            raise RuntimeError(error_message)

        if str(quality.get("status", "")).lower() != "ok":
            logger.warning(
                (
                    "plan quality warning chapter_no=%s status=%s score=%s parser=%s "
                    "used_fallback=%s defaulted_fields=%s template_hits=%s selected=%s "
                    "initial_len=%s retry_len=%s preview=%s"
                ),
                chapter.chapter_number,
                quality.get("status"),
                quality.get("score"),
                quality.get("parser_source"),
                quality.get("used_fallback"),
                quality.get("defaulted_fields"),
                quality.get("template_phrase_hits"),
                selected_source,
                len(str(plan_text or "")),
                len(str(retry_text or "")),
                self._preview_text(selected_text, limit=260),
            )

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
        decision.decision_text = selected_text
        decision.reasoning = json.dumps({"plan_quality": quality}, ensure_ascii=False)
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
            "runtime_state": context.get("runtime_state", ""),
            "memory_compact": context.get("memory_compact", ""),
            "previous_chapter_synopsis": context.get("previous_chapter_synopsis", ""),
            "open_threads": context.get("open_threads", []),
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
            "runtime_state": context.get("runtime_state", ""),
            "memory_compact": context.get("memory_compact", ""),
            "previous_chapter_synopsis": context.get("previous_chapter_synopsis", ""),
            "open_threads": context.get("open_threads", []),
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

    def _load_json_object_payload_with_diag(
        self, text: str
    ) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
        payload = self._strip_json_fence(text)
        diagnostics: Dict[str, Any] = {
            "raw_length": len(payload),
            "candidate_count": 0,
            "candidates": [],
            "parsed": False,
        }
        if not payload:
            return None, diagnostics

        candidates = [payload]
        start = payload.find("{")
        end = payload.rfind("}")
        if start >= 0 and end > start:
            candidates.append(payload[start : end + 1])
        diagnostics["candidate_count"] = len(candidates)

        for index, candidate in enumerate(candidates):
            candidate_diag: Dict[str, Any] = {
                "index": index,
                "length": len(candidate),
            }
            try:
                parsed = json.loads(candidate)
                candidate_diag["parser"] = "json"
            except Exception as exc:
                candidate_diag["json_error"] = str(exc)[:240]
                try:
                    # Some models emit Python-style dicts or single quotes.
                    parsed = ast.literal_eval(candidate)
                    candidate_diag["parser"] = "ast"
                except Exception as ast_exc:
                    candidate_diag["ast_error"] = str(ast_exc)[:240]
                    diagnostics["candidates"].append(candidate_diag)
                    continue
            if isinstance(parsed, dict):
                diagnostics["parsed"] = True
                diagnostics["candidates"].append(candidate_diag)
                return parsed, diagnostics
            candidate_diag["non_dict"] = True
            diagnostics["candidates"].append(candidate_diag)
        return None, diagnostics

    def _load_json_object_payload(self, text: str) -> Optional[Dict[str, Any]]:
        payload, _ = self._load_json_object_payload_with_diag(text)
        return payload

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

    def _normalize_plan_line(self, line: str) -> str:
        cleaned = str(line or "")
        cleaned = re.sub(r"^#+\s*", "", cleaned).strip()
        cleaned = re.sub(r"^[-*•]\s*", "", cleaned).strip()
        cleaned = re.sub(r"^\d+\s*[.)、]\s*", "", cleaned).strip()
        cleaned = cleaned.strip("：: \t")
        return cleaned

    def _extract_plan_sections(self, text: str) -> Dict[str, Any]:
        lines = [line for line in str(text or "").splitlines() if line.strip()]
        if not lines:
            return {
                "beats": [],
                "conflicts": [],
                "foreshadowing": [],
                "callback_targets": [],
                "role_goals": {},
            }

        headings = {
            "beats": ("beats", "节拍"),
            "conflicts": ("conflicts", "冲突点", "冲突"),
            "foreshadowing": ("foreshadowing", "伏笔", "埋伏笔"),
            "callback_targets": ("callback_targets", "回收目标", "回收"),
            "role_goals": ("role_goals", "角色目标", "角色"),
        }

        result: Dict[str, Any] = {
            "beats": [],
            "conflicts": [],
            "foreshadowing": [],
            "callback_targets": [],
            "role_goals": {},
        }
        current_key: Optional[str] = None

        for raw in lines:
            line = self._normalize_plan_line(raw)
            if not line:
                continue

            lowered = line.lower()
            switched = False
            for key, aliases in headings.items():
                if any(lowered == alias for alias in aliases):
                    current_key = key
                    switched = True
                    break
                if any(lowered.startswith(f"{alias}:") or lowered.startswith(f"{alias}：") for alias in aliases):
                    current_key = key
                    line = line.split("：", 1)[1] if "：" in line else line.split(":", 1)[1]
                    line = self._normalize_plan_line(line)
                    switched = True
                    break
            if switched and not line:
                continue

            if current_key is None:
                continue

            if current_key == "role_goals":
                if "：" in line:
                    role, goal = line.split("：", 1)
                elif ":" in line:
                    role, goal = line.split(":", 1)
                else:
                    role, goal = "", ""
                role = role.strip()
                goal = goal.strip()
                if role and goal:
                    result["role_goals"][role] = goal
                continue

            # Skip bare section markers accidentally repeated by model.
            if line in {"冲突", "伏笔", "回收目标", "角色目标", "节拍"}:
                continue

            bucket = result[current_key]
            if isinstance(bucket, list) and line and line not in bucket:
                bucket.append(line)

        return result

    def _goal_core_text(self, chapter: Chapter) -> str:
        goal = str(chapter.goal or "").strip()
        if not goal:
            return ""
        goal = re.sub(r"^围绕[“\"].*?[”\"]推进[：:]\s*", "", goal)
        goal = re.sub(r"^围绕.+?推进[：:]\s*", "", goal)
        goal = goal.strip()
        return goal

    def _build_goal_based_beats(self, chapter: Chapter) -> List[str]:
        core = self._goal_core_text(chapter) or chapter.goal or "推进当前主线冲突"
        fragments = [frag.strip() for frag in re.split(r"[。；;！？!?\n]", core) if frag.strip()]
        if fragments:
            start = fragments[0]
            mid = fragments[1] if len(fragments) > 1 else fragments[0]
        else:
            start = core
            mid = core
        return [
            f"{start}，但行动刚启动就遭遇意外阻力。",
            f"为继续推进“{mid[:30]}”，主角必须做出高代价选择。",
            "章尾暴露新的变量，阶段目标尚未闭合。",
        ]

    def _build_goal_based_conflicts(self, chapter: Chapter) -> List[str]:
        core = self._goal_core_text(chapter) or chapter.title or "当前任务"
        return [
            f"外部：主角推进“{core[:28]}”时，遭遇来自环境或敌对方的强压阻断。",
            f"内部：主角在达成“{core[:28]}”与守住自身底线之间发生价值撕扯。",
        ]

    def _should_retry_plan(self, quality: Dict[str, Any]) -> bool:
        status = str(quality.get("status") or "").lower()
        if status == "bad":
            return True
        if bool(quality.get("used_fallback")):
            return True
        if int(quality.get("template_phrase_hits", 0)) >= 2:
            return True
        return False

    def _detect_template_phrase_hits(self, payload: Dict[str, Any]) -> int:
        markers = (
            "开场建立章节目标",
            "中段制造冲突并推进人物关系",
            "结尾留下悬念或下一章引子",
            "主角目标与外部阻力发生碰撞",
            "内部价值观冲突抬升",
            "回收上一章未决事项至少一项",
            "围绕“",
            "围绕\"",
        )
        values: List[str] = []
        for key in ("beats", "conflicts", "foreshadowing", "callback_targets"):
            values.extend(payload.get(key) or [])
        values.extend([f"{k}:{v}" for k, v in (payload.get("role_goals") or {}).items()])
        joined = "\n".join(str(item or "") for item in values)
        return sum(1 for marker in markers if marker in joined)

    def _assess_plan_quality(
        self,
        payload: Dict[str, Any],
        *,
        source: str,
        defaulted_fields: List[str],
    ) -> Dict[str, Any]:
        score = 100
        issues: List[str] = []
        warnings: List[str] = []

        beats = payload.get("beats") or []
        conflicts = payload.get("conflicts") or []
        foreshadowing = payload.get("foreshadowing") or []
        callback_targets = payload.get("callback_targets") or []
        role_goals = payload.get("role_goals") or {}

        used_fallback = source == "goal_fallback"
        if used_fallback:
            score -= 45
            issues.append("模型输出未成功解析，已启用兜底蓝图。")
        elif source != "json_object":
            score -= 10
            warnings.append("模型未返回标准 JSON，已通过容错解析。")

        if "beats" in defaulted_fields:
            score -= 18
            issues.append("节拍缺失，已自动补齐。")
        if "conflicts" in defaulted_fields:
            score -= 14
            issues.append("冲突点缺失，已自动补齐。")
        if "foreshadowing" in defaulted_fields:
            score -= 8
            warnings.append("伏笔为空，已补最小占位。")
        if "callback_targets" in defaulted_fields:
            score -= 8
            warnings.append("回收目标为空，已补最小占位。")

        if len(beats) < 3:
            score -= 25
            issues.append("节拍数量不足（应至少 3 条）。")
        if len(conflicts) < 2:
            score -= 18
            issues.append("冲突数量不足（应至少 2 条）。")
        if len(foreshadowing) < 1:
            score -= 8
        if len(callback_targets) < 1:
            score -= 8
        if not role_goals:
            score -= 6
            warnings.append("缺少角色目标，后续可在章节工作台补充。")

        avg_beat_len = 0
        if beats:
            avg_beat_len = int(sum(len(str(item)) for item in beats) / max(1, len(beats)))
        if beats and avg_beat_len < 14:
            score -= 10
            warnings.append("节拍描述偏短，可能缺少动作与因果。")

        template_phrase_hits = self._detect_template_phrase_hits(payload)
        if template_phrase_hits > 0:
            penalty = min(36, template_phrase_hits * 12)
            score -= penalty
            issues.append("检测到模板化蓝图语句，建议重试生成。")

        score = max(0, min(100, int(score)))
        if score >= 82:
            status = "ok"
        elif score >= 62:
            status = "warn"
        else:
            status = "bad"

        return {
            "status": status,
            "score": score,
            "parser_source": source,
            "used_fallback": used_fallback,
            "defaulted_fields": defaulted_fields,
            "template_phrase_hits": template_phrase_hits,
            "issues": issues,
            "warnings": warnings,
        }

    def _extract_plan_payload_with_quality(self, text: str, chapter: Chapter) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        source = "goal_fallback"
        payload, parse_diag = self._load_json_object_payload_with_diag(text)
        if payload:
            normalized = {
                "beats": self._normalize_list(payload.get("beats")),
                "conflicts": self._normalize_list(payload.get("conflicts")),
                "foreshadowing": self._normalize_list(payload.get("foreshadowing")),
                "callback_targets": self._normalize_list(payload.get("callback_targets")),
                "role_goals": self._normalize_role_goals(payload.get("role_goals")),
            }
            source = "json_object"
        else:
            beats = self._extract_list(text, "beats")
            conflicts = self._extract_list(text, "conflicts")
            foreshadowing = self._extract_list(text, "foreshadowing")
            callback_targets = self._extract_list(text, "callback_targets")
            role_goals = self._normalize_role_goals(self._extract_dict(text, "role_goals"))
            section_values = self._extract_plan_sections(text)

            if not beats:
                beats = self._normalize_list(section_values.get("beats"))
            if not conflicts:
                conflicts = self._normalize_list(section_values.get("conflicts"))
            if not foreshadowing:
                foreshadowing = self._normalize_list(section_values.get("foreshadowing"))
            if not callback_targets:
                callback_targets = self._normalize_list(section_values.get("callback_targets"))
            if not role_goals:
                role_goals = self._normalize_role_goals(section_values.get("role_goals"))

            normalized = {
                "beats": beats,
                "conflicts": conflicts,
                "foreshadowing": foreshadowing,
                "callback_targets": callback_targets,
                "role_goals": role_goals,
            }

            has_section_values = any(
                normalized.get(key) for key in ("beats", "conflicts", "foreshadowing", "callback_targets")
            ) or bool(normalized.get("role_goals"))
            if has_section_values:
                source = "markdown_sections"

        defaulted_fields: List[str] = []
        if not normalized["beats"]:
            normalized["beats"] = self._build_goal_based_beats(chapter)
            defaulted_fields.append("beats")
            source = "goal_fallback"
        if not normalized["conflicts"]:
            normalized["conflicts"] = self._build_goal_based_conflicts(chapter)
            defaulted_fields.append("conflicts")
            source = "goal_fallback"
        if not normalized["foreshadowing"]:
            normalized["foreshadowing"] = [f"围绕“{chapter.title}”埋下可回收细节"]
            defaulted_fields.append("foreshadowing")
        if not normalized["callback_targets"]:
            normalized["callback_targets"] = ["回收上一章未决事项至少一项"]
            defaulted_fields.append("callback_targets")

        quality = self._assess_plan_quality(
            normalized,
            source=source,
            defaulted_fields=defaulted_fields,
        )
        quality["parse_diagnostics"] = parse_diag
        return normalized, quality

    def _extract_plan_payload(self, text: str, chapter: Chapter) -> Dict[str, Any]:
        payload, _ = self._extract_plan_payload_with_quality(text, chapter)
        return payload

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
