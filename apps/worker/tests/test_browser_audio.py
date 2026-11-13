import asyncio
import importlib
import importlib.util
import json
import struct
import warnings
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    from pipecat.frames.frames import (
        EndFrame,
        InputAudioRawFrame,
        InterruptionFrame,
        OutputAudioRawFrame,
        StartFrame,
    )
    from pipecat.serializers.base_serializer import FrameSerializer


def _browser_audio():
    name = "voice_receptionist_worker.pipeline.browser_audio"
    assert importlib.util.find_spec(name) is not None, "Browser PCM serializer is missing"
    return importlib.import_module(name)


def test_pcm16_round_trip_preserves_signed_little_endian_samples() -> None:
    serializer = _browser_audio().BrowserAudioSerializer()
    assert isinstance(serializer, FrameSerializer)
    # Zero, one, minus one, minimum and maximum signed PCM16 samples.
    pcm = b"\x00\x00\x01\x00\xff\xff\x00\x80\xff\x7f"

    async def exercise():
        frame = await serializer.deserialize(pcm)
        assert isinstance(frame, InputAudioRawFrame)
        assert frame.sample_rate == 16000
        assert frame.num_channels == 1
        assert frame.num_frames == 5
        assert struct.unpack("<5h", frame.audio) == (0, 1, -1, -32768, 32767)
        output = OutputAudioRawFrame(frame.audio, frame.sample_rate, frame.num_channels)
        assert await serializer.serialize(output) == pcm

    asyncio.run(exercise())


