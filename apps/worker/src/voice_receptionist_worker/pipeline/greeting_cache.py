"""Small persistent browser pickup clips; generation is an explicit operator step.

Soniox raw PCM request contract:
https://docs.soniox.com/tts/rest-api/generate-speech
Pipecat output queue, speech lifecycle and text contracts (installed 1.14.0):
https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/transports/base_output.py
https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/frames/frames.py
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from collections.abc import Mapping

import httpx

from .config import RuntimeConfig
from .prompt import build_browser_greeting

_MAGIC = b"BRG1"
_HEADER_SIZE = 68  # Magic, identity digest, PCM digest. No text or credentials.


@dataclass(frozen=True)
class GreetingSpec:
    agent_version_id: str
    restaurant_id: str
    text: str
    model: str
    voice: str
    language: str
    sample_rate: int = 16000

    @property
    def key(self) -> str:
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _validate_pcm(pcm: bytes, sample_rate: int) -> None:
    if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2 or len(pcm) > sample_rate * 2 * 2:
        raise ValueError("Browser greeting must be mono PCM16, nonempty and at most two seconds")


class GreetingCache:
    def __init__(self, directory: str | Path, *, max_age_seconds: float = 2592000):
        self.directory = Path(directory)
        self.max_age_seconds = max_age_seconds

    def read(self, spec: GreetingSpec) -> bytes | None:
        path = self.directory / (spec.key + ".clip")
        try:
            age = time.time() - path.stat().st_mtime
            if age < 0 or age > self.max_age_seconds:
                return None
            with path.open("rb") as source:
                data = source.read(_HEADER_SIZE + spec.sample_rate * 4 + 1)
            pcm = data[_HEADER_SIZE:]
            _validate_pcm(pcm, spec.sample_rate)
            if (data[:4] != _MAGIC or data[4:36] != bytes.fromhex(spec.key)
                    or data[36:68] != hashlib.sha256(pcm).digest()):
                return None
            return pcm
        except (OSError, ValueError):
            return None

    def write(self, spec: GreetingSpec, pcm: bytes) -> Path:
        _validate_pcm(pcm, spec.sample_rate)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination = self.directory / (spec.key + ".clip")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.directory, suffix=".tmp", delete=False) as output:
                temporary = Path(output.name)
                output.write(_MAGIC + bytes.fromhex(spec.key) + hashlib.sha256(pcm).digest() + pcm)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return destination


def cache_for(config: RuntimeConfig) -> GreetingCache:
    settings = config.providers.get("greeting", {})
    return GreetingCache(settings.get("cache_dir", "/tmp/voice-receptionist-browser-greetings"),
                         max_age_seconds=float(settings.get("max_age_seconds", 2592000)))


def greeting_spec(config: RuntimeConfig, prompt_sections: Mapping[str, str] | None = None,
                  *, language: str | None = None) -> GreetingSpec:
    return GreetingSpec(
        str(config.restaurant.get("agent_version_id") or ""), str(config.restaurant.get("id") or ""),
        build_browser_greeting(config.restaurant, prompt_sections), config.providers["tts"]["model"],
        config.providers["tts"]["voice"], language or config.restaurant.get("primary_language") or "en",
        int(config.providers.get("greeting", {}).get("sample_rate", 16000)),
    )


async def prepare_browser_greeting(
    config: RuntimeConfig, prompt_sections: Mapping[str, str] | None = None, *,
    api_key: str, client: httpx.AsyncClient | None = None,
) -> Path:
    """Warm outside calls. Cache hits never send requests; >2s audio is rejected.

    The caller supplies the DB draft's exact id, restaurant, primary language and
    prompt sections. Never load credentials or make this call from a call handler.
    """
    spec, cache = greeting_spec(config, prompt_sections), cache_for(config)
    if not spec.agent_version_id or not spec.restaurant_id:
        raise ValueError("Warm with the exact draft and restaurant identity")
    if spec.sample_rate != 16000:
        raise ValueError("Prepare browser greetings at 16000 Hz")
    if cache.read(spec) is not None:
        return cache.directory / (spec.key + ".clip")
    if client is None:
        async with httpx.AsyncClient(timeout=20) as owned:
            return await prepare_browser_greeting(config, prompt_sections, api_key=api_key, client=owned)
    # Stream into a bounded buffer; never retain a provider error body or log it.
    async with client.stream("POST", config.providers["greeting"]["endpoint"],
        headers={"Authorization": f"Bearer {api_key}"}, json={
            "model": spec.model, "voice": spec.voice, "language": spec.language.split("-")[0],
            "text": spec.text, "audio_format": "pcm_s16le", "sample_rate": spec.sample_rate,
        }) as response:
        if (response.status_code != 200
                or response.headers.get("content-type", "").split(";")[0] != "audio/pcm"):
            raise ValueError("Browser greeting generation failed")
        chunks = bytearray()
        async for chunk in response.aiter_bytes(chunk_size=4096):
            if len(chunks) + len(chunk) > spec.sample_rate * 4:
                raise ValueError("Browser greeting exceeds two seconds; use shorter text and warm again")
            chunks.extend(chunk)
    return cache.write(spec, bytes(chunks))


class BrowserGreeting:
    def __init__(self, config: RuntimeConfig, prompt_sections: Mapping[str, str] | None, *, language: str):
        self.spec = greeting_spec(config, prompt_sections, language=language)
        self.cache = cache_for(config)
        self.played = False

    async def play(self, worker, output, sample_rate: int) -> None:
        if self.played:
            return
        self.played = True
        from pipecat.frames.frames import TTSStartedFrame, TTSAudioRawFrame, TTSTextFrame, TTSStoppedFrame, TTSSpeakFrame
        from pipecat.processors.frame_processor import FrameDirection

        pcm = self.cache.read(self.spec)
        if pcm is not None and sample_rate != self.spec.sample_rate:
            import numpy as np
            import soxr
            try:
                pcm = soxr.resample(np.frombuffer(pcm, dtype="<i2"), self.spec.sample_rate, sample_rate).astype("<i2").tobytes()
                _validate_pcm(pcm, sample_rate)
            except (ValueError, RuntimeError):
                pcm = None
        if pcm is None:
            # Honest cold-cache fallback: live TTS adds first-call latency. No REST here.
            await worker.queue_frame(TTSSpeakFrame(text=self.spec.text, append_to_context=False))
            return
        context_id = "browser-greeting"
        await output.queue_frame(TTSStartedFrame(context_id=context_id, append_to_context=False), FrameDirection.DOWNSTREAM)
        # 40 ms chunks, below the public player's one-second message limit even
        # before BaseOutputTransport rechunks/resamples. Interruptible by default.
        chunk_bytes = sample_rate * 2 * 40 // 1000
        for offset in range(0, len(pcm), chunk_bytes):
            await output.queue_frame(TTSAudioRawFrame(audio=pcm[offset:offset + chunk_bytes],
                sample_rate=sample_rate, num_channels=1), FrameDirection.DOWNSTREAM)
        text = TTSTextFrame(text=self.spec.text, text_type="sentence")
        text.append_to_context = False
        # Released by the transport after the clip plays; a dropped interrupted
        # clip never contributes an unplayed full sentence to the transcript.
        await output.queue_frame(text, FrameDirection.DOWNSTREAM)
        await output.queue_frame(TTSStoppedFrame(context_id=context_id), FrameDirection.DOWNSTREAM)
