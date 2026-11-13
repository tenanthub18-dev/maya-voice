"""Offline tool tests; provider I/O is intercepted at httpx's transport boundary."""
import importlib.util
import json
import stat
import subprocess
import wave
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def quality():
    path = ROOT / "scripts/dev/voice-test/quality_scenarios.py"
    assert path.exists(), "Offline quality scenario CLI is missing"
    spec = importlib.util.spec_from_file_location("quality_scenarios", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def providers():
    return {"tts": {"model": "configured-model", "voice": "configured-voice"},
            "greeting": {"endpoint": "https://tts.invalid/tts", "sample_rate": 16000}}


def test_list_and_plan_do_not_read_runtime_secrets_or_start_io(quality, monkeypatch, capsys):
    def forbidden(*args, **kwargs):
        pytest.fail("Offline command touched secrets, network, or subprocess")
    monkeypatch.setattr(quality, "runtime_environment", forbidden)
    monkeypatch.setattr(httpx.Client, "send", forbidden)
    monkeypatch.setattr(subprocess, "run", forbidden)
    assert quality.main(["--list"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert set(listed) == {"order-correction", "menu-recommendation"}
    for scenario_id in listed:
        assert quality.main(["--plan", scenario_id]) == 0
        plan = json.loads(capsys.readouterr().out)
        assert plan["lead_seconds"] == 8
        assert plan["max_seconds"] <= 120
        assert all(10 <= turn["pause_seconds"] <= 12 for turn in plan["turns"])
        assert plan["manual_review"]["status"] == "pending"


def test_scenario_price_references_match_sourced_pilot(quality):
    manifest = json.loads((ROOT / "config/pilots/barbq-tonite-dixie.json").read_text())
    prices = {item["name"]: item["price_cents"] for item in manifest["menu"]}
    for scenario in quality.load_scenarios().values():
        assert scenario["caller_anchor"].lower() in scenario["turns"][0]["text"].lower()
        for item in scenario["price_references"]:
            assert prices[item["name"]] == item["price_cents"]
        assert len(scenario["manual_checkpoints"]) >= 4


def test_cache_identity_changes_for_every_speech_input(quality, providers):
    original = quality.speech_spec("Hello", "en", providers)
    key = quality.cache_key(original)
    assert len(key) == 64
    for field, value in [("text", "Goodbye"), ("model", "other-model"),
                         ("voice", "other-voice"), ("language", "fr"), ("sample_rate", 24000)]:
        assert quality.cache_key({**original, field: value}) != key


def test_prepare_is_sequential_private_and_reuses_cached_wav(quality, providers, tmp_path):
    scenario = quality.load_scenarios()["order-correction"]
    seen = []
    def respond(request):
        payload = json.loads(request.content)
        seen.append(payload)
        assert payload["audio_format"] == "pcm_s16le"
        assert payload["model"] == "configured-model"
        assert payload["voice"] == "configured-voice"
        assert payload["sample_rate"] == 16000
        return httpx.Response(200, headers={"Content-Type": "audio/pcm"}, content=b"\x01\x00" * 16000)
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        path = quality.prepare(scenario, providers, {"SONIOX_API_KEY": "test-only"}, tmp_path, client=client)
        assert len(seen) == 4
        assert quality.prepare(scenario, providers, {}, tmp_path, client=client) == path
        assert len(seen) == 4
    with wave.open(str(path), "rb") as audio:
        assert (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) == (16000, 1, 2)
        assert audio.getnframes() / 16000 == 60  # 8 + four one-second clips + four 12s pauses.
    assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in tmp_path.iterdir())


@pytest.mark.parametrize("pcm", [b"", b"x", b"\0\0" * (16000 * 16 + 1)], ids=["empty", "odd", "overlong"])
def test_bad_or_overlong_provider_audio_never_becomes_a_fixture(quality, providers, tmp_path, pcm):
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(
            200, headers={"Content-Type": "audio/pcm"}, content=pcm))) as client:
        with pytest.raises(ValueError):
            quality.prepare(quality.load_scenarios()["order-correction"], providers,
                            {"SONIOX_API_KEY": "test-only"}, tmp_path, client=client)
    assert not list(tmp_path.glob("*.wav"))


def test_rate_limit_retry_is_bounded_and_other_errors_are_not_retried(quality, providers, tmp_path, monkeypatch):
    delays = []
    monkeypatch.setattr(quality.time, "sleep", delays.append)
    for status, expected in [(429, 2), (500, 1)]:
        requests = []
        def respond(request):
            requests.append(request)
            return httpx.Response(status, headers={"Retry-After": "999"}, content=b"private provider body")
        with httpx.Client(transport=httpx.MockTransport(respond)) as client:
            with pytest.raises(ValueError, match="TTS") as error:
                quality.prepare(quality.load_scenarios()["order-correction"], providers,
                                {"SONIOX_API_KEY": "test-only"}, tmp_path, client=client)
        assert len(requests) == expected
        assert "private provider body" not in str(error.value)
    assert delays == [2]


