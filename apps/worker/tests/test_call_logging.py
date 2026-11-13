"""Browser accounting boundaries; all provider/DB substitutes live in tests."""
import asyncio
import copy
import importlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4
import warnings

import pytest
import yaml

with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    from pipecat.frames.frames import (
        BotStoppedSpeakingFrame, ErrorFrame, InterruptionFrame, InterimTranscriptionFrame,
        LLMTextFrame, MetricsFrame, TTSAudioRawFrame, TTSTextFrame, TranscriptionFrame,
    )
    from pipecat.metrics.metrics import LLMTokenUsage, LLMUsageMetricsData, STTUsage, STTUsageMetricsData, TTSUsageMetricsData
    from pipecat.observers.base_observer import FramePushed
    from pipecat.processors.frame_processor import FrameDirection
    from pipecat.transcriptions.language import Language

ROOT = Path(__file__).resolve().parents[3]


def module():
    name = "voice_receptionist_worker.call_logging"
    assert importlib.util.find_spec(name), "Real browser call logging has not been implemented"
    return importlib.import_module(name)


def pricing():
    return yaml.safe_load((ROOT / "config/providers.yaml").read_text()).get("pricing", {})


class Repository:
    def __init__(self):
        self.tables = {"calls": [], "call_turns": [], "call_metrics": []}
        self.writes = []
        self.fail_insert = False
        self.fail_update = False
        self.block_update = None

    async def insert(self, table, row):
        if self.fail_insert:
            raise RuntimeError("secret transcript credential should never escape")
        record = copy.deepcopy(dict(row))
        record.setdefault("id", str(uuid4()))
        self.tables.setdefault(table, []).append(record)
        self.writes.append((table, copy.deepcopy(record)))
        return copy.deepcopy(record)

    async def select(self, table, filters=None):
        return copy.deepcopy([row for row in self.tables.get(table, []) if all(row.get(k) == v for k, v in (filters or {}).items())])

    async def update(self, table, filters, values):
        if self.block_update:
            await self.block_update.wait()
        if self.fail_update:
            raise RuntimeError("secret transcript credential should never escape")
        row = next(r for r in self.tables[table] if all(r.get(k) == v for k, v in filters.items()))
        row.update(copy.deepcopy(values))
        self.writes.append((table, copy.deepcopy(values)))
        return copy.deepcopy(row)


def log_for(repo, **kwargs):
    return module().BrowserCallLog(repo, restaurant_id="restaurant-a", agent_version_id="version-a", pricing=pricing(), **kwargs)


def event(frame, source=None, *, first=True):
    return FramePushed(source=source, destination=None, frame=frame, direction=FrameDirection.DOWNSTREAM, timestamp=1_000_000_000, first_push=first)


async def push(observers, frame, source=None, *, first=True):
    for observer in observers:
        await observer.on_push_frame(event(frame, source, first=first))


def llm_metric(model="gpt-4.1-mini", **usage):
    return MetricsFrame(data=[LLMUsageMetricsData(processor="llm", model=model, value=LLMTokenUsage(prompt_tokens=1000, completion_tokens=200, total_tokens=1200, cache_read_input_tokens=400, **usage))])


@pytest.mark.parametrize("model,cost", [("gpt-4.1-mini", 600), ("gpt-4.1", 3000), ("gpt-4.1-mini-2025-04-14", 600), ("gpt-4.1-2025-04-14", 3000)])
def test_cache_aware_actual_model_pricing(model, cost):
    async def exercise():
        repo = Repository()
        async with log_for(repo) as log:
            observers = log.observers(output=None, speech=None)
            frame = llm_metric(model)
            await push(observers, frame)
            await push(observers, frame, first=False)  # Same metrics passing another processor.
        row = repo.tables["calls"][0]
        assert row["cost_micros"] == {"llm": cost}
        assert row["usage"]["totals"]["prompt_tokens"] == 1000
        assert row["usage"]["totals"]["completion_tokens"] == 200
        assert row["usage"]["totals"]["cache_read_input_tokens"] == 400
        assert row["usage"]["cost_status"] == "partial"  # No speech reports.
        assert row["usage"]["services"][0]["model"] == model
        assert row["usage"]["currency"] == "USD"
    asyncio.run(exercise())


