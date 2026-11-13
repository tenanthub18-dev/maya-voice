from __future__ import annotations

import asyncio
import json
import math
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from pydantic import BaseModel


class LatencyRecord(BaseModel):
    call_id: str
    turn: int
    eot_ms: float
    stt_ms: float
    llm_ttft_ms: float
    tts_ttfb_ms: float
    total_ms: float
    # Every Pipecat latency stage (e.g. sentence_aggregation, output_transport, turn_completion).
    stages_ms: dict[str, float] = {}


def _milliseconds(seconds: float) -> float:
    return round(seconds * 1000, 3)


def latency_record_from_breakdown(
    breakdown: Any,
    *,
    call_id: str,
    turn: int,
) -> LatencyRecord:
    durations: dict[str, float] = defaultdict(float)
    for contribution in breakdown.contributions:
        durations[contribution.key] += contribution.duration_secs
    return LatencyRecord(
        call_id=call_id,
        turn=turn,
        eot_ms=_milliseconds(
            durations["endpointing_wait"] + durations["turn_detection"]
        ),
        stt_ms=_milliseconds(durations["transcription"]),
        llm_ttft_ms=_milliseconds(durations["llm_inference"]),
        tts_ttfb_ms=_milliseconds(durations["speech_synthesis"]),
        total_ms=_milliseconds(breakdown.total_secs),
        stages_ms={key: _milliseconds(value) for key, value in durations.items()},
    )


class LatencyJsonlLogger:
    def __init__(self, path: str | Path):
        self._path = Path(path)

    def write(self, record: LatencyRecord) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("a", encoding="utf-8") as output:
            output.write(record.model_dump_json() + "\n")


class LatencyAggregator:
    def __init__(self, records: Iterable[LatencyRecord]):
        self._records = list(records)

    @classmethod
    def from_records(cls, records: Iterable[LatencyRecord]) -> LatencyAggregator:
        return cls(records)

    def summary(self, field: str) -> dict[str, float | int]:
        values = sorted(float(getattr(record, field)) for record in self._records)
        if not values:
            return {"count": 0, "p50": 0.0, "p95": 0.0}

        def nearest_rank(percentile: float) -> float:
            index = max(0, math.ceil(percentile * len(values)) - 1)
            return values[index]

        return {
            "count": len(values),
            "p50": nearest_rank(0.50),
            "p95": nearest_rank(0.95),
        }


def create_latency_observer(path: str | Path, *, call_id: str):
    """Create Pipecat's latency observer with a JSONL event sink.

    Pipecat observer API:
    https://docs.pipecat.ai/api-reference/server/utilities/observers/user-bot-latency-observer
    """
    from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver

    observer = UserBotLatencyObserver()
    logger = LatencyJsonlLogger(path)
    turn = 0

    @observer.event_handler("on_latency_breakdown")
    async def on_latency_breakdown(observer, breakdown) -> None:
        nonlocal turn
        turn += 1
        record = latency_record_from_breakdown(
            breakdown,
            call_id=call_id,
            turn=turn,
        )
        await asyncio.to_thread(logger.write, record)

    return observer
