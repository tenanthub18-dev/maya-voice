"""Bound public-demo input before it reaches Pipecat's internal queues."""
import json
import time
from collections.abc import Callable
from typing import Any


class BrowserAudioSocket:
    """Forward the Starlette interface with a 16kHz PCM token bucket.

    Allow three seconds of startup/network jitter, then at most real-time audio.
    Uvicorn also caps individual frames and its receive queue in local.py.
    https://www.starlette.io/websockets/
    """
    def __init__(self, socket: Any, *, clock: Callable[[], float] = time.monotonic):
        self._socket = socket
        self._clock = clock
        self._last = clock()
        self._bytes = 96000.0
        self._messages = 200.0

    def __getattr__(self, name: str) -> Any:
        return getattr(self._socket, name)

    async def receive(self) -> dict[str, Any]:
        frame = await self._socket.receive()
        if frame['type'] != 'websocket.receive':
            return frame
        now = self._clock()
        elapsed = max(0, now - self._last)
        self._last = now
        self._bytes = min(96000.0, self._bytes + elapsed * 32000)
        self._messages = min(200.0, self._messages + elapsed * 80)
        self._messages -= 1
        audio = frame.get('bytes')
        valid = self._messages >= 0
        if audio is not None:
            valid = valid and 0 < len(audio) <= 16000 and len(audio) % 2 == 0
            self._bytes -= len(audio)
            valid = valid and self._bytes >= 0
        else:
            text = frame.get('text', '')
            try:
                valid = valid and len(text) <= 64 and json.loads(text) == {'type': 'stop'}
            except (ValueError, TypeError):
                valid = False
        if not valid:
            await self._socket.close(code=1008)
            return {'type': 'websocket.disconnect', 'code': 1008}
        return frame
