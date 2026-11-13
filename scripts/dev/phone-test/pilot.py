"""Provision the reviewed Dixie pilot in the existing LOCAL Supabase stack.

Review build_rows(manifest) or run --plan first. Explicit invocation without
--plan applies the import; this module does nothing when imported. No resets,
invitations, phone assignments, provider calls, or customer activity are made.
Run with apps/worker/.venv/bin/python scripts/dev/phone-test/pilot.py --plan.

Contracts checked against migrations/20261027120000_create_core_schema.sql,
installed httpx 0.28.1 _client.py, and @supabase/auth-js GoTrueAdminApi.ts.
"""

import argparse
import copy
import ipaddress
import json
import os
import re
import secrets
import sys
import tempfile
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, UUID, uuid5

import httpx

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "config/pilots/barbq-tonite-dixie.json"
RUNTIME = ROOT / "tmp/phone-test/runtime.json"
EMAIL = "barbq-tonite-pilot@maya.test"  # Reserved internal login, never an owner address.
MAPS = "https://maps.app.goo.gl/bPyNoxAekTQNqP3SA"
WEBSITE = "https://barbqtonite.com/"
PICKUP = "https://barbqtonite.square.site/?location=LVZ0HY3TRYP6V"
BRANCH = {
    "name": "BarBQ Tonite Restaurant", "branch": "Dixie",
    "address": "5165 Dixie Rd Unit 5, Mississauga, ON L4W 4G1, Canada",
    "province": "ON", "timezone": "America/Toronto", "phone": "+19052829868",
    "website": WEBSITE, "maps_url": MAPS, "cuisine": "Pakistani and Indian",
    "latitude": 43.6400167, "longitude": -79.6246218,
}
# Schema requires positive capacities. These are explicitly INTERNAL
# TEST-ONLY values, never verified restaurant policy or actual capacity.
TEST_SLOTS = {"slot_minutes": 30, "covers_per_slot": 20, "seating_minutes": 90,
              "max_party": 8, "lead_time_minutes": 15, "booking_window_days": 30}


