"""Browser usage is real provider usage, never customer telephone billing."""
import asyncio

import httpx

from voice_receptionist_worker.integrations.gemini import GeminiClient
from voice_receptionist_worker.postcall import PostCallProcessor
from voice_receptionist_worker.tools import InMemoryRepository


def repository():
    return InMemoryRepository(
        restaurant={"id": "restaurant", "organization_id": "organization"},
        hours=[], menu_items=[], slots_config={},
    )


def browser_call():
    return {"id": "browser", "restaurant_id": "restaurant", "source": "browser",
            "started_at": "2026-11-12T20:00:00+00:00", "ended_at": "2026-11-12T20:02:00+00:00",
            "billable_seconds": 0, "cost_micros": {"llm": 9999}, "summary": "",
            "outcome": "answered", "qa_flags": []}


def test_monthly_telephone_usage_ignores_browser_duration_and_usd_cost():
    async def scenario():
        repo = repository()
        repo.seed("calls", [browser_call(), {
            **browser_call(), "id": "phone", "source": "phone",
            "ended_at": "2026-11-12T20:01:00+00:00", "billable_seconds": 60,
            "cost_micros": {"llm": 100},
        }])
        processor = PostCallProcessor(repo, None)
        await processor._record_usage("restaurant", "2026-11-12T20:00:00+00:00")
        assert repo.rows("usage_ledger")[0]["seconds"] == 60
        assert repo.rows("usage_ledger")[0]["cost_micros"] == 100
    asyncio.run(scenario())


def test_browser_postcall_does_not_summarize_or_create_customer_usage():
    async def scenario():
        repo = repository()
        repo.seed("calls", [browser_call()])
        client = GeminiClient(api_key="test-only", model="test-only", transport=httpx.MockTransport(
            lambda request: (_ for _ in ()).throw(AssertionError("Browser call must not invoke summary AI"))
        ))
        try:
            processor = PostCallProcessor(repo, client)
            result = await processor.process("browser")
            assert await processor.process("browser") == result
        finally:
            await client.aclose()
        assert result["billable_seconds"] == 0
        assert repo.rows("usage_ledger") == []
        assert repo.rows("calls")[0]["cost_micros"] == {"llm": 9999}
    asyncio.run(scenario())


def test_mixed_months_and_legacy_phone_rows_rebuild_idempotently():
    async def scenario():
        repo = repository()
        phone = {**browser_call(), "id": "legacy", "billable_seconds": 120,
                 "cost_micros": {"llm": 100, "tts": 50}, "summary": "Done"}
        phone.pop("source")  # Historical fixtures default to telephone usage.
        repo.seed("calls", [browser_call(), phone, {
            **phone, "id": "previous-month", "source": "phone",
            "started_at": "2026-10-12T20:00:00+00:00",
            "ended_at": "2026-10-12T20:02:00+00:00", "cost_micros": {"llm": 800},
        }, {**phone, "id": "unfinished", "ended_at": None}])
        processor = PostCallProcessor(repo, None)
        await processor.process("legacy")
        first = repo.rows("usage_ledger")[0].copy()
        await processor.process("legacy")
        await processor.process("browser")
        assert repo.rows("usage_ledger") == [first]
        assert first["seconds"] == 120
        assert first["cost_micros"] == 150
        assert repo.rows("calls")[0] == browser_call()
    asyncio.run(scenario())
