from __future__ import annotations

import asyncio
import math
import time
from datetime import UTC, datetime, timedelta

from voice_receptionist_worker.tools import InMemoryRepository, ToolContext, ToolDispatcher


RESTAURANT_ID = "00000000-0000-0000-0000-000000000001"


def percentile95(samples_ms: list[float]) -> float:
    return sorted(samples_ms)[math.ceil(len(samples_ms) * 0.95) - 1]


def test_mock_availability_with_one_thousand_month_bookings_is_under_150ms_p95() -> None:
    repo = InMemoryRepository(
        restaurant={
            "id": RESTAURANT_ID,
            "province": "ON",
            "timezone": "America/Toronto",
        },
        hours=[],
        menu_items=[],
        slots_config={
            "slot_minutes": 15,
            "covers_per_slot": 10_000,
            "seating_minutes": 90,
            "max_party": 20,
            "lead_time_minutes": 0,
            "booking_window_days": 90,
        },
    )
    month_start = datetime(2026, 11, 1, 17, 0, tzinfo=UTC)
    repo.seed(
        "bookings",
        [
            {
                "id": f"booking-{index}",
                "restaurant_id": RESTAURANT_ID,
                "party_size": (index % 6) + 1,
                "starts_at": (
                    month_start
                    + timedelta(days=index % 30, minutes=15 * (index % 28))
                ).isoformat().replace("+00:00", "Z"),
                "status": "confirmed",
            }
            for index in range(1_000)
        ],
    )
    dispatcher = ToolDispatcher(repo)
    context = ToolContext(
        call_id="performance-call",
        turn=1,
        restaurant_id=RESTAURANT_ID,
        language="en",
        now=datetime(2026, 10, 27, tzinfo=UTC),
    )
    arguments = {"date": "2026-11-15", "time": "19:00", "party_size": 4}

    async def scenario() -> list[float]:
        for index in range(10):
            warmup_context = ToolContext(**{**context.__dict__, "turn": f"warmup-{index}"})
            result = await dispatcher.dispatch("check_availability", arguments, warmup_context)
            assert result["ok"] is True
        samples: list[float] = []
        for index in range(200):
            started = time.perf_counter()
            measured_context = ToolContext(**{**context.__dict__, "turn": f"measured-{index}"})
            result = await dispatcher.dispatch("check_availability", arguments, measured_context)
            samples.append((time.perf_counter() - started) * 1_000)
            assert result["ok"] is True
        return samples

    samples = asyncio.run(scenario())
    p95_ms = percentile95(samples)
    print(f"F9 mock availability: p95={p95_ms:.3f} ms over 200 runs")
    assert p95_ms < 150
