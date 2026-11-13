from __future__ import annotations

import os

from voice_receptionist_worker.security.redaction import before_send


def sentry_options():
    dsn = os.environ.get("SENTRY_DSN")
    return {"dsn": dsn, "before_send": before_send, "send_default_pii": False} if dsn else None
