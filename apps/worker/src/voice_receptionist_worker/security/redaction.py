from __future__ import annotations

import copy
import logging
import re
from collections.abc import Mapping
from typing import Any

REDACTED = "[REDACTED]"
SENSITIVE_KEY = re.compile(r"^(?:name|first_?name|last_?name|full_?name|caller_?name|token|access_?token|refresh_?token|authorization|api_?key|secret|password)$", re.I)
E164 = re.compile(r"\+[1-9]\d{7,14}\b")
EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", re.I)
KEY_VALUE = re.compile(r"\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+\b")
SECRET_ASSIGNMENT = re.compile(r"\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+", re.I)


def _scrub_string(value: str) -> str:
    for pattern in (E164, EMAIL, BEARER, KEY_VALUE):
        value = pattern.sub(REDACTED, value)
    return SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}={REDACTED}", value)


def redact(value: Any, key: str = "") -> Any:
    if SENSITIVE_KEY.fullmatch(key):
        return REDACTED
    if isinstance(value, str):
        return _scrub_string(value)
    if isinstance(value, Mapping):
        return {child_key: redact(child, str(child_key)) for child_key, child in value.items()}
    if isinstance(value, tuple):
        return tuple(redact(child) for child in value)
    if isinstance(value, list):
        return [redact(child) for child in value]
    return copy.deepcopy(value)


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.msg)
        record.args = redact(record.args)
        for key, value in tuple(record.__dict__.items()):
            if key not in logging.LogRecord("", 0, "", 0, "", (), None).__dict__:
                record.__dict__[key] = redact(value, key)
        return True


def before_send(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any]:
    return redact(event)


def configure_logging_redaction() -> None:
    root = logging.getLogger()
    if not any(isinstance(item, RedactingFilter) for item in root.filters):
        root.addFilter(RedactingFilter())


def redacted_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if not any(isinstance(item, RedactingFilter) for item in logger.filters):
        logger.addFilter(RedactingFilter())
    return logger