@pytest.mark.filterwarnings("ignore:`AudioContextTTSService` is deprecated.*:DeprecationWarning")
@pytest.mark.parametrize("initial_language", ["en", "fr-CA", "en-IN"])
def test_sentence_soniox_websocket_languages_survive_delayed_playback_and_observer(
    initial_language, monkeypatch,
):
    """Exercise installed 1.14 Soniox I/O; substitute only its websocket boundary.

    Contract inspected offline in pipecat/services/soniox/tts.py:
    https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/soniox/tts.py
    https://soniox.com/docs/api-reference/tts/websocket-api
    """
    import base64
    import json

    from websockets.protocol import State
    from pipecat.frames.frames import (
        EndFrame, LLMContextFrame, TTSSpeakFrame, TTSStartedFrame, TTSStoppedFrame,
    )
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineParams, PipelineWorker
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.frame_processor import FrameProcessor
    from pipecat.services.openai.llm import OpenAILLMService
    from pipecat.services.soniox.tts import SonioxTTSService
    from pipecat.services.tts_service import TextAggregationMode
    from pipecat.workers.runner import WorkerRunner
    from voice_receptionist_worker.resilience.runtime import (
        ResponseLanguageTTSMixin, TTSLanguageProcessor, bind_response_language,
    )

    async def exercise():
        latest_changed = asyncio.Event()
        release_audio = asyncio.Event()
        release_observer = asyncio.Event()
        generated, changed, emitted, played = [], [], [], []
        texts = {"ur": "جی ضرور seventeen dollars.", "hi": "ज़रूर seventeen dollars.",
                 "te": "ధర seventeen dollars."}
        greeting = "Welcome seventeen dollars."

        class SonioxSocket:
            """Protocol peer: real send JSON in, real receive JSON out, no services."""
            state = State.OPEN

            def __init__(self):
                self.sent, self.received, self.violations = [], [], []
                self.configs, self.chunks, self.pcm = {}, {}, {}
                self.text_ended, self.terminated = [], []
                self.incoming = asyncio.Queue()
                self.previous = None
                self.closed = False

            async def send(self, payload):
                msg = json.loads(payload)
                self.sent.append(msg)
                if msg.get("keep_alive"):
                    return
                sid = msg["stream_id"]
                if "model" in msg:
                    if sid in self.configs:
                        self.violations.append("duplicate stream config")
                    self.configs[sid] = msg
                    self.chunks[sid] = []
                elif msg.get("cancel"):
                    # The real Soniox lifecycle cancels eagerly opened empty turns.
                    self.incoming.put_nowait({"stream_id": sid, "terminated": True})
                else:
                    if sid not in self.configs or sid in self.text_ended:
                        self.violations.append("text outside configured open stream")
                    if msg["text_end"]:
                        self.text_ended.append(sid)
                        text = "".join(self.chunks[sid]).rstrip()
                        # Split inside the first word; terminated must flush the
                        # final word because there is no trailing timestamp space.
                        split = max(1, len(text.split()[0]) // 2)
                        audio = [bytes([len(self.text_ended), part]) * 240
                                 for part in (1, 2)]
                        self.pcm[sid] = audio
                        for part, chars in enumerate((text[:split], text[split:])):
                            offset = 0 if part == 0 else split
                            self.incoming.put_nowait({
                                "stream_id": sid,
                                "audio": base64.b64encode(audio[part]).decode("ascii"),
                                "timestamps": {
                                    "characters": list(chars),
                                    "character_start_times_seconds": [
                                        (offset + i) * .0001 for i in range(len(chars))],
                                },
                            })
                        self.incoming.put_nowait({"stream_id": sid, "audio_end": True})
                        self.incoming.put_nowait({"stream_id": sid, "terminated": True})
                        if len(self.text_ended) == 4:
                            release_audio.set()
                    else:
                        self.chunks[sid].append(msg["text"])

            def __aiter__(self):
                return self

            async def __anext__(self):
                await release_audio.wait()
                # Re-entering the iterator proves the real receive loop has
                # finished processing the previous message, without sleeps.
                if self.previous:
                    sid = self.previous["stream_id"]
                    if self.previous.get("audio_end") and not tts.audio_context_available(sid):
                        self.violations.append("audio_end prematurely closed context")
                    if self.previous.get("terminated"):
                        self.terminated.append(sid)
                        if sid in tts._configured_contexts or sid in tts._partials:
                            self.violations.append("terminated retained provider state")
                msg = await self.incoming.get()
                self.received.append(msg)
                self.previous = msg
                return json.dumps(msg)

            async def close(self):
                self.closed = True
                self.state = State.CLOSED

        socket = SonioxSocket()

        class Requests(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, TranscriptionFrame):
                    frame = LLMContextFrame(LLMContext())
                await self.push_frame(frame, direction)

        class OfflineLLM(OpenAILLMService):
            async def _process_context(self, context):
                code = self.settings.system_instruction.rsplit("=", 1)[-1]
                await latest_changed.wait()
                generated.append(code)
                # Actual sentence aggregation, rather than prebuilt TTS frames.
                for part in texts[code].split(" "):
                    await self.push_frame(LLMTextFrame(part + " "))

        class SentenceTTS(ResponseLanguageTTSMixin, SonioxTTSService):
            pass

        class BufferedOutput(FrameProcessor):
            def __init__(self):
                super().__init__()
                self.buffer, self.stopped = [], []

            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, (TTSStartedFrame, TTSAudioRawFrame, TTSTextFrame, TTSStoppedFrame)):
                    self.buffer.append(frame)
                    if isinstance(frame, TTSStoppedFrame):
                        self.stopped.append(frame.context_id)
                        if len(self.stopped) == 4:
                            await worker.queue_frame(EndFrame())
                    return
                if isinstance(frame, EndFrame):
                    # All preference changes, synthesis and context completion
                    # precede transport playback and the queued logging observer.
                    for item in self.buffer:
                        played.append(item)
                        await self.push_frame(item, direction)
                    release_observer.set()
                await self.push_frame(frame, direction)

        repo = Repository()
        async with log_for(repo) as log:
            llm = OfflineLLM(api_key="unused-offline", settings=OpenAILLMService.Settings(
                model="unused-offline", system_instruction=f"caller_language={initial_language}"))
            tts = SentenceTTS(api_key="unused-offline", initial_language=initial_language,
                sample_rate=24000, settings=SonioxTTSService.Settings(
                    model="tts-rt-v2", voice="Bryce",
                    language=Language(initial_language.split("-")[0])),
                text_aggregation_mode=TextAggregationMode.SENTENCE)

            async def connect(uri, **kwargs):
                return socket

            monkeypatch.setattr(tts, "_websocket_connect", connect)

            @tts.event_handler("on_before_push_frame")
            async def capture(processor, frame):
                if isinstance(frame, (TTSAudioRawFrame, TTSTextFrame)):
                    emitted.append(frame)

            output = BufferedOutput()
            bind_response_language(llm, initial_language=initial_language)

            def on_change(code):
                changed.append(code)
                log.language = log.assistant_language = code
                if code == "te":
                    latest_changed.set()

            language = TTSLanguageProcessor({initial_language, "ur", "hi", "te"}, on_change,
                initial_language=initial_language,
                llm_settings_factory=lambda code: OpenAILLMService.Settings(
                    system_instruction=f"caller_language={code}"))
            observers = log.observers(output=output, speech=tts)
            original = observers[1].on_push_frame

            async def delayed(data):
                await release_observer.wait()
                await original(data)

            monkeypatch.setattr(observers[1], "on_push_frame", delayed)
            worker = PipelineWorker(Pipeline([language, Requests(), llm, tts, output]),
                params=PipelineParams(enable_usage_metrics=True), enable_rtvi=False,
                observers=observers)
            log.bind_worker(worker)
            await worker.queue_frames([
                TTSSpeakFrame(greeting, append_to_context=False),
                TranscriptionFrame("Urdu please", "caller", "1", language=Language.HI),
                TranscriptionFrame("speak Hindi", "caller", "2", language=Language.UR),
                TranscriptionFrame("ఈరోజు మీరు ఎన్ని గంటలకు మూసేస్తారు?", "caller", "3", language=Language.TE),
            ])
            runner = WorkerRunner(handle_sigint=False)
            await runner.add_workers(worker)
            await asyncio.wait_for(runner.run(), 5)

        # Check the harness and full lifecycle before the language regression so
        # RED cannot be a timeout, swallowed provider error or incomplete audio.
        assert not [task for task in asyncio.all_tasks()
                    if task is not asyncio.current_task() and not task.done()]
        assert socket.closed and socket.incoming.empty()
        assert not socket.violations
        assert changed == [initial_language, "ur", "hi", "te"]
        assert generated == ["ur", "hi", "te"]
        assert len(socket.configs) == 4
        assert socket.text_ended == socket.terminated == output.stopped
        configs = list(socket.configs.values())
        assert [c["language"] for c in configs] == [initial_language.split("-")[0], "ur", "hi", "te"]
        assert all(c["voice"] == "Bryce" and c["model"] == "tts-rt-v2"
                   and c["sample_rate"] == 24000 and c["audio_format"] == "pcm_s16le"
                   and c["return_timestamps"] is True for c in configs)
        audio = [f for f in played if isinstance(f, TTSAudioRawFrame)]
        assert audio == [f for f in emitted if isinstance(f, TTSAudioRawFrame)]
        assert [f.audio for f in audio] == [pcm for sid in socket.text_ended for pcm in socket.pcm[sid]]
        assert all(f.sample_rate == 24000 and f.num_channels == 1 for f in audio)
        for sid in socket.text_ended:
            frames = [f for f in played if getattr(f, "context_id", None) == sid]
            assert isinstance(frames[0], TTSStartedFrame)
            assert isinstance(frames[-1], TTSStoppedFrame)
            assert len([f for f in frames if isinstance(f, TTSAudioRawFrame)]) == 2
            assert any(isinstance(f, TTSTextFrame) and "dollars." in f.text for f in frames)
        call = repo.tables["calls"][0]
        assert call["qa_flags"] == []
        assert call["usage"]["usage_complete"] is True
        totals = call["usage"]["totals"]
        assert totals["characters"] == sum(len(chunk) for chunks in socket.chunks.values() for chunk in chunks)
        assert totals["generated_audio_seconds"] == pytest.approx(sum(len(f.audio) / 48000 for f in audio))
        assert call["billable_seconds"] == 0
        expected = [(initial_language, greeting), *texts.items()]
        actual = [(t["language"], t["text"].strip()) for t in repo.tables["call_turns"]
                  if t["speaker"] == "agent"]
        metadata = [(f.context_id, f.text if isinstance(f, TTSTextFrame) else "audio",
                     f.metadata.get("response_language")) for f in emitted]
        assert actual == expected, f"persisted={actual!r}; expected={expected!r}; metadata={metadata!r}"
        canonical_by_context = dict(zip(socket.text_ended, [initial_language, "ur", "hi", "te"]))
        for frame in emitted:
            assert frame.metadata.get("response_language") == canonical_by_context[frame.context_id]
            assert frame.metadata["response_language"].split("-")[0] == socket.configs[frame.context_id]["language"]

    asyncio.run(exercise())


