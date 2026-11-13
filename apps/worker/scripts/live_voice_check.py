"""Live round trip with real keys: Gemini reply -> Soniox TTS -> Soniox STT, per language.

Usage (from apps/worker): uv run python scripts/live_voice_check.py [en fr hi ur pa]
Reads SONIOX_API_KEY and GEMINI_API_KEY from the environment or ../../.env.local.
Costs a few cents. Prints results only; never prints keys.

Docs (checked 2026-10-29):
- Gemini generateContent: https://ai.google.dev/api/generate-content
- Soniox TTS REST: https://soniox.com/docs/api-reference/tts/generate_tts.mdx
- Soniox STT websocket: https://soniox.com/docs/api-reference/stt/websocket-api.mdx
"""

import asyncio
import difflib
import json
import os
import sys
import time
from pathlib import Path

import httpx
import websockets
import yaml

ROOT = Path(__file__).resolve().parents[3]
LANGUAGES = {
    "en": "English",
    "fr": "French",
    "hi": "Hindi",
    "ur": "Urdu",
    "pa": "Punjabi (Gurmukhi script)",
}


def load_env() -> dict[str, str]:
    values = dict(os.environ)
    env_file = ROOT / ".env.local"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, _, value = line.partition("=")
                values.setdefault(key.strip(), value.strip().strip("\"'"))
    return values


def provider_config() -> dict:
    return yaml.safe_load((ROOT / "config" / "providers.yaml").read_text())


async def gemini_reply(client: httpx.AsyncClient, key: str, model: str, language: str) -> str:
    menu = "Classic Poutine, Maple Salmon, Butter Chicken, Margherita Pizza, Nanaimo Bar"
    prompt = (
        f"You are the phone receptionist of Maple Table Test Kitchen. Menu: {menu}. "
        f"A caller asks in {language}: 'Do you have butter chicken, and can I order it?' "
        f"Reply in {language} in one short spoken sentence. No markdown."
    )
    response = await client.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": key},
        json={"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"maxOutputTokens": 120}},
    )
    response.raise_for_status()
    return response.json()["candidates"][0]["content"]["parts"][0]["text"].strip()


async def soniox_tts(client: httpx.AsyncClient, key: str, tts: dict, language: str, text: str) -> bytes:
    body = {
        "model": tts["model"],
        "language": language,
        "voice": tts["voice"],
        "audio_format": "pcm_mulaw",  # what Telnyx PCMU carries; only 8000 Hz allowed
        "sample_rate": 8000,
        "text": text,
    }
    response = await client.post(
        "https://tts-rt.soniox.com/tts", headers={"Authorization": f"Bearer {key}"}, json=body
    )
    response.raise_for_status()
    return response.content


async def soniox_stt(key: str, stt_model: str, language: str, audio: bytes) -> str:
    config = {
        "model": stt_model,
        "audio_format": "mulaw",
        "sample_rate": 8000,
        "num_channels": 1,
        "language_hints": [language],
        "enable_endpoint_detection": False,
    }
    final_text: list[str] = []
    async with websockets.connect(
        "wss://stt-rt.soniox.com/transcribe-websocket",
        additional_headers={"Authorization": f"Bearer {key}"},
    ) as socket:
        await socket.send(json.dumps(config))
        for start in range(0, len(audio), 4000):
            await socket.send(audio[start : start + 4000])
        await socket.send("")  # empty TEXT frame ends the stream
        async for raw in socket:
            message = json.loads(raw)
            if "error_code" in message:
                raise RuntimeError(f"STT error {message['error_code']}: {message.get('error_message')}")
            final_text += [t["text"] for t in message.get("tokens", []) if t.get("is_final")]
            if message.get("finished"):
                break
    return "".join(final_text).strip()


async def main(codes: list[str]) -> int:
    env = load_env()
    config = provider_config()
    failures = 0
    async with httpx.AsyncClient(timeout=60) as client:
        for code in codes:
            name = LANGUAGES[code]
            row = {"lang": code}
            try:
                t0 = time.perf_counter()
                reply = await gemini_reply(client, env["GEMINI_API_KEY"], config["llm"]["model"], name)
                t1 = time.perf_counter()
                audio = await soniox_tts(client, env["SONIOX_API_KEY"], config["tts"], code, reply)
                t2 = time.perf_counter()
                heard = await soniox_stt(env["SONIOX_API_KEY"], config["stt"]["model"], code, audio)
                t3 = time.perf_counter()
                similarity = difflib.SequenceMatcher(None, reply.lower(), heard.lower()).ratio()
                row.update(
                    gemini_s=round(t1 - t0, 2),
                    tts_s=round(t2 - t1, 2),
                    stt_s=round(t3 - t2, 2),
                    audio_seconds=round(len(audio) / 8000, 1),
                    match=round(similarity, 2),
                    reply=reply,
                    heard=heard,
                )
                if similarity < 0.6:
                    failures += 1
            except Exception as error:  # report per language, keep going
                failures += 1
                row["error"] = f"{type(error).__name__}: {str(error)[:160]}"
            print(json.dumps(row, ensure_ascii=False))
    return failures


if __name__ == "__main__":
    selected = sys.argv[1:] or list(LANGUAGES)
    sys.exit(1 if asyncio.run(main(selected)) else 0)
