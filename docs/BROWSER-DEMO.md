# Browser voice demo — 2026-11-12

## User-approved objective

Deploy the existing web application to Vercel, connect Supabase and a working
browser voice call, and let the owner tap a call button on a phone to judge
language switching, naturalness and conversational flow. Defer Telnyx, number
purchases, SMS and normal-phone routing. Do not claim the PRD language/latency
gates passed without actual measurements and human listening.

## Current design and decisions

- Keep the Next.js application and Pipecat/Soniox/OpenAI voice pipeline.
- Repair browser playback, connection/error cleanup and the test-call route's
  unnecessary dependency on unsupported policy data.
- Keep browser tool operations in the existing explicit dry-run mode while the
  owner focuses on speech; do not enable real SMS/payments or bill test calls.
- Owner selected the existing Mac, with remote friends/clients able to test.
  Keep Vercel as the shareable web entry and use the existing secure tunnel to
  the Mac worker. Use a binary PCM WebSocket browser transport over HTTPS/WSS,
  avoiding WebRTC NAT/TURN dependencies and any new hosting bill. Preserve the
  existing WebRTC owner test path and telephone path.
- Add a dedicated `/demo` page protected by a strong access code. A server route
  checks that code and issues a short-lived HMAC token pinned to the configured
  test restaurant/draft; the worker verifies allowed origin, single-use nonce,
  expiry and concurrency limits before opening speech/LLM connections. Never put
  speech/LLM credentials or permanent HMAC secrets in the browser.
- Send audio at 16 kHz PCM16 with explicit framing, bounded buffering and cleanup;
  play streamed PCM in the browser, clear queued playback on interruption, and
  preserve the existing language/STT/LLM/TTS pipeline. Tests cover serialization,
  sample conversion, authentication, replay, disconnect and audio playback.
- Vercel CLI is authorized. Supabase CLI currently lists only an unrelated paused
  project; the intended Maya cloud project is not accessible under that session.
  Do not alter the unrelated project or claim cloud Supabase is connected.
- User supplied BarBQ Tonite Restaurant's Dixie Google Maps link and authorized
  a separate pilot client. Manifest: `config/pilots/barbq-tonite-dixie.json`.
  Google Maps provides branch identity/address/contact/coordinates/hours;
  the official website's Square link, explicitly selected to Dixie location
  `LVZ0HY3TRYP6V`, provides 44 unique pickup menu items with CAD prices. The
  Square default selected Dundas; those prices were not used for this pilot.
- Pilot data is stored in the existing **local** Supabase, with a separate local
  test owner and membership. The Vercel dashboard uses the Supabase API tunnel,
  publishable key and signed-in-user RLS. The administrator key stays on the Mac.
  Deferred provider webhooks fail closed when administrator credentials are absent.

## Implementation tasks and acceptance

1. Browser transport: real remote audio, bounded negotiation, stop/unmount cleanup
   and useful errors; meaningful tests exercise audio arrival and cancellation.
2. Agent test screen: load only the data needed for that tab; real Supabase
   `listPolicies` is unsupported and must not prevent opening a voice test.
3. Network path: validate browser media through the internet tunnel; actual iPhone
   and mobile-network quality still require a human phone test.
4. Cloud connections: connect only the intended Supabase project after valid
   account access; deploy Vercel after code/tests/build/security checks, using
   existing authorized account. No git commit/push is needed for CLI deployment.
5. Verify microphone -> AI speech with real providers, one language at a time,
   plus hang-up/reconnect and desktop/mobile layouts. Record limitations honestly.

## Progress

- Fixed existing WebRTC playback/cleanup/timeout bugs and removed the test tab's
  unnecessary policy-table read. Added an authenticated binary PCM WebSocket
  browser demo that shares the existing speech/LLM/TTS cascade.
- Designed the `/demo` call screen in the existing paper/forest-green style:
  restaurant identity/address, connection status, elapsed timer, measured mic
  activity, working mute/unmute, cancel, end-call and EN/FR interface copy.
- Auth: short-lived origin-bound single-use tokens; code gate on session issuance;
  pending handshake cap8, active call cap2, 600-second lifetime; PCM rate/message
  buckets and explicit Uvicorn legacy WebSocket queue16/message16384 limits.
  Public demos cannot retrieve/modify/cancel existing private bookings.
