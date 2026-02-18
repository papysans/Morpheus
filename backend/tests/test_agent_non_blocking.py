import asyncio
import time

import pytest

from agents.studio import Agent, AgentRole


class SlowLLM:
    def chat(self, messages):
        time.sleep(0.2)
        return "ok"

    def chat_stream_text(self, messages):
        for chunk in ("a", "b", "c"):
            time.sleep(0.08)
            yield chunk


@pytest.mark.asyncio
async def test_agent_think_does_not_block_event_loop():
    agent = Agent(
        role=AgentRole.DIRECTOR,
        name="director",
        description="",
        system_prompt="system",
        llm_client=SlowLLM(),
    )

    start = time.perf_counter()
    think_task = asyncio.create_task(agent.think({"chapter_id": 1}))
    await asyncio.sleep(0.05)
    elapsed = time.perf_counter() - start
    # If think() blocks event loop, this sleep would not wake up until ~0.2s.
    assert elapsed < 0.15
    assert await think_task == "ok"


@pytest.mark.asyncio
async def test_agent_think_stream_does_not_block_event_loop():
    agent = Agent(
        role=AgentRole.DIRECTOR,
        name="director",
        description="",
        system_prompt="system",
        llm_client=SlowLLM(),
    )

    start = time.perf_counter()
    stream_task = asyncio.create_task(agent.think_stream({"chapter_id": 1}))
    await asyncio.sleep(0.05)
    elapsed = time.perf_counter() - start
    # Streaming path should also yield control back to event loop.
    assert elapsed < 0.15
    assert await stream_task == "abc"
