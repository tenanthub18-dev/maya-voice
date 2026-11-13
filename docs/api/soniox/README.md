# Soniox API notes (STT real-time + TTS)

Researched 2026-10-27 from official docs only (soniox.com/docs, soniox.com/pricing). Fixtures in `fixtures/` carry `_source` and `_status` keys. Anything not read directly from docs is marked **UNVERIFIED**. Page text was read through a summarising fetcher, so exact JSON key ordering in fixtures is ours; field names come from the docs.

Docs index (machine readable): https://soniox.com/docs/llms.txt (append `.mdx` to any docs URL for raw page).

## 1. Current model IDs (https://soniox.com/docs/stt/models, https://soniox.com/docs/tts/models)

| Kind | ID | Status |
|---|---|---|
| STT real-time | `stt-rt-v5` | Active, added 2026-06-16; replaces v4 |
| STT async | `stt-async-v5` | Active, added 2026-06-11 |
| STT aliases | `stt-rt-v4`, `stt-async-v4` | Aliases to v5, removed 2026-06-30 (route to v5) |
| TTS real-time | `tts-rt-v2` | Active (v2: "reduced silence between sentences and punctuation") |
| TTS | `tts-rt-v1` | Deprecated; removed 2026-08-31 (alias `tts-rt-v1-preview`) |

Note: REST `POST /tts` docs say `model` "defaults to tts-rt-v1". Always pass the model explicitly.

Model-list endpoints (need API key; Authorization: Bearer): `GET /v1/models` (STT), `GET /v1/tts-models`, `GET /v1/shared-voices?model=...`. Schemas in `fixtures/rest_models_and_voices_shapes.json`. Hosts: `api.soniox.com` (US) for model/voice lists. **TTS REST is `POST https://tts-rt.soniox.com/tts` (404 on api.soniox.com; verified live 2026-10-29).** Live responses were NOT fetched (need key).

## 2. Real-time STT WebSocket

Source: https://soniox.com/docs/api-reference/stt/websocket-api.mdx

- URL: `wss://stt-rt.soniox.com/transcribe-websocket`
- Auth: API key in `Authorization` header or WS protocols list. The `api_key` field in the start message is deprecated and refused from **2027-01-15** if it is the only key sent.
- First message (text frame) = JSON config. Audio then goes as **binary frames**. Fixture: `stt_config_start.json`.

