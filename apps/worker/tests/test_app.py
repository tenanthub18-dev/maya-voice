import base64
import asyncio
import hashlib
import hmac
import logging
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from time import monotonic
from xml.etree import ElementTree

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from voice_receptionist_worker import main as worker_main
from voice_receptionist_worker.main import app


def _telnyx_signature_headers(monkeypatch, body: bytes = b"") -> dict[str, str]:
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    monkeypatch.setenv("TELNYX_PUBLIC_KEY", base64.b64encode(public_key).decode())
    timestamp = str(int(time.time()))
    signature = base64.b64encode(
        private_key.sign(timestamp.encode() + b"|" + body)
    ).decode()
    return {
        "Telnyx-Timestamp": timestamp,
        "Telnyx-Signature-Ed25519": signature,
        "Content-Type": "application/x-www-form-urlencoded",
    }


def _websocket_token(secret: str, timestamp: int, call_id: str = "") -> str:
    signed = f"{timestamp}|{call_id}" if call_id else str(timestamp)
    digest = hmac.new(
        secret.encode(),
        signed.encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{timestamp}.{digest}"


def test_healthz_reports_absent_providers_as_unconfigured(monkeypatch) -> None:
    for name in (
        "SONIOX_API_KEY",
        "SONIOX_HEALTHCHECK_URL",
        "GEMINI_API_KEY",
        "GEMINI_HEALTHCHECK_URL",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
    ):
        monkeypatch.delenv(name, raising=False)

    response = TestClient(app).get("/healthz")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "checks": {
            "soniox": "unconfigured",
            "gemini": "unconfigured",
            "supabase": "unconfigured",
        },
    }


def test_healthz_probes_configured_provider_endpoints(monkeypatch) -> None:
    configured_environment = {
        "SONIOX_API_KEY": "test-key",
        "SONIOX_HEALTHCHECK_URL": "https://soniox.invalid/health",
        "GEMINI_API_KEY": "test-key",
        "GEMINI_HEALTHCHECK_URL": "https://gemini.invalid/health",
        "SUPABASE_URL": "https://supabase.invalid",
        "SUPABASE_SERVICE_ROLE_KEY": "test-key",
    }
    for name, value in configured_environment.items():
        monkeypatch.setenv(name, value)
    calls: list[tuple[str, float, bool]] = []
    active = 0
    max_active = 0

    class FakeAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_value, traceback):
            return None

        async def get(self, endpoint, *, timeout, follow_redirects):
            nonlocal active, max_active
            calls.append((endpoint, timeout, follow_redirects))
            active += 1
            max_active = max(max_active, active)
            await asyncio.sleep(0)
            active -= 1
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(worker_main.httpx, "AsyncClient", FakeAsyncClient)

    response = TestClient(app).get("/healthz")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "checks": {
            "soniox": "reachable",
            "gemini": "reachable",
            "supabase": "reachable",
        },
    }
    assert max_active == 3
    assert {timeout for _, timeout, _ in calls} == {0.8}
    assert all(follow_redirects for _, _, follow_redirects in calls)


def test_healthz_bounds_the_overall_probe_budget(monkeypatch) -> None:
    configured_environment = {
        "SONIOX_API_KEY": "test-key",
        "SONIOX_HEALTHCHECK_URL": "https://soniox.invalid/health",
        "GEMINI_API_KEY": "test-key",
        "GEMINI_HEALTHCHECK_URL": "https://gemini.invalid/health",
        "SUPABASE_URL": "https://supabase.invalid",
        "SUPABASE_SERVICE_ROLE_KEY": "test-key",
    }
    for name, value in configured_environment.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(worker_main, "HEALTH_OVERALL_TIMEOUT_SECONDS", 0.01)

    class SlowAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_value, traceback):
            return None

        async def get(self, endpoint, *, timeout, follow_redirects):
            await asyncio.sleep(0.2)
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(worker_main.httpx, "AsyncClient", SlowAsyncClient)

    started_at = monotonic()
    response = TestClient(app).get("/healthz")
    elapsed = monotonic() - started_at

    assert elapsed < 0.15
    assert response.json() == {
        "status": "degraded",
        "checks": {
            "soniox": "unreachable",
            "gemini": "unreachable",
            "supabase": "unreachable",
        },
    }