- Local pilot imported idempotently: one isolated organization/restaurant/owner,
  seven hours rows, 44 menu rows, seven sourced FAQs and published/draft agents.
  No customer bookings, orders or calls were seeded. Menu prices are online
  pickup prices; booking capacity/defaults are expressly unconfirmed TEST-ONLY.
- Verified live public WSS greeting and spoken reply using the real providers;
  reply used closing22:30 and Butter Chicken1799 cents. Headless Chromium390px
  browser sent/received real audio, muted/unmuted, ended capture, had no horizontal
  overflow and reported zero page errors. Desktop/mobile screenshots are private
  under `tmp/phone-test/`. Native iPhone audio quality remains unverified.
- Production Next build/client-secret scan passed locally and on Vercel.
  Public demo: https://voice-receptionist-demo-ten.vercel.app/demo . The Vercel
 390px Chromium check sent593280/received471040 audio bytes, verified mute/unmute,
  ended all mic tracks, found no horizontal overflow and reported zero page errors.
  Vercel login/home/calls/bookings/menu/hours/FAQs/settings checks all returned200
  with the real pilot name and zero page errors. Through the public Supabase API,
  anonymous REST reads were denied401; the signed-in pilot saw exactly its one
  restaurant and44menuitems, and could not read the old sample client.
- Fly rejects account access because its trial ended; owner asked for alternatives.
- No new hosting, cloud database mutation or paid resource was created.

## Android Chrome playback cutoff — 2026-11-12 follow-up

- Owner reported the playback-behind error after repeated Android Chrome calls.
  Normal long-response Chrome runs had maximum scheduled lead0.10–0.29seconds.
  A controlled2.2-second batch of real incoming WebSocket audio reproduced the
  exact cutoff on the deployed code: its1.5-second scheduling guard ended the call.
- Changed playback to a bounded PCM FIFO, with only about200ms of audio scheduled
  in native nodes (maximum one40ms-chunk overshoot). Up to5seconds of total PCM
  remains bounded in memory; packets over1second and malformed/overflow data are
  still rejected. Ordered audio is preserved without dropping words or changing
  playback speed. Interruption/hang-up clears buffered and scheduled speech,
  cancels the pump and prevents callbacks from affecting a fresh call.
- Review found timer-driven native audio errors could escape the receive handler.
  Added explicit call-failure reporting and complete cleanup even if a failed,
  unstarted native source cannot be stopped. Regression tests reproduced the
  failure before the change and passed afterward.
- Fresh web verification:729tests, typecheck and lint pass. The opt-in real-provider
  check is `apps/web/tests/live/browser-playback-check.mjs`; it emulates a Pixel7
  browser and batches real audio without blocking capture. It failed on the old
  deployed player with the reported error. The revised production build deployed
  successfully, including the client-secret scan. Three consecutive public calls
  on the same page with2.2-second delivery bursts passed, with maximum native
  scheduled lead0.24seconds, six/seven concurrent native sources, completed
  microphone cleanup and no page errors. A further public call held a later reply
  for3.4seconds and released86frames in a batch; it stayed connected, native lead
  remained0.24seconds, mic tracks ended and no audio was scheduled after hang-up.
  This is browser emulation, not a physical Android quality gate. The local3101
  production build has since been refreshed with this player and call-usage updates.

## Running the demo

- Private access code: `tmp/phone-test/demo-access.txt`; private client login:
  `tmp/phone-test/pilot-login.txt`. Do not commit or paste these in logs/docs.
- Restart the prepared stack with
  `apps/worker/.venv/bin/python scripts/dev/phone-test/local.py serve`.
  It runs worker8187, production dashboard3101, the worker and Supabase API tunnels,
  and caffeinate. Other existing processes are not stopped. Keep the Mac awake,
  connected to the internet and the launcher running.
- Stop only this managed stack with `local.py stop`. Quick-tunnel URLs change on
  restart. Update Vercel WORKER_BASE_URL/NEXT_PUBLIC_SUPABASE_URL to the new public
  URLs and redeploy; never export the database administrator key.
- Refresh reviewed pilot facts with `pilot.py --plan`, then `pilot.py` after
  reviewing the manifest. It refuses remote database URLs and changes only the
  deterministic pilot rows/internal `.test` owner. Local.py prepare refuses to
  replace an already configured pilot. Source updates must be verified again.
