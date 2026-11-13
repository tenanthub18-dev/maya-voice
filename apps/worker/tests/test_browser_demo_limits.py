import asyncio
import pytest
from voice_receptionist_worker.security.browser_demo import BrowserAudioSocket
from voice_receptionist_worker.tools.dispatcher import ToolContext, ToolDispatcher


class Socket:
    def __init__(self, frames):
        self.frames = iter(frames)
        self.closed = []
    async def receive(self):
        return next(self.frames)
    async def close(self, *, code):
        self.closed.append(code)


def test_pcm_flood_disconnects_with_bounded_burst():
    async def exercise():
        socket = Socket([{'type': 'websocket.receive', 'bytes': b'\0' * 16000}] * 8)
        limited = BrowserAudioSocket(socket, clock=lambda: 0)
        for _ in range(6):
            assert (await limited.receive())['type'] == 'websocket.receive'
        assert (await limited.receive())['type'] == 'websocket.disconnect'
        assert socket.closed == [1008]
    asyncio.run(exercise())


def test_real_time_pcm_continues_and_malformed_controls_disconnect():
    async def exercise():
        now = [0.0]
        socket = Socket([{'type': 'websocket.receive', 'bytes': b'\0' * 640}] * 1000 + [{'type': 'websocket.receive', 'text': '{"type":"injected"}'}])
        limited = BrowserAudioSocket(socket, clock=lambda: now[0])
        for _ in range(1000):
            now[0] += .02
            assert (await limited.receive())['type'] == 'websocket.receive'
        assert (await limited.receive())['type'] == 'websocket.disconnect'
    asyncio.run(exercise())


def test_private_tools_never_read_database_in_public_demo():
    class NoReads:
        async def select(self, *args, **kwargs):
            pytest.fail('Public demo read private customer data')
    async def exercise():
        dispatcher = ToolDispatcher(NoReads(), allow_private_lookups=False)
        context = ToolContext(call_id='demo-test', turn=1, restaurant_id='restaurant-1', language='en', dry_run=True)
        for tool in ['find_booking', 'modify_booking', 'cancel_booking']:
            result = await dispatcher.dispatch(tool, {'phone': '4165550100', 'booking_id': 'booking-1'}, context)
            assert not result['ok']
            assert 'booking' not in result
    asyncio.run(exercise())
