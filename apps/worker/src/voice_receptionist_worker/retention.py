from __future__ import annotations

from typing import Any

import httpx


async def run_retention(
    web_app_url: str,
    cron_secret: str,
    *,
    dry_run: bool = False,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Invoke the same protected retention transaction used by the nightly web cron."""
    if not web_app_url.startswith(("https://", "http://localhost")):
        raise ValueError("Retention endpoint must use HTTPS outside localhost")
    owns_client = client is None
    active_client = client or httpx.AsyncClient(timeout=30)
    try:
        response = await active_client.post(
            f"{web_app_url.rstrip('/')}/api/cron/retention",
            params={"dryRun": "true" if dry_run else "false"},
            headers={"Authorization": f"Bearer {cron_secret}"},
        )
        response.raise_for_status()
        result = response.json()
        if not isinstance(result, dict):
            raise ValueError("Retention response must be an object")
        return result
    finally:
        if owns_client:
            await active_client.aclose()