| Field | Notes |
|---|---|
| `model` (req) | `stt-rt-v5` |
| `audio_format` (req) | `auto` or raw. Raw needs `sample_rate` + `num_channels` |
| `language_hints` | array of ISO codes; **bias, not restriction** (https://soniox.com/docs/stt/concepts/language-hints.mdx) |
| `language_hints_strict` | bool, restricts output to hinted languages (field in API ref; behaviour page not found; model flag `supports_language_hints_strict` exists) |
| `enable_language_identification` | adds `language` to every token |
| `enable_endpoint_detection` | semantic endpointing, emits `<end>` token |
| `max_endpoint_delay_ms` | 500-3000, default 2000 |
| `endpoint_sensitivity` | -1.0..1.0, default 0.0, v5 only |
| `endpoint_latency_adjustment_level` | 0-3, default 0, v5 only. Higher = earlier endpoints, more segments, slightly lower accuracy |
| `context`, `enable_speaker_diarization`, `translation`, `client_reference_id` | optional |

Audio formats (https://soniox.com/docs/stt/rt/real-time-transcription.mdx): `auto` (aac, aiff, amr, asf, flac, mp3, ogg, wav, webm) or raw `pcm_s8/16/24/32`, `pcm_u*`, `pcm_f32/f64` (le/be), `mulaw`, `alaw`. Example: `{"audio_format":"pcm_s16le","sample_rate":16000,"num_channels":1}`. Telnyx 8 kHz mulaw => `mulaw`, 8000, 1 (our inference, UNVERIFIED end-to-end; Pipecat's Soniox service may convert for us).

Response (`fixtures/stt_response_tokens.json`): `{tokens:[{text,start_ms,end_ms,confidence,is_final,language?,speaker?,translation_status?,source_language?}], final_audio_proc_ms, total_audio_proc_ms}`.
- Final tokens are sent once, never repeated. Non-final are provisional; replace the non-final buffer each response.
- `language` is per token, sentence-coherent (a loanword inside an English sentence is tagged `en`). Real-time tags may be revised as more speech arrives. Codes are base ISO (`fr`, `ur`, `hi`, `pa`, `en`). **No `fr-CA`**.
- Endpoint: `<end>` final token once per finalized segment (`stt_endpoint_tokens.json`). Docs warn endpointing can reduce accuracy and diarization accuracy. Suggested low-latency start: level 2, sensitivity 0.3, max delay 1500 ms.
- Finalize: send `{"type":"finalize"}`; completes with `{"text":"<fin>","is_final":true}`. Docs advise calling it ~200 ms after silence.
- Keepalive: `{"type":"keepalive"}`. While streaming, send at least every 20 s when no audio (5-10 s typical), else **408 request_timeout** and close. Before the start message: every 40 s else close 1001. Idle time is billed. (Note: the WebSocket API page says 40 s only for the pre-start phase.)
- End of stream: send an **empty text frame** (empty binary frame does NOT end it). Server flushes, sends `{"tokens":[],...,"finished":true}`, closes.
- Errors (`stt_error.json`): one message `{tokens:[],error_code,error_type,error_message,more_info,request_id}` then close. Branch on `error_type`. 413 `max_duration_reached` at 300 min per stream. 503 -> reconnect immediately. 1006 -> reconnect.
- Limits (https://soniox.com/docs/stt/rt/limits-and-quotas.mdx): 100 req/min, 10 concurrent streams, 300 min per session (fixed). **TTS**: 3 concurrent streams, 5 streams per connection, 2 min generated audio per stream (https://soniox.com/docs/tts/rt/limits-and-quotas.mdx). The 3-stream TTS default is low for a multi-restaurant fleet; plan a limit increase (UNVERIFIED how).

## 3. Text-to-speech

Sources: https://soniox.com/docs/api-reference/tts/websocket-api.mdx, https://soniox.com/docs/api-reference/tts/generate_tts.mdx

### WebSocket (streaming, what Pipecat `SonioxTTSService` uses)
- URL: `wss://tts-rt.soniox.com/tts-websocket`; same auth rule as STT (header/protocols; `api_key` in config deprecated, refused from 2027-01-15).
- Config message per `stream_id` (required): `model`, `language`, `voice`, `audio_format`, `stream_id`; optional `sample_rate`, `bitrate`, `client_reference_id`, `return_timestamps`, `speed` (0.7-1.3), `reduce_silence`. Fixture `tts_ws_config.json`.
- Text messages: `{stream_id, text, text_end}` (chunk max 5000 chars). Send LLM tokens as they arrive; audio starts before the sentence ends. A stream with no text for more than a few seconds without `text_end:true` is terminated.
- Server: `{stream_id, audio (base64), audio_end}`; optional `timestamps`; then `{stream_id, terminated:true}` (complete only after `terminated`). Cancel: `{stream_id, cancel:true}` (barge-in). Per-stream errors keep the connection open. Fixture `tts_ws_text_and_responses.json`, `tts_ws_error.json`.
- Keepalive for TTS connection exists (page https://soniox.com/docs/tts/rt/connection-keepalive.mdx **not read**, JSON UNVERIFIED; Pipecat handles it).

### REST
`POST /tts` (JSON body, Bearer auth), returns raw binary audio; `text` max 5000 chars; fields as above. Fixture `tts_rest_request.json`. Useful for greeting/prompt pre-render and Urdu quality listening tests.

### Audio formats (https://soniox.com/docs/tts/concepts/audio-formats.mdx)
| Format | Sample rates (Hz) |
|---|---|
| `pcm_s16le`, `pcm_f32le`, `wav` | 8000, 16000, 24000 (default), 44100, 48000 |
| `pcm_mulaw`, `pcm_alaw` | **8000 only** (default) |
| `flac` | 16000-48000 (no 8000) |
| `mp3`, `opus`, `aac` | lossy, bitrate option (opus supports 8000) |

So Telnyx can be fed natively: `pcm_mulaw` @ 8000, or `pcm_s16le` @ 8000/16000.

### Languages and voices
- TTS supported languages page (https://soniox.com/docs/tts/concepts/supported-languages.mdx) lists **ur, hi, pa, fr, en** (all present). STT page lists the same five. Regional variants are not listed: `fr-CA` does not exist as a code; use `fr`. Whether French output is Canadian-accented is UNVERIFIED (test by ear).
- Docs claim "60+ languages"; every voice works with every language ("any voice, any language", speaker identity stays consistent). `language` sets the primary language and accent bias for the whole utterance; do not choose it from a few embedded foreign words (https://soniox.com/docs/tts/concepts/language-mixing.mdx). Hindi/Urdu/Punjabi script handling and code-switching specifics: **not documented**. Urdu TTS *quality* cannot be verified from docs.
- Voices: built-in names or cloned IDs. Docs examples name `Adrian` (API ref) and `Daniel` (voices page). The tts-rt-v1 example response had 28 voices. Authoritative list: `GET /v1/tts-models` and `GET /v1/shared-voices?model=tts-rt-v2` (key needed) or Console > Text-to-speech > Voices. **`Daniel` on `tts-rt-v2` is not confirmed by a list call.**
- Other knobs: `speed` 0.7-1.3 (model flag `supports_speed_adjustment`), `reduce_silence` only if `supports_silence_reduction`.

### Latency
No numeric latency published in the pages read ("ultra-low latency", audio before sentence ends). Our 700 ms p50 budget must be measured by us at M1/M2. No numbers for STT latency either.

## 4. Pricing (VERIFY, read 2026-10-27 from https://soniox.com/pricing)

| Item | Price |
|---|---|
| STT real-time | stated **$0.12 per hour**; token basis: input audio $2.00/1M tokens, input text $4.00/1M, output text $4.00/1M |
| STT async | $0.10/hr |
| TTS real-time | stated **~$0.70 per hour of generated speech**; tokens: input text $4.00/1M tokens, output audio $21.50/1M tokens |
| Our derived TTS text price | ~$1.20 per 1M input characters (derivation: 1 char ~ 0.3 token, page says so) |

Page quirk: 30,000 audio tokens/hr at $21.50/1M = $0.645/hr, slightly below the stated $0.70/hr. No per-character audio price is published. Budget check: STT $0.002/min + TTS about $0.012/min of speech = well below the $0.033/min cap, before Gemini and Telnyx. Billing includes idle stream time for STT (keepalive streams still bill).

## 5. Data handling
- https://soniox.com/docs/security-and-privacy.mdx: audio/transcripts never used to improve models; not stored unless requested (async data auto-deleted after 30 days). Page does not mention TTS explicitly.
- Regions (https://soniox.com/docs/data-residency.mdx): US, EU, Japan, India. **No Canada region.** Regional hosts e.g. `stt-rt.eu.soniox.com`; access by request in Console. Relevant to PIPEDA/Quebec Law 25 disclosure (not legal advice).

## 6. Not confirmed
- Live voice list for `tts-rt-v2`, presence of `Daniel`; Urdu/Hindi/Punjabi TTS quality; fr-CA accent.
- TTS connection keepalive JSON; STT/TTS latency numbers; `language_hints_strict` semantics (page not found); error `error_type` catalog (https://soniox.com/docs/api-reference/errors not fetched).
- Whether Pipecat's `SonioxSTTService` exposes `language_hints`, `enable_endpoint_detection` etc. (check installed package source).
- REST `/tts` full path prefix (`/v1/tts` vs `/tts`).
