import base64
import asyncio
import hashlib
import hmac
import json
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from voice_receptionist_worker import main as worker_main
from voice_receptionist_worker.main import app
from voice_receptionist_worker.security.hmac import sign_request


def _token(secret: str, claims: dict[str, object]) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps(claims, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()
    signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def _claims(now: int) -> dict[str, object]:
    return {
        "exp": now + 60,
        "mode": "test",
        "agent_version_id": "agent-version-7",
        "restaurant_id": "restaurant-1",
    }


def _authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _signed_headers(secret: str, now: int, body: str) -> dict[str, str]:
    timestamp = str(now)
    return {
        "X-Timestamp": timestamp,
        "X-Signature": sign_request(
            secret=secret,
            timestamp=timestamp,
            method="POST",
            path="/webrtc/offer",
            body=body.encode(),
        ),
        "Content-Type": "application/json",
    }


def test_webrtc_cors_allows_only_the_configured_web_app_origin() -> None:
    cors_app = FastAPI()
    worker_main._configure_test_call_cors(cors_app, "https://app.example.com")

    @cors_app.post("/webrtc/offer")
    async def offer() -> dict[str, bool]:
        return {"ok": True}

    client = TestClient(cors_app)
    allowed = client.options(
        "/webrtc/offer",
        headers={
            "Origin": "https://app.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    rejected = client.options(
        "/webrtc/offer",
        headers={
            "Origin": "https://attacker.example",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "https://app.example.com"
    assert "authorization" in allowed.headers["access-control-allow-headers"].lower()
    assert rejected.status_code == 400


def test_webrtc_offer_maps_pipecat_contract_and_launches_dry_run(monkeypatch) -> None:
    now = 1_700_000_000
    secret = "test-call-secret"
    monkeypatch.setenv("TEST_CALL_HMAC_SECRET", secret)
    monkeypatch.setattr(worker_main.time, "time", lambda: now)
    seen: dict[str, object] = {}

    class Handler:
        async def handle_web_request(self, request, callback):
            seen["request"] = request
            await callback(SimpleNamespace(pc_id="pc-generated"))
            return {"sdp": "answer-sdp", "type": "answer", "pc_id": "pc-generated"}

    async def launch(connection, claims, *, dry_run_tools):
        seen["launch"] = (connection, claims, dry_run_tools)

    monkeypatch.setattr(worker_main, "_small_webrtc_handler", Handler(), raising=False)
    monkeypatch.setattr(worker_main, "_launch_test_call_pipeline", launch, raising=False)
    monkeypatch.setattr(
        worker_main,
        "_build_small_webrtc_request",
        lambda body: SimpleNamespace(**body),
        raising=False,
    )

    body = json.dumps({
        "sdp": "offer-sdp",
        "type": "offer",
        "pc_id": "pc-existing",
        "restart_pc": True,
        "request_data": {"agent_version_id": "agent-version-7"},
    }, separators=(",", ":"))
    response = TestClient(app).post(
        "/webrtc/offer",
        headers={**_authorization(_token(secret, _claims(now))), **_signed_headers(secret, now, body)},
        content=body,
    )

    assert response.status_code == 200
    assert response.json() == {
        "sdp": "answer-sdp",
        "type": "answer",
        "pc_id": "pc-generated",
    }
    request = seen["request"]
    assert request.sdp == "offer-sdp"
    assert request.type == "offer"
    assert request.pc_id == "pc-existing"
    assert request.restart_pc is True
    assert request.request_data == {"agent_version_id": "agent-version-7"}
    connection, claims, dry_run_tools = seen["launch"]
    assert connection.pc_id == "pc-generated"
    assert claims == _claims(now)
    assert dry_run_tools is True


def test_webrtc_offer_requires_server_secret(monkeypatch) -> None:
    monkeypatch.delenv("TEST_CALL_HMAC_SECRET", raising=False)

    response = TestClient(app).post("/webrtc/offer", json={"sdp": "offer", "type": "offer"})

    assert response.status_code == 503
    assert response.json() == {"detail": "Test-call authentication unavailable"}


def test_webrtc_offer_rejects_missing_request_hmac(monkeypatch) -> None:
    now = 1_700_000_000
    secret = "test-call-secret"
    monkeypatch.setenv("TEST_CALL_HMAC_SECRET", secret)
    monkeypatch.setattr(worker_main.time, "time", lambda: now)

    response = TestClient(app).post(
        "/webrtc/offer",
        headers=_authorization(_token(secret, _claims(now))),
        json={"sdp": "offer", "type": "offer"},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid worker request signature"}


@pytest.mark.parametrize(
    "make_token",
    [
        lambda secret, now: "malformed",
        lambda secret, now: _token(secret, _claims(now)) + "tampered",
        lambda secret, now: _token(secret, {**_claims(now), "exp": now}),
        lambda secret, now: _token(secret, {**_claims(now), "exp": now - 1}),
        lambda secret, now: _token(secret, {**_claims(now), "exp": now + 121}),
        lambda secret, now: _token(secret, {**_claims(now), "mode": "live"}),
        lambda secret, now: _token(secret, {**_claims(now), "agent_version_id": ""}),
        lambda secret, now: _token(secret, {**_claims(now), "restaurant_id": 123}),
        lambda secret, now: _token(secret, {**_claims(now), "exp": "soon"}),
    ],
)
def test_webrtc_offer_rejects_invalid_tokens_before_handler(monkeypatch, make_token) -> None:
    now = 1_700_000_000
    secret = "test-call-secret"
    monkeypatch.setenv("TEST_CALL_HMAC_SECRET", secret)
    monkeypatch.setattr(worker_main.time, "time", lambda: now)

    class Handler:
        async def handle_web_request(self, request, callback):
            raise AssertionError("handler must not run before authentication")

    monkeypatch.setattr(worker_main, "_small_webrtc_handler", Handler(), raising=False)

    body = json.dumps({"sdp": "offer", "type": "offer"}, separators=(",", ":"))
    response = TestClient(app).post(
        "/webrtc/offer",
        headers={**_authorization(make_token(secret, now)), **_signed_headers(secret, now, body)},
        content=body,
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid test-call token"}


def test_webrtc_offer_rejects_missing_bearer_token_before_handler(monkeypatch) -> None:
    secret = "test-call-secret"
    now = int(time.time())
    monkeypatch.setenv("TEST_CALL_HMAC_SECRET", secret)

    class Handler:
        async def handle_web_request(self, request, callback):
            raise AssertionError("handler must not run before authentication")

    monkeypatch.setattr(worker_main, "_small_webrtc_handler", Handler(), raising=False)

    body = json.dumps({"sdp": "offer", "type": "offer"}, separators=(",", ":"))
    response = TestClient(app).post(
        "/webrtc/offer",
        headers=_signed_headers(secret, now, body),
        content=body,
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid test-call token"}


def test_test_call_pipeline_loads_the_signed_draft_restaurant_and_forces_dry_run(
    monkeypatch,
    tmp_path,
) -> None:
    from voice_receptionist_worker.pipeline import builder
    from voice_receptionist_worker.pipeline.config import RuntimeConfig

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key")
    monkeypatch.setattr(
        worker_main,
        "load_runtime_config",
        lambda *args: RuntimeConfig(
            providers={
                "stt": {},
                "llm": {},
                "tts": {},
                "resilience": {
                    "offline_queue": {
                        "path": str(tmp_path / "offline.json"),
                        "maximum_messages": 10,
                    }
                },
            },
            restaurant={"name": "fallback", "hours": {}, "menu": []},
        ),
    )
    seen: dict[str, object] = {}

    class Repository:
        async def select(self, table, filters=None):
            rows = {
                "agent_versions": [{"agent_id": "agent-1", "prompt_sections": {"rules": "Be concise."}}],
                "agents": [{"id": "agent-1", "restaurant_id": "restaurant-1"}],
                "restaurants": [{"id": "restaurant-1", "name": "Harbour Table", "timezone": "America/Toronto", "enabled_languages": ["en", "en-IN"]}],
                "hours": [{"weekday": 1, "open_time": "11:00", "close_time": "21:00"}],
                "menu_items": [{"name": "Poutine", "price_cents": 1299}],
                "legal_settings": [{"transcript_enabled": True}],
            }
            return rows[table]

        async def insert(self, table, row):
            assert table == "calls"
            seen["inserted_call_id"] = row["id"]
            return row

        async def update(self, table, filters, values):
            assert table == "calls"
            return {**filters, **values}

        async def aclose(self):
            seen["closed"] = True

    monkeypatch.setattr(worker_main, "SupabasePostgrestRepository", lambda *args: Repository())

    async def run(config, connection, **kwargs):
        seen["config"] = config
        seen["kwargs"] = kwargs

    monkeypatch.setattr(builder, "run_webrtc_pipeline", run)
    asyncio.run(worker_main._launch_test_call_pipeline(
        SimpleNamespace(pc_id="pc-1"),
        {"agent_version_id": "version-1", "restaurant_id": "restaurant-1"},
        dry_run_tools=True,
    ))

    config = seen["config"]
    assert config.restaurant == {
        "id": "restaurant-1",
        "name": "Harbour Table",
        "timezone": "America/Toronto",
        "enabled_languages": ["en", "en-IN"],
        "primary_language": "en",
        "agent_version_id": "version-1",
        "hours": {"1": "11:00-21:00"},
        "menu": [{"name": "Poutine", "price": "12.99"}],
    }
    assert seen["kwargs"]["dry_run_tools"] is True
    assert seen["kwargs"]["database_call_id"] == seen["inserted_call_id"]
    assert seen["kwargs"]["prompt_sections"] == {"rules": "Be concise."}
    assert seen["closed"] is True
