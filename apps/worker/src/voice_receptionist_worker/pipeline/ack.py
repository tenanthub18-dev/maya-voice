"""Pre-recorded acknowledgement ("Mm-hm", "हाँ जी") played the moment the caller's turn ends.

The real answer still comes from the LLM; the clip only shortens the silence the caller hears. Clips are
rendered once per process with Soniox REST text-to-speech (same voice as the call) and cached:
https://soniox.com/docs/tts/rest-api/generate-speech
`first_audio_ms` (the clip) and `content_ms` (the real answer) are logged separately so the clip never
hides how long the answer takes.
"""
from __future__ import annotations

import asyncio
import json
import random
import time
from pathlib import Path

import httpx
from loguru import logger
import numpy as np
import soxr

# Short reactions per caller language (tags are English, text is the call language).
ACK_PHRASES: dict[str, list[str]] = {
    # Neutral "I'm listening" sounds only: they must fit before any answer, including a "no".
    "en": ["[warm] Mm-hm.", "[warm] Okay.", "[warm] Mm."],
    "fr": ["[warm] Mm-hm.", "[warm] D'accord."],
    "hi": ["[warm] अच्छा.", "[warm] हम्म."],
    "pa": ["[warm] ਅੱਛਾ.", "[warm] ਹੂੰ."],
    "ur": ["[warm] اچھا.", "[warm] جی."],
    "te": ["[warm] సరే.", "[warm] హ్మ్."],
    "ar": ["[warm] تمام.", "[warm] همم."],
}
_SOURCE_RATE = 24000
_TTS_URL = "https://tts-rt.soniox.com/tts"
_cache: dict[tuple[str, str], list[bytes]] = {}
_locks: dict[tuple[str, str], asyncio.Lock] = {}


async def load_clips(api_key: str, model: str, voice: str, language: str) -> list[bytes]:
    """PCM s16le mono clips at 24 kHz for one language; rendered once and cached."""
    key = (voice, language)
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        if key in _cache:
            return _cache[key]
        clips: list[bytes] = []
        async with httpx.AsyncClient(timeout=20) as client:
            for phrase in ACK_PHRASES[language]:
                response = await client.post(
                    _TTS_URL,
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "model": model,
                        "language": language,
                        "voice": voice,
                        "audio_format": "pcm_s16le",
                        "sample_rate": _SOURCE_RATE,
                        "text": phrase,
                    },
                )
                response.raise_for_status()
                clips.append(response.content)
        _cache[key] = clips
        return clips


def resample(pcm: bytes, target_rate: int) -> bytes:
    if target_rate == _SOURCE_RATE:
        return pcm
    samples = np.frombuffer(pcm, dtype=np.int16)
    return soxr.resample(samples, _SOURCE_RATE, target_rate).astype(np.int16).tobytes()


class AckPlayer:
    """Plays a cached clip when a user turn stops; tracks the caller's language."""

    def __init__(self, api_key: str, model: str, voice: str) -> None:
        self._api_key, self._model, self._voice = api_key, model, voice
        self.language = "en"
        self.stopped_at: float | None = None
        self._ready: dict[str, list[bytes]] = {}
        self._tasks: list[asyncio.Task] = []

    def preload(self) -> None:
        # Sequential: Soniox allows only a few concurrent TTS requests per project.
        self._tasks.append(asyncio.create_task(self._load_all()))

    async def _load_all(self) -> None:
        for language in ACK_PHRASES:
            await self._load(language)

    async def _load(self, language: str) -> None:
        try:
            self._ready[language] = await load_clips(self._api_key, self._model, self._voice, language)
        except Exception as error:  # a missing clip only means no acknowledgement for that language
            logger.warning("ack clip load failed for {}: {}", language, type(error).__name__)
            self._ready.pop(language, None)

    def set_language(self, code: str) -> None:
        self.language = code.split("-")[0]

    async def on_turn_stopped(self, output, sample_rate: int) -> None:
        self.stopped_at = time.monotonic()
        clips = self._ready.get(self.language) or self._ready.get("en")
        if not clips:
            return
        from pipecat.frames.frames import OutputAudioRawFrame
        from pipecat.processors.frame_processor import FrameDirection

        pcm = resample(random.choice(clips), sample_rate)
        # Straight to the transport output: frames sent through the pipeline wait behind the LLM request.
        await output.queue_frame(
            OutputAudioRawFrame(audio=pcm, sample_rate=sample_rate, num_channels=1), FrameDirection.DOWNSTREAM
        )


def make_probe(player: AckPlayer, path: str | Path, call_id: str):
    """Build the probe lazily: Pipecat imports must stay out of module import time (tests treat its warnings as errors)."""
    from pipecat.frames.frames import Frame, OutputAudioRawFrame, TTSAudioRawFrame
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

    class ContentLatencyProbe(FrameProcessor):
        """Logs first_audio_ms (any audio) and content_ms (the LLM answer's audio) after each turn stop."""

        def __init__(self, player: AckPlayer, path: str | Path, call_id: str) -> None:
            super().__init__()
            self._player, self._path, self._call_id = player, Path(path), call_id
            self._turn = 0
            self._seen_for: float | None = None
            self._first_audio: float | None = None

        async def process_frame(self, frame: Frame, direction: FrameDirection):
            await super().process_frame(frame, direction)
            stopped = self._player.stopped_at
            if stopped is not None and isinstance(frame, OutputAudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
                if self._seen_for != stopped:
                    self._seen_for, self._first_audio = stopped, time.monotonic()
                    self._turn += 1
                if isinstance(frame, TTSAudioRawFrame) and self._first_audio is not None:
                    now = time.monotonic()
                    row = {
                        "call_id": self._call_id,
                        "turn": self._turn,
                        "first_audio_ms": round((self._first_audio - stopped) * 1000, 1),
                        "content_ms": round((now - stopped) * 1000, 1),
                    }
                    self._player.stopped_at = None
                    self._first_audio = None
                    self._path.parent.mkdir(parents=True, exist_ok=True)
                    with self._path.open("a", encoding="utf-8") as output:
                        output.write(json.dumps(row) + "\n")
            await self.push_frame(frame, direction)

    return ContentLatencyProbe(player, path, call_id)