@pytest.fixture
def browser_config(monkeypatch, tmp_path):
    from voice_receptionist_worker.pipeline.config import load_runtime_config

    root = Path(__file__).resolve().parents[3]
    config = load_runtime_config(root / "config/providers.yaml", root / "config/dev-restaurant.yaml")
    config.restaurant["id"] = "restaurant-browser-test"
    monkeypatch.setenv("SONIOX_API_KEY", "test-soniox-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.setenv("LATENCY_JSONL_PATH", str(tmp_path / "latency.jsonl"))
    monkeypatch.setenv("ACK_CLIPS", "0")
    monkeypatch.setenv("TURN_DETECTION", "speech_timeout")
    monkeypatch.setenv("PIPECAT_ALLOWED_ORIGINS", "")
    monkeypatch.delenv("VOICE_MODE", raising=False)
    return config


def _build_browser(config, websocket, dispatcher):
    from voice_receptionist_worker.pipeline import builder

    factory = getattr(builder, "build_browser_audio_pipeline", None)
    assert factory is not None, "Browser PCM cascade builder is missing"
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        return factory(
            config, websocket, tool_dispatcher=dispatcher,
            database_call_id="browser-call", dry_run_tools=True,
            prompt_sections={"rules": "Keep the owner's current instructions."},
        )


def _processors(processor):
    for child in processor.processors:
        if child.processors:
            yield from _processors(child)
        else:
            yield child


def test_browser_reuses_real_cascade_prompt_languages_and_dry_run_tools(
    browser_config, monkeypatch,
) -> None:
    from voice_receptionist_worker.pipeline import builder

    async def exercise():
        dispatched = []

        async def dispatch(name, arguments, context):
            dispatched.append((name, arguments, context))
            return {"dry_run": context.dry_run}

        dispatcher = SimpleNamespace(timeout_seconds=3, dispatch=dispatch)
        # Browser PCM always uses the cascade, even when WebRTC experiments use realtime.
        monkeypatch.setenv("VOICE_MODE", "realtime")
        worker = _build_browser(browser_config, SimpleNamespace(headers={}), dispatcher)
        processors = list(_processors(worker.pipeline))
        names = [type(p).__name__ for p in processors]
        assert names.index("SonioxSTTService") < names.index("TTSLanguageProcessor")
        assert names.index("TTSLanguageProcessor") < names.index("OpenAILLMService")
        assert names.index("OpenAILLMService") < names.index("ResponseLanguageTTS")
        stt = next(p for p in processors if type(p).__name__ == "SonioxSTTService")
        llm = next(p for p in processors if type(p).__name__ == "OpenAILLMService")
        tts = next(p for p in processors if type(p).__name__ == "ResponseLanguageTTS")
        try:
            assert stt.settings.model == browser_config.providers["stt"]["model"]
            assert stt.settings.enable_language_identification is True
            assert stt.settings.language_hints_strict is True
            assert llm.settings.model == browser_config.providers["voice_llm"]["model"]
            assert "Keep the owner's current instructions." in llm.settings.system_instruction
            assert tts.settings.voice == browser_config.providers["tts"]["voice"]
            assert worker.params.audio_in_sample_rate == 16000
            assert worker.params.audio_out_sample_rate == 16000
            callback = AsyncMock()
            await llm._functions["send_sms"].handler(SimpleNamespace(
                tool_call_id="turn-1", function_name="send_sms",
                arguments={"message": "Test"}, result_callback=callback,
            ))
            name, arguments, context = dispatched[0]
            assert name == "send_sms"
            assert context.dry_run is True
            assert context.call_id == "browser-call"
            assert context.restaurant_id == "restaurant-browser-test"
            callback.assert_awaited_once_with({"dry_run": True})
        finally:
            await llm._client.close()

    asyncio.run(exercise())


def test_transport_is_mono_16khz_raw_pcm_and_timeout_and_disconnect_cancel(
    browser_config, monkeypatch,
) -> None:
    async def exercise():
        worker = _build_browser(
            browser_config, SimpleNamespace(headers={}), SimpleNamespace(timeout_seconds=3),
        )
        processors = list(_processors(worker.pipeline))
        transport = next(
            p for p in processors if type(p).__name__ == "FastAPIWebsocketInputTransport"
        )._transport
        params = transport._params
        llm = next(p for p in processors if type(p).__name__ == "OpenAILLMService")
        try:
            assert params.audio_in_enabled and params.audio_out_enabled
            assert params.audio_in_sample_rate == params.audio_out_sample_rate == 16000
            assert params.audio_in_channels == params.audio_out_channels == 1
            assert params.add_wav_header is False
            assert params.session_timeout == 600
            assert isinstance(params.serializer, _browser_audio().BrowserAudioSerializer)
            cancel = AsyncMock()
            monkeypatch.setattr(worker, "cancel", cancel)
            for event in ("on_session_timeout", "on_client_disconnected"):
                await transport._call_event_handler(event, transport._client._websocket)
                await asyncio.sleep(0)  # Pipecat schedules asynchronous event handlers.
            assert cancel.await_count == 2
            assert all(call.kwargs.get("reason") for call in cancel.await_args_list)
        finally:
            await llm._client.close()

    asyncio.run(exercise())


def test_webrtc_keeps_realtime_branch(browser_config, monkeypatch) -> None:
    from voice_receptionist_worker.pipeline import builder

    monkeypatch.setenv("VOICE_MODE", "realtime")
    result = object()
    seen = {}

    def realtime(config, connection, **kwargs):
        seen.update(kwargs)
        return result

    monkeypatch.setattr(builder, "_build_webrtc_realtime_pipeline", realtime)
    assert builder.build_webrtc_pipeline(
        browser_config, object(), tool_dispatcher=object(), database_call_id="rtc-call",
        dry_run_tools=True, prompt_sections={"rules": "Draft"},
    ) is result
    assert seen["database_call_id"] == "rtc-call"
    assert seen["dry_run_tools"] is True
    assert seen["prompt_sections"] == {"rules": "Draft"}


def test_webrtc_and_pcm_use_the_same_cascade(browser_config, monkeypatch) -> None:
    from voice_receptionist_worker.pipeline import builder

    shared = getattr(builder, "_build_browser_cascade", None)
    assert shared is not None, "Shared browser cascade is missing"
    transports = []

    def track_shared(config, transport, **kwargs):
        transports.append(type(transport).__name__)
        return shared(config, transport, **kwargs)

    monkeypatch.setattr(builder, "_build_browser_cascade", track_shared)

    async def exercise():
        workers = []
        dispatcher = SimpleNamespace(timeout_seconds=3)
        try:
            workers.append(_build_browser(browser_config, SimpleNamespace(headers={}), dispatcher))
            # The connection is not opened; only its event-registration boundary is needed.
            connection = SimpleNamespace(event_handler=lambda name: lambda handler: handler)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                workers.append(builder.build_webrtc_pipeline(
                    browser_config, connection, tool_dispatcher=dispatcher,
                    database_call_id="rtc-call", dry_run_tools=True,
                    prompt_sections={"rules": "Keep the owner's current instructions."},
                ))
            assert transports == ["FastAPIWebsocketTransport", "SmallWebRTCTransport"]
            pcm_core = [p for p in _processors(workers[0].pipeline) if "Transport" not in type(p).__name__]
            rtc_core = [p for p in _processors(workers[1].pipeline) if "Transport" not in type(p).__name__]
            assert [type(p) for p in pcm_core] == [type(p) for p in rtc_core]
            # Preserve WebRTC's existing default output sample rate.
            assert workers[1].params.audio_out_sample_rate == 24000
        finally:
            for worker in workers:
                for processor in _processors(worker.pipeline):
                    if type(processor).__name__ == "OpenAILLMService":
                        await processor._client.close()

    asyncio.run(exercise())


@pytest.mark.parametrize("finish", ["stop", "timeout", "cancel"])
def test_browser_runner_streams_pcm_and_clear_and_cleans_up_without_providers(
    browser_config, monkeypatch, finish,
) -> None:
    from starlette.websockets import WebSocketState
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.processors.frame_processor import FrameProcessor
    from voice_receptionist_worker.pipeline import builder

    run = getattr(builder, "run_browser_audio_pipeline", None)
    assert run is not None, "Browser PCM runner is missing"

    async def exercise():
        pcm = b"\x01\x00\xff\xff" * 320  # Default output packet: 40 ms.
        messages = asyncio.Queue()
        audio_sent = asyncio.Event()
        clear_sent = asyncio.Event()
        closed = asyncio.Event()
        sent = []
        seen = {}

        class Socket:
            headers = {}
            client_state = WebSocketState.CONNECTED
            application_state = WebSocketState.CONNECTED

            async def receive(self):
                return await messages.get()

            async def send_bytes(self, data):
                sent.append(data)
                audio_sent.set()

            async def send_text(self, data):
                assert json.loads(data) == {"type": "clear"}
                clear_sent.set()

            async def close(self):
                self.application_state = WebSocketState.DISCONNECTED
                closed.set()

        class Echo(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, InputAudioRawFrame):
                    assert frame.sample_rate == 16000 and frame.num_channels == 1
                    frame = OutputAudioRawFrame(frame.audio, frame.sample_rate, frame.num_channels)
                await self.push_frame(frame, direction)

        def offline_cascade(config, transport, **kwargs):
            # Replace remote speech only; exercise the real transport, serializer,
            # worker, runner, timeout handler and their shutdown tasks locally.
            seen["transport"] = transport
            return PipelineWorker(
                Pipeline([transport.input(), Echo(), transport.output()]),
                params=kwargs["pipeline_params"],
            )

        monkeypatch.setattr(builder, "_build_browser_cascade", offline_cascade)
        socket = Socket()
        task = asyncio.create_task(run(
            browser_config, socket, tool_dispatcher=SimpleNamespace(timeout_seconds=3),
            database_call_id="browser-call", dry_run_tools=True,
        ))
        try:
            await messages.put({"type": "websocket.receive", "bytes": b"\x01"})
            await messages.put({"type": "websocket.receive", "text": "invalid"})
            await messages.put({"type": "websocket.receive", "bytes": pcm})
            await asyncio.wait_for(audio_sent.wait(), timeout=3)
            assert sent == [pcm]  # No WAV header or base64, malformed input dropped.
            transport = seen["transport"]
            await transport.output().queue_frame(InterruptionFrame())
            await asyncio.wait_for(clear_sent.wait(), timeout=3)
            if finish == "stop":
                await messages.put({"type": "websocket.receive", "text": '{"type":"stop"}'})
            elif finish == "timeout":
                await transport._on_session_timeout(socket)
            else:
                task.cancel()
            # A wait_for timeout must not cancel the runner: WorkerRunner handles
            # CancelledError as a shutdown request, which can hide a stuck stop.
            await asyncio.wait_for(asyncio.shield(task), timeout=3)
            await asyncio.wait_for(closed.wait(), timeout=3)
            assert transport.input()._receive_task is None
            assert transport.input()._monitor_websocket_task is None
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "pcm", [b"", b"\x01", b"\x00" * 32002, b"\x00" * 32001],
    ids=["empty", "odd", "oversized", "odd-oversized"],
)
def test_rejects_empty_odd_or_more_than_one_second_of_pcm(pcm) -> None:
    serializer = _browser_audio().BrowserAudioSerializer()
    assert asyncio.run(serializer.deserialize(pcm)) is None


