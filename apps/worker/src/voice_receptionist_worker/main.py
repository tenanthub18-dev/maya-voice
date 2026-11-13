import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import os
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID
from urllib.parse import parse_qs
from xml.etree import ElementTree

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketDisconnect, WebSocketState

from voice_receptionist_worker.integrations import GeminiClient
from voice_receptionist_worker.agent_config_cache import AgentConfigCache
from voice_receptionist_worker.pipeline import (
    ProviderConfigError,
    RuntimeConfig,
    load_runtime_config,
    run_pipeline,
)
from voice_receptionist_worker.postcall import PostCallProcessor
from voice_receptionist_worker.tools import (
    RepositoryError,
    SupabasePostgrestRepository,
    ToolDispatcher,
)
from voice_receptionist_worker.resilience.offline_queue import OfflineMessageQueue
from voice_receptionist_worker.security.hmac import verify_request
from voice_receptionist_worker.security.redaction import configure_logging_redaction, redacted_logger



def _configure_test_call_cors(application: FastAPI, web_app_url: str | None) -> None:
    if not web_app_url:
        return
    # FastAPI's CORS middleware handles browser preflight requests as documented:
    # https://fastapi.tiangolo.com/tutorial/cors/
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[web_app_url.rstrip("/")],
        allow_methods=["POST"],
        allow_headers=["Authorization", "Content-Type"],
    )


configure_logging_redaction()
app = FastAPI(title="Voice Receptionist Worker")
_configure_test_call_cors(app, os.environ.get("NEXT_PUBLIC_APP_URL"))
logger = redacted_logger(__name__)
TELNYX_SIGNATURE_TOLERANCE_SECONDS = 300
WEBSOCKET_AUTH_TOLERANCE_SECONDS = 120
TEST_CALL_TOKEN_MAX_LIFETIME_SECONDS = 120
HEALTH_PROBE_TIMEOUT_SECONDS = 0.8
HEALTH_OVERALL_TIMEOUT_SECONDS = 1.4
PAYMENT_GRACE_SECONDS = 7 * 24 * 60 * 60
REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
PROVIDERS_CONFIG_PATH = REPOSITORY_ROOT / "config" / "providers.yaml"
DEV_RESTAURANT_CONFIG_PATH = REPOSITORY_ROOT / "config" / "dev-restaurant.yaml"
_small_webrtc_handler: Any | None = None
_test_call_pipeline_tasks: set[asyncio.Task[None]] = set()
_browser_demo_nonces: dict[str, int] = {}
_browser_demo_active_calls = 0
_browser_demo_pending_handshakes = 0
_agent_config_cache: AgentConfigCache[dict[str, Any]] = AgentConfigCache(
    ttl_seconds=60
)


def _tool_dispatcher(
    repository: SupabasePostgrestRepository,
    offline_queue: OfflineMessageQueue,
    *,
    public_demo: bool = False,
) -> ToolDispatcher:
    return ToolDispatcher(
        repository,
        payment_links_enabled=None,
        payment_link_base_url=os.environ.get("NEXT_PUBLIC_APP_URL"),
        worker_hmac_secret=os.environ.get("WORKER_HMAC_SECRET"),
        offline_queue=offline_queue,
        allow_private_lookups=not public_demo,
    )


async def _raise_owner_notification(
    repository: SupabasePostgrestRepository,
    event: dict[str, str],
) -> None:
    calls = await repository.select("calls", {"id": event["call_id"]})
    if not calls:
        return
    restaurants = await repository.select(
        "restaurants", {"id": calls[0]["restaurant_id"]}
    )
    if not restaurants:
        return
    recipients = await repository.select(
        "notification_preferences",
        {
            "organization_id": restaurants[0]["organization_id"],
            "flagged_call": True,
        },
    )
    if not recipients:
        return

    api_key = os.environ["RESEND_API_KEY"]
    from_email = os.environ["RESEND_FROM_EMAIL"]
    base_url = os.environ["RESEND_BASE_URL"].rstrip("/")
    async with httpx.AsyncClient(timeout=4.0) as client:
        for recipient in recipients:
            french = recipient.get("locale") == "fr"
            subject = "Appel signalé" if french else "Flagged call"
            detail = (
                "Le traitement après appel a échoué. Vérifiez l’appel dans le tableau de bord."
                if french
                else "Post-call processing failed. Review the call in the dashboard."
            )
            # Resend send-email and idempotency contracts:
            # https://resend.com/docs/api-reference/emails/send-email
            # https://resend.com/docs/dashboard/emails/idempotency-keys
            response = await client.post(
                f"{base_url}/emails",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Idempotency-Key": (
                        f"{event['idempotency_key']}:{recipient['id']}"
                    ),
                },
                json={
                    "from": from_email,
                    "to": recipient["email"],
                    "subject": subject,
                    "text": detail,
                    "html": f"<h1>{subject}</h1><p>{detail}</p>",
                    "tags": [{"name": "notification", "value": event["type"]}],
                },
            )
            response.raise_for_status()


