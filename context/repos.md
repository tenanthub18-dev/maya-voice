# Repos & References (from PRD)

| Item | Link | Use |
|------|------|-----|
| Pipecat Telnyx inbound example (`telnyx-chatbot/inbound`) | https://github.com/pipecat-ai/pipecat/tree/main/examples | M1 call loop base (VERIFY path) |
| Pipecat Soniox TTS | https://docs.pipecat.ai/api-reference/server/services/tts/soniox | TTS service |
| Soniox + Pipecat | https://soniox.com/blog/voice-bot-with-pipecat-and-soniox | STT/TTS wiring |
| Pipecat Telnyx serializer | https://docs.pipecat.ai/api-reference/server/services/serializers/telnyx.md | media stream |
| Pipecat Telnyx guide | https://docs.pipecat.ai/guides/telephony/telnyx-websockets | 8 kHz mono |
| Soniox STT / TTS languages | https://soniox.com/docs/stt/concepts/supported-languages , https://soniox.com/docs/tts/concepts/supported-languages | language gate |
| Soniox Urdu | https://soniox.com/platform/urdu | VERIFY quality |
| Vercel WebSockets | https://vercel.com/docs/functions/websockets | why worker is on Fly |
| Fly regions | https://www.fly.io/docs/regions/ | `yyz` |
| CRTC (phase 2 outbound) | https://crtc.gc.ca/eng/archive/2026/vt260724.htm | not v1 |

Planned repo: monorepo `apps/web` (Next.js, Vercel), `apps/worker` (Python 3.12, Pipecat, Fly.io yyz), `packages/shared`, `config/providers.yaml`, `supabase/migrations`, `tests/eval`. Not created yet (M0).
