import json
from pathlib import Path

from voice_receptionist_worker.security.hmac import sign_request, verify_request


FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "packages/shared/fixtures/worker-hmac.json")
    .read_text(encoding="utf-8")
)


def test_worker_hmac_matches_shared_typescript_fixture() -> None:
    signature = sign_request(
        secret=FIXTURE["secret_utf8"],
        timestamp=FIXTURE["timestamp"],
        method=FIXTURE["method"],
        path=FIXTURE["path"],
        body=FIXTURE["body_utf8"].encode(),
    )
    assert signature == f"sha256={FIXTURE['signature_hex']}"


def test_worker_hmac_enforces_replay_window_and_request_binding() -> None:
    values = {
        "secret": FIXTURE["secret_utf8"],
        "timestamp": FIXTURE["timestamp"],
        "signature": f"sha256={FIXTURE['signature_hex']}",
        "method": FIXTURE["method"],
        "path": FIXTURE["path"],
        "body": FIXTURE["body_utf8"].encode(),
    }
    assert verify_request(**values, now_seconds=1_700_000_300)
    assert not verify_request(**values, now_seconds=1_700_000_301)
    assert not verify_request(**{**values, "body": values["body"] + b" "}, now_seconds=1_700_000_000)