- To rebuild the local production dashboard, load the private runtime environment
  without printing it, set NEXT_DIST_DIR=.next-phone-prod and run Next build;
  restart the managed stack afterward. The separate .next-phone-prod directory
  avoids the user's other running dashboard/build.

## Browser greeting warm-up

The browser cascade uses `prompt_sections.browser_greeting` independently of the
telephone greeting and its recording notice. The Dixie manifest/importer supplies
`BarBQ Tonite, hello.`. Apply that one section to the isolated local draft before
warming; re-running the importer against an existing pilot is unnecessary.

The exported API in
`apps/worker/src/voice_receptionist_worker/pipeline/greeting_cache.py` is:

```python
async def prepare_browser_greeting(
    config: RuntimeConfig,
    prompt_sections: Mapping[str, str] | None = None,
    *,
    api_key: str,
    client: httpx.AsyncClient | None = None,
) -> Path:
    ...
```

Outside calls, invoke
`await prepare_browser_greeting(config, prompt_sections, api_key=runtime_soniox_key)`
with the exact DB draft's `agent_version_id`, restaurant `id`, `name`,
`primary_language`, prompt sections, and the worker's provider configuration.
This is an operator step; the worker never reads secrets from files to warm it.
The returned path contains only a digest. The isolated Dixie draft has been
updated and its real Soniox/Priya greeting warmed: 1.7067 seconds of speech.
Cache generation used the existing provider account; offline tests use fixtures.

`providers.greeting` configures the REST endpoint, `/tmp` cache directory,
16 kHz source rate and 30-day expiry. Cache identity includes draft, restaurant,
text, TTS model, voice, canonical language and sample rate. Entries use atomic
writes and identity/PCM checksums. Empty, malformed, expired, mismatched or
longer-than-two-second clips are rejected. If a warm rejects duration, shorten
the draft greeting (for example `Hello.`) and warm its new identity; audio is
never truncated or accelerated. Cache generation is a one-off provider cost,
not per-call TTS usage.

Warm before worker restart using the same cache directory. Without a valid
entry the browser speaks the short text through live TTS once, so the first
uncached greeting retains provider startup latency. Cache hits queue interruptible
40 ms PCM frames directly through installed Pipecat output; WebRTC resamples
16 kHz to its existing 24 kHz rate. The output transport also bounds oversized
input frames. Completed cached greetings contribute one transcript sentence;
an interrupted clip does not claim its unplayed full sentence. There are no word
timestamps for partially played cached greetings, so that partial text is omitted.

Both browser usage migrations were reviewed and applied to local Supabase.
`20261112120100_exclude_browser_admin_usage.sql` excludes browser calls from admin business usage
while preserving the existing function owner, permissions and RLS. Worker
post-call/monthly billing also excludes browser calls without clearing their
provider cost snapshots. This change does not repair previously persisted
monthly ledger rows until telephone post-call rebuilding runs for that period.


## Call history and usage update — 2026-11-12

New browser calls create real UUID records before paid processing, incrementally
store final conversation text, language, timing and provider metrics, and finalize
on hang-up/failure. Historical unlogged calls cannot be recovered. No audio is
recorded and no additional AI summary pass runs. Practice bookings/orders/SMS
remain unsaved; browser calls never enter customer billing or admin revenue usage.

The existing Calls list/detail layout now shows Browser test call, actual elapsed
duration, input/output/cached LLM tokens and provider/model cost breakdown. Dollar
values are explicitly **USD estimates**. Pipecat reports exact LLM token usage;
Soniox seconds/characters are converted using configured approximate rates, which
exclude unreported STT text/context. Missing values stay unavailable. This is not
an invoice reconciliation. Call dates and Today/7-day/30-day filters use the
restaurant timezone, including after UTC midnight and across DST boundaries.

Caller language is validated before LLM/TTS settings, with immediate explicit
requests, minimum dominant-word evidence and Hindi/Urdu ambiguity hysteresis.
Generation language is frozen on each TTS context so delayed playback cannot
inherit a subsequent turn's language. Prices, times, phone digits and other
numeric speech use English words while the surrounding answer stays in the
validated caller language. Number conversion does not alter LLM/tool context.

