import hashlib
import hmac
import re
import time


TOLERANCE_SECONDS = 300
_SIGNATURE = re.compile(r"^sha256=([a-f0-9]{64})$")


def _canonical(*, timestamp: str, method: str, path: str, body: bytes) -> bytes:
    body_hash = hashlib.sha256(body).hexdigest()
    return f"{timestamp}\n{method.upper()}\n{path}\n{body_hash}".encode()


def sign_request(
    *, secret: str, timestamp: str, method: str, path: str, body: bytes
) -> str:
    digest = hmac.new(
        secret.encode(),
        _canonical(timestamp=timestamp, method=method, path=path, body=body),
        hashlib.sha256,
    ).hexdigest()
    return f"sha256={digest}"


def verify_request(
    *,
    secret: str,
    timestamp: str,
    signature: str,
    method: str,
    path: str,
    body: bytes,
    now_seconds: int | None = None,
) -> bool:
    if not timestamp.isascii() or not timestamp.isdigit() or len(timestamp) != 10:
        return False
    timestamp_value = int(timestamp)
    now = int(time.time()) if now_seconds is None else now_seconds
    if abs(now - timestamp_value) > TOLERANCE_SECONDS or not _SIGNATURE.fullmatch(signature):
        return False
    expected = sign_request(
        secret=secret, timestamp=timestamp, method=method, path=path, body=body
    )
    return hmac.compare_digest(expected, signature)