@pytest.mark.parametrize("model", ["unknown", "gpt-4.1-mini-future", "gpt-realtime-2.1-mini", None])
def test_unknown_model_never_uses_default_or_zero_cost(model):
    async def exercise():
        repo = Repository()
        async with log_for(repo) as log:
            await push(log.observers(output=None, speech=None), llm_metric(model))
        row = repo.tables["calls"][0]
        assert row["cost_micros"] == {}
        assert row["usage"]["cost_status"] == "unavailable"
        assert row["usage"]["services"][0]["cost_micros"] is None
    asyncio.run(exercise())


def test_speech_uses_characters_and_measured_audio_estimates_no_fake_tokens():
    async def exercise():
        repo = Repository()
        speech = SimpleNamespace(name="tts", settings=SimpleNamespace(model="tts-rt-v2"))
        async with log_for(repo) as log:
            observers = log.observers(output=None, speech=speech)
            frame = MetricsFrame(data=[STTUsageMetricsData(processor="stt", model="stt-rt-v5", value=STTUsage(audio_seconds=60)), TTSUsageMetricsData(processor="tts", model="tts-rt-v2", value=100)])
            await push(observers, frame)
            audio = TTSAudioRawFrame(b"\x00\x00" * 16000, 16000, 1)
            await push(observers, audio, speech)
            await push(observers, audio, speech, first=False)
        row = repo.tables["calls"][0]
        assert row["usage"]["totals"]["audio_seconds"] == 60
        assert row["usage"]["totals"]["characters"] == 100
        assert row["usage"]["totals"]["generated_audio_seconds"] == 1
        assert row["usage"]["totals"]["prompt_tokens"] is None
        assert row["usage"]["cost_status"] == "partial"  # STT text/context tokens not reported.
        assert row["cost_micros"]["stt"] == 1000
        assert row["cost_micros"]["tts"] == 299  # 30 * $4 + (30000/3600) * $21.50.
        assert all(s["cost_basis"].startswith("estimated_") for s in row["usage"]["services"])
        import json
        json.dumps(row)  # No binary audio in persisted data.
    asyncio.run(exercise())


def test_only_final_caller_and_played_assistant_words_including_interruption():
    async def exercise():
        repo = Repository()
        output, speech = object(), SimpleNamespace(name="tts", settings=SimpleNamespace(model="tts-rt-v2"))
        async with log_for(repo) as log:
            observers = log.observers(output=output, speech=speech)
            await push(observers, InterimTranscriptionFrame("not final", "", ""))
            final = TranscriptionFrame("Bonjour", "", "", language=Language.FR, finalized=True)
            await push(observers, final)
            await push(observers, final, first=False)
            await push(observers, LLMTextFrame("unspoken system/tool payload"))
            await push(observers, TTSTextFrame("unplayed", text_type="sentence"), speech)
            word = TTSTextFrame("Bonjour", text_type="sentence")
            await push(observers, word, output, first=False)
            await push(observers, InterruptionFrame())
        turns = repo.tables["call_turns"]
        assert [r["text"] for r in turns] == ["Bonjour", "Bonjour"]
        assert [r["speaker"] for r in turns] == ["caller", "agent"]
        assert turns[1]["interrupted"] is True
        assert turns[0]["language"] == "fr-CA"
        assert repo.tables["calls"][0]["languages"] == ["fr-CA"]
        assert repo.tables["calls"][0]["recording_path"] is None
    asyncio.run(exercise())


