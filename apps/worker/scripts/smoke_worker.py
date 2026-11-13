"""Smoke-check a deployed worker before the first real Telnyx call.

Usage: uv run python scripts/smoke_worker.py https://<worker-host> [+1CalledNumber]

Checks /healthz, then POSTs a TeXML request and verifies the Connect/Stream
element the caller's audio depends on. The TeXML check needs the worker to run
with TELNYX_TEXML_REQUIRE_SIGNATURE=false (we cannot sign as Telnyx); it is
skipped, not failed, when the worker answers 401 or 503.
"""

import sys
from xml.etree import ElementTree

import httpx

# Telnyx Stream attribute table:
# https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/stream
EXPECTED_STREAM_ATTRIBUTES = {
    "bidirectionalMode": "rtp",
    "bidirectionalCodec": "PCMU",
    "bidirectionalSamplingRate": "8000",
}


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    base = sys.argv[1].rstrip("/")
    called_number = sys.argv[2] if len(sys.argv) > 2 else "+16475550100"
    failures = 0

    health = httpx.get(f"{base}/healthz", timeout=10)
    checks = health.json().get("checks", {})
    print(f"healthz {health.status_code}: {checks}")
    if health.status_code != 200 or any(value != "reachable" for value in checks.values()):
        failures += 1

    texml = httpx.post(
        f"{base}/telnyx/texml",
        data={"CallSid": "smoke-test", "From": "+14165550100", "To": called_number},
        timeout=15,
    )
    if texml.status_code in (401, 503):
        print(f"texml skipped ({texml.status_code}): signature enforcement is on")
        return 1 if failures else 0
    stream = ElementTree.fromstring(texml.text).find("./Connect/Stream")
    if stream is None:
        print(f"texml FAIL: no Connect/Stream, got: {texml.text}")
        return 1
    for name, expected in EXPECTED_STREAM_ATTRIBUTES.items():
        if stream.attrib.get(name) != expected:
            print(f"texml FAIL: {name}={stream.attrib.get(name)!r}, expected {expected!r}")
            failures += 1
    print(f"texml {texml.status_code}: stream url scheme={stream.attrib['url'].split(':')[0]}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