def test_texml_connects_call_to_request_host(monkeypatch) -> None:
    monkeypatch.setattr(worker_main.time, "time", lambda: 1_700_000_000)
    headers = _telnyx_signature_headers(monkeypatch)
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.setenv("TRANSFER_PHONE_FALLBACK", "+14165550123")
    monkeypatch.setattr(
        worker_main,
        "load_runtime_config",
        lambda *args: SimpleNamespace(),
    )

    response = TestClient(app, base_url="https://worker.example").post(
        "/telnyx/texml",
        headers=headers,
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/xml")
    root = ElementTree.fromstring(response.content)
    assert root.tag == "Response"
    stream = root.find("./Connect/Stream")
    assert stream is not None
    assert stream.attrib == {
        "url": (
            "wss://worker.example/ws?t=1700000000."
            "1b74eaf87da46877ba651ac812b24a3bf01990e9ed0101b88268f60f965729e2"
        ),
        "bidirectionalMode": "rtp",
        "bidirectionalCodec": "PCMU",
        "bidirectionalSamplingRate": "8000",
        "enableReconnect": "false",
    }
    assert root.findtext("./Say") == "Please hold while I transfer your call."
    assert root.findtext("./Dial") == "+14165550123"


def test_startup_log_requires_telnyx_voice_fallback_url(caplog) -> None:
    with caplog.at_level(logging.WARNING):
        worker_main._log_telnyx_failover_requirement()

    assert "voice_fallback_url" in caplog.text
    assert "TRANSFER_PHONE_FALLBACK" in caplog.text


def test_texml_dials_human_when_runtime_config_fails(monkeypatch, caplog) -> None:
    headers = _telnyx_signature_headers(monkeypatch)
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.setenv("TRANSFER_PHONE_FALLBACK", "+14165550123")

    def unavailable_config(*args):
        raise RuntimeError("configuration unavailable")

    monkeypatch.setattr(worker_main, "load_runtime_config", unavailable_config)

    with caplog.at_level(logging.ERROR):
        response = TestClient(app).post("/telnyx/texml", headers=headers)

    root = ElementTree.fromstring(response.content)
    assert response.status_code == 200
    assert root.findtext("./Dial") == "+14165550123"
    assert root.find("./Connect") is None
    assert "Unable to prepare Telnyx call" in caplog.text


def test_texml_forwards_spend_capped_account_without_starting_stream(monkeypatch) -> None:
    headers = _telnyx_signature_headers(monkeypatch)
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.setenv("TRANSFER_PHONE_FALLBACK", "+14165550123")
    monkeypatch.setattr(
        worker_main,
        "load_runtime_config",
        lambda *args: SimpleNamespace(
            restaurant={"spend_cap_reached": True, "billing_status": "active"}
        ),
    )

    response = TestClient(app).post("/telnyx/texml", headers=headers)

    root = ElementTree.fromstring(response.content)
    assert root.findtext("./Dial") == "+14165550123"
    assert root.find("./Connect") is None


def test_texml_allows_agent_during_payment_grace_then_forwards_after_seven_days(monkeypatch) -> None:
    monkeypatch.setattr(worker_main.time, "time", lambda: 1_700_000_000)
    headers = _telnyx_signature_headers(monkeypatch)
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.setenv("TRANSFER_PHONE_FALLBACK", "+14165550123")
    failed_at = datetime.fromtimestamp(1_700_000_000 - (7 * 24 * 60 * 60), tz=timezone.utc)

    monkeypatch.setattr(
        worker_main,
        "load_runtime_config",
        lambda *args: SimpleNamespace(
            restaurant={
                "spend_cap_reached": False,
                "last_invoice_status": "payment_failed",
                "stripe_invoice_event_created_at": (failed_at + timedelta(milliseconds=1)).isoformat(),
            }
        ),
    )
    grace = TestClient(app).post("/telnyx/texml", headers=headers)
    assert ElementTree.fromstring(grace.content).find("./Connect") is not None

    monkeypatch.setattr(
        worker_main,
        "load_runtime_config",
        lambda *args: SimpleNamespace(
            restaurant={
                "spend_cap_reached": False,
                "last_invoice_status": "payment_failed",
                "stripe_invoice_event_created_at": failed_at.isoformat(),
            }
        ),
    )
    blocked = TestClient(app).post("/telnyx/texml", headers=headers)
    root = ElementTree.fromstring(blocked.content)
    assert root.find("./Connect") is None
    assert root.findtext("./Dial") == "+14165550123"


def test_texml_uses_persisted_call_start_decision_and_restaurant_transfer_number(monkeypatch) -> None:
    body = b"To=%2B14165550199"
    headers = _telnyx_signature_headers(monkeypatch, body)
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.setenv("TRANSFER_PHONE_FALLBACK", "+14165550000")
    monkeypatch.setattr(worker_main, "load_runtime_config", lambda *args: SimpleNamespace(restaurant={}))
    seen: list[str | None] = []

    async def persisted(called_number, fallback):
        seen.append(called_number)
        return {"spend_cap_reached": True, "transfer_phone": "+14165550123"}

    monkeypatch.setattr(worker_main, "_load_call_start_restaurant", persisted)
    response = TestClient(app).post("/telnyx/texml", content=body, headers=headers)
    root = ElementTree.fromstring(response.content)

    assert seen == ["+14165550199"]
    assert root.find("./Connect") is None
    assert root.findtext("./Dial") == "+14165550123"


def test_texml_rechecks_number_kill_switch_on_every_request(monkeypatch) -> None:
    body = b"To=%2B14165550199"
    headers = _telnyx_signature_headers(monkeypatch, body)
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.setenv("TRANSFER_PHONE_FALLBACK", "+14165550000")
    monkeypatch.setattr(
        worker_main,
        "load_runtime_config",
        lambda *args: SimpleNamespace(restaurant={}),
    )
    decisions = iter(
        [
            {"kill_switch": False, "spend_cap_reached": False},
            {"kill_switch": True, "spend_cap_reached": False},
        ]
    )

    async def persisted(called_number, fallback):
        assert called_number == "+14165550199"
        return next(decisions)

    monkeypatch.setattr(worker_main, "_load_call_start_restaurant", persisted)
    client = TestClient(app)

    allowed = ElementTree.fromstring(
        client.post("/telnyx/texml", content=body, headers=headers).content
    )
    killed = ElementTree.fromstring(
        client.post("/telnyx/texml", content=body, headers=headers).content
    )

    assert allowed.find("./Connect") is not None
    assert killed.find("./Connect") is None
    assert killed.findtext("./Dial") == "+14165550000"


def test_texml_apologizes_and_hangs_up_when_websocket_secret_is_missing(
    monkeypatch,
) -> None:
    headers = _telnyx_signature_headers(monkeypatch)
    monkeypatch.delenv("WS_AUTH_SECRET", raising=False)
    monkeypatch.delenv("TRANSFER_PHONE_FALLBACK", raising=False)
    monkeypatch.setattr(
        worker_main,
        "load_runtime_config",
        lambda *args: SimpleNamespace(),
    )

    response = TestClient(app).post("/telnyx/texml", headers=headers)

    root = ElementTree.fromstring(response.content)
    assert response.status_code == 200
    assert root.find("./Say") is not None
    assert root.find("./Hangup") is not None
    assert root.find("./Connect") is None


def test_texml_returns_service_unavailable_without_public_key(monkeypatch) -> None:
    monkeypatch.delenv("TELNYX_PUBLIC_KEY", raising=False)

    response = TestClient(app).post("/telnyx/texml")

    assert response.status_code == 503


def test_texml_validates_signature_when_public_key_is_configured(monkeypatch) -> None:
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    monkeypatch.setenv("TELNYX_PUBLIC_KEY", base64.b64encode(public_key).decode())
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.setattr(
        worker_main,
        "load_runtime_config",
        lambda *args: SimpleNamespace(),
    )
    body = b"CallSid=abc"
    timestamp = str(int(time.time()))
    signature = base64.b64encode(
        private_key.sign(timestamp.encode() + b"|" + body)
    ).decode()
    headers = {
        "Telnyx-Timestamp": timestamp,
        "Telnyx-Signature-Ed25519": signature,
        "Content-Type": "application/x-www-form-urlencoded",
    }
    client = TestClient(app)

    valid_response = client.post("/telnyx/texml", content=body, headers=headers)
    invalid_response = client.post(
        "/telnyx/texml",
        content=body + b"-tampered",
        headers=headers,
    )

    assert valid_response.status_code == 200
    assert invalid_response.status_code == 401


@pytest.mark.parametrize("failing_stage", ["config", "parse", "pipeline"])
def test_websocket_closes_generically_on_any_pipeline_stage_exception(
    monkeypatch, caplog, failing_stage
) -> None:
    secret = "test-secret"
    timestamp = 1_700_000_000
    monkeypatch.setenv("WS_AUTH_SECRET", secret)
    monkeypatch.setattr(worker_main.time, "time", lambda: timestamp)

    def load_config(*args):
        if failing_stage == "config":
            raise RuntimeError("sensitive config failure")
        return SimpleNamespace()

    async def parse_websocket(websocket):
        if failing_stage == "parse":
            raise RuntimeError("sensitive parse failure")
        return "telnyx", SimpleNamespace()

    async def run_pipeline(config, websocket, stream_info):
        if failing_stage == "pipeline":
            raise RuntimeError("sensitive pipeline failure")

    monkeypatch.setattr(worker_main, "load_runtime_config", load_config)
    monkeypatch.setattr(worker_main, "_parse_telnyx_websocket", parse_websocket)
    monkeypatch.setattr(worker_main, "run_pipeline", run_pipeline)
    client = TestClient(app)
    token = _websocket_token(secret, timestamp)

    with caplog.at_level(logging.ERROR):
        with pytest.raises(WebSocketDisconnect) as closed:
            with client.websocket_connect(f"/ws?t={token}") as websocket:
                websocket.receive_text()

    assert closed.value.code == 1011
    assert closed.value.reason == "Internal server error"
    assert "sensitive" not in closed.value.reason
    assert "WebSocket pipeline failed" in caplog.text


def test_websocket_runs_postcall_after_live_pipeline(monkeypatch, tmp_path) -> None:
    secret = "test-secret"
    timestamp = 1_700_000_000
    call_id = "00000000-0000-0000-0000-000000000002"
    monkeypatch.setenv("WS_AUTH_SECRET", secret)
    monkeypatch.setenv("SUPABASE_URL", "https://supabase.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-key")
    monkeypatch.setattr(worker_main.time, "time", lambda: timestamp)
    monkeypatch.setattr(
        worker_main,
        "load_runtime_config",
        lambda *args: SimpleNamespace(
            restaurant={"id": "00000000-0000-0000-0000-000000000001"},
            providers={
                "resilience": {
                    "offline_queue": {
                        "path": str(tmp_path / "offline.json"),
                        "maximum_messages": 10,
                    }
                },
                "llm": {"model": "test-model"},
            },
        ),
    )

    async def parse_websocket(websocket):
        return "telnyx", {"call_id": call_id}

    events: list[str] = []

    async def run_pipeline(*args, **kwargs):
        events.append("pipeline")

    async def run_postcall(*args, **kwargs):
        events.append("postcall")

    class FakeRepository:
        async def aclose(self):
            events.append("repository_closed")

    async def load_live_runtime(repository, base_config, call_record_id):
        assert call_record_id == call_id
        return base_config, {}

    monkeypatch.setattr(worker_main, "_load_live_call_runtime", load_live_runtime)
    monkeypatch.setattr(worker_main, "_parse_telnyx_websocket", parse_websocket)
    monkeypatch.setattr(worker_main, "run_pipeline", run_pipeline)
    monkeypatch.setattr(worker_main, "_run_postcall_job", run_postcall)
    monkeypatch.setattr(worker_main, "SupabasePostgrestRepository", lambda *args: FakeRepository())

    token = _websocket_token(secret, timestamp, call_id)
    with TestClient(app).websocket_connect(f"/ws?t={token}&c={call_id}"):
        pass

    assert events == ["pipeline", "postcall", "repository_closed"]


def test_websocket_runs_postcall_when_live_pipeline_fails(monkeypatch, tmp_path) -> None:
    secret = "test-secret"
    timestamp = 1_700_000_000
    monkeypatch.setenv("WS_AUTH_SECRET", secret)
    monkeypatch.setenv("SUPABASE_URL", "https://supabase.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-key")
    monkeypatch.setattr(worker_main.time, "time", lambda: timestamp)
    monkeypatch.setattr(
        worker_main,
        "load_runtime_config",
        lambda *args: SimpleNamespace(
            restaurant={"id": "restaurant-1"},
            providers={"resilience": {"offline_queue": {
                "path": str(tmp_path / "offline.json"),
                "maximum_messages": 10,
            }}},
        ),
    )

    async def parse_websocket(websocket):
        return "telnyx", {"call_id": "call-1"}

    events: list[str] = []

    async def run_pipeline(*args, **kwargs):
        events.append("pipeline")
        raise RuntimeError("pipeline failed")

    async def run_postcall(*args, **kwargs):
        events.append("postcall")

    class FakeRepository:
        async def aclose(self):
            events.append("repository_closed")

    async def load_live_runtime(repository, base_config, call_record_id):
        return base_config, {}

    monkeypatch.setattr(worker_main, "_load_live_call_runtime", load_live_runtime)
    monkeypatch.setattr(worker_main, "_parse_telnyx_websocket", parse_websocket)
    monkeypatch.setattr(worker_main, "run_pipeline", run_pipeline)
    monkeypatch.setattr(worker_main, "_run_postcall_job", run_postcall)
    monkeypatch.setattr(
        worker_main,
        "SupabasePostgrestRepository",
        lambda *args: FakeRepository(),
    )

    call_id = "00000000-0000-0000-0000-000000000003"
    token = _websocket_token(secret, timestamp, call_id)
    with pytest.raises(WebSocketDisconnect):
        with TestClient(app).websocket_connect(f"/ws?t={token}&c={call_id}") as websocket:
            websocket.receive_text()

    assert events == ["pipeline", "postcall", "repository_closed"]


def test_flagged_call_owner_notification_uses_resend_idempotency_key(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RESEND_API_KEY", "test-key")
    monkeypatch.setenv("RESEND_FROM_EMAIL", "Receptionist <alerts@example.test>")
    monkeypatch.setenv("RESEND_BASE_URL", "https://resend.invalid")
    requests: list[tuple[str, dict[str, str], dict[str, object]]] = []

    class FakeRepository:
        async def select(self, table, filters=None):
            if table == "calls":
                return [{"restaurant_id": "restaurant-1"}]
            if table == "restaurants":
                return [{"organization_id": "organization-1"}]
            if table == "notification_preferences":
                return [{
                    "id": "preference-1",
                    "email": "owner@example.test",
                    "locale": "en",
                }]
            raise AssertionError(f"unexpected table: {table}")

    class FakeResponse:
        def raise_for_status(self):
            return None

    class FakeAsyncClient:
        def __init__(self, *, timeout):
            assert timeout == 4.0

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_value, traceback):
            return None

        async def post(self, url, *, headers, json):
            requests.append((url, headers, json))
            return FakeResponse()

    monkeypatch.setattr(worker_main.httpx, "AsyncClient", FakeAsyncClient)
    event = {
        "type": "flagged_call",
        "call_id": "call-1",
        "idempotency_key": "postcall_failed:call-1",
    }

    asyncio.run(worker_main._raise_owner_notification(FakeRepository(), event))

    assert requests == [(
        "https://resend.invalid/emails",
        {
            "Authorization": "Bearer test-key",
            "Content-Type": "application/json",
            "Idempotency-Key": "postcall_failed:call-1:preference-1",
        },
        {
            "from": "Receptionist <alerts@example.test>",
            "to": "owner@example.test",
            "subject": "Flagged call",
            "text": "Post-call processing failed. Review the call in the dashboard.",
            "html": "<h1>Flagged call</h1><p>Post-call processing failed. Review the call in the dashboard.</p>",
            "tags": [{"name": "notification", "value": "flagged_call"}],
        },
    )]


def test_postcall_job_closes_gemini_client(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    events: list[str] = []

    class FakeGeminiClient:
        def __init__(self, *, api_key, model):
            assert (api_key, model) == ("test-key", "test-model")

        async def aclose(self):
            events.append("gemini_closed")

    class FakeProcessor:
        def __init__(self, repository, gemini, *, notify_owner):
            assert repository is repo
            assert isinstance(gemini, FakeGeminiClient)
            assert callable(notify_owner)

        async def process(self, call_id):
            assert call_id == "call-1"
            events.append("processed")

    repo = object()
    config = SimpleNamespace(providers={"llm": {"model": "test-model"}})
    monkeypatch.setattr(worker_main, "GeminiClient", FakeGeminiClient)
    monkeypatch.setattr(worker_main, "PostCallProcessor", FakeProcessor)

    asyncio.run(worker_main._run_postcall_job(repo, config, "call-1"))

    assert events == ["processed", "gemini_closed"]


@pytest.mark.parametrize(
    "secret,now,token",
    [
        ("test-secret", 1_700_000_000, None),
        ("test-secret", 1_700_000_121, _websocket_token("test-secret", 1_700_000_000)),
        ("test-secret", 1_700_000_000, "1700000000." + "0" * 64),
        ("test-secret", 1_700_000_000.0, "9" * 400 + "." + "0" * 64),
    ],
)
def test_websocket_rejects_missing_stale_or_invalid_auth_before_accept(
    monkeypatch,
    secret,
    now,
    token,
) -> None:
    monkeypatch.setenv("WS_AUTH_SECRET", secret)
    monkeypatch.setattr(worker_main.time, "time", lambda: now)

    def must_not_load_config(*args):
        raise AssertionError("authentication must run before config load")

    monkeypatch.setattr(worker_main, "load_runtime_config", must_not_load_config)
    path = "/ws" if token is None else f"/ws?t={token}"

    with pytest.raises(WebSocketDisconnect) as closed:
        with TestClient(app).websocket_connect(path):
            pass

    assert closed.value.code == 1008


def test_texml_creates_call_record_and_signs_its_id(monkeypatch) -> None:
    monkeypatch.setattr(worker_main.time, "time", lambda: 1_700_000_000)
    body = b"CallSid=sid-1&From=%2B14165550100&To=%2B16475550100"
    headers = _telnyx_signature_headers(monkeypatch, body)
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.delenv("TRANSFER_PHONE_FALLBACK", raising=False)
    call_record_id = "00000000-0000-0000-0000-0000000000aa"
    created: list[tuple[str, str]] = []
    monkeypatch.setattr(
        worker_main, "load_runtime_config", lambda *args: SimpleNamespace()
    )

    async def load_restaurant(called_number, fallback):
        return {"restaurant_id": "restaurant-1", "agent_version_id": "version-1"}

    async def create_record(restaurant_config, telnyx_call_id, caller_phone):
        created.append((telnyx_call_id, caller_phone))
        return call_record_id

    monkeypatch.setattr(worker_main, "_load_call_start_restaurant", load_restaurant)
    monkeypatch.setattr(worker_main, "_create_call_record", create_record)

    response = TestClient(app, base_url="https://worker.example").post(
        "/telnyx/texml",
        headers=headers,
        content=body,
    )

    assert response.status_code == 200
    assert created == [("sid-1", "+14165550100")]
    stream = ElementTree.fromstring(response.content).find("./Connect/Stream")
    assert stream is not None
    expected_token = worker_main._websocket_auth_token(
        "test-secret", 1_700_000_000, call_record_id
    )
    assert stream.attrib["url"] == (
        f"wss://worker.example/ws?t={expected_token}&c={call_record_id}"
    )


def test_texml_forwards_call_when_no_agent_version_is_published(monkeypatch) -> None:
    monkeypatch.setattr(worker_main.time, "time", lambda: 1_700_000_000)
    headers = _telnyx_signature_headers(monkeypatch)
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.setattr(
        worker_main, "load_runtime_config", lambda *args: SimpleNamespace()
    )

    async def load_restaurant(called_number, fallback):
        return {
            "restaurant_id": "restaurant-1",
            "agent_version_id": None,
            "transfer_phone": "+14165550199",
        }

    monkeypatch.setattr(worker_main, "_load_call_start_restaurant", load_restaurant)

    response = TestClient(app, base_url="https://worker.example").post(
        "/telnyx/texml", headers=headers
    )

    root = ElementTree.fromstring(response.content)
    assert root.find("./Connect") is None
    assert root.findtext("./Dial") == "+14165550199"


def test_websocket_rejects_a_call_id_that_was_not_signed(monkeypatch) -> None:
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.setattr(worker_main.time, "time", lambda: 1_700_000_000)
    token = _websocket_token("test-secret", 1_700_000_000)

    with pytest.raises(WebSocketDisconnect) as closed:
        with TestClient(app).websocket_connect(f"/ws?t={token}&c=forged-call-id"):
            pass

    assert closed.value.code == 1008


def test_texml_signature_check_can_be_disabled_only_by_configuration(monkeypatch) -> None:
    monkeypatch.setattr(worker_main.time, "time", lambda: 1_700_000_000)
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.delenv("TELNYX_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("TRANSFER_PHONE_FALLBACK", raising=False)
    monkeypatch.setattr(
        worker_main, "load_runtime_config", lambda *args: SimpleNamespace()
    )
    client = TestClient(app, base_url="https://worker.example")

    assert client.post("/telnyx/texml").status_code == 503

    monkeypatch.setenv("TELNYX_TEXML_REQUIRE_SIGNATURE", "false")
    monkeypatch.delenv("TELNYX_TEXML_WEBHOOK_SECRET", raising=False)
    assert client.post("/telnyx/texml").status_code == 503

    monkeypatch.setenv("TELNYX_TEXML_WEBHOOK_SECRET", "s" * 32)
    assert client.post("/telnyx/texml").status_code == 401
    assert client.post("/telnyx/texml?token=incorrect").status_code == 401
    assert client.post("/telnyx/texml?token=%C3%A9").status_code == 401
    response = client.post("/telnyx/texml?token=" + "s" * 32)

    assert response.status_code == 200
    stream = ElementTree.fromstring(response.content).find("./Connect/Stream")
    assert stream is not None
    assert stream.attrib["enableReconnect"] == "false"


def test_texml_shared_secret_does_not_bypass_signature_mode(monkeypatch) -> None:
    monkeypatch.setenv("TELNYX_TEXML_REQUIRE_SIGNATURE", "true")
    monkeypatch.setenv("TELNYX_TEXML_WEBHOOK_SECRET", "s" * 32)
    monkeypatch.delenv("TELNYX_PUBLIC_KEY", raising=False)
    assert TestClient(app).post("/telnyx/texml?token=" + "s" * 32).status_code == 503


def test_caller_reference_matches_the_web_privacy_scheme(monkeypatch) -> None:
    secret = "s" * 32
    monkeypatch.setenv("PRIVACY_REQUEST_HASH_SECRET", secret)

    expected = hmac.new(
        secret.encode(), b"restaurant-1:+14165550100", hashlib.sha256
    ).hexdigest()

    assert worker_main._caller_reference("restaurant-1", "+14165550100") == expected


def test_texml_post_connect_dial_prefers_restaurant_transfer_number(monkeypatch) -> None:
    body = b"To=%2B14165550199"
    headers = _telnyx_signature_headers(monkeypatch, body)
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    monkeypatch.setenv("TRANSFER_PHONE_FALLBACK", "+14165550000")
    monkeypatch.setattr(worker_main, "load_runtime_config", lambda *args: SimpleNamespace(restaurant={}))

    async def persisted(called_number, fallback):
        return {"transfer_phone": "+14165550123"}

    monkeypatch.setattr(worker_main, "_load_call_start_restaurant", persisted)
    root = ElementTree.fromstring(
        TestClient(app).post("/telnyx/texml", content=body, headers=headers).content
    )

    assert root.find("./Connect") is not None
    assert root.findtext("./Dial") == "+14165550123"


def test_create_call_record_reuses_row_when_a_concurrent_retry_wins_the_insert(monkeypatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    monkeypatch.setenv("PRIVACY_REQUEST_HASH_SECRET", "x" * 32)

    class RacingRepository:
        def __init__(self, *args) -> None:
            self.selects = 0

        async def select(self, table, filters):
            self.selects += 1
            return [] if self.selects == 1 else [{"id": "call-1"}]

        async def insert(self, table, row):
            raise worker_main.RepositoryError("conflict", "duplicate key")

        async def aclose(self) -> None:
            return None

    monkeypatch.setattr(worker_main, "SupabasePostgrestRepository", RacingRepository)
    call_id = asyncio.run(
        worker_main._create_call_record(
            {"restaurant_id": "r1", "agent_version_id": "v1"}, "sid-1", "+14165550111"
        )
    )

    assert call_id == "call-1"


def test_websocket_auth_rejects_non_ascii_digest_without_raising(monkeypatch) -> None:
    monkeypatch.setenv("WS_AUTH_SECRET", "test-secret")
    token = f"{int(time.time())}.é"

    assert worker_main._verify_websocket_auth(token) is False
