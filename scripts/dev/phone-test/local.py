"""Local-only real-phone setup. Run with apps/worker/.venv/bin/python.

No purchases, outbound calls or messages are made by this tool. Provider endpoints:
https://developers.telnyx.com/api-reference/texml-applications/creates-a-texml-application
https://developers.telnyx.com/api-reference/messaging-profiles/create-a-messaging-profile
https://supabase.com/docs/reference/javascript/auth-admin-createuser
"""

import argparse
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "tmp" / "phone-test"
STATE = OUT / "runtime.json"
RESTAURANT_ID = "02000000-0000-4000-8000-000000000002"
ORGANIZATION_ID = "01000000-0000-4000-8000-000000000001"
EMAIL = "owner@maya.test"
WORKER_PORT = 8187
WEB_PORT = 3101


def dotenv(path):
    result = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def save(state):
    OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(STATE, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(state, stream, indent=2)


def environment(state):
    return {**os.environ, **dotenv(ROOT / ".env.example"),
            **dotenv(ROOT / ".env.local"), **state["env"]}


def local_headers(env):
    key = env["SUPABASE_SERVICE_ROLE_KEY"]
    return {"apikey": key, **({"Authorization": "Bearer " + key} if key.count(".") == 2 else {})}


def request(client, method, url, **kwargs):
    response = client.request(method, url, **kwargs)
    if response.is_error:
        # Never include the credential-bearing request URL or provider body.
        raise RuntimeError(f"{method} {urlparse(url).path}: HTTP {response.status_code}")
    return response.json() if response.content else None


def prepare():
    result = subprocess.run(["supabase", "status", "-o", "json"], cwd=ROOT,
                            capture_output=True, text=True, check=True)
    local = json.loads(result.stdout)
    if urlparse(local["API_URL"]).hostname not in {"localhost", "127.0.0.1"}:
        raise RuntimeError("Refusing to prepare a non-local database")
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    if state.get("pilot"):
        raise RuntimeError("Pilot client is configured; use pilot.py to refresh its data or local.py serve to restart. No existing client was changed.")
    state.setdefault("email", EMAIL)
    state.setdefault("password", secrets.token_urlsafe(24))
    previous = state.get("env", {})
    state["env"] = {
        **previous,
        "SUPABASE_URL": local["API_URL"],
        # New local stacks sign JWTs asymmetrically; the CLI's legacy HS256
        # keys can be invalid. Prefer the supported publishable/secret keys:
        # https://supabase.com/docs/guides/api/api-keys
        "SUPABASE_SERVICE_ROLE_KEY": local.get("SECRET_KEY") or local["SERVICE_ROLE_KEY"],
        "SUPABASE_SECRET_KEY": local.get("SECRET_KEY") or local["SERVICE_ROLE_KEY"],
        "NEXT_PUBLIC_SUPABASE_URL": local["API_URL"],
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": local.get("PUBLISHABLE_KEY") or local["ANON_KEY"],
        "NEXT_PUBLIC_APP_URL": f"http://localhost:{WEB_PORT}",
        "VOICE_DEMO_ACCESS_CODE": previous.get("VOICE_DEMO_ACCESS_CODE") or secrets.token_urlsafe(24),
        "VOICE_DEMO_RESTAURANT_ID": RESTAURANT_ID,
        "VOICE_DEMO_AGENT_VERSION_ID": "09000000-0000-4000-8000-000000000010",
        "BROWSER_DEMO_ALLOWED_ORIGINS": previous.get("BROWSER_DEMO_ALLOWED_ORIGINS") or f"http://localhost:{WEB_PORT},http://127.0.0.1:{WEB_PORT}",
        "DATA_SOURCE": "supabase", "INTEGRATIONS_MODE": "live",
        "WORKER_BASE_URL": f"http://127.0.0.1:{WORKER_PORT}",
        "PHONE_TEST_WEB_ORIGIN": f"http://127.0.0.1:{WEB_PORT}",
        "NEXT_DIST_DIR": ".next-phone-test",
        # Local instruction fetches use a strong shared secret; event callbacks
        # continue to require the Telnyx Ed25519 signature in the web handler.
        "TELNYX_TEXML_REQUIRE_SIGNATURE": "false",
        "TELNYX_TEXML_WEBHOOK_SECRET": previous.get("TELNYX_TEXML_WEBHOOK_SECRET") or secrets.token_urlsafe(32),
        "SONIOX_HEALTHCHECK_URL": "https://api.soniox.com/v1/models",
        "GEMINI_HEALTHCHECK_URL": "https://generativelanguage.googleapis.com/v1beta/models",
        "LATENCY_JSONL_PATH": str(OUT / "latency.jsonl"),
    }
    env = environment(state)
    for name in ["WS_AUTH_SECRET", "WORKER_HMAC_SECRET", "TEST_CALL_HMAC_SECRET", "PRIVACY_REQUEST_HASH_SECRET"]:
        state["env"][name] = env.get(name) or secrets.token_urlsafe(32)
    save(state)
    login_fd = os.open(OUT / "login.txt", os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    os.fchmod(login_fd, 0o600)
    with os.fdopen(login_fd, "w") as stream:
        stream.write(f"http://localhost:{WEB_PORT}/login\nEmail: {EMAIL}\nPassword: {state['password']}\n")
    demo_fd = os.open(OUT / "demo-access.txt", os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    os.fchmod(demo_fd, 0o600)
    with os.fdopen(demo_fd, "w") as stream:
        stream.write(f"Demo access code: {state['env']['VOICE_DEMO_ACCESS_CODE']}\n")
    base = local["API_URL"]
    with httpx.Client(headers=local_headers(environment(state)), timeout=10) as client:
        restaurants = request(client, "GET", base + "/rest/v1/restaurants",
                              params={"id": "eq." + RESTAURANT_ID, "select": "id"})
        if not restaurants:
            raise RuntimeError("The existing local test seed is missing; no reset was attempted")
        users = request(client, "GET", base + "/auth/v1/admin/users")["users"]
        user = next((user for user in users if user.get("email") == EMAIL), None)
        if user is None:
            # Installed @supabase/auth-js GoTrueAdminApi.createUser uses this
            # endpoint; email_confirm avoids sending an email outside this Mac.
            user = request(client, "POST", base + "/auth/v1/admin/users",
                           json={"email": EMAIL, "password": state["password"], "email_confirm": True})
        else:
            # Only this reserved test owner in the loopback database is changed.
            # Recover if private runtime state was recreated while the DB stayed.
            # https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid
            request(client, "PUT", base + "/auth/v1/admin/users/" + user["id"],
                    json={"password": state["password"]})
        request(client, "POST", base + "/rest/v1/memberships",
                params={"on_conflict": "organization_id,user_id"},
                headers={"Prefer": "resolution=merge-duplicates"},
                json={"user_id": user["id"], "organization_id": ORGANIZATION_ID, "role": "owner"})
        # This is the deterministic local test restaurant, never a production row.
        request(client, "PATCH", base + "/rest/v1/restaurants", params={"id": "eq." + RESTAURANT_ID},
                json={"name": "Maya Test Restaurant", "transfer_phone": None})
        request(client, "PATCH", base + "/rest/v1/agents", params={"restaurant_id": "eq." + RESTAURANT_ID},
                json={"persona_name": "Maya"})
        request(client, "PATCH", base + "/rest/v1/agent_versions",
                params={"id": "eq.09000000-0000-4000-8000-000000000009"},
                json={"prompt_sections": {"greeting": "Hello"}})
    print("Prepared local owner and test restaurant; real Supabase auth/data enabled.")
    print("Private login details: " + str(OUT / "login.txt"))


def configure(state):
    if not state.get("public_url"):
        raise RuntimeError("Start the tunnel first")
    env = environment(state)
    base = env["TELNYX_BASE_URL"].rstrip("/")
    public = state["public_url"]
    voice_url = public + "/telnyx/texml?token=" + env["TELNYX_TEXML_WEBHOOK_SECRET"]
    with httpx.Client(headers={"Authorization": "Bearer " + env["TELNYX_API_KEY"]}, timeout=15) as client:
        apps = request(client, "GET", base + "/texml_applications")["data"]
        app = next((row for row in apps if row.get("friendly_name") == "maya-local-phone-test"), None)
        payload = {"friendly_name": "maya-local-phone-test", "voice_url": voice_url, "voice_method": "post"}
        app = request(client, "PATCH" if app else "POST",
                      base + "/texml_applications" + ("/" + app["id"] if app else ""), json=payload)["data"]
        profiles = request(client, "GET", base + "/messaging_profiles")["data"]
        profile = next((row for row in profiles if row.get("name") == "maya-local-phone-test"), None)
        payload = {"name": "maya-local-phone-test", "whitelisted_destinations": ["CA"],
                   "webhook_url": public + "/api/webhooks/telnyx-sms", "webhook_api_version": "2"}
        profile = request(client, "PATCH" if profile else "POST",
                          base + "/messaging_profiles" + ("/" + profile["id"] if profile else ""), json=payload)["data"]
    state["env"]["TELNYX_TEXML_APP_ID"] = app["id"]
    state["env"]["TELNYX_MESSAGING_PROFILE_ID"] = profile["id"]
    save(state)
    print("Configured Telnyx voice application and CA-only messaging profile; no number purchased.")
    print("Restart the local stack to load the messaging profile.")


def serve(state):
    env = environment(state)
    for port in [WEB_PORT, WORKER_PORT]:
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                raise RuntimeError(f"Port {port} is occupied; no existing process was stopped")
    python = ROOT / "apps/worker/.venv/bin/python"
    env["PYTHONPATH"] = str(ROOT / "apps/worker/src") + os.pathsep + str(Path(__file__).parent)
    children, logs = [], []
    commands = [
        ("worker", [str(python), "-m", "uvicorn", "gateway:app", "--host", "127.0.0.1", "--port", str(WORKER_PORT), "--no-access-log", "--ws", "websockets", "--ws-max-size", "16384", "--ws-max-queue", "16"], ROOT),
        ("web", ["pnpm", "--filter", "@voice-receptionist/web", "exec", "next", "start" if env.get("PHONE_TEST_WEB_MODE") == "production" else "dev", "--hostname", "127.0.0.1", "--port", str(WEB_PORT)], ROOT),
        ("tunnel", ["cloudflared", "tunnel", "--no-autoupdate", "--protocol", "http2", "--url", f"http://127.0.0.1:{WORKER_PORT}"], ROOT),
    ]
    if env.get("DASHBOARD_DATABASE_TUNNEL") == "true":
        database_url = env.get("SUPABASE_URL", "")
        if urlparse(database_url).hostname not in {"127.0.0.1", "localhost"}:
            raise RuntimeError("Database demo tunnel must target the local Supabase API")
        # Expose only Supabase's authenticated HTTP API, never Postgres or Studio.
        # https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
        commands.append(("database-tunnel", ["cloudflared", "tunnel", "--no-autoupdate", "--protocol", "http2", "--url", database_url], ROOT))
    def interrupt(_signal, _frame):
        raise KeyboardInterrupt

    previous_handlers = {sig: signal.getsignal(sig) for sig in [signal.SIGINT, signal.SIGTERM]}
    for sig in previous_handlers:
        signal.signal(sig, interrupt)
    try:
        for name, command, cwd in commands:
            path = OUT / (name + ".log")
            fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
            log = os.fdopen(fd, "w"); logs.append(log)
            children.append(subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True))
        children.append(subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())], start_new_session=True))
        state["stack_pid"] = os.getpid()
        save(state)
        print(f"Dashboard: http://localhost:{WEB_PORT}/login", flush=True)
        print(f"Worker: http://127.0.0.1:{WORKER_PORT}/healthz", flush=True)
        print("Logs and private login details: " + str(OUT), flush=True)
        published = set()
        tunnels = {"tunnel": "public_url"}
        if env.get("DASHBOARD_DATABASE_TUNNEL") == "true":
            tunnels["database-tunnel"] = "database_public_url"
        while True:
            for child in children[:len(commands)]:
                if child.poll() is not None:
                    raise RuntimeError("A test-stack process exited; inspect the private local logs")
            for name, key in tunnels.items():
                if name in published:
                    continue
                text = (OUT / (name + ".log")).read_text()
                match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", text)
                if match:
                    state[key] = match.group(0); save(state)
                    print(name + " public URL: " + state[key], flush=True)
                    published.add(name)
            time.sleep(0.5)
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
        for child in children:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for child in children:
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait()
        for log in logs:
            log.close()


def stop(state):
    pid = state.get("stack_pid")
    if not isinstance(pid, int):
        raise RuntimeError("No managed stack PID was recorded")
    result = subprocess.run(["ps", "-p", str(pid), "-o", "args="], capture_output=True, text=True)
    if "/phone-test/local.py serve" not in result.stdout:
        raise RuntimeError("Recorded PID is not this launcher; no process was stopped")
    os.kill(pid, signal.SIGINT)
    print("Stopped the managed phone-test stack; existing services are untouched.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "serve", "configure", "stop"])
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(); return
    if not STATE.exists():
        raise RuntimeError("Run prepare first")
    state = json.loads(STATE.read_text())
    if args.command == "serve": serve(state)
    elif args.command == "stop": stop(state)
    else: configure(state)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (RuntimeError, httpx.HTTPError, subprocess.CalledProcessError) as error:
        print("Setup stopped: " + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