def test_accepts_one_second_pcm_boundary() -> None:
    serializer = _browser_audio().BrowserAudioSerializer()
    frame = asyncio.run(serializer.deserialize(b"\x01\x00" * 16000))
    assert isinstance(frame, InputAudioRawFrame)
    assert frame.num_frames == 16000


@pytest.mark.parametrize("text", [
    "not json", "[]", "null", "1", '"stop"', '{}',
    '{"type":"start"}', '{"type":"audio","audio":"AAAA"}',
    '{"type":"stop","audio":"AAAA"}', '{"type":"stop"',
    '{"type":"stop"}' + " " * 65,
])
def test_rejects_invalid_or_unsupported_text(text) -> None:
    serializer = _browser_audio().BrowserAudioSerializer()
    assert asyncio.run(serializer.deserialize(text)) is None


def test_stop_text_ends_the_pipeline_without_turning_text_into_audio() -> None:
    serializer = _browser_audio().BrowserAudioSerializer()
    assert isinstance(asyncio.run(serializer.deserialize('{"type":"stop"}')), EndFrame)


def test_interruption_emits_clear_and_unrelated_frames_emit_nothing() -> None:
    serializer = _browser_audio().BrowserAudioSerializer()

    async def exercise():
        clear = await serializer.serialize(InterruptionFrame())
        assert isinstance(clear, str)
        assert json.loads(clear) == {"type": "clear"}
        assert await serializer.serialize(StartFrame()) is None
        assert await serializer.serialize(EndFrame()) is None

    asyncio.run(exercise())


