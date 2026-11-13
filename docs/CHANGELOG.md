# Changelog

## 2026-11-12 — Reuse-first feature research

- Compared installed Pipecat capabilities, reusable UI/metrics components, language/numbers options and official POS APIs for the requested pilot improvements.
- Recorded source links, license and hosting constraints, browser call persistence gaps and integration acceptance checks in `REUSE-RESEARCH-2026-11-12.md`.
- Research only: no application code, dependency installation, deployment or live POS order changes.

## 2026-11-12 — Local real-phone test preparation

- Added an isolated local launcher, real Supabase owner login, private login details, Cloudflare worker tunnel and signed-SMS-only gateway; existing services stay untouched.
- Connected worker SMS to Telnyx with tenant-owned senders, localized identity/STOP text, provider idempotency and receipt IDs. Uncertain sends remain pending rather than being labelled rejected.
- Protected optional unsigned TeXML instruction fetches with a strong shared secret; disabled stream reconnection on intentional shutdown. Production signature verification remains the default.
- Let SMS callbacks reach their signature-verifying handler without browser login, and return 503 for missing live verification configuration.
- Verified automated tests, real dashboard login and one silent local voice response. Number purchase and real phone acceptance remain pending the owner's account upgrade; see `docs/PHONE-TEST.md`.

## 2026-10-27 — Automated PRD measurements

- Added deterministic F9 availability performance gates for the in-memory worker path and a real SQL function under PGlite with 1,000 seeded bookings and 200 measured runs.
- Added F13 ten-minute call-detail SSR timing and exact data-source call counting, plus full F14 raw-row funnel and heat-map assertions.
- Added a shared, hand-calculated 13-jurisdiction restaurant tax fixture consumed by worker and web tests, including Quebec GST/QST and the BC restaurant-food PST exemption note.
- Added a 60-second worker agent-config cache with targeted publish invalidation tests, restaurant-scoped STOP/START consent coverage, and serious/critical axe scans across route states and viewports.
- Recorded thresholds, current measurements, environment limits, and pass/fail status in `docs/GATES.md`.

## 2026-10-27 — Flagged diner payments (F12)

- Added owner-only Stripe Standard connection settings behind the default-off `diner_payments` feature flag.
- Added HMAC-authenticated, server-priced order and booking-deposit Payment Links on connected accounts, localized opt-out-aware SMS delivery, and one-completion link restrictions.
- Added connected-account Stripe webhook reconciliation with duplicate protection, historical account mapping after disconnect, and synchronous paid-state updates.
- Added EN/FR paid badges for bookings; existing order badges now receive webhook-backed paid state.
- Hardened production credentials, request-body limits, cross-restaurant lookups, paid-state write privileges, and already-paid refusal.

## 2026-10-27 — Auth, organizations, and invitations

- Added mock and Supabase SSR authentication, secure route protection, owner/staff/platform-admin authorization, expiring single-use organization invitations through Resend, and sign-out.
- Added the public landing, login, signup, callback, and invitation acceptance flows.
- Mock deployments now expose one-click demo-owner login and emit `noindex` metadata and headers without reading live provider keys.

## 2026-11-12 — Browser pilot demonstration

- Added a code-protected browser call screen, real PCM audio playback/capture,
  measured microphone activity, mute/unmute, timer and call cleanup.
- Reused the existing speech/AI pipeline over WSS so remote testers can connect
  through the Mac tunnel without telephony or paid worker hosting.
- Added authentication/replay/origin/admission/audio-rate limits and blocked
  private customer booking lookup in public demo calls.
- Provisioned the isolated, sourced Dixie restaurant pilot locally, with 44
  pickup-menu items, seven-day hours, contact/location FAQs and separate owner.
- Kept administrator credentials on the Mac; dashboard uses user-authenticated
  Supabase access. Deferred webhooks load without privileged keys and fail closed.
- Fixed existing owner WebRTC remote playback/cleanup and test-tab policy read.
- Production browser/phone and restaurant policy gates remain open; see BROWSER-DEMO.md.

## 2026-11-12 — Android Chrome playback cutoff

- Reproduced the reported cutoff with a2.2-second real-audio delivery burst.
- Replaced whole-burst native scheduling with a bounded PCM FIFO and short
  scheduling window, preserving samples and recovering transient delivery jitter.
- Added complete interruption/hang-up/retry and timer-driven failure cleanup.
-729web tests, typecheck/lint, production build/secret scan pass. Updated Vercel
  demo passed three repeated burst calls and a later3.4-second reply burst.
- Physical Android audio-quality retest remains open; local production UI needs
  rebuilding to receive the public deployment's playback fix.

## 2026-11-12 — Browser language, cached pickup and billing integration

- Browser post-call skips summary AI and customer usage writes; monthly rebuilding
  excludes browser duration and provider USD costs without erasing call snapshots.
  Added an additive admin-usage RPC migration preserving owner/permissions/RLS;
  the migration is tested in PGlite and awaits root application.