def test_transcript_optout_still_records_usage_and_no_text():
    async def exercise():
        repo = Repository()
        output = object()
        async with log_for(repo, transcript_enabled=False) as log:
            observers = log.observers(output=output, speech=None)
            await push(observers, TranscriptionFrame("private caller", "", "", finalized=True))
            await push(observers, TTSTextFrame("private agent", text_type="sentence"), output)
            await push(observers, llm_metric())
        assert repo.tables["call_turns"] == []
        assert "private" not in str(repo.writes)
        assert repo.tables["calls"][0]["usage"]["totals"]["prompt_tokens"] == 1000
    asyncio.run(exercise())


@pytest.mark.parametrize("failure", [None, "provider", "cancel", "error_frame"])
def test_lifecycle_finalizes_success_provider_failure_and_cancel(failure):
    async def exercise():
        repo = Repository()
        try:
            async with log_for(repo) as log:
                row = repo.tables["calls"][0]
                UUID(log.call_id)
                assert row["source"] == "browser"
                assert row["restaurant_id"] == "restaurant-a"
                assert row["agent_version_id"] == "version-a"
                assert all(row.get(k) is None for k in ["telnyx_call_id", "from_e164_hash", "from_last4"])
                if failure == "provider":
                    raise RuntimeError("provider failed")
                if failure == "cancel":
                    raise asyncio.CancelledError()
                if failure == "error_frame":
                    await push(log.observers(output=None, speech=None), ErrorFrame("secret provider payload"))
        except (RuntimeError, asyncio.CancelledError):
            assert failure in {"provider", "cancel"}
        row = repo.tables["calls"][0]
        assert row["ended_at"] >= row["started_at"]
        assert row["outcome"] == "answered"
        assert row["billable_seconds"] == 0
        assert bool(row["qa_flags"]) == (failure is not None)
        assert row["usage"]["usage_complete"] is (failure is None)
        assert {t for t, _ in repo.writes} <= {"calls", "call_turns", "call_metrics"}
    asyncio.run(exercise())


def test_create_and_write_errors_are_safe_and_never_successful():
    async def exercise():
        repo = Repository()
        repo.fail_insert = True
        with pytest.raises(module().CallLoggingError, match="^Browser call creation failed$"):
            async with log_for(repo):
                pytest.fail("Paid pipeline must not start")
        repo.fail_insert = False
        with pytest.raises(module().CallLoggingError, match="^Browser call persistence failed$"):
            async with log_for(repo):
                repo.fail_update = True
    asyncio.run(exercise())


@pytest.mark.parametrize("response", ["timeout", "lost", "mismatched_id"])
def test_committed_creation_with_failed_response_is_finalized(response, caplog):
    class CommitThenFailRepository(Repository):
        async def insert(self, table, row):
            result = await super().insert(table, row)
            if response == "timeout":
                await asyncio.sleep(1)
            elif response == "lost":
                raise RuntimeError("secret transcript credential should never escape")
            else:
                result["id"] = str(uuid4())
            return result

    async def exercise():
        repo = CommitThenFailRepository()
        log = log_for(repo, write_timeout=0.02)
        async with asyncio.timeout(0.3):
            with pytest.raises(module().CallLoggingError, match="^Browser call creation failed$"):
                async with log:
                    pytest.fail("Paid pipeline must not start after an ambiguous creation")
        row = repo.tables["calls"][0]
        assert row["id"] == log.call_id
        assert row["ended_at"] >= row["started_at"]
        assert "recording_incomplete" in row["qa_flags"]
        assert row["usage"]["usage_complete"] is False
        assert row["billable_seconds"] == 0
        assert "secret transcript credential" not in caplog.text
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    asyncio.run(exercise())


def test_child_flush_deadline_still_persists_terminal_metadata_and_usage():
    class SlowTurnsRepository(Repository):
        async def insert(self, table, row):
            if table == "call_turns":
                await asyncio.sleep(0.025)
            return await super().insert(table, row)

    async def exercise():
        repo = SlowTurnsRepository()
        async with asyncio.timeout(0.4):
            with pytest.raises(module().CallLoggingError, match="^Browser call persistence failed$"):
                async with log_for(repo, snapshot_interval=100, write_timeout=0.1, flush_timeout=0.06) as log:
                    await push(log.observers(output=None, speech=None), llm_metric())
                    for n in range(4):
                        log.add_text("caller", "synthetic", n * 1_000_000)
        assert 0 < len(repo.tables["call_turns"]) < 4
        row = repo.tables["calls"][0]
        assert row["ended_at"] >= row["started_at"]
        assert "recording_incomplete" in row["qa_flags"]
        assert row["usage"]["usage_complete"] is False
        assert row["usage"]["totals"]["prompt_tokens"] == 1000
        assert row["usage"]["totals"]["completion_tokens"] == 200
        assert row["usage"]["services"][0]["reported_events"] == 1
        assert row["cost_micros"] == {"llm": 600}
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    asyncio.run(exercise())


def test_slow_database_does_not_block_frames_and_final_flush_is_bounded():
    async def exercise():
        repo = Repository()
        with pytest.raises(module().CallLoggingError):
            async with log_for(repo, write_timeout=0.02, flush_timeout=0.1, snapshot_interval=0.001) as log:
                repo.block_update = asyncio.Event()
                observers = log.observers(output=None, speech=None)
                await asyncio.wait_for(push(observers, llm_metric()), timeout=0.05)
                await asyncio.sleep(0.03)
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    asyncio.run(exercise())


def test_incremental_snapshot_and_failed_snapshot_remains_visible():
    async def exercise():
        repo = Repository()
        with pytest.raises(module().CallLoggingError):
            async with log_for(repo, snapshot_interval=0.001) as log:
                observers = log.observers(output=None, speech=None)
                await push(observers, llm_metric())
                await asyncio.sleep(0.02)
                assert repo.tables["calls"][0]["usage"]["totals"]["prompt_tokens"] == 1000
                assert repo.tables["calls"][0]["ended_at"] is None
                repo.fail_update = True
                await push(observers, llm_metric())
                await asyncio.sleep(0.02)
                repo.fail_update = False
        row = repo.tables["calls"][0]
        assert "recording_incomplete" in row["qa_flags"]
        assert row["usage"]["totals"]["prompt_tokens"] == 2000
    asyncio.run(exercise())


