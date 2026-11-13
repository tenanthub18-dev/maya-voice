"""Silent live browser-audio smoke through the public tunnel; no phone/SMS.

Uses the private local demo code to request a session, sends an existing caller
clip at real-time PCM16/16kHz and records the AI reply under ignored tmp/.
Run with apps/worker/.venv/bin/python. AI API usage applies.
"""
import asyncio
import json
import time
import wave
from pathlib import Path

import httpx
import numpy as np
import websockets

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'tmp/phone-test'


async def main():
    state = json.loads((OUT / 'runtime.json').read_text())
    origin = state['env']['NEXT_PUBLIC_APP_URL']
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(origin + '/api/demo/session', headers={'origin': origin},
                                     json={'accessCode': state['env']['VOICE_DEMO_ACCESS_CODE']})
        response.raise_for_status()
        session = response.json()
    # Always exercise the actual internet tunnel, even when obtaining the session locally.
    url = state['public_url'].replace('https:', 'wss:') + '/browser-call'
    clip = ROOT / 'scripts/dev/voice-test/clips/en.wav'
    with wave.open(str(clip)) as source:
        assert source.getnchannels() == 1 and source.getsampwidth() == 2
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype='<i2')
        rate = source.getframerate()
    resampled = np.interp(np.arange(0, len(samples), rate / 16000), np.arange(len(samples)), samples).astype('<i2').tobytes()
    lead = 8
    pcm = b'\0\0' * (16000 * lead) + resampled + b'\0\0' * (16000 * 12)
    received = []
    greeting = answer = False
    async with websockets.connect(url, origin=origin, max_size=65536, open_timeout=15) as ws:
        await ws.send(json.dumps({'type': 'authenticate', 'token': session['token']}))
        assert json.loads(await ws.recv()) == {'type': 'ready'}
        started = time.monotonic()

        async def capture():
            nonlocal greeting, answer
            async for message in ws:
                if isinstance(message, bytes):
                    received.append(message)
                    level = np.sqrt(np.mean(np.frombuffer(message, dtype='<i2').astype(float) ** 2))
                    if level > 150:
                        if time.monotonic() - started < lead:
                            greeting = True
                        elif time.monotonic() - started > lead + len(resampled) / 32000:
                            answer = True
                elif json.loads(message).get('type') == 'error':
                    raise RuntimeError('Worker returned a voice error; inspect private worker log')

        recorder = asyncio.create_task(capture())
        for offset in range(0, len(pcm), 640):
            await ws.send(pcm[offset:offset + 640])
            await asyncio.sleep(max(0, started + (offset + 640) / 32000 - time.monotonic()))
        await ws.close()
        await recorder
    with wave.open(str(OUT / 'browser-reply.wav'), 'wb') as target:
        target.setnchannels(1); target.setsampwidth(2); target.setframerate(16000)
        target.writeframes(b''.join(received))
    print(f'Public WSS live audio: greeting={greeting}, reply_after_caller={answer}, received_bytes={sum(map(len, received))}')
    if not greeting or not answer:
        raise RuntimeError('No audible greeting or reply after caller audio')


if __name__ == '__main__':
    asyncio.run(main())
