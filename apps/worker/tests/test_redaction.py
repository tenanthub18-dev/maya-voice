import json
import logging

from voice_receptionist_worker.security.redaction import RedactingFilter, before_send, redact, redacted_logger


HOSTILE = {
    "message": "Call +14165550123 or victim@example.com",
    "name": "Jane Caller",
    "nested": {"api_key": "sk_live_secret-value", "token": "Bearer eyJhbGci.payload.signature"},
}


def test_redact_scrubs_hostile_nested_payload_without_mutating_input():
    result = redact(HOSTILE)
    serialized = json.dumps(result)
    for secret in ("14165550123", "victim@example.com", "Jane Caller", "sk_live_secret-value", "eyJhbGci"):
        assert secret not in serialized
    assert HOSTILE["nested"]["api_key"] == "sk_live_secret-value"


def test_logging_filter_and_sentry_hook_never_emit_sensitive_values():
    record = logging.LogRecord("worker", logging.ERROR, __file__, 1, "payload=%s", (HOSTILE,), None)
    assert RedactingFilter().filter(record)
    sentry_event = before_send({"extra": HOSTILE}, {})
    serialized = record.getMessage() + json.dumps(sentry_event)
    for secret in ("14165550123", "victim@example.com", "Jane Caller", "sk_live_secret-value", "eyJhbGci"):
        assert secret not in serialized


def test_production_logger_factory_attaches_the_shared_filter():
    logger = redacted_logger("voice_receptionist_worker.test")
    assert sum(isinstance(item, RedactingFilter) for item in logger.filters) == 1
    assert redacted_logger("voice_receptionist_worker.test") is logger
    assert sum(isinstance(item, RedactingFilter) for item in logger.filters) == 1
