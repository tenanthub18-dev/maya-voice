from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import httpx
import pytest

from voice_receptionist_worker.integrations.gemini import (
    GeminiClient,
    GeminiError,
    PostCallAnalysis,
)
from voice_receptionist_worker.pipeline.builder import create_tool_context
from voice_receptionist_worker.postcall import PostCallProcessor
from voice_receptionist_worker.resilience.offline_queue import OfflineMessageQueue
from voice_receptionist_worker.tools import (
    InMemoryRepository,
    ToolContext,
    ToolDispatcher,
    SupabasePostgrestRepository,
    build_tool_schemas,
)
from voice_receptionist_worker.tools.repository import RepositoryError
from voice_receptionist_worker.tools.schemas import validate_tool_arguments
from voice_receptionist_worker.tools.dispatcher import DEFAULT_RESTAURANT_TAX_RATES
from voice_receptionist_worker.security.hmac import verify_request


RESTAURANT_ID = "00000000-0000-0000-0000-000000000001"
CALL_ID = "00000000-0000-0000-0000-000000000002"


TAX_FIXTURE = json.loads(
    (Path(__file__).parents[3] / "tests/fixtures/canadian-restaurant-tax.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize(
    "case", TAX_FIXTURE["jurisdictions"], ids=lambda case: case["province"]
)
def test_every_canadian_restaurant_tax_rate_matches_hand_calculated_fixture(case) -> None:
    rate = DEFAULT_RESTAURANT_TAX_RATES[case["province"]]
    assert rate * 10_000 == Decimal(str(case["rate_basis_points"]))
    tax_cents = int(
        (Decimal(TAX_FIXTURE["subtotal_cents"]) * rate).quantize(
            Decimal("1"), rounding="ROUND_HALF_UP"
        )
    )
    assert tax_cents == case["tax_cents"]


def test_tax_fixture_documents_bc_pst_exemption_and_qc_combined_rate() -> None:
    cases = {case["province"]: case for case in TAX_FIXTURE["jurisdictions"]}
    assert "exempt from BC PST" in cases["BC"]["note"]
    assert cases["QC"]["rate_basis_points"] == 1497.5


@pytest.mark.parametrize(
    "case",
    json.loads(
        (Path(__file__).parents[3] / "tests/fixtures/billable-seconds.json").read_text(
            encoding="utf-8"
        )
    ),
    ids=lambda case: case["name"],
)
def test_postcall_billable_seconds_matches_shared_fixture(case) -> None:
    started = datetime(2026, 10, 27, 20, tzinfo=UTC)
    call = {"started_at": case.get("started_at", started.isoformat())}
    if "duration_seconds" in case:
        call["ended_at"] = (started + timedelta(seconds=case["duration_seconds"])).isoformat()
    if "cached_billable_seconds" in case:
        call["billable_seconds"] = case["cached_billable_seconds"]

    if "error" in case:
        with pytest.raises(ValueError, match=case["error"]):
            PostCallProcessor._billable_seconds(call)
    else:
        assert PostCallProcessor._billable_seconds(call) == case["billable_seconds"]


def test_postcall_rerounds_cached_billable_seconds_without_undercounting_duration() -> None:
    call = {
        "started_at": "2026-10-27T20:00:00Z",
        "ended_at": "2026-10-27T20:00:07Z",
        "billable_seconds": 5,
    }
    assert PostCallProcessor._billable_seconds(call) == 12


def test_postcall_idempotent_path_persists_rerounded_cached_seconds() -> None:
    repo = seeded_repository()
    repo.seed("calls", [{
        "id": CALL_ID,
        "restaurant_id": RESTAURANT_ID,
        "started_at": "2026-10-27T20:00:00Z",
        "ended_at": "2026-10-27T20:00:07Z",
        "summary": "Already complete",
        "outcome": "answered",
        "billable_seconds": 5,
    }])
    client = GeminiClient(api_key="test-key", model="test-model", transport=httpx.MockTransport(lambda _request: pytest.fail("Gemini must not run")))
    processor = PostCallProcessor(repo, client)

    async def scenario():
        result = await processor.process(CALL_ID)
        await client.aclose()
        return result

    result = asyncio.run(scenario())
    assert result["billable_seconds"] == 12
    assert repo.rows("calls")[0]["billable_seconds"] == 12
    assert repo.rows("usage_ledger")[0]["seconds"] == 12


def test_postcall_ledger_aggregates_cost_and_reopens_changed_usage_for_reporting() -> None:
    repo = seeded_repository()
    repo.seed("calls", [
        {
            "id": CALL_ID,
            "restaurant_id": RESTAURANT_ID,
            "started_at": "2026-10-27T20:00:00Z",
            "ended_at": "2026-10-27T20:00:07Z",
            "summary": "Already complete",
            "outcome": "answered",
            "billable_seconds": 12,
            "cost_micros": {"stt": 100, "llm": 200, "tts": 300},
        },
        {
            "id": "00000000-0000-0000-0000-000000000004",
            "restaurant_id": RESTAURANT_ID,
            "started_at": "2026-10-27T21:00:00Z",
            "ended_at": "2026-10-27T21:00:01Z",
            "summary": "Second",
            "outcome": "answered",
            "billable_seconds": 6,
            "cost_micros": {"stt": 50},
        },
    ])
    repo.seed("usage_ledger", [{
        "id": "00000000-0000-0000-0000-000000000005",
        "organization_id": "00000000-0000-0000-0000-000000000003",
        "period": "2026-10",
        "seconds": 12,
        "reported_seconds": 12,
        "stripe_reported": True,
        "cost_micros": 600,
    }])
    client = GeminiClient(api_key="test-key", model="test-model", transport=httpx.MockTransport(lambda _request: pytest.fail("Gemini must not run")))

    async def scenario():
        await PostCallProcessor(repo, client).process(CALL_ID)
        await client.aclose()

    asyncio.run(scenario())
    assert repo.rows("usage_ledger")[0] == {
        "id": "00000000-0000-0000-0000-000000000005",
        "organization_id": "00000000-0000-0000-0000-000000000003",
        "period": "2026-10",
        "seconds": 18,
        "reported_seconds": 12,
        "stripe_reported": False,
        "cost_micros": 650,
    }


def seeded_repository() -> InMemoryRepository:
    return InMemoryRepository(
        restaurant={
            "id": RESTAURANT_ID,
            "organization_id": "00000000-0000-0000-0000-000000000003",
            "province": "ON",
            "timezone": "America/Toronto",
            "transfer_phone": "+14165550100",
            "transfer_hours": {"monday": ["09:00", "22:00"]},
        },
        hours=[{"weekday": 0, "open_time": "09:00", "close_time": "22:00"}],
        menu_items=[
            {"id": "m1", "name": "Crème brûlée", "price_cents": 1001, "available": True},
            {"id": "m2", "name": "بریانی", "price_cents": 1499, "available": True},
            {"id": "m3", "name": "पनीर टिक्का", "price_cents": 1299, "available": True},
            {"id": "m4", "name": "ਪਕੌੜਾ", "price_cents": 899, "available": True},
        ],
        slots_config={
            "slot_minutes": 30,
            "covers_per_slot": 2,
            "seating_minutes": 90,
            "max_party": 8,
            "lead_time_minutes": 0,
            "booking_window_days": 60,
        },
    )


def context(*, turn: int = 1, dry_run: bool = False) -> ToolContext:
    return ToolContext(
        call_id=CALL_ID,
        turn=turn,
        restaurant_id=RESTAURANT_ID,
        language="en",
        dry_run=dry_run,
        now=datetime(2026, 10, 26, 16, 0, tzinfo=UTC),  # Monday noon Toronto.
    )


def test_concurrent_create_booking_allows_only_one_last_slot() -> None:
    async def scenario():
        dispatcher = ToolDispatcher(seeded_repository())
        args = {
            "name": "Caller",
            "phone": "+14165550199",
            "party_size": 2,
            "starts_at": "2026-10-27T22:00:00Z",
            "notes": "",
        }
        return await asyncio.gather(
            *(dispatcher.dispatch("create_booking", args, context(turn=i)) for i in range(20))
        )

    results = asyncio.run(scenario())

    assert sum(result["ok"] for result in results) == 1
    assert sum(result.get("error", {}).get("code") == "slot_unavailable" for result in results) == 19


def test_create_booking_is_idempotent_for_call_and_turn() -> None:
    async def scenario():
        repo = seeded_repository()
        dispatcher = ToolDispatcher(repo)
        args = {
            "name": "Same caller",
            "phone": "+14165550199",
            "party_size": 2,
            "starts_at": "2026-10-27T22:00:00Z",
            "notes": "window",
        }
        first = await dispatcher.dispatch("create_booking", args, context())
        second = await dispatcher.dispatch("create_booking", args, context())
        return repo, first, second

    repo, first, second = asyncio.run(scenario())

    assert first == second
    assert len(repo.rows("bookings")) == 1
    assert len(repo.rows("tool_invocations")) == 1


def test_dry_run_performs_no_writes_including_invocation_log() -> None:
    repo = seeded_repository()
    dispatcher = ToolDispatcher(repo)

    result = asyncio.run(
        dispatcher.dispatch(
            "take_message",
            {"name": "A", "phone": "+14165550199", "text": "Call me"},
            context(dry_run=True),
        )
    )

    assert result == {"ok": True, "dry_run": True}
    assert repo.write_count == 0


def test_dry_run_still_executes_read_only_tools_without_writes() -> None:
    repo = seeded_repository()
    dispatcher = ToolDispatcher(repo)

    result = asyncio.run(
        dispatcher.dispatch(
            "search_menu",
            {"query": "بریانی", "language": "ur"},
            context(dry_run=True),
        )
    )

    assert result["items"][0]["name"] == "بریانی"
    assert repo.write_count == 0


def test_create_order_computes_half_up_tax_from_server_prices() -> None:
    repo = seeded_repository()
    dispatcher = ToolDispatcher(repo, tax_rates={"ON": Decimal("0.13")})

    result = asyncio.run(
        dispatcher.dispatch(
            "create_order",
            {
                "items": [{"menu_item_id": "m1", "quantity": 1, "modifiers": []}],
                "pickup_at": "2026-10-27T23:00:00Z",
                "name": "A",
                "phone": "+14165550199",
            },
            context(),
        )
    )

    assert result["order"]["subtotal_cents"] == 1001
    assert result["order"]["tax_cents"] == 130
    assert result["order"]["total_cents"] == 1131


@pytest.mark.parametrize(
    ("query", "expected"),
    [("creme brulee", "Crème brûlée"), ("بریانی", "بریانی"), ("पनीर", "पनीर टिक्का"), ("ਪਕੋੜਾ", "ਪਕੌੜਾ")],
)
def test_search_menu_fuzzy_matches_across_launch_scripts(query: str, expected: str) -> None:
    dispatcher = ToolDispatcher(seeded_repository())

    result = asyncio.run(
        dispatcher.dispatch("search_menu", {"query": query, "language": "fr-CA"}, context())
    )

    assert result["items"][0]["name"] == expected


def test_dispatcher_times_out_and_logs_timeout() -> None:
    repo = seeded_repository()

    async def slow_handler(arguments, tool_context):
        await asyncio.sleep(0.05)
        return {"ok": True}

    dispatcher = ToolDispatcher(repo, timeout_seconds=0.01, extra_handlers={"slow": slow_handler})
    result = asyncio.run(dispatcher.dispatch("slow", {}, context()))

    assert result["error"]["code"] == "timeout"
    assert repo.rows("tool_invocations")[0]["status"] == "timed_out"


def test_dispatcher_returns_typed_bad_input_error() -> None:
    dispatcher = ToolDispatcher(seeded_repository())
    result = asyncio.run(
        dispatcher.dispatch("create_booking", {"name": "missing fields"}, context())
    )
    assert result["error"]["code"] == "bad_input"


def test_nested_json_schema_validation_returns_typed_error() -> None:
    dispatcher = ToolDispatcher(seeded_repository())

    result = asyncio.run(
        dispatcher.dispatch(
            "create_order",
            {
                "items": ["not-an-object"],
                "pickup_at": "2026-10-27T23:00:00Z",
                "name": "A",
                "phone": "+14165550199",
            },
            context(),
        )
    )

    assert result["error"]["code"] == "bad_input"
    assert "items[0]" in result["error"]["message"]


@pytest.mark.parametrize("server_owned", ["restaurant_id", "amount", "amount_cents"])
def test_tool_validator_rejects_model_supplied_server_owned_fields(server_owned: str) -> None:
    arguments = {"date": "2026-10-27", server_owned: "attacker-value"}

    with pytest.raises(ValueError, match="unexpected field"):
        validate_tool_arguments("get_hours", arguments)


def test_tool_validator_allows_template_variables_but_not_unknown_top_level_fields() -> None:
    validate_tool_arguments(
        "send_sms",
        {
            "template_key": "message_received",
            "vars": {"name": "Caller"},
            "phone": "+14165550199",
            "language": "en",
        },
    )


def test_dispatcher_uses_known_caller_phone_instead_of_model_text() -> None:
    repo = seeded_repository()
    dispatcher = ToolDispatcher(repo)
    known_phone = "+14165550111"
    caller_context = ToolContext(
        call_id=CALL_ID,
        turn=1,
        restaurant_id=RESTAURANT_ID,
        language="en",
        caller_phone=known_phone,
        now=datetime(2026, 10, 26, 16, 0, tzinfo=UTC),
    )

    result = asyncio.run(
        dispatcher.dispatch(
            "take_message",
            {"name": "Caller", "phone": "+14165550999", "text": "Call me"},
            caller_context,
        )
    )

    assert result["ok"] is True
    assert repo.rows("messages")[0]["phone"] == known_phone


def test_booking_rejects_party_above_restaurant_server_limit() -> None:
    dispatcher = ToolDispatcher(seeded_repository())

    result = asyncio.run(
        dispatcher.dispatch(
            "create_booking",
            {
                "name": "Caller",
                "phone": "+14165550199",
                "party_size": 9,
                "starts_at": "2026-10-27T22:00:00Z",
            },
            context(),
        )
    )

    assert result["error"]["code"] == "bad_input"
    assert "maximum party size" in result["error"]["message"]


def test_unknown_tool_invocation_is_logged() -> None:
    repo = seeded_repository()
    dispatcher = ToolDispatcher(repo)

    result = asyncio.run(dispatcher.dispatch("not_a_tool", {}, context()))

    assert result["error"]["code"] == "unknown_tool"
    assert repo.rows("tool_invocations")[0]["status"] == "failed"


def test_all_prd_tools_have_json_schema() -> None:
    schemas = build_tool_schemas()
    expected = {
        "get_hours", "search_menu", "check_availability", "create_booking",
        "find_booking", "modify_booking", "cancel_booking", "create_order",
        "send_sms", "send_payment_link", "transfer_call", "take_message", "end_call",
    }
    assert {schema.name for schema in schemas.standard_tools} == expected
    for schema in schemas.standard_tools:
        payload = schema.to_default_dict()
        assert payload["parameters"]["type"] == "object"
        assert set(payload["parameters"]["required"]) <= set(payload["parameters"]["properties"])


def test_payment_link_refuses_when_flag_is_off_including_dry_run() -> None:
    dispatcher = ToolDispatcher(seeded_repository())

    for dry_run in (False, True):
        result = asyncio.run(dispatcher.dispatch(
            "send_payment_link",
            {"order_id": "order-1"},
            ToolContext(**{**context().__dict__, "dry_run": dry_run}),
        ))
        assert result["error"]["code"] == "feature_disabled"


def test_payment_link_never_accepts_an_llm_amount() -> None:
    dispatcher = ToolDispatcher(seeded_repository(), payment_links_enabled=True)
    result = asyncio.run(dispatcher.dispatch(
        "send_payment_link",
        {"order_id": "order-1", "amount_cents": 1},
        context(),
    ))
    assert result["error"]["code"] == "bad_input"
    assert "unexpected field" in result["error"]["message"]


def test_payment_link_wrong_restaurant_target_is_not_found() -> None:
    repo = seeded_repository()
    repo.seed("orders", [{
        "id": "order-other", "restaurant_id": "other-restaurant", "phone": "+14165550199",
        "total_cents": 1, "paid_status": "unpaid",
    }])
    dispatcher = ToolDispatcher(repo, payment_links_enabled=True)
    result = asyncio.run(dispatcher.dispatch(
        "send_payment_link", {"order_id": "order-other"}, context(),
    ))
    assert result["error"]["code"] == "not_found"


@pytest.mark.parametrize(
    ("language", "expected"),
    [("en", "Pay securely: https://buy.stripe.test/link"), ("fr-CA", "Payez en toute sécurité : https://buy.stripe.test/link")],
)
def test_payment_link_calls_hmac_web_route_without_amount_and_sends_localized_sms(language: str, expected: str, monkeypatch) -> None:
    captured: dict[str, object] = {}
    sms_requests: list[httpx.Request] = []
    monkeypatch.setenv("TELNYX_API_KEY", "test-telnyx-key")
    monkeypatch.setenv("TELNYX_BASE_URL", "https://telnyx.test/v2")
    monkeypatch.setenv("TELNYX_MESSAGING_PROFILE_ID", "test-profile")

    def send_sms(request: httpx.Request) -> httpx.Response:
        sms_requests.append(request)
        return httpx.Response(200, json={"data": {"id": "test-message-id"}})

    def respond(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.content
        captured["timestamp"] = request.headers["x-timestamp"]
        captured["signature"] = request.headers["x-signature"]
        return httpx.Response(200, json={"url": "https://buy.stripe.test/link", "target_id": "order-1"})

    repo = seeded_repository()
    asyncio.run(repo.update("restaurants", {"id": RESTAURANT_ID}, {"name": "Chez Test"}))
    repo.seed("phone_numbers", [{"restaurant_id": RESTAURANT_ID, "status": "active", "e164": "+14165550102"}])
    repo.seed("orders", [{
        "id": "order-1", "restaurant_id": RESTAURANT_ID, "phone": "+14165550199",
        "total_cents": 4_275, "paid_status": "unpaid",
    }])

    async def scenario():
        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        sms_client = httpx.AsyncClient(transport=httpx.MockTransport(send_sms))
        dispatcher = ToolDispatcher(
            repo,
            payment_links_enabled=True,
            payment_link_base_url="https://app.test",
            worker_hmac_secret="worker-secret",
            payment_http_client=client,
            sms_http_client=sms_client,
        )
        result = await dispatcher.dispatch(
            "send_payment_link",
            {"order_id": "order-1"},
            ToolContext(**{**context().__dict__, "language": language}),
        )
        await client.aclose()
        await sms_client.aclose()
        return result

    result = asyncio.run(scenario())
    body = json.loads(bytes(captured["body"]))
    assert body == {"restaurant_id": RESTAURANT_ID, "call_id": CALL_ID, "order_id": "order-1"}
    assert "amount" not in str(body)
    assert verify_request(
        secret="worker-secret",
        timestamp=str(captured["timestamp"]),
        signature=str(captured["signature"]),
        method="POST",
        path="/api/payments/link",
        body=bytes(captured["body"]),
        now_seconds=int(str(captured["timestamp"])),
    )
    assert result["ok"] is True
    assert len(sms_requests) == 1
    sms_body = json.loads(sms_requests[0].content)
    assert sms_body["text"].startswith("Chez Test: ")
    assert "STOP" in sms_body["text"]
    assert sms_body["text"].endswith(expected)
    assert sms_body["from"] == "+14165550102"
    assert repo.rows("sms_log")[0]["body"] == sms_body["text"]
    assert repo.rows("sms_log")[0]["status"] == "sent"


def test_payment_link_sms_respects_restaurant_opt_out() -> None:
    repo = seeded_repository()
    repo.seed("orders", [{
        "id": "order-1", "restaurant_id": RESTAURANT_ID, "phone": "+14165550199",
        "total_cents": 4_275, "paid_status": "unpaid",
    }])
    repo.seed("sms_optouts", [{"restaurant_id": RESTAURANT_ID, "phone_e164": "+14165550199"}])
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"url": "https://buy.stripe.test/link", "target_id": "order-1"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(respond))

    async def scenario():
        dispatcher = ToolDispatcher(
            repo, payment_links_enabled=True, payment_link_base_url="https://app.test",
            worker_hmac_secret="worker-secret", payment_http_client=client,
        )
        result = await dispatcher.dispatch("send_payment_link", {"order_id": "order-1"}, context())
        await client.aclose()
        return result

    result = asyncio.run(scenario())
    assert result["error"]["code"] == "sms_opted_out"
    assert repo.rows("sms_log") == []
    assert requests == []


def test_pipeline_tool_context_uses_pipecat_tool_call_id_for_turn() -> None:
    params = type("Params", (), {"tool_call_id": "turn-7"})()
    built = create_tool_context(
        params,
        call_id=CALL_ID,
        restaurant_id=RESTAURANT_ID,
        language="ur",
        caller_phone="+14165550111",
        dry_run=True,
    )
    assert built.idempotency_key == f"{CALL_ID}:turn-7"
    assert built.language == "ur"
    assert built.caller_phone == "+14165550111"
    assert built.dry_run is True


def test_supabase_booking_insert_preserves_call_and_uses_database_trigger() -> None:
    captured: dict[str, object] = {}

    def respond(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = request.content.decode()
        return httpx.Response(201, json=[{"id": "booking-1", "call_id": CALL_ID}])

    async def scenario():
        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        repo = SupabasePostgrestRepository("https://example.supabase.co", "sb_secret_test", client=client)
        result = await repo.create_booking(
            {
                "restaurant_id": RESTAURANT_ID,
                "call_id": CALL_ID,
                "name": "Caller",
                "phone_e164": "+14165550199",
                "party_size": 2,
                "starts_at": "2026-10-27T22:00:00Z",
                "notes": "",
                "status": "confirmed",
                "source": "call",
            }
        )
        await client.aclose()
        return result

    result = asyncio.run(scenario())
    assert result["call_id"] == CALL_ID
    assert captured["path"] == "/rest/v1/bookings"
    assert f'"call_id":"{CALL_ID}"' in str(captured["body"])


def test_supabase_network_failure_is_typed_as_unreachable() -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    async def scenario():
        client = httpx.AsyncClient(transport=httpx.MockTransport(fail))
        repo = SupabasePostgrestRepository(
            "https://example.supabase.co", "sb_secret_test", client=client
        )
        try:
            await repo.select("restaurants", {"id": RESTAURANT_ID})
        finally:
            await client.aclose()

    with pytest.raises(RepositoryError, match="Supabase is unreachable") as error:
        asyncio.run(scenario())

    assert error.value.code == "unreachable"


def test_dispatcher_queues_message_and_degrades_to_faq_when_supabase_is_unreachable(
    tmp_path: Path,
) -> None:
    class OfflineRepository:
        async def select(self, table, filters=None):
            raise RepositoryError("unreachable", "Supabase is unreachable")

    queue = OfflineMessageQueue(tmp_path / "offline.json", 10)
    dispatcher = ToolDispatcher(OfflineRepository(), offline_queue=queue)

    message = asyncio.run(
        dispatcher.dispatch(
            "take_message",
            {"name": "Caller", "phone": "+14165550199", "text": "Call me"},
            context(),
        )
    )
    faq = asyncio.run(dispatcher.dispatch("get_hours", {"date": "2026-10-27"}, context(turn=2)))

    assert message == {"ok": True, "queued_offline": True}
    assert json.loads((tmp_path / "offline.json").read_text(encoding="utf-8"))[0]["restaurant_id"] == RESTAURANT_ID
    assert faq["error"]["code"] == "faq_only"


def test_postcall_retries_transient_gemini_error_and_is_idempotent() -> None:
    attempts = 0
    requests: list[dict[str, object]] = []

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        requests.append(json.loads(request.content))
        if attempts == 1:
            return httpx.Response(503, json={"error": {"code": 503, "status": "UNAVAILABLE"}})
        return httpx.Response(
            200,
            json={
                "candidates": [{"content": {"parts": [{"text": '{"summary":"Booked dinner","outcome":"booking","qa_flags":[]}'}]}}],
                "usageMetadata": {"totalTokenCount": 20},
            },
        )

    repo = seeded_repository()
    repo.seed(
        "calls",
        [{
            "id": CALL_ID,
            "restaurant_id": RESTAURANT_ID,
            "started_at": "2026-10-27T20:00:00Z",
            "ended_at": "2026-10-27T20:01:01Z",
            "summary": "",
        }],
    )
    repo.seed(
        "call_turns",
        [{"call_id": CALL_ID, "idx": 0, "speaker": "caller", "language": "en", "text": "Book dinner"}],
    )
    client = GeminiClient(
        api_key="test-key",
        model="test-model",
        transport=httpx.MockTransport(respond),
        backoff_seconds=0,
    )
    processor = PostCallProcessor(repo, client)

    async def scenario():
        first = await processor.process(CALL_ID)
        second = await processor.process(CALL_ID)
        await client.aclose()
        return first, second

    first, second = asyncio.run(scenario())

    assert first == second
    assert attempts == 2
    fixture = json.loads(
        (
            Path(__file__).parents[3]
            / "docs/api/gemini/fixtures/structured_summary_request.json"
        ).read_text(encoding="utf-8")
    )
    assert requests[0]["generationConfig"]["responseMimeType"] == fixture[
        "variant_B_generationConfig"
    ]["responseMimeType"]
    assert repo.rows("calls")[0]["summary"] == "Booked dinner"
    assert repo.rows("usage_ledger")[0]["seconds"] == 66


def test_postcall_retry_reconciles_usage_after_partial_failure() -> None:
    class FailUsageOnceRepository(InMemoryRepository):
        fail_usage = True

        async def insert(self, table, row):
            if table == "usage_ledger" and self.fail_usage:
                self.fail_usage = False
                raise RuntimeError("temporary database error")
            return await super().insert(table, row)

    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": '{"summary":"Answered","outcome":"answered","qa_flags":[]}'}]}}]},
        )

    base = seeded_repository()
    repo = FailUsageOnceRepository(
        restaurant=base.rows("restaurants")[0],
        hours=base.rows("hours"),
        menu_items=base.rows("menu_items"),
        slots_config=base.rows("slots_config")[0],
    )
    repo.seed("calls", [{"id": CALL_ID, "restaurant_id": RESTAURANT_ID, "started_at": "2026-10-27T20:00:00Z", "ended_at": "2026-10-27T20:00:30Z", "summary": ""}])
    repo.seed("call_turns", [{"call_id": CALL_ID, "idx": 0, "speaker": "caller", "language": "en", "text": "Hours?"}])
    client = GeminiClient(api_key="test-key", model="test-model", transport=httpx.MockTransport(respond), backoff_seconds=0)
    processor = PostCallProcessor(repo, client)

    async def scenario():
        with pytest.raises(RuntimeError, match="temporary database error"):
            await processor.process(CALL_ID)
        result = await processor.process(CALL_ID)
        await client.aclose()
        return result

    result = asyncio.run(scenario())
    assert result["summary"] == "Answered"
    assert repo.rows("usage_ledger")[0]["seconds"] == 30


def test_postcall_success_does_not_sleep_or_notify() -> None:
    class SuccessfulGemini:
        attempts = 0

        async def analyze_call(self, transcript: str) -> PostCallAnalysis:
            self.attempts += 1
            return PostCallAnalysis("Answered", "answered", ())

    repo = seeded_repository()
    repo.seed("calls", [{"id": CALL_ID, "restaurant_id": RESTAURANT_ID, "started_at": "2026-10-27T20:00:00Z", "ended_at": "2026-10-27T20:00:30Z"}])
    repo.seed("call_turns", [{"call_id": CALL_ID, "idx": 0, "speaker": "caller", "language": "en", "text": "Hours?"}])
    gemini = SuccessfulGemini()
    sleeps: list[float] = []
    notifications: list[dict[str, str]] = []

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    async def notify(event: dict[str, str]) -> None:
        notifications.append(event)

    result = asyncio.run(PostCallProcessor(repo, gemini, sleep=sleep, notify_owner=notify).process(CALL_ID))

    assert result["summary"] == "Answered"
    assert gemini.attempts == 1
    assert sleeps == []
    assert notifications == []


def test_postcall_fails_twice_then_succeeds_on_third_attempt() -> None:
    class FlakyGemini:
        attempts = 0

        async def analyze_call(self, transcript: str) -> PostCallAnalysis:
            self.attempts += 1
            if self.attempts < 3:
                raise httpx.NetworkError("transient")
            return PostCallAnalysis("Recovered", "answered", ())

    repo = seeded_repository()
    repo.seed("calls", [{"id": CALL_ID, "restaurant_id": RESTAURANT_ID, "started_at": "2026-10-27T20:00:00Z", "ended_at": "2026-10-27T20:00:30Z"}])
    gemini = FlakyGemini()
    sleeps: list[float] = []

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    result = asyncio.run(PostCallProcessor(repo, gemini, sleep=sleep).process(CALL_ID))

    assert result["summary"] == "Recovered"
    assert gemini.attempts == 3
    assert sleeps == [1.0, 4.0]


def test_postcall_retries_generic_gemini_5xx_failure() -> None:
    class FlakyGemini:
        attempts = 0

        async def analyze_call(self, transcript: str) -> PostCallAnalysis:
            self.attempts += 1
            if self.attempts == 1:
                raise GeminiError("Gemini request failed with status 502")
            return PostCallAnalysis("Recovered", "answered", ())

    repo = seeded_repository()
    repo.seed("calls", [{"id": CALL_ID, "restaurant_id": RESTAURANT_ID, "started_at": "2026-10-27T20:00:00Z", "ended_at": "2026-10-27T20:00:30Z"}])
    gemini = FlakyGemini()

    async def no_wait(delay: float) -> None:
        return None

    result = asyncio.run(
        PostCallProcessor(repo, gemini, sleep=no_wait).process(CALL_ID)
    )

    assert result["summary"] == "Recovered"
    assert gemini.attempts == 2


def test_postcall_four_transient_failures_flag_and_notify_exactly_once(caplog) -> None:
    class UnavailableGemini:
        attempts = 0

        async def analyze_call(self, transcript: str) -> PostCallAnalysis:
            self.attempts += 1
            raise httpx.NetworkError("contains caller PII 416-555-0199")

    repo = seeded_repository()
    repo.seed("calls", [{"id": CALL_ID, "restaurant_id": RESTAURANT_ID, "started_at": "2026-10-27T20:00:00Z", "ended_at": "2026-10-27T20:00:30Z", "qa_flags": []}])
    gemini = UnavailableGemini()
    notifications: list[dict[str, str]] = []
    sleeps: list[float] = []

    async def notify(event: dict[str, str]) -> None:
        notifications.append(event)

    async def no_wait(delay: float) -> None:
        sleeps.append(delay)

    processor = PostCallProcessor(repo, gemini, sleep=no_wait, notify_owner=notify)
    with caplog.at_level("ERROR"):
        with pytest.raises(httpx.NetworkError):
            asyncio.run(processor.process(CALL_ID))
        with pytest.raises(httpx.NetworkError):
            asyncio.run(processor.process(CALL_ID))

    assert gemini.attempts == 8
    assert sleeps == [1.0, 4.0, 16.0, 1.0, 4.0, 16.0]
    assert repo.rows("calls")[0]["qa_flags"] == ["postcall_failed"]
    assert notifications == [{"type": "flagged_call", "call_id": CALL_ID, "idempotency_key": f"postcall_failed:{CALL_ID}"}]
    assert {record.error_class for record in caplog.records} == {"NetworkError"}
    assert "416-555-0199" not in caplog.text


def test_postcall_non_retryable_validation_error_has_one_attempt() -> None:
    class InvalidGemini:
        attempts = 0

        async def analyze_call(self, transcript: str) -> PostCallAnalysis:
            self.attempts += 1
            raise ValueError("invalid analysis")

    repo = seeded_repository()
    repo.seed("calls", [{"id": CALL_ID, "restaurant_id": RESTAURANT_ID, "started_at": "2026-10-27T20:00:00Z", "ended_at": "2026-10-27T20:00:30Z"}])
    gemini = InvalidGemini()
    sleeps: list[float] = []

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    with pytest.raises(ValueError, match="invalid analysis"):
        asyncio.run(PostCallProcessor(repo, gemini, sleep=sleep).process(CALL_ID))

    assert gemini.attempts == 1
    assert sleeps == []


def test_postcall_retry_after_ambiguous_usage_insert_keeps_one_ledger_row() -> None:
    class AmbiguousUsageRepository(InMemoryRepository):
        failed = False

        async def insert(self, table, row):
            inserted = await super().insert(table, row)
            if table == "usage_ledger" and not self.failed:
                self.failed = True
                raise RepositoryError("unreachable", "response lost after commit")
            return inserted

    base = seeded_repository()
    repo = AmbiguousUsageRepository(
        restaurant=base.rows("restaurants")[0],
        hours=base.rows("hours"),
        menu_items=base.rows("menu_items"),
        slots_config=base.rows("slots_config")[0],
    )
    repo.seed("calls", [{"id": CALL_ID, "restaurant_id": RESTAURANT_ID, "started_at": "2026-10-27T20:00:00Z", "ended_at": "2026-10-27T20:00:30Z"}])

    class SuccessfulGemini:
        async def analyze_call(self, transcript: str) -> PostCallAnalysis:
            return PostCallAnalysis("Answered", "answered", ())

    async def no_wait(delay: float) -> None:
        return None

    asyncio.run(PostCallProcessor(repo, SuccessfulGemini(), sleep=no_wait).process(CALL_ID))

    assert len(repo.rows("usage_ledger")) == 1
    assert repo.rows("usage_ledger")[0]["seconds"] == 30


def test_postcall_deadline_never_starts_backoff_that_crosses_120_seconds() -> None:
    now = 0.0

    class SlowFailingGemini:
        attempts = 0

        async def analyze_call(self, transcript: str) -> PostCallAnalysis:
            nonlocal now
            self.attempts += 1
            now += 59.0
            raise httpx.NetworkError("transient")

    async def sleep(delay: float) -> None:
        nonlocal now
        now += delay

    async def notify(event: dict[str, str]) -> None:
        return None

    repo = seeded_repository()
    repo.seed("calls", [{"id": CALL_ID, "restaurant_id": RESTAURANT_ID, "started_at": "2026-10-27T20:00:00Z", "ended_at": "2026-10-27T20:00:30Z"}])
    gemini = SlowFailingGemini()

    with pytest.raises(httpx.NetworkError):
        asyncio.run(PostCallProcessor(repo, gemini, sleep=sleep, clock=lambda: now, notify_owner=notify).process(CALL_ID))

    assert gemini.attempts == 2
    assert now == 119.0


def test_postcall_backoff_timeout_still_runs_terminal_handling(caplog) -> None:
    now = 0.0

    class SlowFailingGemini:
        attempts = 0

        async def analyze_call(self, transcript: str) -> PostCallAnalysis:
            nonlocal now
            self.attempts += 1
            now = 114.99
            raise httpx.NetworkError("transient")

    async def blocked_sleep(delay: float) -> None:
        await asyncio.Event().wait()

    notifications: list[dict[str, str]] = []

    async def notify(event: dict[str, str]) -> None:
        notifications.append(event)

    repo = seeded_repository()
    repo.seed("calls", [{"id": CALL_ID, "restaurant_id": RESTAURANT_ID, "started_at": "2026-10-27T20:00:00Z", "ended_at": "2026-10-27T20:00:30Z"}])

    with caplog.at_level("ERROR"):
        with pytest.raises(httpx.NetworkError):
            asyncio.run(
                PostCallProcessor(
                    repo,
                    SlowFailingGemini(),
                    sleep=blocked_sleep,
                    clock=lambda: now,
                    notify_owner=notify,
                ).process(CALL_ID)
            )

    assert repo.rows("calls")[0]["qa_flags"] == ["postcall_failed"]
    assert len(notifications) == 1
    assert {record.error_class for record in caplog.records} == {"NetworkError"}


def test_postcall_persistent_repository_outage_still_logs_and_notifies(caplog) -> None:
    class UnavailableRepository:
        attempts = 0

        async def select(self, table, filters=None):
            self.attempts += 1
            raise RepositoryError("unreachable", "database unavailable")

    class UnusedGemini:
        async def analyze_call(self, transcript: str) -> PostCallAnalysis:
            pytest.fail("Gemini must not run")

    async def no_wait(delay: float) -> None:
        return None

    notifications: list[dict[str, str]] = []

    async def notify(event: dict[str, str]) -> None:
        notifications.append(event)

    repo = UnavailableRepository()
    with caplog.at_level("ERROR"):
        with pytest.raises(RepositoryError, match="database unavailable"):
            asyncio.run(
                PostCallProcessor(
                    repo,
                    UnusedGemini(),
                    sleep=no_wait,
                    notify_owner=notify,
                ).process(CALL_ID)
            )

    assert repo.attempts == 5
    assert notifications == [{"type": "flagged_call", "call_id": CALL_ID, "idempotency_key": f"postcall_failed:{CALL_ID}"}]
    assert {record.error_class for record in caplog.records} == {"RepositoryError"}


@pytest.mark.parametrize("code", ["22P02", "PGRST204"])
def test_postcall_repository_validation_error_is_not_retried(code: str) -> None:
    class InvalidRepository:
        attempts = 0

        async def select(self, table, filters=None):
            self.attempts += 1
            raise RepositoryError(code, "invalid input syntax")

    class UnusedGemini:
        async def analyze_call(self, transcript: str) -> PostCallAnalysis:
            pytest.fail("Gemini must not run")

    async def notify(event: dict[str, str]) -> None:
        return None

    repo = InvalidRepository()
    with pytest.raises(RepositoryError, match="invalid input syntax"):
        asyncio.run(
            PostCallProcessor(repo, UnusedGemini(), notify_owner=notify).process(
                CALL_ID
            )
        )

    assert repo.attempts == 2


def test_e164_accepts_spoken_ten_digit_canadian_numbers():
    import pytest
    from voice_receptionist_worker.tools.dispatcher import ToolInputError, _e164

    assert _e164("4165550199") == "+14165550199"
    assert _e164("(416) 555-0199") == "+14165550199"
    assert _e164("1 416 555 0199") == "+14165550199"
    assert _e164("+14165550199") == "+14165550199"
    with pytest.raises(ToolInputError):
        _e164("555-0199")
