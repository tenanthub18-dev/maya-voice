from __future__ import annotations

import json
import os
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any


class OfflineMessageQueue:
    """Bounded local queue; oldest messages are discarded when the bound is reached."""

    def __init__(self, path: str | Path, maximum_messages: int) -> None:
        if maximum_messages < 1:
            raise ValueError("maximum_messages must be positive")
        self.path = Path(path)
        self.maximum_messages = maximum_messages

    def _read(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        value = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
            raise ValueError("offline message queue must contain a JSON array of objects")
        return value

    def _write(self, messages: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(json.dumps(messages, ensure_ascii=False), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.path)

    def enqueue(self, message: Mapping[str, Any]) -> None:
        stored = self._read()
        stored.append(dict(message))
        self._write(stored[-self.maximum_messages :])

    async def flush(
        self,
        sender: Callable[[dict[str, Any]], Awaitable[bool]],
    ) -> int:
        remaining: list[dict[str, Any]] = []
        for message in self._read():
            try:
                delivered = await sender(message)
            except Exception:
                delivered = False
            if not delivered:
                remaining.append(message)
        self._write(remaining)
        return len(remaining)
