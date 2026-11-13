from __future__ import annotations

import asyncio

import pytest

from voice_receptionist_worker.agent_config_cache import AgentConfigCache


def test_agent_config_cache_rejects_ttl_above_prd_limit() -> None:
    with pytest.raises(ValueError, match="60"):
        AgentConfigCache(ttl_seconds=60.001)


def test_live_call_reloads_published_config_at_sixty_seconds() -> None:
    now = [1_000.0]
    loads = 0

    async def scenario() -> None:
        nonlocal loads
        cache: AgentConfigCache[dict[str, int]] = AgentConfigCache(
            ttl_seconds=60, clock=lambda: now[0]
        )

        async def load() -> dict[str, int]:
            nonlocal loads
            loads += 1
            return {"version": loads}

        assert await cache.get("+14165550101", load) == {"version": 1}
        now[0] += 59.999
        assert await cache.get("+14165550101", load) == {"version": 1}
        now[0] += 0.001
        assert await cache.get("+14165550101", load) == {"version": 2}

    asyncio.run(scenario())
    assert loads == 2


def test_publish_invalidates_only_the_published_restaurant_config() -> None:
    versions = {"restaurant-a": 1, "restaurant-b": 7}
    loads = {"restaurant-a": 0, "restaurant-b": 0}

    async def scenario() -> None:
        cache: AgentConfigCache[dict[str, int]] = AgentConfigCache(ttl_seconds=60)

        async def load(key: str) -> dict[str, int]:
            loads[key] += 1
            return {"version": versions[key]}

        assert await cache.get("restaurant-a", lambda: load("restaurant-a")) == {"version": 1}
        assert await cache.get("restaurant-b", lambda: load("restaurant-b")) == {"version": 7}
        versions["restaurant-a"] = 2
        cache.invalidate_published("restaurant-a")
        assert await cache.get("restaurant-a", lambda: load("restaurant-a")) == {"version": 2}
        assert await cache.get("restaurant-b", lambda: load("restaurant-b")) == {"version": 7}

    asyncio.run(scenario())
    assert loads == {"restaurant-a": 2, "restaurant-b": 1}