@pytest.mark.parametrize("failure", [None, "provider", "cancel", "create", "ownership"])
def test_launcher_checks_ownership_before_db_uuid_and_paid_pipeline(monkeypatch, tmp_path, failure):
    from voice_receptionist_worker import main
    from voice_receptionist_worker.pipeline import builder
    from voice_receptionist_worker.pipeline.config import RuntimeConfig

    class LaunchRepository(Repository):
        closed = False
        async def select(self, table, filters=None):
            rows = {
                "agent_versions": [{"id": "version-a", "agent_id": "agent-a", "prompt_sections": {"rules": "Private system instructions"}}],
                "agents": [] if failure == "ownership" else [{"id": "agent-a", "restaurant_id": "restaurant-a"}],
                "restaurants": [{"id": "restaurant-a", "name": "Test", "timezone": "America/Toronto", "enabled_languages": ["en", "fr-CA"], "primary_language": "fr-CA"}],
                "hours": [{"weekday": 1, "open_time": "09:00", "close_time": "21:00"}],
                "menu_items": [{"name": "Soup", "price_cents": 500}],
                "legal_settings": [{"transcript_enabled": False}],
            }
            if table == "agents":
                assert filters == {"id": "agent-a", "restaurant_id": "restaurant-a"}
            if table == "legal_settings":
                assert filters == {"restaurant_id": "restaurant-a"}
            return rows[table]
        async def aclose(self):
            self.closed = True

    repo = LaunchRepository()
    repo.fail_insert = failure == "create"
    monkeypatch.setenv("SUPABASE_URL", "https://example.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-key")
    monkeypatch.setattr(main, "SupabasePostgrestRepository", lambda *a: repo)
    monkeypatch.setattr(main, "load_runtime_config", lambda *a: RuntimeConfig(providers={"pricing": pricing(), "resilience": {"offline_queue": {"path": str(tmp_path / "offline.json"), "maximum_messages": 10}}}, restaurant={}))
    started = []

    async def run(config, connection, **kwargs):
        assert repo.tables["calls"], "Persist call before paid providers"
        row = repo.tables["calls"][0]
        UUID(kwargs["database_call_id"])
        assert kwargs["database_call_id"] == row["id"]
        assert kwargs["dry_run_tools"] is True
        assert config.restaurant["primary_language"] == "fr-CA"
        assert config.restaurant["agent_version_id"] == "version-a"
        assert kwargs["call_log"].transcript_enabled is False
        assert row["restaurant_id"] == "restaurant-a"
        assert row["agent_version_id"] == "version-a"
        started.append(True)
        if failure == "provider":
            raise RuntimeError("provider failed")
        if failure == "cancel":
            raise asyncio.CancelledError()

    monkeypatch.setattr(builder, "run_browser_audio_pipeline", run)

    async def exercise():
        try:
            await main._launch_test_call_pipeline(object(), {"restaurant_id": "restaurant-a", "agent_version_id": "version-a", "nonce": "private"}, dry_run_tools=True, browser_audio=True)
        except BaseException as error:
            if failure is None:
                raise
            if failure == "create":
                assert str(error) == "Browser call creation failed"
        assert repo.closed
        if failure in {"create", "ownership"}:
            assert not started
            assert repo.tables["calls"] == []
        else:
            assert started
            assert repo.tables["calls"][0]["ended_at"]
            assert repo.tables["calls"][0]["billable_seconds"] == 0
        assert {t for t, _ in repo.writes} <= {"calls", "call_turns", "call_metrics"}
    asyncio.run(exercise())


def test_browser_migration_constraints_and_rls_in_current_harness():
    import subprocess
    result = subprocess.run(["node", str(Path(__file__).with_name("browser_call_migration.mjs"))], capture_output=True, text=True, cwd=ROOT)
    assert result.returncode == 0, result.stdout + result.stderr


def test_pipeline_cancel_frame_marks_incomplete_usage_and_partial_speech():
    from pipecat.frames.frames import CancelFrame
    async def exercise():
        repo = Repository()
        output = object()
        async with log_for(repo) as log:
            observers = log.observers(output=output, speech=None)
            await push(observers, TTSTextFrame("Still speaking", text_type="sentence"), output)
            await push(observers, CancelFrame())
        row = repo.tables["calls"][0]
        assert row["usage"]["usage_complete"] is False
        assert "cancelled" in row["qa_flags"]
        assert repo.tables["call_turns"][0]["interrupted"] is True
    asyncio.run(exercise())


def test_incomplete_cache_report_never_prices_missing_tokens_as_uncached():
    async def exercise():
        repo = Repository()
        async with log_for(repo) as log:
            observers = log.observers(output=None, speech=None)
            await push(observers, llm_metric())
            await push(observers, MetricsFrame(data=[LLMUsageMetricsData(processor="llm", model="gpt-4.1-mini", value=LLMTokenUsage(prompt_tokens=1000, completion_tokens=200, total_tokens=1200))]))
        row = repo.tables["calls"][0]
        assert row["cost_micros"] == {}
        assert row["usage"]["totals"]["cache_read_input_tokens"] is None
        assert row["usage"]["totals"]["prompt_tokens"] == 2000
    asyncio.run(exercise())


def test_latency_records_reuse_installed_breakdown_and_incremental_turn_updates():
    async def exercise():
        repo = Repository()
        output = object()
        async with log_for(repo, snapshot_interval=0.001) as log:
            observers = log.observers(output=output, speech=None)
            await push(observers, TTSTextFrame("First", text_type="sentence"), output)
            await asyncio.sleep(0.02)
            await push(observers, TTSTextFrame("words", text_type="sentence"), output)
            await push(observers, InterruptionFrame())
            log.add_latency(None, SimpleNamespace(total_secs=0.7, contributions=[SimpleNamespace(key="transcription", duration_secs=0.1), SimpleNamespace(key="llm_inference", duration_secs=0.2), SimpleNamespace(key="speech_synthesis", duration_secs=0.4)]))
        assert len(repo.tables["call_turns"]) == 1
        assert repo.tables["call_turns"][0]["text"] == "First words"
        assert repo.tables["call_turns"][0]["interrupted"] is True
        assert repo.tables["call_metrics"][0]["total_ms"] == 700
        assert repo.tables["call_metrics"][0]["llm_ttft_ms"] == 200
    asyncio.run(exercise())