- Integrated the completed language helper with restaurant-enabled/primary
  languages, typed OpenAI/Google instruction replacements, TTS base languages,
  tool language and assistant accounting. Caller transcript labels remain intact.
- Added explicit persistent greeting warm-up, identity/checksum/expiry validation,
  a two-second duration cap, atomic writes and interruptible 40 ms cached output.
  Cold/invalid caches use live TTS once. Telephone recording notice is unchanged.
- Added the short Dixie browser greeting metadata/import section. Existing EN/FR
  owner disclosures already cover AI, review text/usage, no audio storage and
  unsaved practice business actions; added translation-contract coverage.
- Verified 449 worker tests and 751 web tests, web typecheck/lint, admin permissions,
  transcript/usage behavior, 16/24 kHz playback, interruption and output chunking.
  No provider requests, DB application, commits, pushes or deployments performed;
  root must patch the isolated draft, warm and run real browser/listening checks.

## 2026-11-12 — Browser call review, usage and multilingual pilot updates

- Saved new browser call UUID/lifecycle, final text, language, latency and real
  provider token/usage metrics incrementally; bounded final flush handles
  cancellation, ambiguous create responses and Pipecat final observer events.
- Preserved the current UI; Calls list/detail now shows browser source, actual
  duration, input/output/cache tokens and explicit partial USD cost estimates.
  Restaurant timezone drives list/detail dates and civil-date filters.
- Applied two additive migrations only to local Supabase; preserved RLS/grants
  and excluded browser calls from customer/admin billing. No audio recording or
  extra AI summary pass; business tools remain practice-only.
- Warmed a1.7067s Priya browser greeting, separate from telephone notice; added
  validated language control, HI/UR ambiguity protection, frozen per-generation
  TTS language and English-spoken numbers without changing tool context.
- Corrected the isolated pilot/importer allowlist from five to all eight
  requested languages; no other restaurant facts or clients changed.
- Kept configured model/voice/rates and sentence streaming. Dynamic time now
  follows the complete stable prompt/owner prefix; brief factual first replies.
- Root verified488worker/763web/8shared tests, web lint/typecheck, local/remote
  production builds and client-secret scan. Accounting and language changes
  independently reviewed. Public EN/UR/TE and EN/FR/HI/PA synthetic calls saved
  usage, correct speech/language tags and English prices with zero business
  writes/page errors and complete microphone cleanup.
- Public measured medians~1.28s in small synthetic runs; a2.35s reply remained.
  Partial known estimates~US$0.0094–0.0116/min. Sub-second and native-phone voice
  quality are not established. Same Vercel URL/login; Mac/tunnels must stay up.
  Final prefix-only worker refresh/public recheck tracked in BROWSER-DEMO.md.

## 2026-11-12 — Stale browser recovery and fixed quality scenarios

- Refreshed the owner’s old Codex demo tab; verified a real AI call reached
  the worker afterward. Existing public/local endpoints were healthy.
- Improved the existing WebSocket error to give reload/code/start guidance;
  added a five-attempt cleanup/stale-callback regression. No auth/CSP changes.
- Root764web/type/lint pass; independent review approved; Vercel production
  build/client-secret scan and fault-injected recovery check pass.
- Five consecutive real synthetic calls passed2.2s audio delivery batching,
  mic teardown and no after-hang-up playback. Correction/memory/uncertainty/
  interruption/cancellation and all advertised base languages functionally
  checked with existing voice/models and practice-only writes. Costs remain
  partial estimates (~US$0.0095–0.0103/min in latest scenarios); consistent
  sub-second/native-phone/native-speaker quality is not certified.

## 2026-11-12 — Repeatable acceptance and initial-publication preparation

- Added two opt-in fixed voice scenarios for quantity/modifier/date corrections
  and recommendation/budget/uncertainty changes, using existing libraries.
  Offline plans, private cached caller WAVs, exact new-call correlation and
  pending manual rubrics keep evidence repeatable without another AI judge.
- Fixed the reviewed report-filename collision: runtime.json is rejected
  case-insensitively before credential/network work; regression tests protect
  runtime bytes and prevent side effects.
- Clarified recommendation/correction/consent instructions; live factual checks
  passed while brevity/follow-up consistency remains open. Discarded a late
  reminder and sampling experiment that did not prove a useful improvement.
- Patched audited Python dependencies without changing voice/model/rates.
 510worker/764web/8shared tests, type/lint/build/client-secret checks and Node/
  Python vulnerability audits pass. No production-ready/latency/native gate claim.
- Prepared maya-voice README and public-source exclusions; private runtime,
  credentials, synthetic audio/reports, agent state, generated output and local
  session ledgers remain untracked. Initial push requires destination write access.
