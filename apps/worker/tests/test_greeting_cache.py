"""Static browser greeting cache: no paid providers in tests."""
import asyncio
from dataclasses import replace
import os
import time

import httpx
import pytest


def test_cache_key_integrity_duration_and_expiry(tmp_path):
    from voice_receptionist_worker.pipeline.greeting_cache import GreetingCache, GreetingSpec
    spec = GreetingSpec("version", "restaurant", "BarBQ Tonite, hello.", "model", "voice", "en", 16000)
    cache = GreetingCache(tmp_path, max_age_seconds=60)
    pcm = b"\x01\x00" * 27307
    assert cache.read(spec) is None
    path = cache.write(spec, pcm)
    assert cache.read(spec) == pcm
    assert path.name == spec.key + ".clip"
    assert all(word not in path.name for word in ("restaurant", "voice", "version"))
    for field, value in [("agent_version_id", "v2"), ("restaurant_id", "r2"), ("text", "Hello."),
                         ("model", "m2"), ("voice", "v2"), ("language", "fr-CA"), ("sample_rate", 24000)]:
        changed = replace(spec, **{field: value})
        assert cache.read(changed) is None
        (tmp_path / (changed.key + ".clip")).write_bytes(path.read_bytes())
        assert cache.read(changed) is None  # Renaming a different identity cannot hit.
    for invalid in (b"", b"x", b"\0\0" * 32001):
        with pytest.raises(ValueError):
            cache.write(spec, invalid)
    encoded = path.read_bytes()
    path.write_bytes(encoded[:-1] + b"x")
    assert cache.read(spec) is None
    cache.write(spec, pcm)
    os.utime(path, (time.time() - 61, time.time() - 61))
    assert cache.read(spec) is None
    assert not list(tmp_path.glob("*.tmp"))


def test_prepare_browser_greeting_is_explicit_and_reuses_cache(tmp_path):
    from voice_receptionist_worker.pipeline.greeting_cache import prepare_browser_greeting, greeting_spec, cache_for
    from voice_receptionist_worker.pipeline.config import RuntimeConfig
    config = RuntimeConfig(providers={"tts": {"model": "model", "voice": "voice"},
        "greeting": {"endpoint": "https://tts.invalid/tts", "cache_dir": str(tmp_path), "sample_rate": 16000}},
        restaurant={"id": "restaurant", "agent_version_id": "version", "name": "Restaurant", "primary_language": "en"})
    sections = {"browser_greeting": "BarBQ Tonite, hello."}
    requests = []
    def respond(request):
        import json
        requests.append(request)
        assert request.headers["authorization"] == "Bearer test-only"
        assert json.loads(request.content) == {"model": "model", "voice": "voice", "text": sections["browser_greeting"],
            "language": "en", "audio_format": "pcm_s16le", "sample_rate": 16000}
        return httpx.Response(200, headers={"Content-Type": "audio/pcm"}, content=b"\x01\x00" * 27000)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            first = await prepare_browser_greeting(config, sections, api_key="test-only", client=client)
            assert await prepare_browser_greeting(config, sections, api_key="test-only", client=client) == first
        assert cache_for(config).read(greeting_spec(config, sections)) == b"\x01\x00" * 27000
    asyncio.run(scenario())
    assert len(requests) == 1


def test_browser_short_greeting_and_phone_recording_notice_are_separate():
    from voice_receptionist_worker.pipeline.prompt import build_browser_greeting, build_greeting
    restaurant = {"name": "A Restaurant With A Very Long Name"}
    assert build_browser_greeting(restaurant, None) == "Hello."
    assert build_browser_greeting({"name": "BarBQ Tonite"}, None) == "BarBQ Tonite."
    sections = {"greeting": "A long telephone introduction", "browser_greeting": "BarBQ Tonite, hello."}
    assert build_browser_greeting(restaurant, sections) == "BarBQ Tonite, hello."
    assert "may be recorded" in build_greeting(restaurant, sections)
    assert "long telephone introduction" in build_greeting(restaurant, sections)


@pytest.mark.parametrize("sample_rate,interrupted,large_injection", [(16000, False, False), (24000, False, False),
                                                                   (16000, True, False), (16000, False, True)])
