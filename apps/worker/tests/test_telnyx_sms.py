from __future__ import annotations

import asyncio
import json
import re

import httpx
import pytest

from voice_receptionist_worker.tools import InMemoryRepository, ToolContext, ToolDispatcher


RESTAURANT_ID = "restaurant-1"
MESSAGE_ID = "40385f64-5717-4562-b3fc-2c963f66afa6"
ARGUMENTS = {
    "template_key": "message_received",
    "vars": {"name": "Caller"},
    "phone": "+14165550199",
    "language": "en",
}


@pytest.fixture(autouse=True)
def telnyx_env(monkeypatch):
    monkeypatch.setenv("TELNYX_API_KEY", "test-telnyx-key")
    monkeypatch.setenv("TELNYX_BASE_URL", "https://telnyx.test/v2/")
    monkeypatch.setenv("TELNYX_MESSAGING_PROFILE_ID", "test-profile")


@pytest.fixture
def repo():
    repository = InMemoryRepository(
        restaurant={"id": RESTAURANT_ID, "name": "Chez Test"},
        hours=[], menu_items=[], slots_config={},
    )
    repository.seed("phone_numbers", [
        {"restaurant_id": "other", "status": "active", "e164": "+14165550100"},
        {"restaurant_id": RESTAURANT_ID, "status": "released", "e164": "+14165550101"},
        {"restaurant_id": RESTAURANT_ID, "status": "active", "e164": "+14165550102"},
    ])
    return repository


def context(*, dry_run=False, turn="sms-1"):
    return ToolContext(
        call_id="call-1", turn=turn, restaurant_id=RESTAURANT_ID,
        language="en", caller_phone="+14165550199", dry_run=dry_run,
    )


def accepted(_request):
    return httpx.Response(200, json={"data": {"id": MESSAGE_ID, "to": [{"status": "queued"}]}})


async def dispatch(repo, respond=accepted, *, arguments=None, ctx=None, **kwargs):
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        dispatcher = ToolDispatcher(repo, sms_http_client=client, **kwargs)
        return await dispatcher.dispatch("send_sms", arguments or ARGUMENTS, ctx or context())


@pytest.mark.parametrize("missing", ["TELNYX_API_KEY", "TELNYX_BASE_URL", "TELNYX_MESSAGING_PROFILE_ID"])
def test_missing_configuration_fails_instead_of_queuing(repo, monkeypatch, missing):
    monkeypatch.delenv(missing)
    result = asyncio.run(ToolDispatcher(repo).dispatch("send_sms", ARGUMENTS, context()))
    assert result["ok"] is False
    assert result["error"]["code"] == "sms_not_configured"
    assert repo.rows("sms_log") == []
    assert repo.rows("tool_invocations")[0]["status"] == "failed"


def test_send_posts_active_tenant_sender_and_records_provider_acceptance(repo):
    requests = []
    selections = []
    original_select = repo.select

    async def select(table, filters=None):
        selections.append((table, filters))
        return await original_select(table, filters)

    repo.select = select

    def respond(request):
        requests.append(request)
        assert repo.rows("sms_log")[0]["status"] != "sent"
        return accepted(request)

    result = asyncio.run(dispatch(repo, respond))
    assert result["ok"] is True
    assert result["message_id"] == MESSAGE_ID
    assert result["sms"]["status"] == "sent"
    assert result["sms"]["provider_message_id"] == MESSAGE_ID
    assert repo.rows("sms_log") == [result["sms"]]
    assert ("phone_numbers", {"restaurant_id": RESTAURANT_ID, "status": "active"}) in selections
    assert len(requests) == 1
    request = requests[0]
    assert request.method == "POST"
    assert str(request.url) == "https://telnyx.test/v2/messages"
    assert request.headers["authorization"] == "Bearer test-telnyx-key"
    assert request.headers["content-type"] == "application/json"
    assert re.fullmatch(r"[A-Za-z0-9_-]{1,255}", request.headers["idempotency-key"])
    assert json.loads(request.content) == {
        "from": "+14165550102", "to": "+14165550199",
        "messaging_profile_id": "test-profile", "type": "SMS",
        "text": "Chez Test: Reply STOP to opt out. We received your message, Caller.",
    }
    assert "delivered" not in result


@pytest.mark.parametrize(("language", "instruction", "text"), [
    ("en", "Reply STOP to opt out.", "We received your message, Caller."),
    ("fr-CA", "Répondez STOP pour vous désabonner.", "Nous avons reçu votre message, Caller."),
    ("ur", "پیغامات بند کرنے کے لیے STOP لکھ کر جواب دیں۔", "Caller، آپ کا پیغام موصول ہو گیا۔"),
    ("hi", "संदेश बंद करने के लिए STOP लिखकर जवाब दें।", "Caller, आपका संदेश मिल गया।"),
    ("pa", "ਸੁਨੇਹੇ ਬੰਦ ਕਰਨ ਲਈ STOP ਲਿਖ ਕੇ ਜਵਾਬ ਦਿਓ।", "Caller, ਤੁਹਾਡਾ ਸੁਨੇਹਾ ਮਿਲ ਗਿਆ।"),
    ("te", "సందేశాలు ఆపడానికి STOP అని ప్రత్యుత్తరం ఇవ్వండి.", "Caller, మీ సందేశం అందింది."),
    ("ar", "للإلغاء، أرسل STOP رداً على الرسالة.", "Caller، وصلتنا رسالتك."),
])
def test_localized_template_starts_with_identity_and_unsubscribe(repo, language, instruction, text):
    requests = []

    def respond(request):
        requests.append(json.loads(request.content))
        return accepted(request)

    result = asyncio.run(dispatch(repo, respond, arguments={**ARGUMENTS, "language": language}))
    assert result["ok"] is True
    assert requests[0]["text"] == f"Chez Test: {instruction} {text}"