async def _run_postcall_job(
    repository: SupabasePostgrestRepository,
    config: RuntimeConfig,
    call_id: str,
) -> None:
    try:
        gemini = GeminiClient(
            api_key=os.environ["GEMINI_API_KEY"],
            model=str(config.providers["llm"]["model"]),
        )
    except Exception as error:
        logger.error(
            "postcall_setup_failed",
            extra={"call_id": call_id, "error_class": type(error).__name__},
        )
        return
    try:
        async def notify_owner(event: dict[str, str]) -> None:
            await _raise_owner_notification(repository, event)

        await PostCallProcessor(
            repository,
            gemini,
            notify_owner=notify_owner,
        ).process(call_id)
    except Exception:
        # PostCallProcessor records the sanitized terminal failure and raises the
        # idempotent owner-notification event before returning control here.
        return
    finally:
        await gemini.aclose()


def _log_telnyx_failover_requirement() -> None:
    # TeXML application failover is configured as `voice_fallback_url` on the
    # Telnyx application, not in a TeXML response. Official field reference:
    # https://developers.telnyx.com/api-reference/texml-applications/creates-a-texml-application
    logger.warning(
        "Telnyx TeXML voice_fallback_url must point to a transfer TeXML endpoint; "
        "verify it dials TRANSFER_PHONE_FALLBACK before go-live"
    )


_log_telnyx_failover_requirement()


def _verify_telnyx_signature(request_body: bytes, request: Request) -> None:
    public_key_encoded = os.environ.get("TELNYX_PUBLIC_KEY")
    if not public_key_encoded:
        raise HTTPException(
            status_code=503,
            detail="Telnyx signature verification unavailable",
        )

    signature_encoded = request.headers.get("Telnyx-Signature-Ed25519")
    timestamp_text = request.headers.get("Telnyx-Timestamp")
    try:
        if not signature_encoded or not timestamp_text:
            raise ValueError("missing signature headers")
        timestamp = int(timestamp_text)
        if abs(time.time() - timestamp) > TELNYX_SIGNATURE_TOLERANCE_SECONDS:
            raise ValueError("signature timestamp outside tolerance")
        public_key = base64.b64decode(public_key_encoded, validate=True)
        signature = base64.b64decode(signature_encoded, validate=True)
        signed_payload = timestamp_text.encode() + b"|" + request_body

        # Telnyx documents Ed25519 over "{timestamp}|{raw payload}" here:
        # https://developers.telnyx.com/docs/api/v2/overview
        Ed25519PublicKey.from_public_bytes(public_key).verify(
            signature,
            signed_payload,
        )
    except (binascii.Error, InvalidSignature, ValueError) as error:
        raise HTTPException(status_code=401, detail="Invalid Telnyx signature") from error


async def _probe_endpoint(client: httpx.AsyncClient, endpoint: str) -> str:
    try:
        # HTTPX async client usage follows:
        # https://www.python-httpx.org/async/
        response = await client.get(
            endpoint,
            timeout=HEALTH_PROBE_TIMEOUT_SECONDS,
            follow_redirects=True,
        )
    except httpx.HTTPError:
        return "unreachable"
    return "reachable" if response.status_code < 500 else "unreachable"


async def _parse_telnyx_websocket(websocket: WebSocket):
    # Pipecat documents this parser for Telnyx's connected/start handshake:
    # https://docs.pipecat.ai/pipecat/telephony/telnyx-websockets
    from pipecat.runner.utils import parse_telephony_websocket

    return await parse_telephony_websocket(websocket)


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    provider_configuration = {
        "soniox": (
            ("SONIOX_API_KEY", "SONIOX_HEALTHCHECK_URL"),
            "SONIOX_HEALTHCHECK_URL",
        ),
        "gemini": (
            ("GEMINI_API_KEY", "GEMINI_HEALTHCHECK_URL"),
            "GEMINI_HEALTHCHECK_URL",
        ),
        "supabase": (
            ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"),
            "SUPABASE_URL",
        ),
    }
    checks: dict[str, str] = {}
    configured_endpoints: dict[str, str] = {}
    for provider, (required_names, endpoint_name) in provider_configuration.items():
        if not all(os.environ.get(name) for name in required_names):
            checks[provider] = "unconfigured"
            continue
        configured_endpoints[provider] = os.environ[endpoint_name]

    if configured_endpoints:
        async with httpx.AsyncClient() as client:
            providers = list(configured_endpoints)
            probes = asyncio.gather(
                *(
                    _probe_endpoint(client, configured_endpoints[provider])
                    for provider in providers
                )
            )
            try:
                results = await asyncio.wait_for(
                    probes,
                    timeout=HEALTH_OVERALL_TIMEOUT_SECONDS,
                )
            except TimeoutError:
                results = ["unreachable"] * len(providers)
            checks.update(zip(providers, results, strict=True))

    status = "degraded" if "unreachable" in checks.values() else "ok"
    return {"status": status, "checks": checks}


