# Latency brief: how a reply is produced and where the time goes

## Current browser pilot measurement — 2026-11-12

The active cascade uses configured OpenAI gpt-4.1-mini, Soniox stt-rt-v5 /
tts-rt-v2 with Priya, sentence aggregation, VAD stop0.12s and speech timeout0.1s.
The historical November3 figures/model description below are superseded for
the browser pilot. No priority tier or filler acknowledgements are enabled.

Approximate client audible timing from synthetic microphone/output energy:

| Run | Samples (ms) | Median | Known partial USD/min |
|---|---|---|---|
| Baseline EN/UR/TE |5030,1598,1361|1598|0.01146|
| Updated public EN/UR/TE |1284,1209,1451|1284|0.01164|
| Updated public EN/FR/HI/PA |1217,1589,1278,2351|1278|0.00943|
| Final full-prefix public EN/UR/TE |1321,1197,1243|1243|0.01271|

Small, network-sensitive samples; not a guaranteed speedup or PRD p95 gate.
The same voices/models and configured rates remain. Short factual first replies
and stable prompt prefix reuse avoid extra inference calls. Complete owner
draft sections now precede the dynamic Toronto timestamp. Prompt caching is
provider-controlled, not guaranteed. Numbers remain spoken in English.

Cached greeting duration1.7067s. Arrival after worker-ready varied0.176–2.410s
in recent public runs, with a separate cold5.75s provider connection observed.
Do not report clip duration as tap-to-ready latency. Browser business tools
remain dry-run. Sub-second meaningful replies are not yet established; native
speakers and a physical Android phone still need to judge conversational quality.

Goal: reply gap as close to a human's (~0.2-0.5 s) as possible. Today (Mac, local, 2026-11-03): median 1.75 s from the caller finishing a sentence to the first audio of the reply.

## Pipeline (per turn)
caller audio -> VAD (Silero, 0.2 s silence) -> end-of-turn rule (fixed 0.25 s silence, or Smart Turn model) -> Soniox STT final text -> OpenAI gpt-5.6-terra (reasoning off, streaming) -> first sentence -> Soniox TTS (voice Priya, language follows caller) -> audio out.
Barge-in: caller interrupts only after 3 recognised words while the agent speaks.

## Measured medians (7 turns, 7 languages, Mac -> cloud APIs)
- end-of-turn wait ~0.40 s (VAD 0.2 + speech timeout 0.25, minus overlap)
- STT final ~0.05-0.13 s
- LLM first token ~0.80 s (OpenAI benchmark, text only: gpt-4.1-mini 0.39, gpt-5.4-nano 0.53, gpt-5.6-luna 0.64, gpt-5.6-terra 0.67 s)
- TTS first audio ~0.28 s
- plus ~0.2 s unexplained (sentence completion, transport)

## Tried
- Barge-in 3 words: fixes false cut-offs (echo/noise), no latency gain.
- TTS token streaming instead of sentence buffering: no gain (median 1.88 s vs 1.75 s, small sample).
- Smart Turn model (TURN_DETECTION=smart_turn): wired in, not yet measured (Gemini was failing then).

## Ideas not yet built
1. Instant pre-recorded acknowledgement ("Mm-hm", "Sure") the moment the caller stops, while the LLM thinks.
2. Run the LLM speculatively on interim transcripts, cancel if the caller keeps talking.
3. Smaller/faster model for the first sentence, Terra for the rest; or gpt-4.1-mini for simple hours/menu questions with Terra for tools.
4. OpenAI priority service tier; keep the prompt prefix stable for caching.
5. Move the worker to Fly Toronto next to the providers (cloud round trips are shorter than from a home Mac).
6. Soniox endpoint detection (semantic) instead of fixed silence; shorter VAD stop.
7. Speech-to-speech model (Gemini Live / OpenAI Realtime) as a separate experiment.

## Constraints
Budget p50 0.7 s, hard 1.5 s; cost < $0.033/min; languages en, en-IN, fr-CA, ur, hi, pa, te, ar; tools (booking/orders) must work; barge-in < 0.3 s; Telnyx phone audio is 8 kHz mu-law.