@pytest.mark.parametrize("sender_field", ["from", "sender", "messaging_profile_id"])
def test_model_cannot_supply_sender_or_profile(repo, sender_field):
    result = asyncio.run(dispatch(
        repo, lambda _: pytest.fail("Provider must not run"),
        arguments={**ARGUMENTS, sender_field: "attacker"},
    ))
    assert result["error"]["code"] == "bad_input"
    assert repo.rows("sms_log") == []


def test_opt_out_blocks_all_provider_requests(repo):
    repo.seed("sms_optouts", [{"restaurant_id": RESTAURANT_ID, "phone_e164": "+14165550199"}])
    result = asyncio.run(dispatch(repo, lambda _: pytest.fail("Provider must not run")))
    assert result["error"]["code"] == "sms_opted_out"
    assert repo.rows("sms_log") == []


def test_other_restaurant_opt_out_does_not_block_send(repo):
    repo.seed("sms_optouts", [{"restaurant_id": "other", "phone_e164": "+14165550199"}])
    assert asyncio.run(dispatch(repo))["ok"] is True


def test_dry_run_has_zero_writes_and_requests_without_credentials(repo, monkeypatch):
    monkeypatch.delenv("TELNYX_API_KEY")
    result = asyncio.run(dispatch(repo, lambda _: pytest.fail("Provider must not run"), ctx=context(dry_run=True)))
    assert result == {"ok": True, "dry_run": True}
    assert repo.write_count == 0


def test_no_active_sender_for_tenant_fails_without_provider_request(repo):
    asyncio.run(repo.update("phone_numbers", {"e164": "+14165550102"}, {"status": "pending"}))
    result = asyncio.run(dispatch(repo, lambda _: pytest.fail("Provider must not run")))
    assert result["error"]["code"] == "sms_not_configured"
    assert repo.rows("sms_log") == []


@pytest.mark.parametrize("status", [302, 400, 401, 429, 500])
def test_http_rejection_never_claims_sent_or_leaks_provider_body(repo, status):
    result = asyncio.run(dispatch(repo, lambda _: httpx.Response(status, text="sensitive provider error")))
    assert result["ok"] is False
    assert result["error"]["code"] == "sms_provider_error"
    assert "sensitive" not in str(result)
    assert repo.rows("sms_log")[0]["status"] == "failed"
    assert repo.rows("tool_invocations")[0]["status"] == "failed"


@pytest.mark.parametrize(("error", "status"), [(httpx.ReadTimeout, "queued"), (httpx.ConnectError, "failed")])
def test_transport_failure_never_claims_sent(repo, error, status):
    def respond(request):
        raise error("sensitive transport error", request=request)

    result = asyncio.run(dispatch(repo, respond))
    assert result["ok"] is False
    assert result["error"]["code"] in {"sms_timeout", "sms_provider_error"}
    assert "sensitive" not in str(result)
    assert repo.rows("sms_log")[0]["status"] == status


@pytest.mark.parametrize("payload", [None, [], {}, {"data": None}, {"data": []}, {"data": {}},
    {"data": {"id": None}}, {"data": {"id": ""}}, {"data": {"id": "  "}}, {"data": {"id": 123}},
])
def test_success_requires_nonempty_string_message_id(repo, payload):
    result = asyncio.run(dispatch(repo, lambda _: httpx.Response(200, content=json.dumps(payload))))
    assert result["ok"] is False
    assert result["error"]["code"] == "sms_provider_error"
    assert repo.rows("sms_log")[0]["status"] == "failed"


def test_non_json_success_does_not_claim_sent(repo):
    result = asyncio.run(dispatch(repo, lambda _: httpx.Response(200, text="invalid JSON")))
    assert result["error"]["code"] == "sms_provider_error"
    assert repo.rows("sms_log")[0]["status"] == "failed"


def test_concurrent_and_persisted_duplicate_invocations_send_once(repo):
    requests = []

    async def respond(request):
        requests.append(request)
        await asyncio.sleep(0)
        return accepted(request)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            dispatcher = ToolDispatcher(repo, sms_http_client=client)
            results = await asyncio.gather(*[
                dispatcher.dispatch("send_sms", ARGUMENTS, context()) for _ in range(3)
            ])
            results.append(await ToolDispatcher(repo, sms_http_client=client).dispatch("send_sms", ARGUMENTS, context()))
            assert not client.is_closed
            return results

    results = asyncio.run(scenario())
    assert all(result == results[0] and result["ok"] for result in results)
    assert len(requests) == 1
    assert len(repo.rows("sms_log")) == 1


def test_distinct_invocations_have_distinct_provider_keys(repo):
    keys = []

    def respond(request):
        keys.append(request.headers["idempotency-key"])
        return accepted(request)

    for turn in ["sms-1", "sms-2"]:
        assert asyncio.run(dispatch(repo, respond, ctx=context(turn=turn)))["ok"]
    assert len(set(keys)) == 2


def test_dispatch_deadline_does_not_claim_sent_and_duplicate_never_resends(repo):
    requests = []

    async def respond(request):
        requests.append(request)
        await asyncio.Event().wait()

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            dispatcher = ToolDispatcher(repo, sms_http_client=client, timeout_seconds=0.01)
            first = await dispatcher.dispatch("send_sms", ARGUMENTS, context())
            assert await dispatcher.dispatch("send_sms", ARGUMENTS, context()) == first
            return first

    result = asyncio.run(scenario())
    assert result["error"]["code"] == "timeout"
    assert repo.rows("sms_log")[0]["status"] == "queued"
    assert repo.rows("tool_invocations")[0]["status"] == "timed_out"
    assert len(requests) == 1