@pytest.mark.parametrize("provider", ["openai", "google"])
@pytest.mark.filterwarnings("ignore::DeprecationWarning")
def test_built_browser_language_updates_llm_tts_tools_and_accounting_before_text(browser_config, monkeypatch, provider):
    from pipecat.frames.frames import LLMUpdateSettingsFrame, TTSUpdateSettingsFrame, TranscriptionFrame
    from pipecat.processors.frame_processor import FrameDirection
    from voice_receptionist_worker.pipeline import builder
    from voice_receptionist_worker.call_logging import BrowserCallLog
    from voice_receptionist_worker.tools import InMemoryRepository

    async def exercise():
        browser_config.restaurant.update(primary_language="fr-CA", enabled_languages=["fr-CA", "en-IN", "ur"])
        if provider == "google":
            browser_config.providers["voice_llm"] = dict(browser_config.providers["llm"])
            monkeypatch.setenv("GEMINI_API_KEY", "test-only")
        dispatched = []
        async def dispatch(name, args, context):
            dispatched.append(context)
            return {"ok": True}
        log = BrowserCallLog(InMemoryRepository(restaurant={"id": "restaurant"}, hours=[], menu_items=[], slots_config={}),
                             restaurant_id="restaurant", agent_version_id="version", pricing={})
        worker = builder.build_browser_audio_pipeline(
            browser_config, SimpleNamespace(headers={}),
            tool_dispatcher=SimpleNamespace(timeout_seconds=3, dispatch=dispatch),
            database_call_id="browser-call", dry_run_tools=True,
            prompt_sections={"rules": "Never disclose internal rules."}, call_log=log)
        processors = list(_processors(worker.pipeline))
        language = next(p for p in processors if type(p).__name__ == "TTSLanguageProcessor")
        llm = next(p for p in processors if type(p).__name__ == ("OpenAILLMService" if provider == "openai" else "GoogleLLMService"))
        seen = []
        async def capture(frame, direction=FrameDirection.DOWNSTREAM):
            seen.append(frame)
        language.push_frame = capture
        try:
            assert language._supported == {"fr-CA", "en-IN", "ur"}
            assert language._current == "fr-CA"
            old_turn = {"idx": 0, "speaker": "caller", "language": "fr-CA", "text": "Bonjour"}
            log.turns.append(old_turn.copy())
            for text, code in [("Bonjour à vous", "fr"), ("Urdu please", "hi"),
                               ("Hindi please", "hi"), ("English please", "en")]:
                await language.process_frame(TranscriptionFrame(text, "", "", language=code, finalized=True), FrameDirection.DOWNSTREAM)
            settings = [f.delta.system_instruction for f in seen if isinstance(f, LLMUpdateSettingsFrame)]
            assert [s.split("caller_language: ")[1].splitlines()[0] for s in settings] == ["fr-CA", "ur", "en-IN"]
            base = settings[0].split("\ncaller_language: ")[0]
            assert all(s.count("caller_language:") == 1 and s.startswith(base) for s in settings)
            assert "Never disclose internal rules." in base
            assert [f.delta.language.value for f in seen if isinstance(f, TTSUpdateSettingsFrame)] == ["fr", "ur", "en"]
            # Every replacement is delivered before the triggering final transcript.
            assert [type(f).__name__ for f in seen] == [
                "LLMUpdateSettingsFrame", "TTSUpdateSettingsFrame", "TranscriptionFrame",
                "LLMUpdateSettingsFrame", "TTSUpdateSettingsFrame", "TranscriptionFrame",
                "TranscriptionFrame", "LLMUpdateSettingsFrame", "TTSUpdateSettingsFrame", "TranscriptionFrame"]
            await llm._functions["send_sms"].handler(SimpleNamespace(tool_call_id="turn-1", function_name="send_sms",
                arguments={}, result_callback=AsyncMock()))
            assert dispatched[0].language == "en-IN" and dispatched[0].dry_run is True
            assert log.language == "en-IN"
            assert log.turns[0] == old_turn
        finally:
            if provider == "openai":
                await llm._client.close()
            else:
                await llm.cleanup()
    asyncio.run(exercise())