def test_real_task_cancellation_flushes_and_leaves_no_background_task():
    async def exercise():
        repo = Repository()
        entered = asyncio.Event()
        async def run():
            async with log_for(repo) as log:
                await push(log.observers(output=None, speech=None), llm_metric())
                entered.set()
                await asyncio.Event().wait()
        task = asyncio.create_task(run())
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        row = repo.tables["calls"][0]
        assert row["ended_at"]
        assert row["usage"]["totals"]["prompt_tokens"] == 1000
        assert row["usage"]["usage_complete"] is False
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    asyncio.run(exercise())


def test_cancellation_during_call_creation_finalizes_before_returning():
    async def exercise():
        repo = Repository()
        inserted = asyncio.Event()
        release = asyncio.Event()
        original = repo.insert
        async def delayed_insert(table, row):
            result = await original(table, row)
            inserted.set()
            await release.wait()
            return result
        repo.insert = delayed_insert
        async def run():
            async with log_for(repo):
                pytest.fail("Do not open paid providers after cancellation")
        task = asyncio.create_task(run())
        await inserted.wait()
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert repo.tables["calls"][0]["ended_at"]
        assert "cancelled" in repo.tables["calls"][0]["qa_flags"]
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    asyncio.run(exercise())


@pytest.mark.parametrize("mode", ["pcm", "webrtc", "realtime"])
def test_browser_builders_enable_usage_bind_observers_and_force_business_dryrun(monkeypatch, tmp_path, mode):
    from voice_receptionist_worker.pipeline import builder
    from voice_receptionist_worker.pipeline.config import load_runtime_config
    from voice_receptionist_worker.tools import ToolDispatcher
    config = load_runtime_config(ROOT / "config/providers.yaml", ROOT / "config/dev-restaurant.yaml")
    config.restaurant["id"] = "restaurant-a"
    monkeypatch.setenv("SONIOX_API_KEY", "test-soniox")
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai")
    monkeypatch.setenv("LATENCY_JSONL_PATH", str(tmp_path / "latency.jsonl"))
    monkeypatch.setenv("ACK_CLIPS", "0")
    monkeypatch.setenv("TURN_DETECTION", "speech_timeout")
    monkeypatch.setenv("VOICE_MODE", "realtime" if mode == "realtime" else "cascade")
    monkeypatch.setenv("PIPECAT_ALLOWED_ORIGINS", "")

    def processors(p):
        for child in p.processors:
            if child.processors:
                yield from processors(child)
            else:
                yield child

    async def exercise():
        repo = Repository()
        log = log_for(repo)
        dispatcher = ToolDispatcher(repo, allow_private_lookups=False)
        connection = SimpleNamespace(headers={}, event_handler=lambda name: lambda handler: handler)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            factory = builder.build_browser_audio_pipeline if mode == "pcm" else builder.build_webrtc_pipeline
            worker = factory(config, connection, tool_dispatcher=dispatcher, database_call_id=str(uuid4()), dry_run_tools=False, call_log=log)
        llm = next(p for p in processors(worker.pipeline) if "LLMService" in type(p).__name__)
        try:
            assert worker.params.enable_usage_metrics is True
            assert log._drain_observers in worker._event_handlers["on_pipeline_finished"].handlers
            observers = worker._observer._observers
            assert any(type(o).__name__ == "_MetricsObserver" for o in observers)
            speech_observer = next(o for o in observers if type(o).__name__ == "_SpeechObserver")
            assert speech_observer.output in list(processors(worker.pipeline))
            if mode != "realtime":
                latency = next(o for o in observers if type(o).__name__ == "UserBotLatencyObserver")
                assert log.add_latency in latency._event_handlers["on_latency_breakdown"].handlers
            results = []
            async def result_callback(value):
                results.append(value)
            cases = {
                "send_sms": {"phone": "+14165550123", "template_key": "message_received", "vars": {"name": "Test"}, "language": "en"},
                "create_booking": {"name": "Test", "phone": "+14165550123", "party_size": 2, "starts_at": "2026-12-01T18:00:00-05:00"},
                "create_order": {"items": [{"menu_item_id": "10000000-0000-4000-8000-000000000001", "quantity": 1}], "pickup_at": "2026-12-01T18:00:00-05:00", "name": "Test", "phone": "+14165550123"},
            }
            for name, arguments in cases.items():
                await llm._functions[name].handler(SimpleNamespace(tool_call_id=name, function_name=name, arguments=arguments, result_callback=result_callback))
            assert results == [{"ok": True, "dry_run": True}] * 3
            assert repo.writes == []  # No SMS, tool payload, booking, ledger or order writes.
        finally:
            client = getattr(llm, "_client", None)
            if client:
                await client.close()
    asyncio.run(exercise())


@pytest.mark.parametrize("terminal", ["end", "cancel"])
@pytest.mark.parametrize("count", [2, 5, 100])
def test_real_pipecat_runner_drains_final_usage_without_double_counting(terminal, count):
    from pipecat.frames.frames import CancelFrame, EndFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineParams, PipelineWorker
    from pipecat.processors.frame_processor import FrameProcessor
    from pipecat.observers.base_observer import BaseObserver
    from pipecat.workers.runner import WorkerRunner

    class UnrelatedObserver(BaseObserver):
        async def on_push_frame(self, data):
            await asyncio.Event().wait()

    class FinalUsage(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, (CancelFrame, EndFrame)):
                await self.push_frame(MetricsFrame(data=[STTUsageMetricsData(
                    processor="stt", model="stt-rt-v5", value=STTUsage(audio_seconds=5))]), direction)
                for _ in range(count):
                    await self.push_frame(llm_metric(), direction)
            await self.push_frame(frame, direction)

    async def exercise():
        repo = Repository()
        async with log_for(repo) as log:
            worker = PipelineWorker(Pipeline([FinalUsage()]), enable_rtvi=False, params=PipelineParams(enable_metrics=True, enable_usage_metrics=True), observers=[*log.observers(output=None, speech=None), UnrelatedObserver()])
            log.bind_worker(worker)
            @worker.event_handler("on_pipeline_started")
            async def end(worker, frame):
                await worker.queue_frame(EndFrame() if terminal == "end" else CancelFrame())
            runner = WorkerRunner(handle_sigint=False)
            await runner.add_workers(worker)
            await asyncio.wait_for(runner.run(), 5)
        row = repo.tables["calls"][0]
        assert row["usage"]["totals"]["audio_seconds"] == 5
        assert row["usage"]["totals"]["prompt_tokens"] == 1000 * count
        assert row["usage"]["totals"]["completion_tokens"] == 200 * count
        assert row["usage"]["totals"]["total_tokens"] == 1200 * count
        assert row["usage"]["totals"]["cache_read_input_tokens"] == 400 * count
        assert [(s["kind"], s["reported_events"]) for s in row["usage"]["services"]] == [("stt", 1), ("llm", count)]
        assert row["usage"]["usage_complete"] is (terminal == "end")
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    asyncio.run(exercise())


