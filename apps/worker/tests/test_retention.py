import asyncio
import httpx
import pytest

from voice_receptionist_worker.retention import run_retention


def test_python_retention_callable_uses_protected_shared_route_and_dry_run():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"dryRun": True, "recordings": 2, "transcripts": 3})

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await run_retention("https://app.example", "cron-secret", dry_run=True, client=client)

    result = asyncio.run(scenario())

    assert result == {"dryRun": True, "recordings": 2, "transcripts": 3}
    assert seen[0].headers["authorization"] == "Bearer cron-secret"
    assert seen[0].url == "https://app.example/api/cron/retention?dryRun=true"


def test_python_retention_callable_rejects_plain_http_remote_endpoint():
    with pytest.raises(ValueError, match="HTTPS"):
        asyncio.run(run_retention("http://app.example", "cron-secret"))