def _fallback_texml_response(transfer_number: str | None = None) -> Response:
    response_element = ElementTree.Element("Response")
    transfer_number = transfer_number or os.environ.get("TRANSFER_PHONE_FALLBACK")

    # Telnyx TeXML Dial and Say verb references:
    # https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/dial/index
    # https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/say
    if transfer_number:
        ElementTree.SubElement(response_element, "Say").text = (
            "Please hold while I transfer your call."
        )
        ElementTree.SubElement(response_element, "Dial").text = transfer_number
    else:
        ElementTree.SubElement(response_element, "Say").text = (
            "Sorry, we cannot take your call right now."
        )
        ElementTree.SubElement(response_element, "Hangup")
    return Response(
        ElementTree.tostring(response_element, encoding="unicode"),
        media_type="application/xml",
    )


def _billing_blocks_agent(restaurant: Mapping[str, Any], now_seconds: float) -> bool:
    if restaurant.get("spend_cap_reached"):
        return True
    if restaurant.get("billing_status") in {"unpaid", "suspended"}:
        return True
    if restaurant.get("last_invoice_status") != "payment_failed":
        return False
    failed_at_text = restaurant.get("stripe_invoice_event_created_at")
    if not failed_at_text:
        return True
    try:
        failed_at = datetime.fromisoformat(
            str(failed_at_text).replace("Z", "+00:00")
        )
        if failed_at.tzinfo is None:
            failed_at = failed_at.replace(tzinfo=timezone.utc)
    except ValueError:
        return True
    age_seconds = now_seconds - failed_at.timestamp()
    return age_seconds < 0 or age_seconds >= PAYMENT_GRACE_SECONDS


async def _load_call_start_restaurant(
    called_number: str | None,
    fallback: Mapping[str, Any],
) -> dict[str, Any]:
    if (
        not called_number
        or not os.environ.get("SUPABASE_URL")
        or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    ):
        return dict(fallback)
    return await _agent_config_cache.get(
        called_number,
        lambda: _fetch_call_start_restaurant(called_number, fallback),
    )


async def _fetch_call_start_restaurant(
    called_number: str,
    fallback: Mapping[str, Any],
) -> dict[str, Any]:
    repository = SupabasePostgrestRepository(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )
    try:
        phone_rows = await repository.select(
            "phone_numbers", {"e164": called_number, "status": "active"}
        )
        if not phone_rows:
            raise ProviderConfigError("Called number is not assigned to a restaurant")
        restaurant_rows = await repository.select(
            "restaurants", {"id": phone_rows[0]["restaurant_id"]}
        )
        if not restaurant_rows:
            raise ProviderConfigError("Restaurant is unavailable for called number")
        restaurant = restaurant_rows[0]
        agent_rows = await repository.select(
            "agents", {"restaurant_id": restaurant["id"]}
        )
        published_version: dict[str, Any] | None = None
        if agent_rows and agent_rows[0].get("current_published_version_id"):
            version_rows = await repository.select(
                "agent_versions",
                {"id": agent_rows[0]["current_published_version_id"]},
            )
            published_version = version_rows[0] if version_rows else None
        organization_rows = await repository.select(
            "organizations", {"id": restaurant["organization_id"]}
        )
        if not organization_rows:
            raise ProviderConfigError("Organization is unavailable for called number")
        organization = organization_rows[0]
        period = datetime.now(timezone.utc).strftime("%Y-%m")
        ledgers = await repository.select(
            "usage_ledger",
            {"organization_id": organization["id"], "period": period},
        )
        current_cost_micros = int(ledgers[0].get("cost_micros", 0)) if ledgers else 0
        cap_micros = int(organization["spend_cap_cents"]) * 10_000
        return {
            **dict(fallback),
            "transfer_phone": restaurant.get("transfer_phone"),
            "kill_switch": bool(phone_rows[0].get("kill_switch", False)),
            "spend_cap_reached": current_cost_micros >= cap_micros,
            "last_invoice_status": organization.get("last_invoice_status"),
            "stripe_invoice_event_created_at": organization.get(
                "stripe_invoice_event_created_at"
            ),
            "published_agent_version": published_version,
            "restaurant_id": restaurant["id"],
            "agent_version_id": published_version["id"] if published_version else None,
        }
    finally:
        await repository.aclose()


