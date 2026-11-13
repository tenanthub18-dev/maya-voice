"""Fixed synthetic English practice calls. List/plan are offline; AI is opt-in."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse
import wave

import httpx
import yaml

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "apps/web/tests/fixtures/voice-quality-scenarios.json"
PRIVATE = ROOT / "tmp/phone-test"
CACHE = PRIVATE / "quality-fixtures"
RATE = 16000
MAX_CLIP_SECONDS = 16
MAX_SECONDS = 120


def load_scenarios():
    return json.loads(FIXTURES.read_text())


def plan(scenario):
    maximum = scenario["lead_seconds"] + sum(
        MAX_CLIP_SECONDS + turn["pause_seconds"] for turn in scenario["turns"])
    if scenario["lead_seconds"] != 8 or maximum > MAX_SECONDS or any(
            not 10 <= turn["pause_seconds"] <= 12 for turn in scenario["turns"]):
        raise ValueError("Scenario exceeds timing bounds")
    return {**scenario, "max_seconds": maximum, "manual_review": {
        "status": "pending", "checkpoints": scenario["manual_checkpoints"]}}


def speech_spec(text, language, providers):
    rate = providers["greeting"]["sample_rate"]
    if rate != RATE:
        raise ValueError("Quality fixtures require configured 16000 Hz PCM")
    return {"text": text, "model": providers["tts"]["model"],
            "voice": providers["tts"]["voice"], "language": language, "sample_rate": rate}


def cache_key(spec):
    return hashlib.sha256(json.dumps(spec, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def fixture_path(scenario, providers, directory):
    identity = {"lead_seconds": scenario["lead_seconds"], "turns": [
        {"speech": speech_spec(turn["text"], scenario["language"], providers),
         "pause_seconds": turn["pause_seconds"]} for turn in scenario["turns"]]}
    return directory / (cache_key(identity) + ".wav")


def read_wav(path, max_seconds):
    if path.is_symlink() or path.stat().st_size > RATE * 2 * max_seconds + 44:
        raise ValueError("Invalid cached WAV size or path; prepare again")
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError("Cached WAV must be private (0600)")
    with wave.open(str(path), "rb") as source:
        frames = source.getnframes()
        if (source.getframerate(), source.getnchannels(), source.getsampwidth(), source.getcomptype()) != (
                RATE, 1, 2, "NONE") or not 0 < frames <= RATE * max_seconds:
            raise ValueError("Invalid cached WAV format or duration; prepare again")
        pcm = source.readframes(frames)
    if len(pcm) != frames * 2:
        raise ValueError("Truncated cached WAV; prepare again")
    return pcm


def write_wav(path, pcm):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), 0o600)
            with wave.open(output, "wb") as audio:
                audio.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
                audio.writeframes(pcm)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def generate_pcm(spec, endpoint, api_key, client):
    # Same contract as installed worker pipeline/greeting_cache.py; no new SDK.
    # https://docs.soniox.com/tts/rest-api/generate-speech
    deadline = time.monotonic() + 25
    for attempt in range(2):
        retry_delay = None
        with client.stream("POST", endpoint, headers={"Authorization": "Bearer " + api_key},
                           json={**spec, "audio_format": "pcm_s16le"},
                           timeout=httpx.Timeout(20, read=5)) as response:
            if response.status_code == 429 and attempt == 0:
                try:
                    retry_delay = min(2, max(0, float(response.headers.get("retry-after", "1"))))
                except ValueError:
                    retry_delay = 1
            else:
                if response.status_code != 200 or response.headers.get("content-type", "").split(";")[0] != "audio/pcm":
                    raise ValueError("TTS failed; no provider body retained")
                pcm = bytearray()
                for chunk in response.iter_bytes(chunk_size=4096):
                    if time.monotonic() > deadline or len(pcm) + len(chunk) > RATE * 2 * MAX_CLIP_SECONDS:
                        raise ValueError("TTS response exceeds duration, byte or time bound")
                    pcm.extend(chunk)
                if not pcm or len(pcm) % 2:
                    raise ValueError("TTS returned empty or malformed PCM")
                return bytes(pcm)
        if time.monotonic() + retry_delay >= deadline:
            raise ValueError("TTS retry exceeds time bound")
        time.sleep(retry_delay)
    raise ValueError("TTS retry exhausted")


def prepare(scenario, providers, env, directory=CACHE, *, client=None):
    plan(scenario)
    destination = fixture_path(scenario, providers, directory)
    if destination.exists():
        read_wav(destination, MAX_SECONDS)
        return destination
    if client is None:
        with httpx.Client(follow_redirects=False, trust_env=False) as owned:
            return prepare(scenario, providers, env, directory, client=owned)
    endpoint = providers["greeting"]["endpoint"]
    parsed = urlparse(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Configured TTS endpoint must be HTTPS without credentials")
    pieces = [b"\0\0" * (RATE * scenario["lead_seconds"])]
    for turn in scenario["turns"]:  # Sequential requests only; cached clips require no AI.
        spec = speech_spec(turn["text"], scenario["language"], providers)
        clip = directory / (cache_key(spec) + ".wav")
        if not clip.exists():
            if not env.get("SONIOX_API_KEY"):
                raise ValueError("TTS credential missing from local environment")
            write_wav(clip, generate_pcm(spec, endpoint, env["SONIOX_API_KEY"], client))
        pieces.extend([read_wav(clip, MAX_CLIP_SECONDS), b"\0\0" * (RATE * turn["pause_seconds"])])
    pcm = b"".join(pieces)
    if len(pcm) > RATE * 2 * MAX_SECONDS:
        raise ValueError("Combined scenario exceeds 120 seconds")
    write_wav(destination, pcm)
    return destination


def runtime_environment(runtime):
    # Existing launcher merges shell, dotenv and private runtime env in that order.
    path = Path(runtime)
    if (path.resolve() != (PRIVATE / "runtime.json").resolve() or path.is_symlink()
            or not path.is_file() or stat.S_IMODE(path.stat().st_mode) != 0o600):
        raise ValueError("Use the existing private runtime tmp/phone-test/runtime.json (0600)")
    spec = importlib.util.spec_from_file_location("quality_local", ROOT / "scripts/dev/phone-test/local.py")
    local = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(local)
    return local.environment(json.loads(path.read_text()))


def validate_report_name(report):
    if report.lower() == "runtime.json":
        raise ValueError("runtime.json is a reserved report filename")
    if not re.fullmatch(r"[a-zA-Z0-9_-]+\.json", report):
        raise ValueError("Use a simple report filename")


def run(scenario, providers, directory, base, report):
    validate_report_name(report)
    plan(scenario)
    path = fixture_path(scenario, providers, directory)
    if not path.exists():
        raise ValueError("Missing fixture; explicitly --prepare this scenario first")
    pcm = read_wav(path, MAX_SECONDS)
    duration = math.ceil(len(pcm) / (RATE * 2))
    if not 15 <= duration <= MAX_SECONDS:
        raise ValueError("Prepared scenario duration must be 15 to 120 seconds")
    subprocess.run(["node", str(ROOT / "apps/web/tests/live/call-history-check.mjs"),
                    base, str(path), str(duration)], cwd=ROOT, check=True, timeout=300,
                   env={**os.environ, "CALL_QA_SCENARIO": scenario["id"], "CALL_QA_REPORT": report})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--list", action="store_true")
    for action in ("plan", "prepare", "run"):
        actions.add_argument("--" + action, metavar="ID")
    parser.add_argument("--allow-ai", action="store_true", help="Explicit opt-in to billed provider use")
    parser.add_argument("--runtime", type=Path, help="Existing private tmp/phone-test/runtime.json")
    parser.add_argument("--base-url", default="http://localhost:3101")
    parser.add_argument("--report", help="Private report basename (default: quality-ID.json)")
    args = parser.parse_args(argv)
    try:
        scenarios = load_scenarios()
        if args.list:
            print(json.dumps({key: value["name"] for key, value in scenarios.items()}, indent=2))
            return 0
        scenario = scenarios.get(args.plan or args.prepare or args.run)
        if scenario is None:
            raise ValueError("Unknown scenario; use --list")
        if args.plan:
            print(json.dumps(plan(scenario), indent=2))
            return 0
        if not args.allow_ai or args.runtime is None:
            raise ValueError("AI use requires --allow-ai and explicit --runtime for the private runtime")
        report = args.report or "quality-" + scenario["id"] + ".json"
        validate_report_name(report)
        env = runtime_environment(args.runtime)
        providers = yaml.safe_load((ROOT / "config/providers.yaml").read_text())
        if args.prepare:
            print(prepare(scenario, providers, env))
        else:
            run(scenario, providers, CACHE, args.base_url, report)
        return 0
    except (ValueError, KeyError, OSError, wave.Error, httpx.HTTPError, yaml.YAMLError,
            subprocess.SubprocessError):
        # Never print exception text: it may contain URLs, headers or private state.
        print("Quality tool stopped: check scenario, prepared fixtures, opt-in and private runtime (0600).", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
