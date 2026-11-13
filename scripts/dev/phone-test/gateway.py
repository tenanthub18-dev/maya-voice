"""Local launcher only: proxy signed SMS events without exposing the dashboard.

The existing worker serves voice HTTP/WebSocket traffic. The existing Next.js
handler owns SMS signature verification, opt-outs and delivery receipts.
"""
import os

import httpx
from starlette.requests import Request
from starlette.responses import Response

from voice_receptionist_worker.main import app as worker


async def app(scope, receive, send):
    if scope["type"] != "http" or scope["path"] != "/api/webhooks/telnyx-sms":
        return await worker(scope, receive, send)
    request = Request(scope, receive)
    if request.method != "POST":
        return await Response(status_code=405)(scope, receive, send)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 64 * 1024:
            return await Response(status_code=413)(scope, receive, send)
    headers = {key: request.headers[key] for key in
               ["content-type", "telnyx-signature-ed25519", "telnyx-timestamp"] if key in request.headers}
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            response = await client.post(os.environ["PHONE_TEST_WEB_ORIGIN"] + scope["path"],
                                         content=bytes(body), headers=headers)
        result = Response(response.content, status_code=response.status_code,
                          media_type=response.headers.get("content-type", "application/json"))
    except httpx.HTTPError:
        result = Response(status_code=503)
    await result(scope, receive, send)
