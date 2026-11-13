from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Generic, TypeVar


ConfigT = TypeVar("ConfigT")


@dataclass(frozen=True)
class _Entry(Generic[ConfigT]):
    value: ConfigT
    expires_at: float


class AgentConfigCache(Generic[ConfigT]):
    """Short-lived published-agent cache used at live-call startup."""

    MAX_TTL_SECONDS = 60.0

    def __init__(
        self,
        *,
        ttl_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not 0 < ttl_seconds <= self.MAX_TTL_SECONDS:
            raise ValueError("Agent config cache TTL must be greater than 0 and at most 60 seconds")
        self.ttl_seconds = ttl_seconds
        self._clock = clock
        self._entries: dict[str, _Entry[ConfigT]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def get(
        self, key: str, loader: Callable[[], Awaitable[ConfigT]]
    ) -> ConfigT:
        entry = self._entries.get(key)
        now = self._clock()
        if entry is not None and now < entry.expires_at:
            return entry.value
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._entries.get(key)
            now = self._clock()
            if entry is not None and now < entry.expires_at:
                return entry.value
            value = await loader()
            self._entries[key] = _Entry(value, now + self.ttl_seconds)
            return value

    def invalidate_published(self, key: str) -> None:
        """Invalidate the restaurant/number key immediately after a publish event."""
        self._entries.pop(key, None)