def _caller_reference(restaurant_id: str, caller_phone: str) -> str:
    # Same scheme as apps/web/lib/compliance/caller-reference.ts so privacy
    # requests can find this caller's calls.
    secret = os.environ["PRIVACY_REQUEST_HASH_SECRET"]
    if len(secret.encode()) < 32:
        raise ProviderConfigError("PRIVACY_REQUEST_HASH_SECRET must be at least 32 bytes")
    return hmac.new(
        secret.encode(),
        f"{restaurant_id}:{caller_phone}".encode(),
        hashlib.sha256,
    ).hexdigest()


async def _create_call_record(
    restaurant_config: Mapping[str, Any],
    telnyx_call_id: str,
    caller_phone: str,
) -> str:
    """Insert (or reuse, on a Telnyx retry) the calls row and return its uuid.

    TeXML request fields (CallSid, From, To):
    https://developers.telnyx.com/docs/voice/programmable-voice/texml-translator
    """
    repository = SupabasePostgrestRepository(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )
    try:
        existing = await repository.select("calls", {"telnyx_call_id": telnyx_call_id})
        if existing:
            return str(existing[0]["id"])
        digits = "".join(character for character in caller_phone if character.isdigit())
        try:
            row = await repository.insert(
                "calls",
                {
                    "restaurant_id": restaurant_config["restaurant_id"],
                    "agent_version_id": restaurant_config["agent_version_id"],
                    "telnyx_call_id": telnyx_call_id,
                    "from_e164_hash": _caller_reference(
                        str(restaurant_config["restaurant_id"]), caller_phone
                    ),
                    "from_last4": digits[-4:].rjust(4, "0"),
                    "started_at": datetime.now(timezone.utc).isoformat(),
                },
            )
        except RepositoryError:
            # A concurrent Telnyx retry can win the unique(telnyx_call_id) race
            # between our select and insert; reuse that row instead of failing.
            existing = await repository.select("calls", {"telnyx_call_id": telnyx_call_id})
            if not existing:
                raise
            return str(existing[0]["id"])
        return str(row["id"])
    finally:
        await repository.aclose()