def validate_manifest(manifest):
    """Fail closed for another branch, incomplete sources, or invalid row data."""
    def require(condition):
        if not condition:
            raise ValueError("Invalid pilot manifest; check branch, sources, menu and hours")

    require(isinstance(manifest, dict))
    require(all(manifest.get(key) == value for key, value in BRANCH.items()))
    sources = manifest.get("sources")
    require(isinstance(sources, list) and len(sources) == 3)
    require(all(isinstance(source, dict) for source in sources))
    require(all(isinstance(source.get("url"), str) for source in sources))
    require({source.get("url") for source in sources} == {MAPS, WEBSITE, PICKUP})
    for source in sources:
        checked = source.get("checked_at")
        require(isinstance(checked, str) and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", checked)))
        try:
            date.fromisoformat(checked)
        except ValueError:
            require(False)
        require(isinstance(source.get("fields"), list) and bool(source["fields"]))
    menu = manifest.get("menu")
    require(isinstance(menu, list) and len(menu) == 44)
    names = set()
    for item in menu:
        require(isinstance(item, dict))
        require(all(isinstance(item.get(key), str) and bool(item[key].strip())
                    for key in ("name", "category")))
        require(isinstance(item.get("description"), str))
        require(type(item.get("price_cents")) is int and 0 <= item["price_cents"] <= 2147483647)
        require(item.get("source_url") == PICKUP)
        require(item["name"].casefold() not in names)
        names.add(item["name"].casefold())
    hours = manifest.get("opening_hours")
    require(isinstance(hours, list) and len(hours) == 7)
    weekdays = set()
    for hour in hours:
        require(isinstance(hour, dict))
        day = hour.get("weekday")
        require(type(day) is int and 0 <= day <= 6 and day not in weekdays)
        weekdays.add(day)
        for key in ("open_time", "close_time"):
            require(isinstance(hour.get(key), str) and bool(
                re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", hour[key])))
        require(hour["open_time"] < hour["close_time"])
        require(isinstance(hour.get("source"), str) and bool(hour["source"].strip()))
    require(isinstance(manifest.get("unverified"), list) and bool(manifest["unverified"]))


def build_rows(manifest, user_id=None):
    """Pure, reviewable schema rows. IDs depend on Maps URL + branch + row key.

    Never read env, clock, disk or network here. Supply the local GoTrue user ID
    to include its membership; no auth profiles or customer data are generated.
    """
    validate_manifest(manifest)
    namespace = uuid5(NAMESPACE_URL, manifest["maps_url"] + "#" + manifest["branch"])

    def uid(key):
        return str(uuid5(namespace, key))

    org, restaurant, agent = uid("organization"), uid("restaurant"), uid("agent")
    dates = {source["url"]: source["checked_at"] for source in manifest["sources"]}
    provenance = f"Source: {PICKUP}; checked {dates[PICKUP]}; Dixie online pickup prices in CAD."
    maps_source = f"Source: {MAPS}; checked {dates[MAPS]}."
    website_source = f"Source: {WEBSITE}; checked {dates[WEBSITE]}."
    hours_text = "; ".join(
        f"{('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')[h['weekday']]} "
        f"{h['open_time']}-{h['close_time']}"
        for h in sorted(manifest["opening_hours"], key=lambda h: h["weekday"])
    ) + " America/Toronto. " + maps_source
    contact = (f"{manifest['name']}, Dixie branch: {manifest['address']}. "
               f"Public restaurant phone: {manifest['phone']}. Website: {WEBSITE}. "
               f"Map: {MAPS}. Coordinates: {manifest['latitude']}, {manifest['longitude']}. "
               + maps_source + " " + website_source)
    branch_caution = ("The restaurant website lists two branches. This pilot covers only Dixie, "
                     f"{manifest['address']}; never substitute another branch's menu, prices or hours. "
                     + website_source)
    pricing = (provenance + " These are online pickup prices; no dine-in price guarantee. "
               "Live stock, preparation times and holiday hours are unverified; contact the restaurant.")
    unknown = ("Allergen information and halal or other certifications are unverified; never infer "
               "dietary suitability or certification from cuisine, names or ingredients. "
               "Confirm directly with restaurant staff. Reservation policy and actual capacity "
               "are unknown and unconfirmed; no real booking promises. "
               "The reviewed public sources do not establish these policies: "
               + website_source + " " + provenance)
    test_policy = ("TEST-ONLY local pilot dry run: booking config is unconfirmed and internal, "
                   "not actual restaurant capacity or policy. "
                   + ", ".join(f"{key}={value}" for key, value in TEST_SLOTS.items())
                   + ". These defaults support practice dialogue only. "
                   "You may rehearse booking and takeaway-order conversations using made-up caller details "
                   "and the existing dry-run tools. Ask the tester to use made-up details. "
                   "Make clear that the result is a practice request, not a real booking or order. "
                   "Never save real bookings, orders, messages or customer calls, send SMS, transfer, "
                   "or promise a real booking, order or confirmation. "
                   "Do not collect real customer personal information; direct actual requests to restaurant staff.")
    sections = {
        "browser_greeting": manifest.get("browser_greeting", "Hello."),
        "greeting": f"Hello, I'm Maya, the AI assistant for {manifest['name']}, Dixie branch",
        "branch_and_contact": contact + " " + branch_caution,
        "hours": hours_text,
        "cuisine": manifest["cuisine"] + ". " + website_source,
        "menu_prices": "\n".join(
            f"{item['category']} — {item['name']}: CAD ${item['price_cents'] // 100}."
            f"{item['price_cents'] % 100:02d}. {item['description']}"
            for item in manifest["menu"]
        ) + "\n" + pricing,
        "unverified_facts": unknown,
        "rules": test_policy + " These pilot restrictions take precedence over generic booking or SMS instructions.",
    }
    faq_answers = {
        "Where is the Dixie branch and how can I contact it?": contact,
        "What are the verified opening hours?": hours_text,
        "What cuisine does the restaurant serve?": manifest["cuisine"] + ". " + website_source,
        "Does this information cover both branches?": branch_caution,
        "Where do these menu prices come from?": pricing,
        "Are allergens, certifications, booking policy and capacity verified?": unknown,
        "What are the internal pilot booking defaults?": test_policy,
    }
    rules = {"pilot_dry_run": True, "booking_config_confirmed": False,
             "booking_config_scope": "TEST-ONLY internal defaults; actual capacity unconfirmed",
             "bookings": False, "orders": False, "takeout": False, "send_sms": False,
             "transfer": False, "take_message": False, "infer_allergens": False}
    rows = {
        "organizations": [{"id": org, "name": manifest["name"], "plan": "starter", "spend_cap_cents": 0}],
        "restaurants": [{"id": restaurant, "organization_id": org, "name": manifest["name"],
                         "address": manifest["address"], "province": "ON", "timezone": "America/Toronto",
                         "primary_language": "en", "enabled_languages": ["en", "en-IN", "fr-CA", "ur", "hi", "pa", "te", "ar"],
                         "status": "draft", "transfer_phone": None}],
        "hours": [{"id": uid(f"hours:{hour['weekday']}"), "restaurant_id": restaurant,
                   **{key: hour[key] for key in ("weekday", "open_time", "close_time")}}
                  for hour in manifest["opening_hours"]],
        "menu_items": [{"id": uid("menu:" + item["name"]), "restaurant_id": restaurant,
                        "name": item["name"], "category": item["category"], "price_cents": item["price_cents"],
                        "description": item["description"] + "\n\n" + provenance, "dietary_tags": []}
                       for item in manifest["menu"]],
        "faqs": [{"id": uid("faq:" + question), "restaurant_id": restaurant, "question": question,
                  "answer": answer, "language": "en", "source": "import"}
                 for question, answer in faq_answers.items()],
        "agents": [{"id": agent, "restaurant_id": restaurant, "persona_name": "Maya", "filler_level": "low",
                    "enabled": True}],
        "agent_versions": [{"id": uid("version:" + status), "agent_id": agent, "version_no": number,
                            "status": status, "prompt_sections": copy.deepcopy(sections),
                            "rules": copy.deepcopy(rules)}
                           for number, status in ((1, "published"), (2, "draft"))],
        "slots_config": [{"id": uid("slots"), "restaurant_id": restaurant, **TEST_SLOTS}],
    }
    if user_id is not None:
        rows["memberships"] = [{"id": str(uuid5(UUID(org), "membership:" + EMAIL)),
                                "user_id": str(UUID(user_id)), "organization_id": org, "role": "owner"}]
    return rows


def loopback_base(value):
    """Reject credential URLs, paths, redirects and non-loopback hosts."""
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        local = host == "localhost" or (host is not None and ipaddress.ip_address(host).is_loopback)
        valid = (isinstance(value, str) and value == value.strip() and not re.search(r"[\s\\%]", value)
                 and local and parsed.scheme in {"http", "https"} and parsed.netloc
                 and parsed.username is None and parsed.password is None
                 and parsed.path in {"", "/"} and not parsed.query and not parsed.fragment
                 and (parsed.port is None or 0 < parsed.port <= 65535))
    except (ValueError, TypeError, AttributeError):
        valid = False
    if not valid:
        raise ValueError("SUPABASE_URL must be an unambiguous loopback HTTP(S) origin")
    return value.rstrip("/")


def load_runtime(path):
    if path.is_symlink():
        raise ValueError("Pilot runtime must be a regular private local file")
    state = json.loads(path.read_text())
    if not isinstance(state, dict) or not isinstance(state.get("env"), dict):
        raise ValueError("Pilot runtime requires an env mapping")
    env = state["env"]
    base = loopback_base(env.get("SUPABASE_URL"))
    if env.get("NEXT_PUBLIC_SUPABASE_URL"):
        if loopback_base(env["NEXT_PUBLIC_SUPABASE_URL"]) != base:
            raise ValueError("Pilot browser and service must use the same loopback origin")
    if not isinstance(env.get("SUPABASE_SERVICE_ROLE_KEY"), str) or not env["SUPABASE_SERVICE_ROLE_KEY"]:
        raise ValueError("Pilot runtime requires the existing local service key")
    return state, base


def private_write(path, content):
    """Atomic 0600 replacement; never follow an existing target symlink."""
    descriptor, temporary = tempfile.mkstemp(prefix=".pilot-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def request(client, method, base, path, **kwargs):
    response = client.request(method, base + path, **kwargs)
    # Never output response bodies, credentials, env, or credential-bearing URLs.
    if not response.is_success:
        raise RuntimeError(f"Local pilot {method} failed: HTTP {response.status_code}")
    return response.json() if response.content else None


def provision(manifest, runtime_path=RUNTIME, manifest_path=MANIFEST):
    """Apply only these deterministic rows, then update existing private state.

    PostgREST batches are independently retryable, not a cross-table transaction.
    A failed run never deletes rows; rerun after resolving the reported failure.
    """
    rows = build_rows(manifest)
    runtime_path, manifest_path = Path(runtime_path), Path(manifest_path)
    state, base = load_runtime(runtime_path)
    env = state["env"]
    organization_id = rows["organizations"][0]["id"]
    restaurant_id = rows["restaurants"][0]["id"]
    agent_id = rows["agents"][0]["id"]
    published_id = rows["agent_versions"][0]["id"]
    draft_id = rows["agent_versions"][1]["id"]
    saved = state.get("pilot", {})
    password = (state.get("password") if isinstance(saved, dict)
                and saved.get("restaurant_id") == restaurant_id and state.get("email") == EMAIL else None)
    password = password if isinstance(password, str) and len(password) >= 24 else secrets.token_urlsafe(32)
    # Same local service-key contract as local.py; no provider/env fallbacks.
    # https://supabase.com/docs/guides/api/api-keys
    key = env["SUPABASE_SERVICE_ROLE_KEY"]
    headers = {"apikey": key, **({"Authorization": "Bearer " + key} if key.count(".") == 2 else {})}
    # Installed httpx supports these flags: proxies and redirects must not route
    # localhost credentials to another host. https://www.python-httpx.org/api/#client
    with httpx.Client(headers=headers, timeout=10, trust_env=False, follow_redirects=False) as client:
        def api(method, path, **kwargs):
            return request(client, method, base, path, **kwargs)

        def select(table, **filters):
            return api("GET", "/rest/v1/" + table,
                       params={"select": "*", **{key: "eq." + value for key, value in filters.items()}})

        # Auth listUsers pagination contract is read from installed auth-js.
        # https://supabase.com/docs/reference/javascript/auth-admin-listusers
        user, page = None, 1
        while True:
            users = api("GET", "/auth/v1/admin/users", params={"page": page, "per_page": 1000})["users"]
            matches = [u for u in users if str(u.get("email", "")).casefold() == EMAIL]
            if matches:
                user = matches[0]
                break
            if len(users) < 1000:
                break
            page += 1
        if user:
            user_id = str(UUID(user["id"]))
            if any(m["organization_id"] != organization_id for m in select("memberships", user_id=user_id)):
                raise RuntimeError("Reserved pilot login has a membership outside the pilot; no writes made")
        # Existing deterministic parents must describe this pilot. Never adopt or
        # overwrite the seed restaurant, another organization or another owner.
        for org in select("organizations", id=organization_id):
            if org["name"] != manifest["name"]:
                raise RuntimeError("Pilot organization identity conflict; no writes made")
        for restaurant in select("restaurants", id=restaurant_id):
            if restaurant["organization_id"] != organization_id or restaurant["name"] != manifest["name"]:
                raise RuntimeError("Pilot restaurant identity conflict; no writes made")
        members = select("memberships", organization_id=organization_id)
        if any(not user or m["user_id"] != user["id"] for m in members):
            raise RuntimeError("Pilot organization membership conflict; no writes made")
        if user is None:
            # createUser does not email; email_confirm avoids any verification flow.
            # https://supabase.com/docs/reference/javascript/auth-admin-createuser
            user = api("POST", "/auth/v1/admin/users", json={
                "email": EMAIL, "password": password, "email_confirm": True})
            user_id = str(UUID(user["id"]))
        else:
            # Only the explicitly reserved .test login is eligible for recovery.
            # https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid
            api("PUT", "/auth/v1/admin/users/" + user_id, json={"password": password})

        def upsert(table, data, conflict="id"):
            # Only supplied columns change; unrelated columns/rows stay intact.
            # https://docs.postgrest.org/en/stable/references/api/tables_views.html#upsert
            api("POST", "/rest/v1/" + table, params={"on_conflict": conflict},
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"}, json=data)

        for table, data in build_rows(manifest, user_id=user_id).items():
            upsert(table, data, "organization_id,user_id" if table == "memberships" else "id")
        # Resolve the agent/version FK cycle only after both versions exist.
        api("PATCH", "/rest/v1/agents", params={"id": "eq." + agent_id},
            json={"current_published_version_id": published_id})

    # Re-read so unrelated launcher state written during the import is retained.
    current, current_base = load_runtime(runtime_path)
    if current_base != base or current["env"]["SUPABASE_SERVICE_ROLE_KEY"] != key:
        raise RuntimeError("Local runtime database changed during import; state not replaced")
    current["env"].update({"VOICE_DEMO_RESTAURANT_ID": restaurant_id,
                           "VOICE_DEMO_AGENT_VERSION_ID": draft_id,
                           "VOICE_DEMO_RESTAURANT_NAME": manifest["name"],
                           "VOICE_DEMO_RESTAURANT_ADDRESS": manifest["address"]})
    current.update(email=EMAIL, password=password)
    current["pilot"] = {"organization_id": organization_id, "restaurant_id": restaurant_id,
                        "agent_id": agent_id, "published_version_id": published_id,
                        "draft_version_id": draft_id,
                        "user_id": user_id, "manifest_path": str(manifest_path.resolve()),
                        "login_path": str(runtime_path.parent / "pilot-login.txt"),
                        "booking_config_confirmed": False}
    login = f"Internal TEST-ONLY local pilot\nEmail: {EMAIL}\nPassword: {password}\n"
    for name in ("login.txt", "pilot-login.txt"):
        private_write(runtime_path.parent / name, login)
    private_write(runtime_path, json.dumps(current, indent=2) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", action="store_true", help="Offline sanitized counts and targets only")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--runtime", type=Path, default=RUNTIME)
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(args.manifest.read_text())
        rows = build_rows(manifest)
        load_runtime(args.runtime)
        if args.plan:
            print(json.dumps({"counts": {**{table: len(data) for table, data in rows.items()},
                                         "memberships": 1, "internal_auth_users": 1},
                              "targets": {"database": "loopback only", "branch": "Dixie",
                                          "organization_id": rows["organizations"][0]["id"],
                                          "restaurant_id": rows["restaurants"][0]["id"]}}, indent=2))
        else:
            provision(manifest, args.runtime, args.manifest)
            print("Local Dixie pilot imported; private login files updated.")
        return 0
    except (ValueError, OSError, RuntimeError, httpx.HTTPError, KeyError, TypeError):
        # No raw exception may contain private env values, request bodies or URLs.
        print("Pilot refused or failed; check local runtime, manifest and isolated row conflicts. No reset attempted.",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