def test_run_requires_prepared_audio_and_never_generates(quality, providers, tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Run implicitly generated audio or started an unprepared call")
    monkeypatch.setattr(quality, "prepare", forbidden)
    monkeypatch.setattr(subprocess, "run", forbidden)
    with pytest.raises(ValueError, match="prepare"):
        quality.run(quality.load_scenarios()["order-correction"], providers, tmp_path,
                    "http://localhost:3101", "quality.json")


@pytest.mark.parametrize("report", ["quality-test.json", "call-usage-live.json",
                                    "quality-menu-recommendation-final.json", "Runtime-results_1.json"])
def test_run_uses_argument_list_and_actual_wav_duration(quality, providers, tmp_path, monkeypatch, report):
    scenario = quality.load_scenarios()["menu-recommendation"]
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(
            200, headers={"Content-Type": "audio/pcm"}, content=b"\0\0" * 16000))) as client:
        path = quality.prepare(scenario, providers, {"SONIOX_API_KEY": "test-only"}, tmp_path, client=client)
    invocations = []
    monkeypatch.setattr(subprocess, "run", lambda args, **kwargs: invocations.append((args, kwargs)))
    base = "http://localhost:3101/?literal=$(false);&x=test"
    quality.run(scenario, providers, tmp_path, base, report)
    args, kwargs = invocations[0]
    assert args == ["node", str(ROOT / "apps/web/tests/live/call-history-check.mjs"), base, str(path), "60"]
    assert kwargs.get("shell", False) is False
    assert kwargs["env"]["CALL_QA_SCENARIO"] == "menu-recommendation"
    assert kwargs["env"]["CALL_QA_REPORT"] == report
    assert kwargs["timeout"] <= 300
    with pytest.raises(ValueError):
        quality.run(scenario, providers, tmp_path, base, "../unsafe.json")


@pytest.mark.parametrize("report", ["runtime.json", "Runtime.JSON", "RUNTIME.json"])
def test_reserved_report_stops_run_and_cli_before_any_io(
        quality, providers, tmp_path, monkeypatch, report):
    scenario = quality.load_scenarios()["menu-recommendation"]
    monkeypatch.setattr(quality, "PRIVATE", tmp_path)
    monkeypatch.setattr(quality, "CACHE", tmp_path / "quality-fixtures")
    runtime = tmp_path / "runtime.json"
    original = b'{"sentinel":"synthetic private runtime"}\n'
    runtime.write_bytes(original)
    runtime.chmod(0o600)

    def forbidden(*args, **kwargs):
        pytest.fail("Reserved report reached runtime, fixture, provider or subprocess I/O")
    monkeypatch.setattr(quality, "runtime_environment", forbidden)
    monkeypatch.setattr(quality, "fixture_path", forbidden)
    monkeypatch.setattr(quality, "prepare", forbidden)
    monkeypatch.setattr(httpx.Client, "send", forbidden)
    monkeypatch.setattr(subprocess, "run", forbidden)
    with pytest.raises(ValueError):
        quality.run(scenario, providers, quality.CACHE, "http://localhost:3101", report)
    assert quality.main(["--run", scenario["id"], "--allow-ai", "--runtime", str(runtime),
                         "--report", report]) == 1
    assert runtime.read_bytes() == original
    assert stat.S_IMODE(runtime.stat().st_mode) == 0o600
    assert list(tmp_path.iterdir()) == [runtime]