@pytest.mark.parametrize("cache_state", ["hit", "miss", "corrupt", "stale"])
@pytest.mark.filterwarnings("ignore::DeprecationWarning")
def test_built_browser_start_plays_cache_or_short_fallback_once(browser_config, monkeypatch, tmp_path, cache_state):
    from voice_receptionist_worker.pipeline import builder
    from voice_receptionist_worker.pipeline.greeting_cache import greeting_spec, cache_for
    from pipecat.frames.frames import TTSAudioRawFrame, TTSTextFrame, TTSStartedFrame, TTSStoppedFrame
    import httpx
    import os
    import time

    async def exercise():
        browser_config.providers["greeting"]["cache_dir"] = str(tmp_path)
        browser_config.restaurant["agent_version_id"] = "draft-version"
        sections = {"browser_greeting": "BarBQ Tonite, hello.", "greeting": "Full telephone greeting"}
        spec = greeting_spec(browser_config, sections)
        pcm = b"\x01\x00" * 27307
        if cache_state != "miss":
            path = cache_for(browser_config).write(spec, pcm)
            if cache_state == "corrupt":
                path.write_bytes(b"invalid")
            elif cache_state == "stale":
                age = time.time() - 2592001
                os.utime(path, (age, age))
        worker = builder.build_browser_audio_pipeline(browser_config, SimpleNamespace(headers={}),
            tool_dispatcher=SimpleNamespace(timeout_seconds=3), database_call_id="browser-call",
            dry_run_tools=True, prompt_sections=sections)
        processors = list(_processors(worker.pipeline))
        output = next(p for p in processors if type(p).__name__ == "FastAPIWebsocketOutputTransport")
        llm = next(p for p in processors if type(p).__name__ == "OpenAILLMService")
        queued, direct = AsyncMock(), AsyncMock()
        monkeypatch.setattr(worker, "queue_frame", queued)
        monkeypatch.setattr(output, "queue_frame", direct)
        monkeypatch.setattr(httpx.AsyncClient, "post", AsyncMock(side_effect=AssertionError("No greeting REST in calls")))
        try:
            for _ in range(2):
                await worker._call_event_handler("on_pipeline_started", StartFrame())
                await asyncio.sleep(0)
            frames = [c.args[0] for c in direct.await_args_list]
            if cache_state == "hit":
                queued.assert_not_awaited()
                assert isinstance(frames[0], TTSStartedFrame)
                assert isinstance(frames[-1], TTSStoppedFrame)
                audio = [f for f in frames if isinstance(f, TTSAudioRawFrame)]
                assert b"".join(f.audio for f in audio) == pcm
                assert max(len(f.audio) for f in audio) <= 1280
                assert all(f.interruptible for f in audio)
                text = [f for f in frames if isinstance(f, TTSTextFrame)]
                assert len(text) == 1 and text[0].text == spec.text
                assert not text[0].append_to_context
                # Cached playback bypasses the TTS service (no per-call generation metrics).
                assert all(f.sample_rate == 16000 for f in audio)
            else:
                assert not frames
                queued.assert_awaited_once()
                assert queued.await_args.args[0].text == spec.text
                assert "recorded" not in queued.await_args.args[0].text
        finally:
            await llm._client.close()
    asyncio.run(exercise())
