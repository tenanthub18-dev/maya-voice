import base64
import hashlib
import hmac
import json
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from voice_receptionist_worker import main

ORIGIN = 'https://demo.example.com'
SECRET = 'browser-demo-test-secret-1234567890'

def token(**overrides):
    claims = dict(exp=int(time.time()) + 60, mode='test', transport='browser-audio',
                  restaurant_id='restaurant-1', agent_version_id='draft-1',
                  origin=ORIGIN, nonce=str(uuid.uuid4()))
    claims.update(overrides)
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
    return payload + '.' + hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()

@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv('TEST_CALL_HMAC_SECRET', SECRET)
    monkeypatch.setenv('BROWSER_DEMO_ALLOWED_ORIGINS', ORIGIN)
    seen = []
    async def pipeline(websocket, claims, **kwargs):
        seen.append((claims, kwargs))
        await websocket.send_json({'type': 'pipeline-started'})
        await websocket.receive_text()
    monkeypatch.setattr(main, '_launch_test_call_pipeline', pipeline)
    return TestClient(main.app), seen

def test_authentication_gates_provider_start_and_releases_call_slot(setup):
    client, seen = setup
    with client.websocket_connect('/browser-call', headers={'origin': ORIGIN}) as ws:
        ws.send_json({'type': 'authenticate', 'token': token()})
        assert ws.receive_json() == {'type': 'ready'}
        assert ws.receive_json() == {'type': 'pipeline-started'}
        assert seen[0][1] == {'dry_run_tools': True, 'browser_audio': True}
        ws.send_text('stop')

@pytest.mark.parametrize('claims', [dict(exp=1), dict(nonce=''), dict(transport='webrtc'), dict(origin='https://evil.example.com')])
def test_bad_claims_never_start_providers(setup, claims):
    client, seen = setup
    with client.websocket_connect('/browser-call', headers={'origin': ORIGIN}) as ws:
        ws.send_json({'type': 'authenticate', 'token': token(**claims)})
        with pytest.raises(WebSocketDisconnect) as error:
            ws.receive_json()
        assert error.value.code == 1008
    assert seen == []

@pytest.mark.parametrize('origin', ['', 'https://evil.example.com', 'null'])
def test_origin_rejected_before_accept(setup, origin):
    client, seen = setup
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/browser-call', headers={'origin': origin}):
            pass
    assert seen == []

def test_replay_and_forgery_rejected(setup):
    client, seen = setup
    signed = token()
    with client.websocket_connect('/browser-call', headers={'origin': ORIGIN}) as ws:
        ws.send_json({'type': 'authenticate', 'token': signed})
        ws.receive_json()
        ws.receive_json()
        ws.send_text('stop')
    for invalid in [signed, signed + '0']:
        with client.websocket_connect('/browser-call', headers={'origin': ORIGIN}) as ws:
            ws.send_json({'type': 'authenticate', 'token': invalid})
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
    assert len(seen) == 1

def test_call_limit_and_cleanup(setup):
    client, seen = setup
    with client.websocket_connect('/browser-call', headers={'origin': ORIGIN}) as first:
        first.send_json({'type': 'authenticate', 'token': token()})
        first.receive_json(); first.receive_json()
        with client.websocket_connect('/browser-call', headers={'origin': ORIGIN}) as second:
            second.send_json({'type': 'authenticate', 'token': token()})
            second.receive_json(); second.receive_json()
            with client.websocket_connect('/browser-call', headers={'origin': ORIGIN}) as third:
                third.send_json({'type': 'authenticate', 'token': token()})
                assert third.receive_json()['type'] == 'error'
            second.send_text('stop')
        first.send_text('stop')
    assert len(seen) == 2
    with client.websocket_connect('/browser-call', headers={'origin': ORIGIN}) as final:
        final.send_json({'type': 'authenticate', 'token': token()})
        assert final.receive_json()['type'] == 'ready'
        final.receive_json(); final.send_text('stop')


def test_pending_handshake_admission_limit_rejects_before_accept(setup, monkeypatch):
    client, seen = setup
    monkeypatch.setattr(main, '_browser_demo_pending_handshakes', 8)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/browser-call', headers={'origin': ORIGIN}):
            pass
    assert seen == []


def test_bad_handshake_releases_pending_admission(setup):
    client, seen = setup
    before = main._browser_demo_pending_handshakes
    with client.websocket_connect('/browser-call', headers={'origin': ORIGIN}) as ws:
        ws.send_text('not json')
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()
    assert main._browser_demo_pending_handshakes == before
    assert seen == []