def test_realtime_audio_keeps_actual_model_and_remains_unpriced():
    async def exercise():
        repo = Repository()
        speech = SimpleNamespace(name="llm", settings=SimpleNamespace(model="unpriced-realtime"))
        async with log_for(repo) as log:
            observers = log.observers(output=None, speech=speech, speech_kind="llm")
            await push(observers, llm_metric("unpriced-realtime"))
            await push(observers, TTSAudioRawFrame(b"\x00\x00" * 24000, 24000, 1), speech)
        usage = repo.tables["calls"][0]["usage"]
        assert len(usage["services"]) == 1
        assert usage["services"][0]["kind"] == "llm"
        assert usage["services"][0]["units"]["generated_audio_seconds"] == 1
        assert usage["cost_status"] == "unavailable"
    asyncio.run(exercise())


def test_ambiguous_turn_insert_is_retried_idempotently_and_failure_is_visible(caplog):
    from voice_receptionist_worker.tools import RepositoryError
    class AmbiguousRepository(Repository):
        first = True
        async def insert(self, table, row):
            if table == "call_turns" and self.tables[table]:
                raise RepositoryError("23505", "secret transcript credential should never escape")
            result = await super().insert(table, row)
            if table == "call_turns" and self.first:
                self.first = False
                raise RepositoryError("unreachable", "secret transcript credential should never escape")
            return result
    async def exercise():
        repo = AmbiguousRepository()
        with pytest.raises(module().CallLoggingError, match="^Browser call persistence failed$"):
            async with log_for(repo, snapshot_interval=0.001) as log:
                output = object()
                observers = log.observers(output=output, speech=None)
                await push(observers, TTSTextFrame("Spoken", text_type="sentence"), output)
                await asyncio.sleep(0.02)
                await push(observers, TTSTextFrame("words", text_type="sentence"), output)
        assert len(repo.tables["call_turns"]) == 1
        assert repo.tables["call_turns"][0]["text"] == "Spoken words"
        assert "recording_incomplete" in repo.tables["calls"][0]["qa_flags"]
        assert "secret transcript credential" not in caplog.text
    asyncio.run(exercise())


def test_validated_assistant_language_does_not_relabel_prior_asr_turns():
    async def exercise():
        repo = Repository()
        output = object()
        async with log_for(repo) as log:
            observers = log.observers(output=output, speech=None)
            await push(observers, TranscriptionFrame("Bonjour", "", "", language=Language.FR, finalized=True))
            log.assistant_language = log.language = "ur"
            log.languages.add("ur")
            await push(observers, TranscriptionFrame("Urdu please", "", "", language=Language.HI, finalized=True))
            await push(observers, TTSTextFrame("جی ضرور", text_type="sentence"), output, first=False)
            assert log.language == "ur"
            assert [t["language"] for t in log.turns] == ["fr-CA", "hi", "ur"]
    asyncio.run(exercise())


