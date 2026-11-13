# Decisions

## 2026-10-28 — Real-call readiness (pre-keys)

Changed without keys, all unproven until a real call:
- TeXML `<Stream>` now sets `bidirectionalMode="rtp"`, `bidirectionalCodec="PCMU"`, `bidirectionalSamplingRate="8000"` so Pipecat's raw PCMU reaches the caller (Telnyx default is mp3).
- A `calls` row is created at TeXML time; its uuid is HMAC-signed into the websocket URL (`c=`) and used as `database_call_id`, so tools, post-call, transcripts and usage ledger have a real call to attach to. Caller hash uses the web scheme (`PRIVACY_REQUEST_HASH_SECRET`).
- `/ws` loads the restaurant, hours, menu and published agent prompt from the call row, not from `config/dev-restaurant.yaml`. Numbers with no published agent version are forwarded to the transfer number.
- `TELNYX_TEXML_REQUIRE_SIGNATURE` (default true) lets us turn off the Ed25519 check if a captured live request shows TeXML fetches are unsigned.
- Soniox `language_hints` set from `launch_languages` (Pipecat maps `fr-CA` to `fr`).

VERIFY on the first real call (not resolvable without keys):
- Are TeXML application fetches signed by Telnyx? If not, set `TELNYX_TEXML_REQUIRE_SIGNATURE=false`.
- Does the TeXML stream `start` frame carry `call_control_id` / `stream_id` as Pipecat's parser expects? (`docs/api/telnyx/README.md` §I.3, fixture is from Call Control docs.)
- Hangup: Pipecat's serializer hangs up via the Call Control API; for TeXML calls this may not apply. When the websocket closes with no further TeXML verbs, the call should end on its own — confirm.
- Transfer after stream stop (`StopFrame` then `<Say>`/`<Dial>`) — behaviour after Connect ends is unverified.
- TeXML app must be created with `voice_method=post` (worker route is POST-only); using the TeXML app id as the number's `connection_id` is unconfirmed.
- Soniox voice name (`GET /v1/shared-voices?model=tts-rt-v2`), `SONIOX_TTS_PATH`, Urdu/Hindi/Punjabi TTS quality; Gemini model id and price; Canadian Telnyx rates; Supabase ca-central-1.
- Not yet run against live: `scripts/capture-fixtures.ts`, `apps/web/scripts/smoke-live.ts`, `apps/worker/scripts/smoke_worker.py`.

## 2026-10-29 — Cross-review of worker call path (static read)
Fixed: post-Connect `Dial` now prefers the restaurant `transfer_phone`; `_create_call_record` reuses the row if a Telnyx retry wins the unique(telnyx_call_id) race; WS/test-call digest compares use bytes so non-ASCII input returns False/401 instead of raising.
Not changed (decision): bad Telnyx signature stays 401/503 (fail closed; fallback is Telnyx `voice_fallback_url`). Returning a transfer would expose the transfer number to anonymous callers. If the first live capture shows TeXML fetches are unsigned, set `TELNYX_TEXML_REQUIRE_SIGNATURE=false` AND restrict the webhook (Telnyx-side allowlist or secret path) because the route then creates `calls` rows for any caller.
Open before go-live: single-use /ws token and idempotent post-call job (token replay for 120 s, duplicate postcall on retried CallSid); reject empty `c` in production so a misset env can't serve the dev restaurant; sanitize owner `prompt_sections` names and place immutable rules after them; 60 s config cache delays kill-switch; normalize phone to E.164 before hashing; log only error class + call sid.
Live-mode gap: `apps/web/lib/data/supabase/index.ts` throws for onboarding state, import jobs and agent policies (no schema). Calls unaffected; signup wizard, menu import and policies need tables or UI hiding before DATA_SOURCE=supabase.