@pytest.mark.filterwarnings("ignore::DeprecationWarning")
def test_cached_playback_real_output_lifecycle_and_chunking(tmp_path, sample_rate, interrupted, large_injection):
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        from pipecat.frames.frames import (BotStartedSpeakingFrame, BotStoppedSpeakingFrame, EndFrame,
            InterruptionFrame, TTSAudioRawFrame, TTSTextFrame, TTSStoppedFrame)
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.worker import PipelineWorker, PipelineParams
        from pipecat.observers.base_observer import BaseObserver
        from pipecat.transports.base_output import BaseOutputTransport
        from pipecat.transports.base_transport import TransportParams
        from pipecat.workers.runner import WorkerRunner
    from voice_receptionist_worker.pipeline.config import RuntimeConfig
    from voice_receptionist_worker.pipeline.greeting_cache import BrowserGreeting
    from voice_receptionist_worker.call_logging import BrowserCallLog
    from types import SimpleNamespace

    async def scenario():
        config = RuntimeConfig({"tts": {"model": "model", "voice": "voice"},
            "greeting": {"cache_dir": str(tmp_path)}},
            {"id": "restaurant", "agent_version_id": "draft", "name": "BarBQ Tonite"})
        greeting = BrowserGreeting(config, {"browser_greeting": "BarBQ Tonite, hello."}, language="en")
        pcm = b"\x01\x00" * 27307
        greeting.cache.write(greeting.spec, pcm)
        sent, events = [], []
        first_audio, completed, cleared = asyncio.Event(), asyncio.Event(), asyncio.Event()
        class Output(BaseOutputTransport):
            async def start(self, frame):
                await super().start(frame)
                await self.set_transport_ready(frame)
            async def write_audio_frame(self, frame):
                sent.append(frame)
                first_audio.set()
                await asyncio.sleep(0.003)
                return True
        output = Output(TransportParams(audio_out_enabled=True, audio_out_sample_rate=sample_rate,
                                         audio_out_end_silence_secs=0))
        class Events(BaseObserver):
            async def on_push_frame(self, data):
                if data.source is output:
                    events.append(data.frame)
                    if isinstance(data.frame, TTSStoppedFrame):
                        completed.set()
                    if isinstance(data.frame, InterruptionFrame):
                        cleared.set()
        log = BrowserCallLog(None, restaurant_id="restaurant", agent_version_id="draft", pricing={})
        worker = PipelineWorker(Pipeline([output]), enable_rtvi=False,
            params=PipelineParams(audio_out_sample_rate=sample_rate),
            observers=[Events(), *log.observers(output=output, speech=SimpleNamespace(settings=SimpleNamespace(model="model")))])
        @worker.event_handler("on_pipeline_started")
        async def play(worker, frame):
            if large_injection:
                # Verify installed output chunking also bounds a whole 1.7s input frame.
                await output.queue_frame(TTSAudioRawFrame(pcm, 16000, 1))
                await output.queue_frame(TTSStoppedFrame())
            else:
                await greeting.play(worker, output, sample_rate)
                await greeting.play(worker, output, sample_rate)
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        task = asyncio.create_task(runner.run())
        try:
            await asyncio.wait_for(first_audio.wait(), 3)
            if interrupted:
                await worker.queue_frame(InterruptionFrame())
                await asyncio.wait_for(cleared.wait(), 3)
            else:
                await asyncio.wait_for(completed.wait(), 3)
            await worker.queue_frame(EndFrame())
            await asyncio.wait_for(task, 3)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        assert max(len(f.audio) for f in sent) <= sample_rate * 2  # Public max 1 second.
        assert max(len(f.audio) for f in sent) <= sample_rate * 2 * .04
        assert any(isinstance(f, BotStartedSpeakingFrame) for f in events)
        assert any(isinstance(f, BotStoppedSpeakingFrame) for f in events)
        if interrupted:
            assert len(b"".join(f.audio for f in sent)) < len(pcm)
            assert not log.turns  # No unplayed full greeting claimed after interruption.
        elif not large_injection:
            assert [t["text"] for t in log.turns] == [greeting.spec.text]
            assert log.services == {}  # One-off generation is not per-call provider usage.
            total_seconds = sum(len(f.audio) for f in sent) / (sample_rate * 2)
            assert 1.70 <= total_seconds <= 1.75
    asyncio.run(scenario())


@pytest.mark.parametrize("status,content_type,body", [
    (200, "audio/pcm", b"\x01\x00" * 32001),
    (200, "audio/pcm", b"x"), (200, "audio/pcm", b""),
    (200, "application/json", b"{}"), (503, "application/json", b"private-provider-error"),
])
def test_warm_rejects_invalid_provider_responses_without_cache_files(tmp_path, status, content_type, body):
    from voice_receptionist_worker.pipeline.config import RuntimeConfig
    from voice_receptionist_worker.pipeline.greeting_cache import prepare_browser_greeting
    config = RuntimeConfig({"tts": {"model": "model", "voice": "voice"},
        "greeting": {"cache_dir": str(tmp_path), "endpoint": "https://tts.invalid/tts"}},
        {"id": "restaurant", "agent_version_id": "draft", "name": "Restaurant"})
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request:
            httpx.Response(status, headers={"Content-Type": content_type}, content=body))) as client:
            with pytest.raises(ValueError) as failure:
                await prepare_browser_greeting(config, api_key="test-only", client=client)
            assert "private-provider-error" not in str(failure.value)
    asyncio.run(scenario())
    assert not list(tmp_path.iterdir())
