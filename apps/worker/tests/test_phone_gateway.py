import importlib.util
from pathlib import Path

import httpx
from starlette.testclient import TestClient


def load_gateway():
    path = Path(__file__).parents[3] / "scripts/dev/phone-test/gateway.py"
    spec = importlib.util.spec_from_file_location("phone_test_gateway", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_local_gateway_forwards_exact_sms_body_and_signature_only(monkeypatch):
    gateway = load_gateway()
    captured = []

    def respond(request):
        captured.append(request)
        return httpx.Response(401, json={"error": "invalid signature"})

    factory = httpx.AsyncClient
    monkeypatch.setenv("PHONE_TEST_WEB_ORIGIN", "http://127.0.0.1:3101")
    monkeypatch.setattr(gateway.httpx, "AsyncClient", lambda **kwargs: factory(transport=httpx.MockTransport(respond), **kwargs))
    with TestClient(gateway.app) as client:
        response = client.post("/api/webhooks/telnyx-sms", content=b'{ "data": {} }',
                               headers={"telnyx-signature-ed25519": "signature", "telnyx-timestamp": "123", "authorization": "untrusted"})
    assert response.status_code == 401
    assert captured[0].content == b'{ "data": {} }'
    assert captured[0].headers["telnyx-signature-ed25519"] == "signature"
    assert "authorization" not in captured[0].headers
    assert str(captured[0].url) == "http://127.0.0.1:3101/api/webhooks/telnyx-sms"


def test_local_gateway_keeps_dashboard_private_and_limits_sms_requests():
    gateway = load_gateway()
    with TestClient(gateway.app) as client:
        assert client.get("/home").status_code == 404
        assert client.get("/api/webhooks/telnyx-sms").status_code == 405
        assert client.post("/api/webhooks/telnyx-sms", content=b"x" * (64 * 1024 + 1)).status_code == 413
