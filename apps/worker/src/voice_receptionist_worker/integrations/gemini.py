from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

import httpx


class GeminiError(RuntimeError):
    pass


@dataclass(frozen=True)
class PostCallAnalysis:
    summary: str
    outcome: str
    qa_flags: tuple[str, ...]
    total_tokens: int = 0


class GeminiClient:
    """Minimal Gemini generateContent client for structured post-call output.

    Request/response contract:
    https://ai.google.dev/api/generate-content
    Structured output:
    https://ai.google.dev/gemini-api/docs/structured-output
    """

    _OUTCOMES = {"booking", "order", "message", "answered", "transferred"}

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_seconds: float = 10.0,
        max_attempts: int = 3,
        backoff_seconds: float = 0.25,
    ) -> None:
        if not api_key or not model:
            raise ValueError("Gemini api_key and model are required")
        self._model = model
        self._client = httpx.AsyncClient(
            transport=transport,
            timeout=timeout_seconds,
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
        )
        self._max_attempts = max_attempts
        self._backoff_seconds = backoff_seconds

    async def aclose(self) -> None:
        await self._client.aclose()

    async def analyze_call(self, transcript: str) -> PostCallAnalysis:
        body = {
            "systemInstruction": {
                "parts": [
                    {
                        "text": (
                            "Summarize this restaurant call. Output only the requested JSON. "
                            "Flag safety, abuse, failed tools, or caller dissatisfaction."
                        )
                    }
                ]
            },
            "contents": [{"role": "user", "parts": [{"text": transcript}]}],
            "generationConfig": {
                "maxOutputTokens": 800,
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"},
                        "outcome": {
                            "type": "string",
                            "enum": sorted(self._OUTCOMES),
                        },
                        "qa_flags": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["summary", "outcome", "qa_flags"],
                },
            },
        }
        response = await self._post_with_retry(body)
        try:
            text = response["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(text)
            summary = parsed["summary"]
            outcome = parsed["outcome"]
            qa_flags = parsed["qa_flags"]
            total_tokens = int(response.get("usageMetadata", {}).get("totalTokenCount", 0))
        except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise GeminiError("Gemini returned malformed structured output") from exc
        if not isinstance(summary, str) or not summary.strip():
            raise GeminiError("Gemini summary was empty")
        if outcome not in self._OUTCOMES:
            raise GeminiError("Gemini outcome was invalid")
        if not isinstance(qa_flags, list) or not all(isinstance(flag, str) for flag in qa_flags):
            raise GeminiError("Gemini qa_flags were invalid")
        return PostCallAnalysis(summary.strip(), outcome, tuple(qa_flags), total_tokens)

    async def _post_with_retry(self, body: dict[str, Any]) -> dict[str, Any]:
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self._model}:generateContent"
        )
        for attempt in range(self._max_attempts):
            try:
                response = await self._client.post(url, json=body)
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                if attempt + 1 == self._max_attempts:
                    raise GeminiError("Gemini request failed after retries") from exc
            else:
                if response.status_code < 400:
                    try:
                        return dict(response.json())
                    except (ValueError, TypeError) as exc:
                        raise GeminiError("Gemini returned invalid JSON") from exc
                if response.status_code not in {408, 429, 503}:
                    raise GeminiError(f"Gemini request failed with status {response.status_code}")
                if attempt + 1 == self._max_attempts:
                    raise GeminiError("Gemini transient error persisted after retries")
            await asyncio.sleep(self._backoff_seconds * (2**attempt))
        raise GeminiError("Gemini request failed")
