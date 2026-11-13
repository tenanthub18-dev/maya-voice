import importlib.util
import json
import signal
import subprocess
from pathlib import Path

import httpx
import pytest


def load_setup(tmp_path, monkeypatch):
    path = Path(__file__).parents[3] / "scripts/dev/phone-test/local.py"
    spec = importlib.util.spec_from_file_location("phone_local_setup", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "OUT", tmp_path)
    monkeypatch.setattr(module, "STATE", tmp_path / "runtime.json")
    monkeypatch.setattr(module, "dotenv", lambda _: {})
    return module


def test_prepare_recovers_login_when_private_runtime_password_was_recreated(tmp_path, monkeypatch):
    setup = load_setup(tmp_path, monkeypatch)
    updates = []
    local = {"API_URL": "http://127.0.0.1:55321", "SERVICE_ROLE_KEY": "local-secret", "ANON_KEY": "local-publishable"}
    monkeypatch.setattr(setup.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, json.dumps(local), ""))

    def respond(request):
        if request.method == "GET" and request.url.path.endswith("restaurants"):
            return httpx.Response(200, json=[{"id": setup.RESTAURANT_ID}])
        if request.method == "GET" and request.url.path.endswith("admin/users"):
            return httpx.Response(200, json={"users": [{"id": "owned-local-user", "email": setup.EMAIL}]})
        if request.method == "PUT" and request.url.path.endswith("admin/users/owned-local-user"):
            updates.append(json.loads(request.content))
        return httpx.Response(200, json={})

    factory = httpx.Client
    monkeypatch.setattr(setup.httpx, "Client", lambda **kwargs: factory(transport=httpx.MockTransport(respond), **kwargs))
    setup.prepare()
    state = json.loads(setup.STATE.read_text())
    assert updates == [{"password": state["password"]}]
    assert f"Password: {state['password']}" in (tmp_path / "login.txt").read_text()


def test_sigterm_unwinds_launcher_and_terminates_all_owned_process_groups(tmp_path, monkeypatch):
    setup = load_setup(tmp_path, monkeypatch)
    handlers, terminated, children = {}, [], []
    monkeypatch.setattr(setup, "environment", lambda _: {})
    monkeypatch.setattr(setup.signal, "signal", lambda sig, handler: handlers.update({sig: handler}))
    monkeypatch.setattr(setup.os, "killpg", lambda pid, sig: terminated.append((pid, sig)))

    class UnoccupiedSocket:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def connect_ex(self, _): return 61

    class Child:
        def __init__(self, *args, **kwargs):
            self.pid = 1000 + len(children)
            children.append(self)
        def poll(self): return None
        def wait(self, **kwargs): return 0

    monkeypatch.setattr(setup.socket, "socket", UnoccupiedSocket)
    monkeypatch.setattr(setup.subprocess, "Popen", Child)

    def terminate(_):
        assert signal.SIGTERM in handlers, "SIGTERM must invoke cleanup instead of orphaning services"
        handlers[signal.SIGTERM](signal.SIGTERM, None)

    monkeypatch.setattr(setup.time, "sleep", terminate)
    with pytest.raises(KeyboardInterrupt):
        setup.serve({"env": {}})
    assert terminated == [(child.pid, signal.SIGTERM) for child in children]