def test_js_reserved_report_validation_and_entrypoint_are_offline(tmp_path):
    # Use an isolated copy so even a regressed entrypoint cannot touch real runtime.
    runner = tmp_path / "apps/web/tests/live/call-history-check.mjs"
    runner.parent.mkdir(parents=True)
    runner.write_bytes((ROOT / "apps/web/tests/live/call-history-check.mjs").read_bytes())
    private = tmp_path / "tmp/phone-test"
    private.mkdir(parents=True)
    runtime = private / "runtime.json"
    original = b'{"sentinel":"synthetic private runtime"}\n'
    runtime.write_bytes(original)
    runtime.chmod(0o600)
    script = """
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import module from 'node:module';
      import childProcess from 'node:child_process';
      import {fileURLToPath, pathToFileURL} from 'node:url';
      const runner = process.argv[1];
      const url = pathToFileURL(runner).href;
      const effects = [];
      const forbidden = (name) => () => {
        effects.push(name);
        throw new Error(`Forbidden ${name}`);
      };
      const source = fs.readFileSync(runner);
      fs.readFileSync = (path) => {
        // Node's loader may read the isolated source via this same builtin.
        if ((path instanceof URL ? fileURLToPath(path) : String(path)) === runner) {
          return source;
        }
        return forbidden('runtime/fixture read')();
      };
      fs.openSync = forbidden('report write');
      module.createRequire = forbidden('browser setup');
      childProcess.spawn = forbidden('subprocess spawn');
      childProcess.exec = forbidden('subprocess exec');
      globalThis.fetch = forbidden('provider fetch');
      module.syncBuiltinESMExports();
      delete process.env.CALL_QA_SCENARIO;
      for (const [index, name] of ['runtime.json', 'Runtime.JSON', 'RUNTIME.json'].entries()) {
        process.env.CALL_QA_REPORT = name;
        await assert.rejects(import(`${url}?entry=${index}`), /reserved/i);
      }
      // Import-only exposes the pure validator without executing a call.
      process.argv[1] = 'offline-validator';
      const {validateReportName} = await import(url);
      for (const name of ['runtime.json', 'Runtime.JSON', 'RUNTIME.json']) {
        assert.throws(() => validateReportName(name), /reserved/i);
      }
      for (const name of ['call-usage-live.json', 'quality-test.json',
                          'quality-menu-recommendation-final.json', 'Runtime-results_1.JSON']) {
        assert.doesNotThrow(() => validateReportName(name));
      }
      for (const name of ['../unsafe.json', '/tmp/report.json', 'report.txt']) {
        assert.throws(() => validateReportName(name));
      }
      assert.deepEqual(effects, []);
    """
    result = subprocess.run(["node", "--input-type=module", "-e", script, str(runner)],
                            cwd=tmp_path, capture_output=True, text=True, timeout=20)
    # Check preservation even when the Node assertions fail.
    assert runtime.read_bytes() == original
    assert stat.S_IMODE(runtime.stat().st_mode) == 0o600
    assert list(private.iterdir()) == [runtime]
    assert result.returncode == 0, result.stderr


def test_ai_commands_require_opt_in_and_private_explicit_runtime(quality, capsys):
    assert quality.main(["--prepare", "order-correction"]) == 1
    assert quality.main(["--run", "order-correction"]) == 1
    assert "private runtime" in capsys.readouterr().err


def test_corrupt_prepared_wav_is_rejected_without_subprocess(quality, providers, tmp_path, monkeypatch):
    scenario = quality.load_scenarios()["order-correction"]
    path = quality.fixture_path(scenario, providers, tmp_path)
    quality.write_wav(path, b"\0\0" * 16000 * 121)
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: pytest.fail("Invalid fixture ran"))
    with pytest.raises(ValueError, match="size"):
        quality.run(scenario, providers, tmp_path, "http://localhost:3101", "quality.json")


def test_prepare_rejects_public_runtime_before_reading_it(quality, tmp_path, monkeypatch):
    monkeypatch.setattr(quality, "PRIVATE", tmp_path)
    runtime = tmp_path / "runtime.json"
    runtime.write_text("not even valid JSON")
    runtime.chmod(0o644)
    with pytest.raises(ValueError, match="private runtime"):
        quality.runtime_environment(runtime)


def test_provider_wall_time_is_bounded(quality, providers, monkeypatch):
    times = iter([0, 26])
    monkeypatch.setattr(quality.time, "monotonic", lambda: next(times))
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(
            200, headers={"Content-Type": "audio/pcm"}, content=b"\0\0" * 16000))) as client:
        with pytest.raises(ValueError, match="time bound"):
            quality.generate_pcm(quality.speech_spec("Hello", "en", providers),
                                 providers["greeting"]["endpoint"], "test-only", client)


def test_js_correlation_ignores_newest_unrelated_and_agent_only_anchor():
    # Importing these pure helpers must not read runtime or start Playwright/fetch.
    script = """
      import assert from 'node:assert/strict';
      import {loadScenario, correlateScenarioCall, scenarioReview} from './apps/web/tests/live/call-history-check.mjs';
      assert.throws(() => loadScenario('unknown'), /Unknown/);
      const scenario = loadScenario('order-correction');
      const calls = [{id: 'other', source: 'browser'}, {id: 'mine', source: 'browser'},
                     {id: 'old', source: 'browser'}, {id: 'phone', source: 'phone'}];
      const turns = {
        other: [{speaker: 'agent', text: scenario.caller_anchor}, {speaker: 'caller', text: 'Unrelated caller'}],
        mine: [{speaker: 'caller', text: scenario.caller_anchor.toUpperCase().replaceAll(' ', ', ')}],
        old: [{speaker: 'caller', text: scenario.caller_anchor}],
        phone: [{speaker: 'caller', text: scenario.caller_anchor}],
      };
      assert.equal(correlateScenarioCall(calls, new Set(['old']), turns, scenario).id, 'mine');
      assert.equal(correlateScenarioCall([calls[0]], new Set(), turns, scenario), undefined);
      turns.other = turns.mine;
      assert.throws(() => correlateScenarioCall(calls, new Set(['old']), turns, scenario), /Ambiguous/);
      const review = scenarioReview(scenario, turns.mine);
      assert.equal(review.status, 'pending');
      assert.deepEqual(review.syntheticTranscript, turns.mine);
      assert.equal(review.manualCheckpoints.length, scenario.manual_checkpoints.length);
    """
    result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