The same voice/model and sentence-based streaming remain configured. Runtime
date/time follows the stable prompt prefix to allow provider prompt-cache reuse.
Information replies answer requested facts briefly without automatic follow-up.
No filler audio or higher-priced priority tier was enabled to conceal latency.
Native-speaker listening and physical Android/mobile-network quality remain open.

Opt-in live evidence: `apps/web/tests/live/call-history-check.mjs`. It uses a
synthetic caller and ordinary pilot login, checks stored calls/usage, unchanged
business tables, dashboard rendering, microphone cleanup and approximate audible
reply timing from speech-energy intervals. Reports/screenshots are private under
`tmp/phone-test`; short runs are not formal PRD p50/p95 acceptance gates.


Live verification (2026-11-12, before the final prefix-only worker refresh):
public English→Urdu→Telugu call `8d10f5e6-b66a-4e7e-9d50-c0ec0280becd`
passed correct language tags and English price words, persisted text/tokens/cost,
zero audio recording, zero business writes and zero page errors. Client audible
reply samples:1284/1209/1451ms (median1284ms; n=3). First cached greeting audio
arrived2410ms after ready in this public run; another isolated warm run674.8ms.
An earlier cold Soniox connection waited5.75s before pipeline start. The1.7067s
clip duration is not a tap-to-completed-greeting guarantee.

Baseline client samples were5030/1598/1361ms; these short synthetic runs are
network/provider-sensitive and do not establish a guaranteed improvement or a
formal p95. Partial known USD/min estimates were0.01146baseline and0.01164public
after; changed response lengths and timing affect this estimate. Same Soniox
Priya/model, OpenAI model/rates, sentence aggregation and no priority tier.
Sub-second responses are **not verified**. Native-speaker quality remains open.

Pilot configuration issue found and corrected: importer/database originally
enabled only en/fr-CA/ur/hi/pa; Telugu final ASR text could be recognised but was
correctly rejected by the enabled-language controller. Only the isolated local
restaurant allowlist was widened to en/en-IN/fr-CA/ur/hi/pa/te/ar. No speculative
runtime language changes were made for this disabled-language symptom.


Final reviewed deployment and recheck (2026-11-12 19:39 EST): Vercel alias
refreshed to the current managed Mac/database tunnels. Final public call
`a85c5964-adbd-4e01-be83-3f4b1d013dc4` passed strict EN→UR→TE tagging and
English price text, saved31005LLM tokens with partial cost breakdown, dashboard
rendering, microphone stop, no after-stop audio, zero page errors/business writes.
Audible reply intervals1321/1197/1243ms (n=3, median1243ms); first greeting
audio234ms after ready, native lead≤0.181s. Partial known estimateUS$0.01271/min.
Latest local final run also passed (median1333ms). These are synthetic browser
measurements, not physical Android or native-speaker certification.

Final root checks:488worker/763web/8shared tests; lint/typecheck; isolated local
and Vercel production builds/client-secret scans; migration/RLS/owner review;
independent accounting/language/prompt reviews. No commit/push; M0 and launch
gates remain open. Keep the existing Mac and managed launcher running.


## Connection recovery and existing-quality follow-up — 2026-11-12 evening

Owner reported the generic connection error in the Codex browser. Its existing
tab was an older UI version. Fresh public Chrome and local/public health checks
succeeded. Reloading that tab restored the current demo; the owner re-entered
the code because browser automation redacts the input. An18.36s AI call then
reached the worker and the tab showed a clean call end. No worker/tunnel restart
or security exception was needed. The precise stale-client network cause was
not logged, so CSP/old endpoint are not claimed as proven.

A one-line existing error message now recommends reload, re-enter code and
Start call, with Chrome Android/Safari iPhone fallback.764web tests, type/lint
and independent review pass; deployed production build/client-secret scan pass.
A real blocked-WebSocket check confirmed the message, resource cleanup and
mobile layout without starting providers. Five consecutive public calls with
2.2s delivery batching passed. Synthetic correction, memory, unknown allergen
policy, interruption and cancellation passed; all seven advertised base languages
now have live functional evidence, including Arabic/English numbers.
See QUALITY-CHECKS-2026-11-12.md for fixed scenarios, timings/costs and remaining
physical-phone/native-speaker gates. Same app scope/UI/voice/model/rates; no new
services, billing tier, telephony/SMS, real business writes or launch gate claim.
