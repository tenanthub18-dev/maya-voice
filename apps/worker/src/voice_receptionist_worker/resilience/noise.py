from __future__ import annotations

from collections import deque


class NoisePolicy:
    def __init__(
        self,
        false_barge_in_limit: int,
        window_seconds: float,
        base_vad_threshold: float,
        raised_vad_threshold: float,
    ) -> None:
        if false_barge_in_limit < 1 or window_seconds <= 0:
            raise ValueError("noise policy limits must be positive")
        if not 0 <= base_vad_threshold < raised_vad_threshold <= 1:
            raise ValueError("VAD thresholds must increase within 0..1")
        self.limit = false_barge_in_limit
        self.window_seconds = window_seconds
        self.base_threshold = base_vad_threshold
        self.raised_threshold = raised_vad_threshold
        self.current_threshold = base_vad_threshold
        self._events: deque[float] = deque()

    def false_barge_in(self, occurred_at: float) -> float | None:
        while self._events and occurred_at - self._events[0] > self.window_seconds:
            self._events.popleft()
        self._events.append(occurred_at)
        if len(self._events) >= self.limit and self.current_threshold != self.raised_threshold:
            self.current_threshold = self.raised_threshold
            self._events.clear()
            return self.current_threshold
        return None
