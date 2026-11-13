"""Browser wire format: binary mono PCM16LE at 16 kHz and small JSON controls."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable

from pipecat.frames.frames import (
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer


# Pipecat 1.14.0 contracts: serializers/base_serializer.py and frames/frames.py.
# https://docs.pipecat.ai/api-reference/server/transports/websocket/fastapi
BROWSER_SAMPLE_RATE = 16000
MAX_PCM_BYTES = 32000  # At most one second per message; no serializer buffering.
MAX_CONTROL_CHARS = 64


class BrowserAudioSerializer(FrameSerializer):
    """Keep PCM bytes unchanged; discard malformed or unsupported messages.

    Clients send signed little-endian PCM16, one mono sample every two bytes.
    The only accepted text control is {"type":"stop"}. Returning None rejects
    a message without passing caller-controlled text into the speech pipeline.
    """

    def __init__(
        self, *, on_stop: Callable[[EndFrame], Awaitable[None]] | None = None
    ) -> None:
        super().__init__()
        self._on_stop = on_stop

    async def deserialize(self, data: str | bytes) -> Frame | None:
        if isinstance(data, bytes):
            if not data or len(data) % 2 or len(data) > MAX_PCM_BYTES:
                return None
            return InputAudioRawFrame(
                audio=data, sample_rate=BROWSER_SAMPLE_RATE, num_channels=1
            )
        if not isinstance(data, str) or len(data) > MAX_CONTROL_CHARS:
            return None
        try:
            control = json.loads(data)
        except (ValueError, RecursionError):
            return None
        if control == {"type": "stop"}:
            frame = EndFrame()
            if self._on_stop:
                # FastAPI input pushes decoded frames directly downstream. Route
                # a terminal frame through the worker queue so it also exits.
                await self._on_stop(frame)
                return None
            return frame
        return None

    async def serialize(self, frame: Frame) -> str | bytes | None:
        if isinstance(frame, OutputAudioRawFrame):
            return frame.audio
        if isinstance(frame, InterruptionFrame):
            return '{"type":"clear"}'
        return None