def _websocket_auth_token(secret: str, timestamp: int, call_id: str = "") -> str:
    timestamp_text = str(timestamp)
    signed = f"{timestamp_text}|{call_id}" if call_id else timestamp_text
    digest = hmac.new(
        secret.encode(),
        signed.encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{timestamp_text}.{digest}"


def _verify_websocket_auth(token: str | None, call_id: str = "") -> bool:
    secret = os.environ.get("WS_AUTH_SECRET")
    if not secret or not token:
        return False
    timestamp_text, separator, supplied_digest = token.partition(".")
    try:
        timestamp = int(timestamp_text)
    except ValueError:
        return False
    age_seconds = abs(int(time.time()) - timestamp)
    if not separator or age_seconds > WEBSOCKET_AUTH_TOLERANCE_SECONDS:
        return False
    expected_digest = _websocket_auth_token(secret, timestamp, call_id).partition(".")[2]
    return hmac.compare_digest(expected_digest.encode(), supplied_digest.encode())


def _verify_test_call_token(authorization: str | None) -> dict[str, Any]:
    secret = os.environ.get("TEST_CALL_HMAC_SECRET")
    if not secret:
        raise HTTPException(
            status_code=503,
            detail="Test-call authentication unavailable",
        )
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid test-call token")

    token = authorization.removeprefix("Bearer ")
    payload_encoded, separator, supplied_signature = token.partition(".")
    expected_signature = hmac.new(
        secret.encode(),
        payload_encoded.encode(),
        hashlib.sha256,
    ).hexdigest()
    try:
        if not separator or not hmac.compare_digest(expected_signature.encode(), supplied_signature.encode()):
            raise ValueError("invalid signature")
        padding = "=" * (-len(payload_encoded) % 4)
        payload_bytes = base64.b64decode(
            payload_encoded + padding,
            altchars=b"-_",
            validate=True,
        )
        claims = json.loads(payload_bytes)
        if not isinstance(claims, dict):
            raise ValueError("claims must be an object")
        expiration = claims.get("exp")
        now = int(time.time())
        if (
            not isinstance(expiration, int)
            or isinstance(expiration, bool)
            or expiration <= now
            or expiration > now + TEST_CALL_TOKEN_MAX_LIFETIME_SECONDS
            or claims.get("mode") != "test"
            or not isinstance(claims.get("agent_version_id"), str)
            or not claims["agent_version_id"]
            or not isinstance(claims.get("restaurant_id"), str)
            or not claims["restaurant_id"]
        ):
            raise ValueError("invalid claims")
    except (binascii.Error, json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
        raise HTTPException(status_code=401, detail="Invalid test-call token") from error
    return claims


def _get_small_webrtc_handler():
    global _small_webrtc_handler
    if _small_webrtc_handler is None:
        # Pipecat SmallWebRTC signaling and installation contract:
        # https://docs.pipecat.ai/server/services/transport/small-webrtc
        from pipecat.transports.smallwebrtc.request_handler import (
            SmallWebRTCRequestHandler,
        )

        # Browser test calls from other networks need STUN/TURN; Telnyx phone calls do not use WebRTC.
        # WEBRTC_ICE_SERVERS is a JSON list of {"urls", "username", "credential"} objects.
        # Pipecat contract: pipecat/transports/smallwebrtc/request_handler.py (ice_servers).
        from pipecat.transports.smallwebrtc.connection import IceServer

        ice_servers = [
            IceServer(**server)
            for server in json.loads(os.environ.get("WEBRTC_ICE_SERVERS") or "[]")
        ] or None
        _small_webrtc_handler = SmallWebRTCRequestHandler(ice_servers=ice_servers)
    return _small_webrtc_handler


def _build_small_webrtc_request(body: dict[str, Any]):
    from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequest

    return SmallWebRTCRequest.from_dict(body)


async def _launch_test_call_pipeline(
    connection: Any,
    claims: Mapping[str, Any],
    *,
    dry_run_tools: bool,
    browser_audio: bool = False,
) -> None:
    from voice_receptionist_worker.call_logging import BrowserCallLog
    from voice_receptionist_worker.pipeline.builder import run_webrtc_pipeline

    config = load_runtime_config(PROVIDERS_CONFIG_PATH, DEV_RESTAURANT_CONFIG_PATH)
    repository = SupabasePostgrestRepository(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )
    queue_config = config.providers["resilience"]["offline_queue"]
    offline_queue = OfflineMessageQueue(
        queue_config["path"],
        int(queue_config["maximum_messages"]),
    )

    try:
        versions = await repository.select(
            "agent_versions",
            {"id": claims["agent_version_id"], "status": "draft"},
        )
        if not versions:
            raise ProviderConfigError("Test-call draft is unavailable")
        version = versions[0]
        agents = await repository.select(
            "agents",
            {"id": version.get("agent_id"), "restaurant_id": claims["restaurant_id"]},
        )
        restaurant_rows, hours_rows, menu_rows = await asyncio.gather(
            repository.select("restaurants", {"id": claims["restaurant_id"]}),
            repository.select("hours", {"restaurant_id": claims["restaurant_id"]}),
            repository.select(
                "menu_items",
                {"restaurant_id": claims["restaurant_id"], "available": True},
            ),
        )
        prompt_sections = version.get("prompt_sections")
        if (
            not agents
            or not restaurant_rows
            or not hours_rows
            or not menu_rows
            or not isinstance(prompt_sections, dict)
            or not all(
                isinstance(key, str) and isinstance(value, str)
                for key, value in prompt_sections.items()
            )
        ):
            raise ProviderConfigError("Test-call draft is unavailable")
        restaurant = restaurant_rows[0]
        config = RuntimeConfig(
            providers=config.providers,
            restaurant={
                "id": claims["restaurant_id"],
                "name": str(restaurant["name"]),
                "timezone": str(restaurant["timezone"]),
                "enabled_languages": list(restaurant.get("enabled_languages") or []),
                "primary_language": restaurant.get("primary_language") or "en",
                "agent_version_id": str(claims["agent_version_id"]),
                "hours": {
                    str(row["weekday"]): f"{str(row['open_time'])[:5]}-{str(row['close_time'])[:5]}"
                    for row in sorted(hours_rows, key=lambda value: int(value["weekday"]))
                },
                "menu": [
                    {
                        "name": str(row["name"]),
                        "price": f"{int(row['price_cents']) / 100:.2f}",
                    }
                    for row in menu_rows
                ],
            },
        )
        run_browser_pipeline = run_webrtc_pipeline
        if browser_audio:
            from voice_receptionist_worker.pipeline.builder import run_browser_audio_pipeline
            run_browser_pipeline = run_browser_audio_pipeline
        # Only after the signed draft's agent/restaurant ownership is verified.
        # Legal settings are server-side; a failed read must not enable text logging.
        legal_rows = await repository.select(
            "legal_settings", {"restaurant_id": claims["restaurant_id"]}
        )
        async with BrowserCallLog(
            repository,
            restaurant_id=str(claims["restaurant_id"]),
            agent_version_id=str(claims["agent_version_id"]),
            pricing=config.providers.get("pricing", {}),
            transcript_enabled=bool(legal_rows and legal_rows[0].get("transcript_enabled") is True),
        ) as call_log:
            await run_browser_pipeline(
                config,
                connection,
                tool_dispatcher=_tool_dispatcher(repository, offline_queue, public_demo=browser_audio),
                database_call_id=call_log.call_id,
                # Browser testing never writes business data, even if a caller
                # accidentally supplies dry_run_tools=False to this launcher.
                dry_run_tools=True,
                prompt_sections=prompt_sections,
                call_log=call_log,
            )
    finally:
        await repository.aclose()


@app.websocket('/browser-call')
async def browser_call(websocket: WebSocket) -> None:
    """Authenticate before opening any paid speech/LLM connection.

    Browser WebSockets cannot set Authorization headers, so use a bounded first
    message, keeping tokens out of URLs/access logs. Exact Origin validation:
    https://www.starlette.io/websockets/
    """
    global _browser_demo_active_calls, _browser_demo_pending_handshakes
    origin = websocket.headers.get('origin', '')
    allowed = {value.strip() for value in os.environ.get('BROWSER_DEMO_ALLOWED_ORIGINS', '').split(',') if value.strip()}
    if not origin or origin not in allowed or _browser_demo_pending_handshakes >= 8:
        await websocket.close(code=1008)
        return
    _browser_demo_pending_handshakes += 1
    pending = True
    acquired = False
    try:
        await websocket.accept()
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=5)
        if len(raw.encode()) > 4096:
            raise ValueError('invalid handshake')
        handshake = json.loads(raw)
        if not isinstance(handshake, dict) or handshake.get('type') != 'authenticate' or not isinstance(handshake.get('token'), str):
            raise ValueError('invalid handshake')
        claims = _verify_test_call_token(f"Bearer {handshake['token']}")
        nonce = claims.get('nonce')
        if claims.get('transport') != 'browser-audio' or claims.get('origin') != origin or not isinstance(nonce, str) or str(UUID(nonce)) != nonce:
            raise ValueError('invalid claims')
        now = int(time.time())
        for used, expiration in list(_browser_demo_nonces.items()):
            if expiration <= now:
                del _browser_demo_nonces[used]
        if nonce in _browser_demo_nonces:
            raise ValueError('replayed token')
        # Atomic between awaits in this single-process Mac worker. Cap total calls
        # as well as nonce memory; no provider is instantiated on the busy path.
        if _browser_demo_active_calls >= 2 or len(_browser_demo_nonces) >= 4096:
            await websocket.send_json({'type': 'error', 'message': 'The demo is busy. Please try again shortly.'})
            await websocket.close(code=1013)
            return
        _browser_demo_nonces[nonce] = claims['exp']
        _browser_demo_active_calls += 1
        acquired = True
        _browser_demo_pending_handshakes -= 1
        pending = False
        await websocket.send_json({'type': 'ready'})
        from voice_receptionist_worker.security.browser_demo import BrowserAudioSocket
        await asyncio.wait_for(_launch_test_call_pipeline(BrowserAudioSocket(websocket), claims, dry_run_tools=True, browser_audio=True), timeout=600)
    except (HTTPException, ValueError, TypeError, KeyError, asyncio.TimeoutError):
        if websocket.application_state == WebSocketState.CONNECTED:
            await websocket.close(code=1008)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.error('Browser voice demo pipeline failed')
        if websocket.application_state == WebSocketState.CONNECTED:
            try:
                await websocket.send_json({'type': 'error', 'message': 'Voice service is unavailable. Please try again.'})
            except (WebSocketDisconnect, RuntimeError):
                pass
    finally:
        if pending:
            _browser_demo_pending_handshakes -= 1
        if acquired:
            _browser_demo_active_calls -= 1
        if websocket.application_state == WebSocketState.CONNECTED:
            try:
                await websocket.close()
            except (WebSocketDisconnect, RuntimeError):
                pass


def _track_test_call_pipeline(task: asyncio.Task[None]) -> None:
    _test_call_pipeline_tasks.add(task)

    def completed(done: asyncio.Task[None]) -> None:
        _test_call_pipeline_tasks.discard(done)
        if not done.cancelled() and done.exception() is not None:
            logger.error("WebRTC test-call pipeline failed")

    task.add_done_callback(completed)


@app.post("/webrtc/offer")
async def webrtc_offer(request: Request) -> dict[str, str]:
    secret = os.environ.get("TEST_CALL_HMAC_SECRET")
    if not secret:
        raise HTTPException(
            status_code=503,
            detail="Test-call authentication unavailable",
        )
    raw_body = await request.body()
    if len(raw_body) > 64 * 1024 or not verify_request(
        secret=secret,
        timestamp=request.headers.get("X-Timestamp", ""),
        signature=request.headers.get("X-Signature", ""),
        method=request.method,
        path=request.url.path,
        body=raw_body,
        now_seconds=int(time.time()),
    ):
        raise HTTPException(status_code=401, detail="Invalid worker request signature")
    claims = _verify_test_call_token(request.headers.get("Authorization"))
    try:
        body = json.loads(raw_body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=400, detail="Invalid WebRTC offer") from error
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid WebRTC offer")
    try:
        # Installed Pipecat 1.14.0 accepts sdp/type with optional pc_id,
        # restart_pc, and request_data and returns sdp/type/pc_id:
        # https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/transports/smallwebrtc/request_handler.py
        offer = _build_small_webrtc_request(dict(body))
    except (ImportError, TypeError) as error:
        raise HTTPException(status_code=400, detail="Invalid WebRTC offer") from error

    async def connected(connection: Any) -> None:
        task = asyncio.create_task(
            _launch_test_call_pipeline(connection, claims, dry_run_tools=True)
        )
        _track_test_call_pipeline(task)
        await asyncio.sleep(0)

    answer = await _get_small_webrtc_handler().handle_web_request(offer, connected)
    if answer is None:
        raise HTTPException(status_code=500, detail="WebRTC answer unavailable")
    return answer


@app.post("/telnyx/texml")
async def telnyx_texml(request: Request) -> Response:
    body = await request.body()
    # TeXML instruction fetches are distinct from signed event callbacks:
    # https://developers.telnyx.com/docs/voice/programmable-voice/texml-instruction-fetching
    # Default to signature verification. An explicitly configured unsigned
    # instruction URL must carry a separate strong shared secret.
    if os.environ.get("TELNYX_TEXML_REQUIRE_SIGNATURE", "true").lower() != "false":
        _verify_telnyx_signature(body, request)
    else:
        secret = os.environ.get("TELNYX_TEXML_WEBHOOK_SECRET", "")
        if len(secret) < 32:
            raise HTTPException(status_code=503, detail="TeXML authentication unavailable")
        supplied = request.query_params.get("token", "")
        if not hmac.compare_digest(secret.encode(), supplied.encode()):
            raise HTTPException(status_code=401, detail="Invalid TeXML authentication")
    try:
        runtime_config = load_runtime_config(
            PROVIDERS_CONFIG_PATH,
            DEV_RESTAURANT_CONFIG_PATH,
        )
        fallback_config = getattr(runtime_config, "restaurant", {})
        # Telnyx voice requests identify the destination as `to`; normalize the
        # TeXML form field here before resolving the persisted phone assignment.
        # https://developers.telnyx.com/docs/edge-compute/frameworks/telecom-event-processor
        form = parse_qs(body.decode("utf-8"), keep_blank_values=False)
        called_number = (form.get("To") or form.get("to") or [None])[0]
        restaurant_config = await _load_call_start_restaurant(
            called_number, fallback_config
        )
        if restaurant_config.get("kill_switch"):
            logger.warning("Forwarding call because the number kill switch is active")
            return _fallback_texml_response(restaurant_config.get("transfer_phone"))
        if _billing_blocks_agent(restaurant_config, time.time()):
            logger.warning("Forwarding call because account cannot use agent service")
            return _fallback_texml_response(restaurant_config.get("transfer_phone"))
        call_record_id = ""
        if restaurant_config.get("restaurant_id"):
            if not restaurant_config.get("agent_version_id"):
                logger.warning("Forwarding call because no agent version is published")
                return _fallback_texml_response(restaurant_config.get("transfer_phone"))
            call_sid = (form.get("CallSid") or form.get("call_sid") or [""])[0]
            caller_phone = (form.get("From") or form.get("from") or [""])[0]
            if not call_sid or not caller_phone:
                raise ProviderConfigError("Telnyx request is missing CallSid or From")
            call_record_id = await _create_call_record(
                restaurant_config, call_sid, caller_phone
            )
        websocket_secret = os.environ["WS_AUTH_SECRET"]
    except Exception:
        logger.exception("Unable to prepare Telnyx call")
        return _fallback_texml_response()

    timestamp = int(time.time())
    auth_token = _websocket_auth_token(websocket_secret, timestamp, call_record_id)
    call_query = f"&c={call_record_id}" if call_record_id else ""
    response_element = ElementTree.Element("Response")
    connect_element = ElementTree.SubElement(response_element, "Connect")
    ElementTree.SubElement(
        connect_element,
        "Stream",
        {
            "url": f"wss://{request.url.netloc}/ws?t={auth_token}{call_query}",
            # Without rtp mode Telnyx expects mp3 back, but Pipecat's Telnyx
            # serializer sends raw PCMU: bidirectionalMode attribute table at
            # https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/stream
            "bidirectionalMode": "rtp",
            "bidirectionalCodec": "PCMU",
            "bidirectionalSamplingRate": "8000",
            # Avoid reconnect/replay after intentional hang-up or transfer:
            # https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/stream
            "enableReconnect": "false",
        },
    )
    transfer_number = restaurant_config.get("transfer_phone") or os.environ.get(
        "TRANSFER_PHONE_FALLBACK"
    )
    if transfer_number:
        # TeXML executes following verbs after synchronous Connect stops. This
        # is the verified worker-side mid-call crash/transfer fallback described
        # in docs/api/telnyx/README.md (Connect + Dial references below).
        # https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/connect
        # https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/dial
        ElementTree.SubElement(response_element, "Say").text = (
            "Please hold while I transfer your call."
        )
        ElementTree.SubElement(response_element, "Dial").text = transfer_number
    return Response(
        ElementTree.tostring(response_element, encoding="unicode"),
        media_type="application/xml",
    )


async def _load_live_call_runtime(
    repository: SupabasePostgrestRepository,
    base_config: RuntimeConfig,
    call_record_id: str,
) -> tuple[RuntimeConfig, dict[str, str]]:
    """Build the per-call config from the calls row created at TeXML time."""
    call_rows = await repository.select("calls", {"id": call_record_id})
    if not call_rows:
        raise ProviderConfigError("Call record is unavailable")
    restaurant_id = call_rows[0]["restaurant_id"]
    version_rows, restaurant_rows, hours_rows, menu_rows = await asyncio.gather(
        repository.select("agent_versions", {"id": call_rows[0]["agent_version_id"]}),
        repository.select("restaurants", {"id": restaurant_id}),
        repository.select("hours", {"restaurant_id": restaurant_id}),
        repository.select(
            "menu_items", {"restaurant_id": restaurant_id, "available": True}
        ),
    )
    prompt_sections = version_rows[0].get("prompt_sections") if version_rows else None
    if (
        not restaurant_rows
        or not isinstance(prompt_sections, dict)
        or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in prompt_sections.items()
        )
    ):
        raise ProviderConfigError("Published agent is unavailable for call")
    restaurant = restaurant_rows[0]
    return (
        RuntimeConfig(
            providers=base_config.providers,
            restaurant={
                "id": restaurant_id,
                "name": str(restaurant["name"]),
                "timezone": str(restaurant["timezone"]),
                "enabled_languages": list(restaurant.get("enabled_languages") or []),
                "transfer_phone": restaurant.get("transfer_phone"),
                "hours": {
                    str(row["weekday"]): f"{str(row['open_time'])[:5]}-{str(row['close_time'])[:5]}"
                    for row in sorted(hours_rows, key=lambda value: int(value["weekday"]))
                },
                "menu": [
                    {
                        "name": str(row["name"]),
                        "price": f"{int(row['price_cents']) / 100:.2f}",
                    }
                    for row in menu_rows
                ],
            },
        ),
        prompt_sections,
    )


