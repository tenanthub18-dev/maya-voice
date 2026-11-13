from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import re
import time
import unicodedata
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time as clock_time, timedelta
from decimal import Decimal, ROUND_HALF_UP
from difflib import SequenceMatcher
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from voice_receptionist_worker.resilience.offline_queue import OfflineMessageQueue
from voice_receptionist_worker.security.hmac import sign_request

from .repository import Repository, RepositoryError
from .schemas import validate_tool_arguments


ToolHandler = Callable[[Mapping[str, Any], "ToolContext"], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class ToolContext:
    call_id: str
    turn: int | str
    restaurant_id: str
    language: str
    caller_phone: str | None = None
    dry_run: bool = False
    now: datetime = field(default_factory=lambda: datetime.now(UTC))

    @property
    def idempotency_key(self) -> str:
        return f"{self.call_id}:{self.turn}"


class ToolInputError(ValueError):
    pass


def _required(arguments: Mapping[str, Any], *names: str) -> None:
    missing = [name for name in names if arguments.get(name) in (None, "", [])]
    if missing:
        raise ToolInputError(f"Missing required fields: {', '.join(missing)}")


def _e164(value: Any) -> str:
    phone = str(value)
    digits = re.sub(r"[\s().-]", "", phone)
    # Callers are in Canada/US: accept the spoken 10-digit (or 1 + 10) number and add +1 here.
    if re.fullmatch(r"1?[2-9][0-9]{2}[2-9][0-9]{6}", digits):
        return "+1" + digits[-10:]
    if not re.fullmatch(r"\+[1-9][0-9]{7,14}", phone):
        raise ToolInputError("Phone must use E.164 format")
    return phone


def _iso_datetime(value: Any) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ToolInputError("Datetime must be ISO-8601") from exc
    if parsed.tzinfo is None:
        raise ToolInputError("Datetime must include a timezone")
    return parsed


def _normalized(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    return "".join(character for character in decomposed if not unicodedata.combining(character))


def _similarity(query: str, candidate: str) -> float:
    query_n, candidate_n = _normalized(query), _normalized(candidate)
    if query_n in candidate_n:
        return 1.0
    return SequenceMatcher(None, query_n, candidate_n).ratio()


SMS_TEMPLATES: dict[str, dict[str, str]] = {
    "booking_confirmation": {
        "en": "Booking confirmed for {name} at {time}.",
        "fr-CA": "Réservation confirmée pour {name} à {time}.",
        "ur": "{name} کے لیے {time} پر بکنگ کی تصدیق ہو گئی۔",
        "hi": "{name} के लिए {time} पर बुकिंग पक्की है।",
        "pa": "{name} ਲਈ {time} ਵਜੇ ਬੁਕਿੰਗ ਪੱਕੀ ਹੈ।",
        "te": "{name} కోసం {time} కి బుకింగ్ నిర్ధారించబడింది.",
        "ar": "تم تأكيد الحجز لـ {name} الساعة {time}.",
    },
    "order_confirmation": {
        "en": "Order {order_id} is confirmed for {time}.",
        "fr-CA": "La commande {order_id} est confirmée pour {time}.",
        "ur": "آرڈر {order_id} کی {time} کے لیے تصدیق ہو گئی۔",
        "hi": "ऑर्डर {order_id} की {time} के लिए पुष्टि हो गई।",
        "pa": "ਆਰਡਰ {order_id} ਦੀ {time} ਲਈ ਪੁਸ਼ਟੀ ਹੋ ਗਈ।",
        "te": "ఆర్డర్ {order_id} {time} కి నిర్ధారించబడింది.",
        "ar": "تم تأكيد الطلب {order_id} الساعة {time}.",
    },
    "message_received": {
        "en": "We received your message, {name}.",
        "fr-CA": "Nous avons reçu votre message, {name}.",
        "ur": "{name}، آپ کا پیغام موصول ہو گیا۔",
        "hi": "{name}, आपका संदेश मिल गया।",
        "pa": "{name}, ਤੁਹਾਡਾ ਸੁਨੇਹਾ ਮਿਲ ਗਿਆ।",
        "te": "{name}, మీ సందేశం అందింది.",
        "ar": "{name}، وصلتنا رسالتك.",
    },
    "payment_link": {
        "en": "Pay securely: {url}",
        "fr-CA": "Payez en toute sécurité : {url}",
    },
}

SMS_UNSUBSCRIBE = {
    "en": "Reply STOP to opt out.",
    "fr-CA": "Répondez STOP pour vous désabonner.",
    "ur": "پیغامات بند کرنے کے لیے STOP لکھ کر جواب دیں۔",
    "hi": "संदेश बंद करने के लिए STOP लिखकर जवाब दें।",
    "pa": "ਸੁਨੇਹੇ ਬੰਦ ਕਰਨ ਲਈ STOP ਲਿਖ ਕੇ ਜਵਾਬ ਦਿਓ।",
    "te": "సందేశాలు ఆపడానికి STOP అని ప్రత్యుత్తరం ఇవ్వండి.",
    "ar": "للإلغاء، أرسل STOP رداً على الرسالة.",
}


# General restaurant-food rates current on 2026-10-27. Inject a restaurant-
# specific table when taxable beverages or exemptions require item-level rates.
# GST/HST: https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html
# QST: https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/basic-rules-for-applying-the-gsthst-and-qst/tables-of-gst-and-qst-rates/
# BC restaurant-food exemption: https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst/publications/food-beverage-service-providers-retail-liquor-sellers
# Saskatchewan restaurant PST: https://sets.saskatchewan.ca/rptp/wcm/connect/fe32a5ce-78af-440b-b801-24522674e7ae/PST.033%2BRestaurants.pdf?MOD=AJPERES
DEFAULT_RESTAURANT_TAX_RATES = {
    "AB": Decimal("0.05"),
    "BC": Decimal("0.05"),
    "MB": Decimal("0.12"),
    "NB": Decimal("0.15"),
    "NL": Decimal("0.15"),
    "NS": Decimal("0.14"),
    "NT": Decimal("0.05"),
    "NU": Decimal("0.05"),
    "ON": Decimal("0.13"),
    "PE": Decimal("0.15"),
    "QC": Decimal("0.14975"),
    "SK": Decimal("0.11"),
    "YT": Decimal("0.05"),
}


class ToolDispatcher:
    def __init__(
        self,
        repository: Repository,
        *,
        timeout_seconds: float = 3.0,
        tax_rates: Mapping[str, Decimal] | None = None,
        payment_links_enabled: bool | None = False,
        payment_link_base_url: str | None = None,
        worker_hmac_secret: str | None = None,
        payment_http_client: httpx.AsyncClient | None = None,
        sms_http_client: httpx.AsyncClient | None = None,
        offline_queue: OfflineMessageQueue | None = None,
        extra_handlers: Mapping[str, ToolHandler] | None = None,
        allow_private_lookups: bool = True,
    ) -> None:
        self.repository = repository
        self.allow_private_lookups = allow_private_lookups
        self.timeout_seconds = timeout_seconds
        self.tax_rates = dict(tax_rates or DEFAULT_RESTAURANT_TAX_RATES)
        self.payment_links_enabled = payment_links_enabled
        self.payment_link_base_url = payment_link_base_url.rstrip("/") if payment_link_base_url else None
        self.worker_hmac_secret = worker_hmac_secret
        self.payment_http_client = payment_http_client
        self.sms_http_client = sms_http_client
        self.offline_queue = offline_queue
        self._idempotency_locks: dict[str, asyncio.Lock] = {}
        self._handlers: dict[str, ToolHandler] = {
            "get_hours": self._get_hours,
            "search_menu": self._search_menu,
            "check_availability": self._check_availability,
            "create_booking": self._create_booking,
            "find_booking": self._find_booking,
            "modify_booking": self._modify_booking,
            "cancel_booking": self._cancel_booking,
            "create_order": self._create_order,
            "send_sms": self._send_sms,
            "send_payment_link": self._send_payment_link,
            "transfer_call": self._transfer_call,
            "take_message": self._take_message,
            "end_call": self._end_call,
        }
        self._handlers.update(extra_handlers or {})

    async def dispatch(
        self, name: str, arguments: Mapping[str, Any], context: ToolContext
    ) -> dict[str, Any]:
        if not self.allow_private_lookups and name in {'find_booking', 'modify_booking', 'cancel_booking'}:
            return self._error('not_available_in_demo', 'Existing customer bookings are private and cannot be accessed in this demo')
        handler = self._handlers.get(name)
        if handler is None:
            if context.dry_run:
                return self._error("unknown_tool", f"Unknown tool: {name}")

            async def unknown_handler(
                ignored_arguments: Mapping[str, Any], ignored_context: ToolContext
            ) -> dict[str, Any]:
                raise RepositoryError("unknown_tool", f"Unknown tool: {name}")

            handler = unknown_handler
        if not isinstance(arguments, Mapping):
            if context.dry_run:
                return self._error("bad_input", "Tool arguments must be an object")
            arguments = {"invalid_arguments_type": type(arguments).__name__}

            async def invalid_handler(
                ignored_arguments: Mapping[str, Any], ignored_context: ToolContext
            ) -> dict[str, Any]:
                raise ToolInputError("Tool arguments must be an object")

            handler = invalid_handler
        else:
            arguments = dict(arguments)
            if context.caller_phone and (
                "phone" in arguments
                or name in {"create_booking", "find_booking", "create_order", "send_sms", "take_message"}
            ):
                arguments["phone"] = context.caller_phone
        if context.dry_run and name == "send_payment_link":
            try:
                if not await self._payment_feature_enabled(context):
                    return self._error("feature_disabled", "Payment links are not enabled")
            except RepositoryError as exc:
                return self._error(exc.code, str(exc))
        if context.dry_run and name not in {
            "get_hours",
            "search_menu",
            "check_availability",
            "find_booking",
        }:
            try:
                validate_tool_arguments(name, arguments)
                self._validate_write_input(name, arguments)
                return {"ok": True, "dry_run": True}
            except (ToolInputError, ValueError, TypeError) as exc:
                return self._error("bad_input", str(exc))
        if context.dry_run:
            try:
                validate_tool_arguments(name, arguments)
                async with asyncio.timeout(self.timeout_seconds):
                    return await handler(arguments, context)
            except TimeoutError:
                return self._error("timeout", "The tool did not finish in time; do not claim success")
            except (ToolInputError, ValueError, TypeError) as exc:
                return self._error("bad_input", str(exc))
            except RepositoryError as exc:
                return self._error(exc.code, str(exc))

        lock = self._idempotency_locks.setdefault(context.idempotency_key, asyncio.Lock())
        async with lock:
            try:
                return await self._dispatch_once(name, arguments, context, handler)
            except RepositoryError as exc:
                if exc.code != "unreachable":
                    raise
                if name == "take_message" and self.offline_queue:
                    await asyncio.to_thread(
                        self.offline_queue.enqueue,
                        {
                            "restaurant_id": context.restaurant_id,
                            "call_id": context.call_id,
                            "caller_name": str(arguments["name"]),
                            "phone": _e164(arguments["phone"]),
                            "text": str(arguments["text"]),
                        },
                    )
                    return {"ok": True, "queued_offline": True}
                return self._error(
                    "faq_only",
                    "Live data is unavailable; answer only from cached restaurant configuration",
                )

    async def _dispatch_once(
        self,
        name: str,
        arguments: Mapping[str, Any],
        context: ToolContext,
        handler: ToolHandler,
    ) -> dict[str, Any]:
        previous = await self.repository.select(
            "tool_invocations", {"idempotency_key": context.idempotency_key}
        )
        if previous and previous[0].get("status") in {"succeeded", "failed", "timed_out"}:
            return dict(previous[0].get("result") or {})
        if previous:
            return self._error("in_progress", "This tool invocation is already running")

        started = time.monotonic()
        try:
            invocation = await self.repository.insert(
                "tool_invocations",
                {
                    "call_id": context.call_id,
                    "tool": name,
                    "args": dict(arguments),
                    "result": None,
                    "status": "started",
                    "duration_ms": None,
                    "idempotency_key": context.idempotency_key,
                },
            )
        except RepositoryError as exc:
            if exc.code != "23505":
                raise
            concurrent = await self.repository.select(
                "tool_invocations", {"idempotency_key": context.idempotency_key}
            )
            if concurrent and concurrent[0].get("status") in {
                "succeeded",
                "failed",
                "timed_out",
            }:
                return dict(concurrent[0].get("result") or {})
            return self._error("in_progress", "This tool invocation is already running")
        status = "succeeded"
        try:
            validate_tool_arguments(name, arguments)
            async with asyncio.timeout(self.timeout_seconds):
                result = await handler(arguments, context)
        except TimeoutError:
            status = "timed_out"
            result = self._error("timeout", "The tool did not finish in time; do not claim success")
        except (ToolInputError, ValueError, TypeError) as exc:
            status = "failed"
            result = self._error("bad_input", str(exc))
        except RepositoryError as exc:
            status = "failed"
            result = self._error(exc.code, str(exc))
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        await self.repository.update(
            "tool_invocations",
            {"id": invocation["id"]},
            {"result": result, "status": status, "duration_ms": duration_ms},
        )
        return result

    @staticmethod
    def _error(code: str, message: str) -> dict[str, Any]:
        return {"ok": False, "error": {"code": code, "message": message}}

    @staticmethod
    def _validate_write_input(name: str, arguments: Mapping[str, Any]) -> None:
        required = {
            "create_booking": ("name", "phone", "party_size", "starts_at"),
            "create_order": ("items", "pickup_at", "name", "phone"),
            "send_sms": ("template_key", "vars", "phone", "language"),
            "transfer_call": ("reason",),
            "take_message": ("name", "phone", "text"),
            "end_call": ("reason",),
        }
        if name in required:
            _required(arguments, *required[name])

    async def _restaurant(self, context: ToolContext) -> dict[str, Any]:
        rows = await self.repository.select("restaurants", {"id": context.restaurant_id})
        if not rows:
            raise RepositoryError("not_found", "Restaurant not found")
        return rows[0]

    async def _get_hours(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        restaurant = await self._restaurant(context)
        timezone = ZoneInfo(restaurant["timezone"])
        requested = date.fromisoformat(str(arguments.get("date") or context.now.astimezone(timezone).date()))
        overrides = await self.repository.select(
            "hours_overrides", {"restaurant_id": context.restaurant_id, "date": requested.isoformat()}
        )
        if overrides:
            return {"ok": True, "date": requested.isoformat(), "hours": overrides[0]}
        rows = await self.repository.select(
            "hours", {"restaurant_id": context.restaurant_id, "weekday": requested.weekday()}
        )
        return {"ok": True, "date": requested.isoformat(), "hours": rows[0] if rows else None}

    async def _search_menu(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        _required(arguments, "query", "language")
        if arguments["language"] not in {"en", "fr-CA", "ur", "hi", "pa", "en-IN", "te", "ar"}:
            raise ToolInputError("Unsupported language")
        items = await self.repository.select("menu_items", {"restaurant_id": context.restaurant_id})
        ranked = sorted(
            (
                (_similarity(str(arguments["query"]), str(item.get("name", ""))), item)
                for item in items
                if item.get("available", True)
            ),
            key=lambda pair: pair[0],
            reverse=True,
        )
        matches = [dict(item, match_score=round(score, 3)) for score, item in ranked if score >= 0.45][:5]
        return {"ok": True, "items": matches}

    async def _check_availability(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        _required(arguments, "date", "time", "party_size")
        party_size = int(arguments["party_size"])
        if party_size <= 0:
            raise ToolInputError("party_size must be positive")
        restaurant = await self._restaurant(context)
        timezone = ZoneInfo(restaurant["timezone"])
        local = datetime.combine(
            date.fromisoformat(str(arguments["date"])),
            clock_time.fromisoformat(str(arguments["time"])),
            tzinfo=timezone,
        )
        config_rows = await self.repository.select("slots_config", {"restaurant_id": context.restaurant_id})
        if not config_rows:
            raise RepositoryError("not_configured", "Booking slots are not configured")
        config = config_rows[0]
        if party_size > int(config["max_party"]):
            raise ToolInputError("party_size exceeds the restaurant maximum party size")
        candidates = [local, local - timedelta(minutes=int(config["slot_minutes"])), local + timedelta(minutes=int(config["slot_minutes"]))]
        bookings = await self.repository.select("bookings", {"restaurant_id": context.restaurant_id})
        available = []
        for candidate in candidates:
            iso = candidate.astimezone(UTC).isoformat().replace("+00:00", "Z")
            reserved = sum(int(row["party_size"]) for row in bookings if row.get("starts_at") == iso and row.get("status") in {"confirmed", "seated"})
            if reserved + party_size <= int(config["covers_per_slot"]):
                available.append(iso)
        return {"ok": True, "exact": available[0] if available and available[0] == candidates[0].astimezone(UTC).isoformat().replace("+00:00", "Z") else None, "alternatives": available[:2]}

    async def _create_booking(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        _required(arguments, "name", "phone", "party_size", "starts_at")
        party_size = int(arguments["party_size"])
        if party_size <= 0:
            raise ToolInputError("party_size must be positive")
        config_rows = await self.repository.select(
            "slots_config", {"restaurant_id": context.restaurant_id}
        )
        if not config_rows:
            raise RepositoryError("not_configured", "Booking slots are not configured")
        if party_size > int(config_rows[0]["max_party"]):
            raise ToolInputError("party_size exceeds the restaurant maximum party size")
        starts_at = _iso_datetime(arguments["starts_at"]).astimezone(UTC).isoformat().replace("+00:00", "Z")
        booking = await self.repository.create_booking(
            {
                "restaurant_id": context.restaurant_id,
                "call_id": context.call_id,
                "name": str(arguments["name"]).strip(),
                "phone_e164": _e164(arguments["phone"]),
                "party_size": party_size,
                "starts_at": starts_at,
                "status": "confirmed",
                "notes": str(arguments.get("notes", "")),
                "source": "call",
            },
        )
        return {"ok": True, "booking": booking}

    async def _find_booking(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        _required(arguments, "phone")
        rows = await self.repository.select(
            "bookings", {"restaurant_id": context.restaurant_id, "phone_e164": _e164(arguments["phone"])}
        )
        if arguments.get("date"):
            rows = [row for row in rows if str(row.get("starts_at", "")).startswith(str(arguments["date"]))]
        return {"ok": True, "bookings": rows}

    async def _modify_booking(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        _required(arguments, "booking_id", "changes")
        allowed = {key: value for key, value in dict(arguments["changes"]).items() if key in {"starts_at", "party_size", "notes"}}
        if not allowed:
            raise ToolInputError("No supported booking changes supplied")
        if "party_size" in allowed and int(allowed["party_size"]) <= 0:
            raise ToolInputError("party_size must be positive")
        if "party_size" in allowed:
            config_rows = await self.repository.select(
                "slots_config", {"restaurant_id": context.restaurant_id}
            )
            if not config_rows:
                raise RepositoryError("not_configured", "Booking slots are not configured")
            if int(allowed["party_size"]) > int(config_rows[0]["max_party"]):
                raise ToolInputError("party_size exceeds the restaurant maximum party size")
        if "starts_at" in allowed:
            allowed["starts_at"] = _iso_datetime(allowed["starts_at"]).astimezone(UTC).isoformat().replace("+00:00", "Z")
        booking = await self.repository.update(
            "bookings", {"id": arguments["booking_id"], "restaurant_id": context.restaurant_id}, allowed
        )
        return {"ok": True, "booking": booking}

    async def _cancel_booking(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        _required(arguments, "booking_id")
        booking = await self.repository.update(
            "bookings", {"id": arguments["booking_id"], "restaurant_id": context.restaurant_id}, {"status": "cancelled"}
        )
        return {"ok": True, "booking": booking}

    async def _create_order(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        _required(arguments, "items", "pickup_at", "name", "phone")
        restaurant = await self._restaurant(context)
        menu = {row["id"]: row for row in await self.repository.select("menu_items", {"restaurant_id": context.restaurant_id})}
        modifiers = {row["id"]: row for row in await self.repository.select("menu_modifiers")}
        lines: list[dict[str, Any]] = []
        subtotal = 0
        for requested in arguments["items"]:
            item = menu.get(requested.get("menu_item_id"))
            quantity = int(requested.get("quantity", 0))
            if not item or not item.get("available", True) or quantity <= 0:
                raise ToolInputError("Order contains an invalid or unavailable menu item")
            selected = [modifiers[mid] for mid in requested.get("modifiers", []) if mid in modifiers]
            modifier_cents = sum(int(modifier.get("price_delta_cents", 0)) for modifier in selected)
            unit_cents = int(item["price_cents"]) + modifier_cents
            subtotal += unit_cents * quantity
            lines.append({"item": item["name"], "modifiers": [row["name"] for row in selected], "modifier_price_cents": [int(row.get("price_delta_cents", 0)) for row in selected], "quantity": quantity, "price_cents": unit_cents})
        rate = self.tax_rates.get(str(restaurant["province"]))
        if rate is None:
            raise RepositoryError("tax_not_configured", "Tax rate is not configured for this province")
        tax = int((Decimal(subtotal) * rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        order = await self.repository.insert(
            "orders",
            {"restaurant_id": context.restaurant_id, "call_id": context.call_id, "name": str(arguments["name"]), "phone": _e164(arguments["phone"]), "pickup_at": _iso_datetime(arguments["pickup_at"]).astimezone(UTC).isoformat().replace("+00:00", "Z"), "subtotal_cents": subtotal, "tax_cents": tax, "total_cents": subtotal + tax, "paid_status": "unpaid", "status": "new"},
        )
        for line in lines:
            await self.repository.insert("order_items", dict(line, order_id=order["id"]))
        return {"ok": True, "order": order, "items": lines}

    async def _send_sms(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        _required(arguments, "template_key", "vars", "phone", "language")
        phone, language = _e164(arguments["phone"]), str(arguments["language"])
        opted_out = await self.repository.select("sms_optouts", {"restaurant_id": context.restaurant_id, "phone_e164": phone})
        if opted_out:
            raise RepositoryError("sms_opted_out", "This caller has opted out of SMS")
        try:
            body = SMS_TEMPLATES[str(arguments["template_key"])][language].format_map(dict(arguments["vars"]))
            unsubscribe = SMS_UNSUBSCRIBE[language]
        except (KeyError, ValueError) as exc:
            raise ToolInputError("Unknown template/language or missing template variable") from exc

        api_key = os.environ.get("TELNYX_API_KEY", "").strip()
        base_url = os.environ.get("TELNYX_BASE_URL", "").strip().rstrip("/")
        profile_id = os.environ.get("TELNYX_MESSAGING_PROFILE_ID", "").strip()
        if not all((api_key, base_url, profile_id)):
            raise RepositoryError("sms_not_configured", "Telnyx SMS configuration is incomplete")
        senders = await self.repository.select(
            "phone_numbers", {"restaurant_id": context.restaurant_id, "status": "active"}
        )
        if not senders:
            raise RepositoryError("sms_not_configured", "No active SMS sender for this restaurant")
        sender = _e164(senders[0]["e164"])
        restaurant = await self._restaurant(context)
        identity = str(restaurant.get("name") or "").strip()
        if not identity:
            raise RepositoryError("sms_not_configured", "Restaurant SMS identity is missing")
        body = f"{identity}: {unsubscribe} {body}"
        sms = await self.repository.insert("sms_log", {"restaurant_id": context.restaurant_id, "to_e164": phone, "body": body, "status": "queued"})
        owns_client = self.sms_http_client is None
        client = self.sms_http_client or httpx.AsyncClient(timeout=self.timeout_seconds)
        try:
            # Telnyx POST /messages request/response contract:
            # https://developers.telnyx.com/api-reference/messages/send-a-message
            # Keys permit only letters, numbers, hyphens and underscores; hash the
            # dispatcher key to preserve its identity without colons or caller data.
            # https://developers.telnyx.com/docs/development/api-fundamentals/reliability/idempotency-keys
            try:
                response = await client.post(
                    f"{base_url}/messages",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Idempotency-Key": hashlib.sha256(context.idempotency_key.encode()).hexdigest(),
                    },
                    json={
                        "from": sender, "to": phone, "text": body, "type": "SMS",
                        "messaging_profile_id": profile_id,
                    },
                    timeout=self.timeout_seconds,
                    follow_redirects=False,
                )
            except httpx.TimeoutException as exc:
                raise RepositoryError("sms_timeout", "SMS acceptance is unknown after a timeout; do not claim sent") from exc
            except httpx.HTTPError as exc:
                raise RepositoryError("sms_provider_error", "SMS request failed; do not claim sent") from exc
            finally:
                if owns_client:
                    await client.aclose()
            if not response.is_success:
                raise RepositoryError("sms_provider_error", f"Telnyx rejected SMS (HTTP {response.status_code})")
            try:
                payload = response.json()
            except ValueError as exc:
                raise RepositoryError("sms_provider_error", "Telnyx returned invalid JSON") from exc
            data = payload.get("data") if isinstance(payload, dict) else None
            message_id = data.get("id") if isinstance(data, dict) else None
            if not isinstance(message_id, str) or not message_id.strip():
                raise RepositoryError("sms_provider_error", "Telnyx returned no valid message ID")
        except (RepositoryError, asyncio.CancelledError) as error:
            # A lost response or cancellation cannot establish rejection. Keep
            # the pending row for reconciliation; dispatcher idempotency prevents
            # resending this invocation. Never describe it as confirmed failure.
            if not isinstance(error, asyncio.CancelledError) and error.code != "sms_timeout":
                await self.repository.update("sms_log", {"id": sms["id"]}, {"status": "failed"})
            raise
        # "sent" records provider acceptance only; delivery requires a receipt.
        sms = await self.repository.update(
            "sms_log", {"id": sms["id"]},
            {"status": "sent", "provider_message_id": message_id},
        )
        return {"ok": True, "sms": sms, "message_id": message_id}

    async def _send_payment_link(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        if not await self._payment_feature_enabled(context):
            raise RepositoryError("feature_disabled", "Payment links are not enabled")
        if bool(arguments.get("order_id")) == bool(arguments.get("booking_id")):
            raise ToolInputError("Supply exactly one of order_id or booking_id")
        kind = "order" if arguments.get("order_id") else "booking"
        target_id = str(arguments.get(f"{kind}_id"))
        table = "orders" if kind == "order" else "bookings"
        rows = await self.repository.select(
            table, {"id": target_id, "restaurant_id": context.restaurant_id}
        )
        if not rows:
            raise RepositoryError("not_found", "Payment target was not found")
        target = rows[0]
        phone = _e164(target.get("phone") or target.get("phone_e164"))
        opted_out = await self.repository.select(
            "sms_optouts",
            {"restaurant_id": context.restaurant_id, "phone_e164": phone},
        )
        if opted_out:
            raise RepositoryError("sms_opted_out", "This caller has opted out of SMS")
        link = await self._request_payment_link(kind, target_id, context)
        language = "fr-CA" if context.language == "fr-CA" else "en"
        sms = await self._send_sms(
            {
                "template_key": "payment_link",
                "vars": {"url": link["url"]},
                "phone": phone,
                "language": language,
            },
            context,
        )
        return {
            "ok": True,
            "payment_link": link["url"],
            "target_id": target_id,
            "sms": sms["sms"],
            "message_id": sms["message_id"],
        }

    async def _payment_feature_enabled(self, context: ToolContext) -> bool:
        if self.payment_links_enabled is not None:
            return self.payment_links_enabled
        flags = await self.repository.select("feature_flags", {"key": "diner_payments"})
        restaurant_flag = next(
            (row for row in flags if row.get("restaurant_id") == context.restaurant_id),
            None,
        )
        if restaurant_flag is not None:
            return bool(restaurant_flag.get("enabled"))
        global_flag = next((row for row in flags if row.get("restaurant_id") is None), None)
        return bool(global_flag and global_flag.get("enabled"))

    async def _request_payment_link(
        self, kind: str, target_id: str, context: ToolContext
    ) -> dict[str, Any]:
        if not self.payment_link_base_url or not self.worker_hmac_secret:
            raise RepositoryError("payment_not_configured", "Payment link service is not configured")
        path = "/api/payments/link"
        body = json.dumps(
            {
                "restaurant_id": context.restaurant_id,
                "call_id": context.call_id,
                f"{kind}_id": target_id,
            },
            separators=(",", ":"),
        ).encode()
        timestamp = str(int(time.time()))
        signature = sign_request(
            secret=self.worker_hmac_secret,
            timestamp=timestamp,
            method="POST",
            path=path,
            body=body,
        )
        owns_client = self.payment_http_client is None
        client = self.payment_http_client or httpx.AsyncClient(timeout=self.timeout_seconds)
        try:
            response = await client.post(
                f"{self.payment_link_base_url}{path}",
                content=body,
                headers={
                    "content-type": "application/json",
                    "x-timestamp": timestamp,
                    "x-signature": signature,
                },
            )
        except httpx.HTTPError as exc:
            raise RepositoryError("unreachable", "Payment link service is unreachable") from exc
        finally:
            if owns_client:
                await client.aclose()
        try:
            payload = response.json()
        except ValueError as exc:
            raise RepositoryError("provider_error", "Payment link service returned invalid JSON") from exc
        if response.is_error:
            error = payload.get("error", {}) if isinstance(payload, dict) else {}
            raise RepositoryError(
                str(error.get("code", "provider_error")),
                str(error.get("message", "Payment link service failed")),
            )
        if not isinstance(payload, dict) or not isinstance(payload.get("url"), str):
            raise RepositoryError("provider_error", "Payment link service returned no URL")
        return payload

    async def _transfer_call(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        _required(arguments, "reason")
        restaurant = await self._restaurant(context)
        local_now = context.now.astimezone(ZoneInfo(restaurant["timezone"]))
        key = local_now.strftime("%A").lower()
        hours = restaurant.get("transfer_hours", {}).get(key)
        if not hours or not (clock_time.fromisoformat(hours[0]) <= local_now.time().replace(tzinfo=None) <= clock_time.fromisoformat(hours[1])):
            raise RepositoryError("outside_transfer_hours", "Transfer is unavailable right now")
        if not restaurant.get("transfer_phone"):
            raise RepositoryError("transfer_not_configured", "Transfer phone is not configured")
        return {"ok": True, "transfer_to": restaurant["transfer_phone"], "spoken_summary": str(arguments["reason"])}

    async def _take_message(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        _required(arguments, "name", "phone", "text")
        message = await self.repository.insert("messages", {"restaurant_id": context.restaurant_id, "call_id": context.call_id, "caller_name": str(arguments["name"]), "phone": _e164(arguments["phone"]), "text": str(arguments["text"]), "handled": False})
        return {"ok": True, "message": message}

    async def _end_call(self, arguments: Mapping[str, Any], context: ToolContext) -> dict[str, Any]:
        _required(arguments, "reason")
        return {"ok": True, "action": "play_cached_goodbye_then_hangup", "reason": str(arguments["reason"])}


def pipecat_handler(
    dispatcher: ToolDispatcher,
    context_factory: Callable[[Any], ToolContext],
    result_handler: Callable[[str, dict[str, Any]], Awaitable[None] | None] | None = None,
):
    """Adapt ToolDispatcher to Pipecat's FunctionCallParams contract."""

    async def handle(params: Any) -> None:
        tool_context = context_factory(params)
        result = await dispatcher.dispatch(params.function_name, params.arguments, tool_context)
        if result_handler:
            handled = result_handler(params.function_name, result)
            if inspect.isawaitable(handled):
                await handled
        callback_result = params.result_callback(result)
        if inspect.isawaitable(callback_result):
            await callback_result

    return handle
