"""Offline contract tests: never connect to Supabase or any provider."""
import copy
import importlib.util
import json
import stat
from pathlib import Path
from uuid import UUID

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "config/pilots/barbq-tonite-dixie.json"


@pytest.fixture
def pilot():
    path = ROOT / "scripts/dev/phone-test/pilot.py"
    assert path.exists(), "The isolated local pilot provisioner is missing"
    spec = importlib.util.spec_from_file_location("pilot_import", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def manifest():
    return json.loads(MANIFEST.read_text())


def test_rows_preserve_all_44_dixie_prices_descriptions_and_seven_hours(pilot, manifest):
    rows = pilot.build_rows(manifest)
    expected = {
        "Reshmi Kabob": 1499, "Bihari Kabob": 1899, "Bar BQ Tonite Platter": 5499,
        "Lamb Haleem": 1899, "Chicken Biryani": 1699, "Chicken 65": 1899,
        "Keema Naan Beef": 899, "Chicken Pakoora": 1599, "Chicken Boti": 1699,
        "Lahori Fish": 1799, "Half Chargha": 1499, "Full Chargha": 2899,
        "Chicken Tikka Leg": 1299, "Chapli Kabob": 1499,
        "Chicken Tikka Boti Platter": 4299, "Haryali Boti": 1799,
        "Achari Boti": 1799, "Malai Boti": 1799, "Seekh Kabob": 1499,
        "Vegetable Biryani": 1599, "Lamb Biryani": 2099, "Butter Chicken": 1799,
        "Chicken Tikka Masala": 1799, "Chicken Katakat": 1799, "Channa Masala": 1599,
        "Karahi Chicken": 1799, "Karahi Lamb": 1999, "Prawn Masala": 1999,
        "Sagh Paneer": 1799, "Sagh Chicken": 1799, "Sagh Lamb": 1999,
        "Shahi Paneer": 1799, "Tarka Daal": 1599, "Nihari": 1699,
        "Malai Tikka Masala": 1999, "White Karahi": 1799, "Alloo Gobi": 1799,
        "Garlic Naan": 400, "Whole Wheat Roti": 400, "Butter Naan": 350,
        "Double Ka Meeta": 600, "Ghulab Jamun": 500, "Gajar Ka Halwa": 500,
        "Soft Drinks": 275,
    }
    assert {r["name"]: r["price_cents"] for r in rows["menu_items"]} == expected
    assert len(rows["menu_items"]) == 44
    originals = {r["name"]: r for r in manifest["menu"]}
    for row in rows["menu_items"]:
        original = originals[row["name"]]
        assert row["category"] == original["category"]
        assert row["description"].startswith(original["description"])
        assert original["source_url"] in row["description"]
        assert "2026-11-12" in row["description"]
        assert "online pickup" in row["description"]
        assert row["dietary_tags"] == []
    assert sorted((r["weekday"], r["open_time"], r["close_time"]) for r in rows["hours"]) == [
        (day, "12:00", "22:30") for day in range(7)
    ]
    restaurant = rows["restaurants"][0]
    assert restaurant["address"] == "5165 Dixie Rd Unit 5, Mississauga, ON L4W 4G1, Canada"
    assert restaurant["name"] == "BarBQ Tonite Restaurant"
    assert restaurant["province"] == "ON"
    assert restaurant["timezone"] == "America/Toronto"
    assert restaurant["primary_language"] == "en"
    assert restaurant["enabled_languages"] == ["en", "en-IN", "fr-CA", "ur", "hi", "pa", "te", "ar"]
    assert restaurant["status"] == "draft"
    assert restaurant["transfer_phone"] is None
    assert rows["organizations"][0]["spend_cap_cents"] == 0
    assert rows["organizations"][0]["plan"] == "starter"


def test_pure_rows_have_stable_scoped_uuid5_ids_and_no_customer_or_phone_data(pilot, manifest):
    before = copy.deepcopy(manifest)
    rows = pilot.build_rows(manifest)
    assert rows == pilot.build_rows(copy.deepcopy(manifest))
    assert manifest == before
    assert set(rows) == {"organizations", "restaurants", "hours", "menu_items", "faqs",
                         "agents", "agent_versions", "slots_config"}
    ids = [row["id"] for table in rows.values() for row in table]
    assert len(ids) == len(set(ids))
    assert all(UUID(value).version == 5 for value in ids)
    assert "02000000-0000-4000-8000-000000000002" not in ids
    assert "01000000-0000-4000-8000-000000000001" not in ids
    restaurant_id = rows["restaurants"][0]["id"]
    assert all(row["restaurant_id"] == restaurant_id for table in
               ("hours", "menu_items", "faqs", "agents", "slots_config") for row in rows[table])
    # Auth IDs are assigned by GoTrue, but its membership row is also reviewable
    # through the pure builder once an auth ID is supplied.
    full = pilot.build_rows(manifest, user_id="00000000-0000-4000-8000-000000000002")
    member = full["memberships"][0]
    assert member["user_id"] == "00000000-0000-4000-8000-000000000002"
    assert member["organization_id"] == rows["organizations"][0]["id"]
    assert member["role"] == "owner"


def test_facts_and_unknown_policies_are_in_faqs_and_both_prompt_versions(pilot, manifest):
    rows = pilot.build_rows(manifest)
    faqs = " ".join(row["answer"] for row in rows["faqs"])
    for fact in (manifest["address"], manifest["phone"], manifest["website"],
                 manifest["maps_url"], "43.6400167", "-79.6246218", "Pakistani and Indian",
                 "two branches", "online pickup", "2026-11-12", "TEST-ONLY", "unconfirmed"):
        assert fact in faqs
    assert {row["source"] for row in rows["faqs"]} == {"import"}
    assert {v["status"] for v in rows["agent_versions"]} == {"draft", "published"}
    for version in rows["agent_versions"]:
        assert version["prompt_sections"]["browser_greeting"] == "BarBQ Tonite, hello."
        text = " ".join(version["prompt_sections"].values())
        for fact in (manifest["name"], manifest["address"], manifest["phone"],
                     manifest["website"], "12:00", "22:30", "$54.99", "online pickup",
                     "allergen", "never infer", "TEST-ONLY", "SMS", "real booking"):
            assert fact.casefold() in text.casefold()
        assert version["rules"]["booking_config_confirmed"] is False
        assert version["rules"]["send_sms"] is False
        assert version["rules"]["bookings"] is False
        assert version["rules"]["orders"] is False
    assert rows["slots_config"][0]["max_party"] >= 2
    for version in rows["agent_versions"]:
        assert 'made-up' in version['prompt_sections']['rules']
        assert 'rehearse' in version['prompt_sections']['rules']


@pytest.mark.parametrize("change", [
    lambda m: m.update(branch="other"),
    lambda m: m.update(maps_url="https://maps.app.goo.gl/other"),
    lambda m: m["menu"].pop(),
    lambda m: m["menu"][0].update(price_cents=True),
    lambda m: m["menu"][0].update(price_cents=-1),
    lambda m: m["menu"][0].update(source_url="https://barbqtonite.square.site/?location=OTHER"),
    lambda m: m["menu"][0].update(name=m["menu"][1]["name"]),
    lambda m: m["opening_hours"][0].update(close_time="11:00"),
    lambda m: m["opening_hours"][0].update(weekday=1),
    lambda m: m.update(sources=[]),
    lambda m: m["sources"][0].update(checked_at="not-a-date"),
    lambda m: m.update(phone="private-owner-number"),
    lambda m: m["sources"][0].update(url=[]),
])
def test_bad_manifest_is_rejected_before_import(pilot, manifest, change):
    change(manifest)
    with pytest.raises(ValueError, match="manifest"):
        pilot.build_rows(manifest)


@pytest.mark.parametrize("url", ["https://example.supabase.co", "http://localhost.evil:55321",
    "http://user:secret@localhost:55321", "http://0.0.0.0:55321", "http://169.254.169.254",
    "http://127.0.0.1:55321/redirect", "http://localhost:55321?key=secret", "file:///tmp/db"])
def test_remote_or_ambiguous_database_rejected_without_http(pilot, manifest, tmp_path, monkeypatch, url):
    runtime = tmp_path / "runtime.json"
    runtime.write_text(json.dumps({"env": {"SUPABASE_URL": url, "SUPABASE_SERVICE_ROLE_KEY": "secret"}}))
    monkeypatch.setattr(pilot.httpx, "Client", lambda **kw: pytest.fail("Must reject before HTTP"))
    with pytest.raises(ValueError, match="loopback"):
        pilot.provision(manifest, runtime, MANIFEST)


class LocalDatabase:
    """In-memory HTTP boundary with real row IDs and conflict keys, no sockets."""
    def __init__(self):
        self.tables = {"restaurants": {"maya-existing": {"id": "maya-existing", "name": "Maya Test Restaurant"}}}
        self.users = [{"id": "00000000-0000-4000-8000-000000000001", "email": "owner@maya.test"}]
        self.writes = []

    def respond(self, request):
        path = request.url.path
        payload = json.loads(request.content) if request.content else None
        if request.method != "GET":
            self.writes.append((request.method, path, payload))
        if path == "/auth/v1/admin/users":
            if request.method == "GET":
                assert request.url.params["page"] == "1"
                return httpx.Response(200, json={"users": self.users})
            assert request.method == "POST"
            assert payload["email"] == "barbq-tonite-pilot@maya.test"
            assert payload["email_confirm"] is True
            user = {"id": "00000000-0000-4000-8000-000000000002", **payload}
            self.users.append(user)
            return httpx.Response(200, json=user)
        if path.startswith("/auth/v1/admin/users/"):
            assert request.method == "PUT"
            assert path.endswith("00000000-0000-4000-8000-000000000002")
            return httpx.Response(200, json=self.users[-1])
        assert path.startswith("/rest/v1/")
        table = path.rsplit("/", 1)[-1]
        assert table in {"organizations", "restaurants", "hours", "menu_items", "faqs",
                         "agents", "agent_versions", "slots_config", "memberships"}
        store = self.tables.setdefault(table, {})
        if request.method == "GET":
            results = list(store.values())
            for key, value in request.url.params.items():
                if value.startswith("eq."):
                    results = [row for row in results if str(row.get(key)) == value[3:]]
            return httpx.Response(200, json=results)
        if request.method == "PATCH":
            assert table == "agents"
            store[request.url.params["id"][3:]].update(payload)
        else:
            assert request.method == "POST"
            assert request.headers["Prefer"] == "resolution=merge-duplicates,return=minimal"
            conflict = request.url.params["on_conflict"].split(",")
            for row in payload if isinstance(payload, list) else [payload]:
                matches = [r for r in store.values() if all(r.get(k) == row.get(k) for k in conflict)]
                if matches:
                    assert matches[0]["id"] == row["id"]
                store.setdefault(row["id"], {}).update(row)
        return httpx.Response(204)


def setup_runtime(tmp_path):
    runtime = tmp_path / "runtime.json"
    state = {"email": "owner@maya.test", "password": "old-owner-password", "public_url": "https://tunnel.example",
             "env": {"SUPABASE_URL": "http://127.0.0.1:55321", "SUPABASE_SERVICE_ROLE_KEY": "local-secret",
                     "TELNYX_API_KEY": "unchanged-provider-secret", "VOICE_DEMO_ACCESS_CODE": "unchanged-demo-secret"}}
    runtime.write_text(json.dumps(state))
    return runtime, state


def test_two_imports_preserve_existing_data_secrets_and_private_login(pilot, manifest, tmp_path, monkeypatch, capsys):
    runtime, original = setup_runtime(tmp_path)
    db = LocalDatabase()
    factory = httpx.Client

    def client(**kwargs):
        assert kwargs["trust_env"] is False
        assert kwargs["follow_redirects"] is False
        return factory(transport=httpx.MockTransport(db.respond), **kwargs)

    monkeypatch.setattr(pilot.httpx, "Client", client)
    pilot.provision(manifest, runtime, MANIFEST)
    first = copy.deepcopy(db.tables)
    state = json.loads(runtime.read_text())
    password = state["password"]
    pilot.provision(manifest, runtime, MANIFEST)
    assert db.tables == first
    assert len(db.users) == 2
    assert db.tables["restaurants"]["maya-existing"]["name"] == "Maya Test Restaurant"
    assert len(db.tables["menu_items"]) == 44
    assert len(db.tables["hours"]) == 7
    assert len(db.tables["memberships"]) == 1
    member = next(iter(db.tables["memberships"].values()))
    assert member["organization_id"] == state["pilot"]["organization_id"]
    assert state["email"] == "barbq-tonite-pilot@maya.test"
    assert state["pilot"]["manifest_path"] == str(MANIFEST)
    assert len(password) >= 24 and password != original["password"]
    assert json.loads(runtime.read_text())["password"] == password
    assert state["public_url"] == original["public_url"]
    assert state["env"].items() >= original["env"].items()
    assert state["env"]["VOICE_DEMO_RESTAURANT_ID"] == state["pilot"]["restaurant_id"]
    # The existing browser worker fetches only status=draft for test sessions.
    assert state["env"]["VOICE_DEMO_AGENT_VERSION_ID"] == state["pilot"]["draft_version_id"]
    assert db.tables["agent_versions"][state["env"]["VOICE_DEMO_AGENT_VERSION_ID"]]["status"] == "draft"
    assert db.tables["agents"][state["pilot"]["agent_id"]]["current_published_version_id"] == state["pilot"]["published_version_id"]
    assert state["env"]["VOICE_DEMO_RESTAURANT_NAME"] == manifest["name"]
    assert state["env"]["VOICE_DEMO_RESTAURANT_ADDRESS"] == manifest["address"]
    for path in (runtime, tmp_path / "login.txt", tmp_path / "pilot-login.txt"):
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert password in (tmp_path / "pilot-login.txt").read_text()
    assert not capsys.readouterr().out


def test_existing_reserved_user_in_another_org_fails_before_any_write(pilot, manifest, tmp_path, monkeypatch):
    runtime, _ = setup_runtime(tmp_path)
    db = LocalDatabase()
    db.users.append({"id": "00000000-0000-4000-8000-000000000002", "email": "barbq-tonite-pilot@maya.test"})
    db.tables["memberships"] = {"other": {"id": "other", "user_id": db.users[-1]["id"], "organization_id": "other-org"}}
    factory = httpx.Client
    monkeypatch.setattr(pilot.httpx, "Client", lambda **kw: factory(transport=httpx.MockTransport(db.respond), **kw))
    with pytest.raises(RuntimeError, match="membership"):
        pilot.provision(manifest, runtime, MANIFEST)
    assert db.writes == []


def test_plan_is_read_only_and_sanitized(pilot, manifest, tmp_path, monkeypatch, capsys):
    runtime, original = setup_runtime(tmp_path)
    monkeypatch.setattr(pilot.httpx, "Client", lambda **kw: pytest.fail("Plan must be offline"))
    assert pilot.main(["--plan", "--runtime", str(runtime), "--manifest", str(MANIFEST)]) == 0
    output = capsys.readouterr().out
    result = json.loads(output)
    assert result["counts"]["menu_items"] == 44
    assert result["counts"]["hours"] == 7
    for secret in (original["password"], *original["env"].values()):
        assert secret not in output
    assert json.loads(runtime.read_text()) == original
    assert sorted(p.name for p in tmp_path.iterdir()) == ["runtime.json"]


def test_paginated_reserved_user_is_reused_not_duplicated(pilot, manifest, tmp_path, monkeypatch):
    runtime, _ = setup_runtime(tmp_path)
    db = LocalDatabase()
    db.users.append({"id": "00000000-0000-4000-8000-000000000002", "email": "barbq-tonite-pilot@maya.test"})
    pages = []

    def respond(request):
        if request.method == "GET" and request.url.path == "/auth/v1/admin/users":
            page = int(request.url.params["page"])
            pages.append(page)
            users = [{"id": str(n), "email": f"unrelated{n}@maya.test"} for n in range(1000)] if page == 1 else [db.users[-1]]
            return httpx.Response(200, json={"users": users})
        return db.respond(request)

    factory = httpx.Client
    monkeypatch.setattr(pilot.httpx, "Client", lambda **kw: factory(transport=httpx.MockTransport(respond), **kw))
    pilot.provision(manifest, runtime, MANIFEST)
    assert pages == [1, 2]
    assert len(db.users) == 2
    assert not any(method == "POST" and path == "/auth/v1/admin/users" for method, path, _ in db.writes)


@pytest.mark.parametrize("status", [302, 500])
def test_http_failure_never_leaks_credentials_or_changes_runtime(pilot, tmp_path, monkeypatch, capsys, status):
    runtime, original = setup_runtime(tmp_path)
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(status, headers={"location": "https://external.example"},
                              text="private body with local-secret and old-owner-password")

    factory = httpx.Client
    monkeypatch.setattr(pilot.httpx, "Client", lambda **kw: factory(transport=httpx.MockTransport(respond), **kw))
    assert pilot.main(["--runtime", str(runtime), "--manifest", str(MANIFEST)]) == 1
    captured = capsys.readouterr()
    output = captured.out + captured.err
    assert "local-secret" not in output and "old-owner-password" not in output
    assert len(requests) == 1
    assert json.loads(runtime.read_text()) == original
    assert not (tmp_path / "pilot-login.txt").exists()


def test_bad_manifest_cannot_start_http_or_touch_private_files(pilot, manifest, tmp_path, monkeypatch):
    runtime, original = setup_runtime(tmp_path)
    manifest["menu"] = []
    monkeypatch.setattr(pilot.httpx, "Client", lambda **kw: pytest.fail("Manifest rejected before HTTP"))
    with pytest.raises(ValueError, match="manifest"):
        pilot.provision(manifest, runtime, MANIFEST)
    assert json.loads(runtime.read_text()) == original
    assert not (tmp_path / "login.txt").exists()


def test_row_identity_survives_price_and_description_updates(pilot, manifest):
    first = pilot.build_rows(manifest)
    manifest["menu"][0].update(price_cents=1599, description="Corrected source description")
    updated = pilot.build_rows(manifest)
    assert [r["id"] for r in first["menu_items"]] == [r["id"] for r in updated["menu_items"]]
    assert updated["menu_items"][0]["price_cents"] == 1599
    assert updated["menu_items"][0]["description"].startswith("Corrected source description")


@pytest.mark.parametrize("url", ["http://localhost:55321", "http://127.0.0.2:55321/", "http://[::1]:55321"])
def test_explicit_loopback_urls_are_supported(pilot, url):
    assert pilot.loopback_base(url) == url.rstrip("/")