## 2026-10-29 — Provider doc check (sub-agent report, official docs; re-confirm before relying)
Confirmed: Stream attrs rtp/PCMU/8000; STT `stt-rt-v5`; TTS `tts-rt-v2`; STT/TTS languages en,fr,ur,hi,pa; `fr-CA` must be sent as `fr` (our mapping is right); `gemini-3.5-flash-lite` stable; hang up / transfer a TeXML call via `POST /v2/texml/Accounts/{account_sid}/Calls/{call_sid}` with `Status=completed` or `Url`/`Texml` (https://developers.telnyx.com/api-reference/texml-rest-commands/update-call.md).
Risks for first live call: (1) Pipecat TelnyxFrameSerializer hangup uses Call Control `/v2/calls/{id}/actions/hangup`; may not work for TeXML. If agent-ended calls don't drop, they fall through to the post-Connect Say/Dial transfer. Fix = own hangup via the TeXML endpoint (needs account_sid). (2) Pipecat expects `start.call_control_id`; TeXML start frame unconfirmed. Log the raw start frame. (3) Is TeXML fetch signed? Capture one request. (4) Soniox voice "Daniel" unconfirmed; check GET /v1/shared-voices?model=tts-rt-v2 (default voice is Adrian). (5) Soniox TTS default limit is 3 concurrent streams, 2 min audio per stream: request a raise before >3 simultaneous calls. (6) `gemini-2.5-flash-lite` fallback is "access limited" for new accounts; docs list `gemini-3.1-flash-lite` as stable. Confirm, then update config/providers.yaml.

## 2026-10-29 — Soniox key live check (read-only, no audio)
Key valid. GET /v1/models lists stt-rt-v5. GET /v1/shared-voices?model=tts-rt-v2 lists Daniel (so the configured voice is valid). Resolves risk (4) above. Still unverified: UR/HI/PA voice quality, concurrency limit raise.

## 2026-10-29 — Gemini key live check
Key valid; gemini-3.5-flash-lite, gemini-2.5-flash-lite and gemini-3.1-flash-lite all listed for generateContent. Resolves risk (6): fallback model exists on this account.

## 2026-10-29 — Soniox live findings
- TTS REST is POST https://tts-rt.soniox.com/tts (api.soniox.com/tts and /v1/tts return 404). Web client now accepts SONIOX_TTS_PATH as a full URL; .env.example updated (SONIOX_TTS_PATH=https://tts-rt.soniox.com/tts). Phone path uses Pipecat websocket, unaffected.
- Soniox org balance was exhausted (HTTP 402 organization_balance_exhausted): add funds in console.soniox.com before voice tests. Round-trip script: apps/worker/scripts/live_voice_check.py.

## 2026-10-29 — LLM model change after live latency test (real key)
- `gemini-3.5-flash-lite` (old primary): 16-37 s per reply (even first streamed byte), 5 output tokens, so not thinking. Unusable for voice.
- `gemini-2.5-flash-lite` (old fallback): HTTP 404 "no longer available" despite appearing in the model list.
- `gemini-3.1-flash-lite`: 0.6-2.5 s typical, one 503 "high demand" and one 8 s outlier; $0.25 in / $1.50 out per 1M. NEW PRIMARY. Accepts thinkingLevel=minimal.
- `gemini-3.6-flash`: 0.85-1.7 s steady, no errors; $0.75/$3.75 per 1M until 2026-12-31, then $1.50/$7.50 (would eat most of the $0.033/min budget). NEW FALLBACK.
- Even 0.6-2 s total is above the 700 ms p50 reply budget: measure streaming time-to-first-token inside the real pipeline. Free-tier keys also share capacity and "may be used to improve products": enable billing on the Google AI project before real callers.
- Soniox round trip (TTS->STT, mulaw 8 kHz): en/fr/hi/pa transcribed back at 98-100% match; ur test reply was truncated by Gemini 3.5 at 120 tokens, retest with the new model. TTS ~3 s and STT ~3 s here are batch REST/whole-clip timings, not streaming latency.

## 2026-10-29 — Gemini latency BASELINE on current (likely free-tier) key, streaming first byte, 8 runs each
- gemini-3.1-flash-lite: 4/8 errors (503 high demand), p50 4.59 s, p95 6.71 s.
- gemini-3.6-flash: 2/8 errors, p50 14.64 s, p95 30.27 s (was ~1 s an hour earlier, so load-driven, not model-driven).
- Docs: rate limits "not guaranteed, capacity may vary"; no paid-tier latency promise. Only a Priority tier (Preview, Interactions API `service_tier=priority`) is documented as lower latency/higher reliability. Re-run `bash apps/worker/scripts/gemini_latency_check.sh 8` after enabling billing and compare. If still >1 s p50 with errors, options: Priority tier, Vertex AI regional endpoint (also helps Canadian data residency), or another LLM provider behind the same Pipecat slot.

## 2026-11-02 — Added `en-IN` (English, India) as a sixth language
User-requested; the PRD lists five launch languages. Scope: DB check constraints widened (migration 20261027130700), web language lists/labels, worker tool enums, and a prompt note (Indian English / Hinglish understood, simple English replies) when a restaurant enables it. STT still uses hint `en` and TTS still uses the same English voice; an Indian-accent voice is not verified and not added.

## 2026-11-02 — `TURN_DETECTION` switch (speech_timeout | smart_turn)
Default stays the fixed 0.25 s silence rule. `smart_turn` uses Pipecat's bundled smart-turn-v3.2 model. Not yet benchmarked: Gemini free tier returned 503s during the first on/off test.

## 2026-11-02 — Demo uses one voice, Priya, for all six languages
`config/providers.yaml` tts.voice = Priya (Soniox shared voice, Indian-accent female). Other personas (Grace, Dev, Logan, Nigel) and native Hindi/Punjabi voices deferred until a client asks. Found that the worker never set the Soniox TTS language (default `en`); added `TTSLanguageProcessor` (resilience/runtime.py) which sends a TTS language update when the caller's language changes. Verified in a local Hindi test call (TTS settings updated). Native-speaker rating of Priya in hi/pa/ur/fr still pending.

## 2026-11-02 — LLM cost estimate (not a decision)
Assumed 600 min/month, ~4 turns/min, ~3.5k input tokens/turn (80% cached), ~80 output tokens. Rough monthly LLM cost: Gemini 3.1 Flash-Lite ~$0.9; GPT-5.6 Luna ~$0.7; Gemini 3.6 Flash ~$2.5 (about double from 2027-01-01); GPT-5.6 Terra ~$7; Sol ~$17.5. Prices from Google's pricing page and OpenAI/third-party price pages (Oct-Nov 2026). Speed of the OpenAI models is unmeasured.

## 2026-11-02 — In-call LLM is OpenAI gpt-5.6-terra (reasoning off), fallback gpt-5.6-luna
Benchmark (15 calls/model, text only, no tools, 2026-11-02): time to first word median — gpt-4.1-mini 0.39 s, gpt-4.1 0.49, gpt-5.4-nano 0.53, gpt-5.4-mini 0.62, gpt-5.6-luna 0.64, gpt-5.6-terra 0.67, gpt-6-luna 0.75, gpt-6.1-terra 0.83; luna/6-luna with default reasoning 1.4-1.5 s. Gemini free tier errored (503/429). Terra answered most accurately. Chosen for quality; est. cost at 600 min/month about $17/client (Luna about $11). New config blocks `voice_llm` / `voice_llm_fallback` in config/providers.yaml; `llm` (Gemini) is kept for post-call summaries. Live local calls on Terra: LLM first word 0.6-0.8 s, total reply 1.4-2.0 s (target p50 0.7 s not met; end-of-turn wait 0.37-0.57 s and TTS 0.2-0.36 s remain). Data now flows to OpenAI in-call: review Canadian privacy wording before launch. check-env/GO-LIVE docs not yet updated for OPENAI_API_KEY.

## 2026-11-02 — Telugu (`te`) added as a seventh language; numbers spoken in English; more natural speech
Soniox STT (stt-rt-v5) and TTS both list Telugu (verified via GET /v1/models and the TTS supported-languages page). Added: migration 20261027130800, web lists/labels, worker tool enums, SMS templates and cached phrases (Telugu strings written by Claude; need native-speaker review), launch_languages. Prompt now says prices, times, dates, quantities and phone numbers are always said in English (later: per-client switch for English vs native-language numbers). Prompt also asks for everyday spoken wording per language, short answer-first replies, varied small reactions, no stiff phrases. Local multi-language call (en, fr, hi, pa, ur, te, en): language switch worked every turn; total reply time 1.6-2.8 s (LLM first word 0.7-1.1 s, French 2.0 s); real phone listening test pending.

## 2026-11-02 — Arabic (`ar`) added as an eighth language
Soniox STT stt-rt-v5 and TTS tts-rt-v2 both list Arabic. Added migration 20261027130900, worker tool enums, SMS templates, cached phrases (Arabic strings written by Claude in plain Modern Standard style; dialect not chosen — Gulf, Levantine and Egyptian differ; native-speaker review needed), launch_languages, prompt. Web lists via sub-agent. Priya Arabic sample generated for phone review.

## 2026-11-02 — Barge-in needs 3 recognised words; phone test-call drops after ~35-40 s
Phone test call log showed repeated "broadcasting interruption" (3 within 2 s right after the greeting) from raw voice detection, so noise/speaker echo cut the voice mid-sentence. Replaced VADUserTurnStartStrategy with MinWordsUserTurnStartStrategy(min_words=3): while the bot speaks, 1-2 word sounds are ignored; when it is silent, 1 word starts a turn. Verified locally (ignored 1-2 word fragments while bot_speaking, answered 3 turns). Barge-in budget (<300 ms) now depends on STT interim words; re-measure on a real call. Separate issue: two phone calls ended ~35-39 s after connect with "Media stream error ... ICE closed" (phone-side WebRTC drop; no TURN server). Mac-injected calls run 80+ s fine. Added screen wake lock and status text to the scratch harness; a TURN relay is the likely real fix (needs an account).

## 2026-11-03 — Latency plan after outside review
Review agreed: 0.7 s p50 end to end is only reachable on simple turns by combining speculative LLM start, a fast model for simple turns, and Toronto hosting; real phone audio adds ~0.15-0.3 s transport. Order: (1) deploy to Fly Toronto and measure 100+ real-phone turns per language with every stage logged, (2) speculative LLM on interim transcripts, (3) route simple turns to a fast model after testing ur/pa/te quality, (4) short pre-recorded acknowledgement only on non-trivial turns, (5) A/B Smart Turn / Soniox semantic endpointing (watch false cut-offs on numbers and pauses), (6) priority tier and stable prompt prefix. Speech-to-speech stays a side experiment. Accepted criticisms: 3-word barge-in cannot meet <0.3 s (plan: duck agent audio on VAD onset, confirm with words, resume if noise); report both first-audio and first-content latency; TTS token streaming result (1.88 vs 1.75 s, n=7) is inconclusive. Done: latency records now keep every Pipecat stage (stages_ms: sentence_aggregation, output_transport, turn_completion, tool calls) and apps/worker/scripts/latency_report.py prints p50/p95 per stage. Baseline from 33 Mac turns: total p50 1804 ms, p95 2648 ms; llm 798, eot 398, tts 344, stt 62. Model prices (gpt-4.1-mini, gpt-5.4-nano) not yet checked against the $0.033/min budget.

## 2026-11-03 — In-call model switched to gpt-4.1-mini; end-of-speech timers shortened; digits spoken as English words in code
Scripted silent test calls (apps/worker scripts: scratchpad call_client.py driving /webrtc/offer, 12 caller turns per variant, Mac, 8 languages incl. fr/hi/pa/ur/te): total reply p50/p95 — terra + old timers 1816/2365 (n=7); terra + short timers 1529/1848; mini + old timers 1358/1627; mini + short timers (SPEECH_TIMEOUT_SECS=0.1, VAD_STOP_SECS=0.12) 1182/1564, repeat 1162/1350 (n=4). Locked defaults: voice_llm gpt-4.1-mini (no reasoning param), voice_llm_fallback gpt-4.1, speech timeout 0.1 s, VAD stop 0.12 s (env overrides kept). Final run with defaults (7 turns incl. a booking tool call): p50 1544, p95 2320; run-to-run OpenAI variance is large (LLM p50 490-830 ms), so re-measure in Fly Toronto with 100+ turns. Rejected: Smart Turn (median fine, but p95 4.2 s because turn_detection sometimes waits ~2.9 s), TTS token streaming (sentence_aggregation gone but speech_synthesis 180->470 ms; no net gain). Risk: 0.22 s total silence can split a sentence at a natural pause; watch for early replies on real calls. gpt-4.1-mini broke the English-numbers rule in hi/pa/ur/te (wrote Hindi/Urdu/Telugu number words), so the rule is now enforced in code: pipeline/spoken_numbers.py rewrites digits ($21.95, 10:00 PM, phone numbers, quantities) to English words as a TTS text transform; the LLM is told to write plain digits. Quality of mini for ur/pa/te and tool arguments needs a native-speaker/real-call check; Terra remains the upgrade (one-line config change).

## 2026-11-03 — Pre-recorded listening sound at turn end (loop iteration 1); how latency is now measured
New pipeline/ack.py: a neutral clip ("Mm-hm", "Okay", "अच्छा", "ਅੱਛਾ", "اچھا", "సరే", "تمام"...) per language is rendered once with Soniox REST in the call voice, cached, and played straight to the transport output when the user turn stops (frames sent through the pipeline were held behind the LLM request, so it bypasses it). On by default; ACK_CLIPS=0 turns it off. The prompt tells the LLM not to open with Mm-hm/Okay/Got it. Soniox allows few concurrent TTS requests, so clips load sequentially in the background at call start (no clip, no acknowledgement for that language).
Measurement moved to the caller side (test client records the agent's audio and times it against each caller clip's end, so first sound and answer start are measured separately; absolute numbers include ~0.3 s of harness bias vs the worker observer: 1653 vs 1305 ms for the same no-ack run). 24 turns, 8 languages, Mac, defaults: first sound p50 612 ms / p95 696 ms (no ack: 1653 / 2089); answer start p50 1781 / p95 2157 ms (no ack first sound = answer: ~1650). The acknowledgement adds ~50-100 ms to answer start. Not verified: telephony 8 kHz path (clip is resampled), real phone transport, real listeners' reaction. Answer start under 1 s still needs: early LLM start, priority tier, Toronto hosting, real phone measurement.

## 2026-11-03 — Hooks removed after phone feedback
Phone test: the "Mm-hm" clip on every turn and the laugh/chuckle tags sounded fake. ACK_CLIPS now defaults to off (ACK_CLIPS=1 to re-enable; first sound with clip 0.61 s vs 1.59 s without). Prompt: no laughing/sighing/filler sounds, delivery tags at most one reply in four and only [warm] [happy] [reassuringly]. Scripted check over 43 spoken lines: 1 tagged, 0 laugh/mm. Also fixed French-style prices ("16.95 $") in spoken_numbers. Lesson: a pre-recorded reaction needs to know whether the caller said something worth reacting to; blanket reactions read as scripted.

## 2026-11-03 — OpenAI Realtime (speech-to-speech) tested against the cascade; kept as a switchable experiment
VOICE_MODE=realtime (browser test-call path only) builds Pipecat OpenAIRealtimeLLMService + the same tools; env: REALTIME_MODEL (default gpt-realtime-2.1-mini), REALTIME_VOICE (marin), REALTIME_VAD=server|semantic, REALTIME_SILENCE_MS, REALTIME_EAGERNESS, REALTIME_REASONING. Caller-side first-sound over 12 turns (8 languages, Mac -> OpenAI): mini + semantic VAD high 2248/2426 ms p50; flagship default 2875; flagship reasoning minimal 2332, low 2009; mini + server VAD 200 ms 1564 (p95 2441); mini + server VAD 120 ms 1705 (p95 3421); flagship low + server 200 ms 1839 (p95 5215). Cascade (gpt-4.1-mini, short timers, no clip): ~1.59 s, p95 ~1.9-2.1; with the pre-recorded clip first sound 0.61 s. Conclusion: realtime is not faster here (best ~1.56 s, worse tail); its advantage would be feel (tone, natural interruption), which is not yet judged by a human listener. Not evaluated: Urdu/Punjabi/Telugu/Arabic quality, English-number rule (prompt only, cannot be post-processed), tool reliability, telephony (8 kHz Telnyx) path, cost (~$0.02-0.05/min mini estimate, third-party). OpenAI shuts down gpt-realtime and gpt-realtime-mini on 2027-01-20; use the 2.1 models.


## 2026-11-12 — Local phone test before cloud deployment
Use a local-only Supabase owner and isolated worker/dashboard with a temporary Cloudflare worker tunnel. The gateway forwards only the existing SMS callback path to the dashboard; signed raw bytes and signature headers are preserved. No production deployment or number purchase was performed. User deferred the Telnyx upgrade; number assignment, actual carrier calls and SMS receipt remain pending.

TeXML instruction fetches are separate from event callbacks. Production signature mode remains the default. The local launcher explicitly uses a random shared secret on the existing instruction URL; disabling signature mode without a strong secret now fails closed. Access logs are disabled because the URL includes that secret. Stream reconnect is disabled to avoid reconnecting after intentional hang-up. Sources: https://developers.telnyx.com/docs/voice/programmable-voice/texml-instruction-fetching and https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/stream .

Worker SMS now sends the approved localized template through Telnyx, prefixed by restaurant identity and STOP instructions. Sender comes from active restaurant-owned numbers; credentials/profile/endpoint come from environment; provider idempotency derives from the persisted tool invocation. Accepted message ID and sent status are persisted together in the existing schema for receipt mapping. Sent means accepted, not delivered; timeout/cancellation remains queued/unknown and must be reconciled rather than automatically resent. Source: https://developers.telnyx.com/api-reference/messages/send-a-message .

Local Supabase CLI legacy HS256 keys were rejected by the running asymmetric-signing stack. The launcher therefore prefers the reported publishable/secret keys, preserving the API-key-only header behavior of the existing repository. Actual local owner sign-in and RLS reads were verified. Source: https://supabase.com/docs/guides/api/api-keys .

Verification and live limits are recorded in docs/PHONE-TEST.md. A single local dry-run voice response was audible to the silent harness (2667 ms first sound); it is not a phone-call latency gate.

## 2026-11-12 — Mac-hosted browser pilot, telephony deferred

The owner selected the existing Mac to host voice and local Supabase while
friends/clients access Vercel. Binary PCM WebSockets through a temporary
Cloudflare tunnel avoid WebRTC NAT/TURN hosting requirements. The separate
Supabase API tunnel exposes ordinary authenticated HTTP API access, not Studio
or Postgres. User RLS and the publishable key are sufficient for the pilot
screens; an automatic approval review rejected exporting the administrator key
to Vercel, so that key remains on the Mac. Deferred provider callbacks return503
without privileged configuration. No telephone number, forwarding, SMS, new paid
worker host or cloud database was activated.

The user-supplied restaurant link is the Dixie branch. Official Square ordering
initially selected Dundas; only the explicitly selected Dixie menu was imported.
The isolated pilot contains public business data and internal test defaults,
not customer history. Reservations/orders remain browser practice operations.
Restaurant policy/capacity and actual phone/native-language quality gates remain
open. See BROWSER-DEMO.md and config/pilots/barbq-tonite-dixie.json for provenance.


## 2026-11-12 — Dependency audit before the initial repository publication

The existing CI Python audit found known vulnerabilities in certifi2026.7.22,
cryptography46.0.4, pyasn1.0.6.4 and Starlette0.52.1. Verified patched releases
and compatibility using official PyPI JSON metadata and the
[cryptography changelog](https://cryptography.io/en/latest/changelog/) and
[Starlette release notes](https://starlette.dev/release-notes/).

Updated the direct cryptography pin to50.0.2, and locked certifi2026.10.18,
pyasn1.0.6.5 and Starlette1.3.1. Resolver-required PyOpenSSL moved26.2.0→26.4.0.
FastAPI0.141.1, Pipecat1.14, speech/LLM model and voice configuration are unchanged.
FastAPI metadata permits Starlette>=0.46; application Ed25519 APIs remain valid.
An isolated environment passed all510worker tests and a clean pip-audit before
the managed environment was synchronized. Real browser calls afterward verified
streaming, authentication, call/usage persistence and hang-up cleanup.

No ignore/advisory suppression, dependency override, weaker authentication or
new provider/service was used. These are known-advisory results at verification
time, not a promise that the application has no vulnerabilities.