@pytest.mark.parametrize("failure", ["unsupported", "stalled"])
def test_accounting_drain_failure_is_bounded_and_never_claims_complete(monkeypatch, failure):
    from pipecat.frames.frames import EndFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.processors.frame_processor import FrameProcessor
    from pipecat.workers.runner import WorkerRunner

    class PassThrough(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            await self.push_frame(frame, direction)

    async def exercise():
        repo = Repository()
        async with log_for(repo) as log:
            observers = log.observers(output=None, speech=None)
            worker = PipelineWorker(Pipeline([PassThrough()]), enable_rtvi=False, observers=observers)
            log.bind_worker(worker)
            async with asyncio.timeout(2):
                if failure == "unsupported":
                    # A worker without the pinned SDK's initialized proxy map.
                    await log._drain_observers(worker, EndFrame())
                else:
                    monkeypatch.setattr(module(), "_OBSERVER_DRAIN_TIMEOUT", 0.02)
                    async def stalled(data):
                        await asyncio.Event().wait()
                    monkeypatch.setattr(observers[0], "on_push_frame", stalled)
                    @worker.event_handler("on_pipeline_started")
                    async def end(worker, frame):
                        await worker.queue_frame(EndFrame())
                    runner = WorkerRunner(handle_sigint=False)
                    await runner.add_workers(worker)
                    await runner.run()
        row = repo.tables["calls"][0]
        assert "recording_incomplete" in row["qa_flags"]
        assert row["usage"]["usage_complete"] is False
        assert row["ended_at"]
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    asyncio.run(exercise())


def test_played_assistant_text_splits_when_validated_language_changes():
    async def exercise():
        repo = Repository()
        output = object()
        async with log_for(repo) as log:
            observers = log.observers(output=output, speech=None)
            log.assistant_language = 'ur'
            await push(observers, TTSTextFrame('جی ضرور', text_type='sentence'), output, first=False)
            # A language update can precede the old bot-stop observer event.
            log.assistant_language = 'te'
            await push(observers, TTSTextFrame('ధర seventeen dollars', text_type='sentence'), output, first=False)
        assert [(turn['language'], turn['text']) for turn in repo.tables['call_turns']] == [
            ('ur', 'جی ضرور'), ('te', 'ధర seventeen dollars')]
    asyncio.run(exercise())


def test_buffered_playback_uses_frozen_generation_language():
    async def exercise():
        repo, output = Repository(), object()
        async with log_for(repo) as log:
            observers = log.observers(output=output, speech=None)
            # These words have already been generated in independent streams.
            frames = [TTSTextFrame(text, text_type="word", context_id=code)
                      for code, text in [("ur", "جی ضرور"), ("hi", "ज़रूर"),
                                         ("te", "ధర seventeen dollars")]]
            for frame, code in zip(frames, ["ur", "hi", "te"]):
                frame.metadata["response_language"] = code
            log.assistant_language = log.language = "en"
            for frame in frames:
                await push(observers, frame, output, first=False)
        assert [(t["language"], t["text"]) for t in repo.tables["call_turns"]] == [
            ("ur", "جی ضرور"), ("hi", "ज़रूर"), ("te", "ధర seventeen dollars")]
    asyncio.run(exercise())


@pytest.mark.filterwarnings("ignore:`AudioContextTTSService` is deprecated.*:DeprecationWarning")
@pytest.mark.parametrize("initial_language", ["en", "fr-CA", "en-IN"])
def test_real_pipecat_stream_languages_survive_fast_switches_and_delayed_observer(initial_language):
    from pipecat.frames.frames import EndFrame, LLMContextFrame, TTSSpeakFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.frame_processor import FrameProcessor
    from pipecat.services.openai.llm import OpenAILLMService
    from pipecat.services.soniox.tts import SonioxTTSService
    from pipecat.services.tts_service import TextAggregationMode
    from pipecat.workers.runner import WorkerRunner
    from voice_receptionist_worker.resilience.runtime import (
        ResponseLanguageTTSMixin, TTSLanguageProcessor, bind_response_language,
    )

    async def exercise():
        latest_changed, release_observer = asyncio.Event(), asyncio.Event()
        generated, configured, generated_audio, delivered_audio = [], [], [], []
        texts = {"ur": "جی ضرور seventeen dollars.", "hi": "ज़रूर seventeen dollars.",
                 "te": "ధర seventeen dollars."}

        class Requests(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, TranscriptionFrame):
                    frame = LLMContextFrame(LLMContext())
                await self.push_frame(frame, direction)

        class OfflineLLM(OpenAILLMService):
            async def _process_context(self, context):
                # Keep the first inference open while caller preference runs
                # ahead to Telugu in the upstream processor's independent queue.
                code = self.settings.system_instruction.rsplit("=", 1)[-1]
                await latest_changed.wait()
                generated.append(code)
                for part in texts[code].split(" "):
                    await self.push_frame(LLMTextFrame(part + " "))

        class OfflineTTS(ResponseLanguageTTSMixin, SonioxTTSService):
            async def _connect(self):
                pass

            async def _disconnect(self):
                pass

            async def _send_config(self, context_id):
                config = self._build_config_msg(context_id)
                configured.append((context_id, config["language"]))

            async def run_tts(self, text, context_id):
                # Only the provider I/O is replaced. Real Pipecat aggregation,
                # contexts, timestamps, queues and lifecycle remain in use.
                audio = TTSAudioRawFrame(b"\0\0" * 240, self.sample_rate, 1, context_id=context_id)
                generated_audio.append(audio)
                yield audio
                await self.add_word_timestamps([(word, i * .001)
                                               for i, word in enumerate(text.split())], context_id)

            async def flush_audio(self, context_id=None):
                if context_id and self.audio_context_available(context_id):
                    await self.remove_audio_context(context_id)

        class BufferedOutput(FrameProcessor):
            def __init__(self):
                super().__init__()
                self.words = []

            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, TTSTextFrame):
                    self.words.append(frame)
                    return
                if isinstance(frame, TTSAudioRawFrame):
                    delivered_audio.append(frame)
                if isinstance(frame, EndFrame):
                    for word in self.words:
                        await self.push_frame(word, direction)
                    release_observer.set()
                await self.push_frame(frame, direction)

        repo = Repository()
        async with log_for(repo) as log:
            llm = OfflineLLM(api_key="unused-offline", settings=OpenAILLMService.Settings(
                model="unused-offline", system_instruction="caller_language=en"))
            tts = OfflineTTS(api_key="unused-offline", initial_language=initial_language,
                settings=SonioxTTSService.Settings(
                model="unused-offline", voice="unused-offline", language=Language(initial_language.split("-")[0])),
                text_aggregation_mode=TextAggregationMode.TOKEN)
            output = BufferedOutput()
            bind_response_language(llm, initial_language=initial_language)

            def changed(code):
                log.language = log.assistant_language = code
                if code == "te":
                    latest_changed.set()

            language = TTSLanguageProcessor({initial_language, "ur", "hi", "te"}, changed,
                initial_language=initial_language,
                llm_settings_factory=lambda code: OpenAILLMService.Settings(
                    system_instruction=f"caller_language={code}"))
            observers = log.observers(output=output, speech=tts)
            # Stall the real WorkerObserver proxy until all three streams and
            # buffered output have run. A mutable-state read now sees only TE.
            speech_observer = observers[1]
            original = speech_observer.on_push_frame
            async def delayed(data):
                await release_observer.wait()
                await original(data)
            speech_observer.on_push_frame = delayed
            worker = PipelineWorker(Pipeline([language, Requests(), llm, tts, output]),
                                    enable_rtvi=False, observers=observers)
            log.bind_worker(worker)
            await worker.queue_frames([
                TTSSpeakFrame("Welcome seventeen dollars.", append_to_context=False),
                TranscriptionFrame("Urdu please", "caller", "1", language=Language.HI),
                TranscriptionFrame("speak Hindi", "caller", "2", language=Language.UR),
                TranscriptionFrame("ఈరోజు మీరు ఎన్ని గంటలకు మూసేస్తారు?", "caller", "3", language=Language.TE),
                EndFrame(),
            ])
            runner = WorkerRunner(handle_sigint=False)
            await runner.add_workers(worker)
            await asyncio.wait_for(runner.run(), 5)
        assert generated == ["ur", "hi", "te"]
        assert [code for _, code in configured] == [initial_language.split("-")[0], "ur", "hi", "te"]
        assert [(t["language"], t["text"].strip()) for t in repo.tables["call_turns"]
                if t["speaker"] == "agent"] == [(initial_language, "Welcome seventeen dollars."), *texts.items()]
        configured_by_context = dict(configured)
        assert delivered_audio and output.words
        for frame in [*delivered_audio, *output.words]:
            assert frame.metadata["response_language"].split("-")[0] == configured_by_context[frame.context_id]
        assert delivered_audio == generated_audio  # No audio drops, copies or reordering.
        assert all(frame.audio == b"\0\0" * 240 for frame in delivered_audio)
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    asyncio.run(exercise())