@app.websocket("/ws")
async def websocket_stream(websocket: WebSocket) -> None:
    call_record_id = websocket.query_params.get("c", "")
    if not _verify_websocket_auth(websocket.query_params.get("t"), call_record_id):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    repository: SupabasePostgrestRepository | None = None
    try:
        config = load_runtime_config(
            PROVIDERS_CONFIG_PATH,
            DEV_RESTAURANT_CONFIG_PATH,
        )
        transport_type, stream_info = await _parse_telnyx_websocket(websocket)
        if transport_type != "telnyx":
            raise ProviderConfigError(
                f"VERIFY provider config: expected telnyx stream, got {transport_type}"
            )
        if (
            call_record_id
            and os.environ.get("SUPABASE_URL")
            and os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        ):
            repository = SupabasePostgrestRepository(
                os.environ["SUPABASE_URL"],
                os.environ["SUPABASE_SERVICE_ROLE_KEY"],
            )
            queue_config = config.providers["resilience"]["offline_queue"]
            offline_queue = OfflineMessageQueue(
                queue_config["path"], int(queue_config["maximum_messages"])
            )
            call_config, prompt_sections = await _load_live_call_runtime(
                repository, config, call_record_id
            )
            try:
                await run_pipeline(
                    call_config,
                    websocket,
                    stream_info,
                    tool_dispatcher=_tool_dispatcher(repository, offline_queue),
                    database_call_id=call_record_id,
                    prompt_sections=prompt_sections,
                )
            finally:
                await _run_postcall_job(repository, call_config, call_record_id)
        else:
            await run_pipeline(config, websocket, stream_info)
    except Exception:
        logger.exception("WebSocket pipeline failed")
        await websocket.close(code=1011, reason="Internal server error")
    finally:
        if repository:
            await repository.aclose()
