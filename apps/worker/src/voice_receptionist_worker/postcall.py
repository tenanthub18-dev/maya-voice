from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from math import ceil
from typing import Any

import httpx

from .integrations.gemini import GeminiClient, GeminiError
from .tools.repository import Repository, RepositoryError


logger = logging.getLogger(__name__)
Sleep = Callable[[float], Awaitable[None]]
Clock = Callable[[], float]
OwnerNotifier = Callable[[dict[str, str]], Awaitable[None]]


async def _no_owner_notifier(event: dict[str, str]) -> None:
    return None


class PostCallProcessor:
    """Idempotently summarize a completed call and account for its duration."""

    _BACKOFF_SECONDS = (1.0, 4.0, 16.0)
    _DEADLINE_SECONDS = 120.0
    _FINALIZATION_BUDGET_SECONDS = 5.0
    _RETRYABLE_REPOSITORY_CODES = {
        "40001",
        "40p01",
        "408",
        "429",
        "55p03",
        "57p01",
        "57p02",
        "57p03",
        "timeout",
        "unavailable",
        "unreachable",
    }

    def __init__(
        self,
        repository: Repository,
        gemini: GeminiClient,
        *,
        sleep: Sleep = asyncio.sleep,
        clock: Clock = time.monotonic,
        notify_owner: OwnerNotifier = _no_owner_notifier,
    ) -> None:
        self._repository = repository
        self._gemini = gemini
        self._sleep = sleep
        self._clock = clock
        self._notify_owner = notify_owner
        self._locks: dict[str, asyncio.Lock] = {}
        self._notified_failures: set[str] = set()

    async def process(self, call_id: str) -> dict[str, Any]:
        lock = self._locks.setdefault(call_id, asyncio.Lock())
        async with lock:
            overall_deadline = self._clock() + self._DEADLINE_SECONDS
            attempt_deadline = (
                overall_deadline - self._FINALIZATION_BUDGET_SECONDS
            )
            last_error: Exception | None = None
            for attempt in range(len(self._BACKOFF_SECONDS) + 1):
                try:
                    remaining = attempt_deadline - self._clock()
                    if remaining <= 0:
                        break
                    result = await asyncio.wait_for(
                        self._process_once(call_id), timeout=remaining
                    )
                    if self._clock() <= attempt_deadline:
                        return result
                    raise TimeoutError("Post-call deadline exceeded")
                except Exception as error:
                    last_error = error
                    if not self._is_retryable(error):
                        break
                    if attempt == len(self._BACKOFF_SECONDS):
                        break
                    delay = self._BACKOFF_SECONDS[attempt]
                    if self._clock() + delay > attempt_deadline:
                        break
                    try:
                        await asyncio.wait_for(
                            self._sleep(delay),
                            timeout=attempt_deadline - self._clock(),
                        )
                    except TimeoutError:
                        break
                    if self._clock() >= attempt_deadline:
                        break
            assert last_error is not None
            await self._record_terminal_failure(
                call_id, last_error, overall_deadline
            )
            raise last_error

    @classmethod
    def _is_retryable(cls, error: Exception) -> bool:
        if isinstance(error, RepositoryError):
            code = error.code.lower()
            if code.isdigit():
                return int(code) in {408, 429} or 500 <= int(code) <= 599
            return code in cls._RETRYABLE_REPOSITORY_CODES or code[:2] in {
                "08",
                "40",
                "53",
                "58",
            }
        if isinstance(error, httpx.RequestError):
            return True
        if isinstance(error, httpx.HTTPStatusError):
            return error.response.status_code >= 500
        if isinstance(error, GeminiError):
            cause = error.__cause__
            if isinstance(cause, (httpx.TimeoutException, httpx.NetworkError)):
                return True
            message = str(error).lower()
            return (
                "transient" in message
                or "after retries" in message
                or re.search(r"status 5\d\d", message) is not None
            )
        return False

    async def _record_terminal_failure(
        self,
        call_id: str,
        error: Exception,
        deadline: float,
    ) -> None:
        logger.error(
            "postcall_failed",
            extra={"call_id": call_id, "error_class": type(error).__name__},
        )
        operations: list[Awaitable[Any]] = [self._append_failure_flag(call_id)]
        if call_id not in self._notified_failures:
            self._notified_failures.add(call_id)
            operations.append(
                self._notify_owner(
                    {
                        "type": "flagged_call",
                        "call_id": call_id,
                        "idempotency_key": f"postcall_failed:{call_id}",
                    }
                )
            )
        await self._run_terminal_steps(operations, deadline)

    async def _run_terminal_steps(
        self, operations: list[Awaitable[Any]], deadline: float
    ) -> None:
        remaining = deadline - self._clock()
        if remaining <= 0:
            for operation in operations:
                close = getattr(operation, "close", None)
                if close is not None:
                    close()
            return
        try:
            await asyncio.wait_for(
                asyncio.gather(*operations, return_exceptions=True),
                timeout=remaining,
            )
        except Exception:
            return

    async def _append_failure_flag(self, call_id: str) -> None:
        calls = await self._repository.select("calls", {"id": call_id})
        if not calls:
            return
        flags = list(calls[0].get("qa_flags") or [])
        if "postcall_failed" in flags:
            return
        flags.append("postcall_failed")
        await self._repository.update(
            "calls", {"id": call_id}, {"qa_flags": flags}
        )

    async def _process_once(self, call_id: str) -> dict[str, Any]:
        calls = await self._repository.select("calls", {"id": call_id})
        if not calls:
            raise RepositoryError("not_found", "Call not found")
        call = calls[0]
        if call.get("source", "phone") == "browser":
            return self._result(call)
        if call.get("summary") and call.get("outcome"):
            seconds = self._billable_seconds(call)
            if int(call.get("billable_seconds") or 0) != seconds:
                call = await self._repository.update(
                    "calls", {"id": call_id}, {"billable_seconds": seconds}
                )
            await self._record_usage(call["restaurant_id"], call["started_at"])
            return self._result(call)
        turns = await self._repository.select("call_turns", {"call_id": call_id})
        turns.sort(key=lambda row: int(row.get("idx", 0)))
        transcript = "\n".join(
            f"{turn['speaker']} [{turn.get('language', 'unknown')}]: {turn['text']}"
            for turn in turns
        )
        analysis = await self._gemini.analyze_call(transcript)
        seconds = self._billable_seconds(call)
        updated = await self._repository.update(
            "calls",
            {"id": call_id},
            {
                "summary": analysis.summary,
                "outcome": analysis.outcome,
                "qa_flags": list(analysis.qa_flags),
                "billable_seconds": seconds,
            },
        )
        await self._record_usage(call["restaurant_id"], call["started_at"])
        return self._result(updated)

    @staticmethod
    def _billable_seconds(call: dict[str, Any]) -> int:
        if not call.get("ended_at"):
            raise ValueError("Completed call requires ended_at")
        started = datetime.fromisoformat(str(call["started_at"]).replace("Z", "+00:00"))
        ended = datetime.fromisoformat(str(call["ended_at"]).replace("Z", "+00:00"))
        duration_seconds = (ended - started).total_seconds()
        if duration_seconds < 0:
            raise ValueError("Call duration must be non-negative")
        rounded_duration = ceil(duration_seconds / 6) * 6
        cached_seconds = call.get("billable_seconds")
        if cached_seconds is None:
            return rounded_duration
        cached = int(cached_seconds)
        if cached < 0:
            raise ValueError("Billable seconds must be non-negative")
        return max(rounded_duration, ceil(cached / 6) * 6)

    async def _record_usage(self, restaurant_id: str, started_at: str) -> None:
        restaurants = await self._repository.select("restaurants", {"id": restaurant_id})
        if not restaurants:
            raise RepositoryError("not_found", "Restaurant not found for usage")
        organization_id = restaurants[0]["organization_id"]
        period = str(started_at)[:7]
        organization_restaurants = await self._repository.select(
            "restaurants", {"organization_id": organization_id}
        )
        seconds = 0
        cost_micros = 0
        for restaurant in organization_restaurants:
            calls = await self._repository.select(
                "calls", {"restaurant_id": restaurant["id"]}
            )
            seconds += sum(
                self._billable_seconds(call)
                for call in calls
                if str(call.get("started_at", "")).startswith(period)
                and call.get("ended_at")
                and call.get("source", "phone") != "browser"
            )
            cost_micros += sum(
                self._call_cost_micros(call)
                for call in calls
                if str(call.get("started_at", "")).startswith(period)
                and call.get("ended_at")
                and call.get("source", "phone") != "browser"
            )
        rows = await self._repository.select(
            "usage_ledger", {"organization_id": organization_id, "period": period}
        )
        if rows:
            previous_seconds = int(rows[0].get("seconds", 0))
            await self._repository.update(
                "usage_ledger",
                {"id": rows[0]["id"]},
                {
                    "seconds": seconds,
                    "stripe_reported": bool(rows[0].get("stripe_reported"))
                    and previous_seconds == seconds,
                    "cost_micros": cost_micros,
                },
            )
        else:
            await self._repository.insert(
                "usage_ledger",
                {
                    "organization_id": organization_id,
                    "period": period,
                    "seconds": seconds,
                    "reported_seconds": 0,
                    "stripe_reported": False,
                    "cost_micros": cost_micros,
                },
            )

    @staticmethod
    def _call_cost_micros(call: dict[str, Any]) -> int:
        costs = call.get("cost_micros") or {}
        if not isinstance(costs, dict):
            raise ValueError("Call cost_micros must be an object")
        total = 0
        for value in costs.values():
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError("Call costs must be non-negative integers")
            total += value
        return total

    @staticmethod
    def _result(call: dict[str, Any]) -> dict[str, Any]:
        return {
            "call_id": call["id"],
            "summary": call.get("summary", ""),
            "outcome": call.get("outcome"),
            "qa_flags": list(call.get("qa_flags") or []),
            "billable_seconds": int(call.get("billable_seconds") or 0),
        }
