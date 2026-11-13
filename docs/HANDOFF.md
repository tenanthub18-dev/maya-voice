# Handoff — 2026-11-12 (Claude session ended; start a new one from here)

## Latest — repeatable quality gates and publication prep, 2026-11-12 late EST

Supersedes older test counts and local-build notes below.510worker/764web/
8shared pass, type/lint/build/client-secret scans pass. Node production audit
and patched Python audit have no known vulnerabilities. Patched cryptography
50.0.2, certifi2026.10.18, pyasn1.0.6.5, Starlette1.3.1 and required
PyOpenSSL26.4.0; existing FastAPI/Pipecat/model/voice/rates unchanged.

Managed demo uses .next-phone-quality-final and the current runtime/tunnel URLs.
Latest Vercel public alias is connected; no privileged DB/AI keys exported.
Existing user code/login unchanged. New source test tools version two fixed
correction/modifier/date and recommendation/budget/uncertainty scenarios.
Their cached WAVs/reports are ignored/private; reports retain pending human
judgment and cannot be named runtime.json. See scripts/dev/voice-test/README.md.

Factual/consent/cancellation/no-write checks passed. Natural brevity, unnecessary
follow-ups, consistent sub-second speed and physical/native-speaker quality
remain open; do not call this Friday-night/production certified. Discarded late
reminder/sampling experiments. Final public EN→UR→TE regression passed with
1089ms median over3synthetic replies and estimated partialUSD0.01193/min.

User requested full initial snapshot to public tenanthub18-dev/maya-voice/main.
README renamed maya-voice; private env/runtime/audio/reports, machine state,
generated output and local comms ledgers excluded without deleting working
files. Source credential comparison and policy secret scan clean; reviewed
public fixture/environment-reference false positives. GitHub CLI still showed
anyappx without write access at the last check; user chose owner sign-in.
Verify actual CLI identity/permission before push; do not force remote history.
Commit/push state must be reported from actual Git/remote evidence, not this
preparation note. See quality-acceptance-and-initial-push plan.


## Latest — call history, usage and speech updates, 2026-11-12 evening EST

This supersedes the older counts/local-build warnings below. Existing paper/green
UI retained; new browser calls persist real duration, final transcript, language,
latency and provider usage. Calls list/detail shows input/output/cache tokens and
partial USD estimates, dates in restaurant timezone. No audio recording, summary
AI pass or customer billing for practice sessions. Browser bookings/orders/SMS
remain dry-run. Historical calls with no logging cannot be recovered.

Two additive browser usage migrations applied to local Supabase only, reviewed
for owner/grants/RLS and browser exclusion from admin/customer billing. Priya
short browser greeting warmed (1.7067s audio); cold service startup may still
delay playback. Validated language before LLM/TTS; HI/UR ambiguity protection;
frozen generation language survives delayed playback; numeric speech is English.
Pilot/importer now enable en/en-IN/fr-CA/ur/hi/pa/te/ar (previously only five).

Final root checks:488worker,763web,8shared; lint/typecheck/local and remote
production builds/client-secret scan. Security/accounting/language source
review approved. Real public synthetic EN→UR→TE and EN→FR→HI→PA calls verified
speech, tags, tokens/cost, dashboard, zero business writes/page errors and mic
cleanup. Median~1.28s in short client samples, slowest2.35s in the broader run;
not a PRD gate or sub-second guarantee. Costs are partial estimates,~US$0.01/min.
Same voice/model/rates; no paid tier, new service, speculative inference or filler.

Stable public entry: https://voice-receptionist-demo-ten.vercel.app/demo
and /calls, /login. Private unchanged credentials remain in ignored runtime
files. Managed worker8187 / production UI3101 uses .next-phone-call-updates-v2.
Runtime state records current launcher PID and tunnel URLs. Keep launcher and
Mac awake; stop only through scripts/dev/phone-test/local.py stop. Restart
requires public URL env refresh + Vercel redeploy. Admin DB key stays Mac-only.
No commits/pushes, Telnyx/SMS/cloud Supabase or milestone closure. Physical
Android/network/native-speaker, actual restaurant policies/capacity and launch
gates remain open. Detailed evidence/restart: BROWSER-DEMO.md / LATENCY-BRIEF.md.


## Latest — browser pilot deployed, 2026-11-12 15:58 EST

Playback follow-up: owner reported Android Chrome playback-behind errors. A2.2s
delivery burst reproduced the old1.5s cutoff. The public Vercel demo now has a
bounded PCM FIFO and~200ms native scheduling window; clear/stop cancels all
pending audio/timers, and delayed native scheduling errors clean up the call.
Fresh729web tests/typecheck/lint and production build/secret scan pass. Three
same-page repeat calls with2.2s bursts and another later3.4s reply burst passed
on the public demo, with~0.24s native lead and clean hang-up. Physical Android
retest remains with owner. Local3101 production build still predates this fix;
do not assume it serves the updated player until rebuilt. See BROWSER-DEMO.md.

The owner deferred Telnyx/SMS/number purchase and rejected Fly billing. They chose
the existing Mac for remote friend/client testing, requested a designed browser
call screen and supplied the BarBQ Tonite Restaurant Dixie link for a real-data
pilot. **This supersedes the phone-first next steps below.**

See `docs/BROWSER-DEMO.md` for the complete design, verification and restart
instructions. Public call page:
https://voice-receptionist-demo-ten.vercel.app/demo ; dashboard `/home` on the same
host uses the local Supabase API tunnel with ordinary user authentication/RLS.
The database administrator key remains on the Mac; never export it to Vercel.
Private code/login: ignored `tmp/phone-test/demo-access.txt` and
`tmp/phone-test/pilot-login.txt` (0600). Do not print them. Runtime holds the
current tunnel URLs, pilot IDs and server environment, also0600.

Managed launcher is running with worker8187, production web3101, two temporary
tunnels and caffeinate. Keep it running. Restart changes tunnel URLs and requires
Vercel public/backend URL updates and redeployment. No git commit/push occurred.
Pilot manifest has44 verified Dixie pickup-menu prices, profile, coordinates and
listed hours; importer creates its own isolated organization/owner/restaurant,
seven FAQs and published/draft agents. Other clients were preserved. Slots are
explicitly TEST-ONLY defaults; orders/bookings in browser calls are dry-run.

Fresh checks:312worker,716web,8shared; web typecheck/lint; local and Vercel
production builds/client-secret scan; real WSS question/reply with correct
restaurant closing time and menu price; Vercel Chromium audio/mute/unmute/hang-up
with zero page errors; authenticated profile/menu/hours/FAQs/dashboard pages200;
public API rejects anonymous table reads and isolates the pilot from other clients.
Security reviewer findings were fixed, including explicit bounded WebSocket backend.
Actual iPhone/mobile-network and native-language quality still need owner tests.
Cloud Supabase/telephony/actual restaurant policy and all remaining PRD gates stay open.

## Codex continuation — local phone preparation, 2026-11-12

Latest state supersedes the account/local-readiness notes below. Branch is
`codex/phone-e2e-local`; no commit, push or cloud deployment. See
`docs/PHONE-TEST.md` and `scripts/dev/phone-test/README.md` for the complete ledger.

The real-data dashboard is running on port 3101, isolated worker on 8187, with a
protected temporary Cloudflare worker tunnel and reserved local owner. Login
details are in ignored `tmp/phone-test/login.txt`; runtime state/IDs are in ignored
`tmp/phone-test/runtime.json`. Do not print either file. Telnyx API key is already
in `.env.local` and works. The named test TeXML app and CA-only messaging profile
are configured. Worker SMS delivery code is now real, with provider receipt IDs.

User chose **keep preparing; upgrade later**. Still needed: Telnyx upgrade,
`TELNYX_PUBLIC_KEY` from the portal, purchase approval for one actual number,
number assignment to the provider app/profile and local restaurant, then a real
call/SMS test. No number has been purchased and no real call/SMS has been made.
Do not treat passing automated tests or the local dry-run voice check as the
phone/latency acceptance gate. The older default dev servers were left alone.

Latest checks: 236 worker + 640 web + 8 shared tests; typecheck/lint; authenticated
browser Home/Calls/Bookings with zero page errors. Review fixes approved.

Read first: `CLAUDE.md`, this file, `docs/DECISIONS.md` (tail), `docs/LATENCY-BRIEF.md`, `scripts/dev/voice-test/README.md`.
Nothing is committed or deployed: ~180 paths are uncommitted on `main`; no push has happened.

## Where we are
Product: multilingual AI voice receptionist for Canadian restaurants (PRD in repo root). The call path works locally end to end on a
Mac: browser test call (WebRTC) -> Pipecat worker -> reply. Telnyx phone path exists in code but **has never taken a real call**.

Languages (8): en, en-IN, fr-CA, ur, hi, pa, te, ar. One demo voice for all: Soniox **Priya**. Telugu/Arabic phrases and SMS texts were
written by Claude and need a native-speaker review; Arabic dialect not chosen.

### Stack as configured (config/providers.yaml, worker env)
| Part | Choice |
|---|---|
| Speech to text | Soniox `stt-rt-v5`, language hints strict, language ID on |
| In-call LLM | OpenAI `gpt-4.1-mini` (no reasoning param); fallback `gpt-4.1`. `gpt-5.6-terra` (reasoning none) is the quality upgrade |
| Post-call summary | Gemini `gemini-3.1-flash-lite` (free tier is flaky: 503/429) |
| Text to speech | Soniox `tts-rt-v2`, voice Priya; language follows the caller (`TTSLanguageProcessor`) |
| Turn taking | Silero VAD stop 0.12 s + speech timeout 0.1 s (env `VAD_STOP_SECS`, `SPEECH_TIMEOUT_SECS`); barge-in needs 3 recognised words |
| Numbers | LLM writes digits; `pipeline/spoken_numbers.py` turns them into English words before TTS (all languages) |
| Phone numbers | 10-digit Canadian numbers accepted, `+1` added in `tools/dispatcher.py` |
| Telephony | Telnyx TeXML (PCMU 8 kHz) — untested live |
| Data / web | Supabase (local stack ports 55321-55324; cloud project created, empty), Next.js app with all 8 languages |
Switches (env): `TURN_DETECTION=smart_turn` (rejected, bad tail), `TTS_AGGREGATION=token` (rejected), `ACK_CLIPS=1` (pre-recorded "Mm-hm",
off: sounded fake), `VOICE_MODE=realtime` (+`REALTIME_*`, OpenAI speech-to-speech experiment, browser path only).

### Latency (caller side, Mac, 12+ turns, 8 languages; harness adds ~0.3 s vs worker log)
| Setup | first sound p50 / p95 |
|---|---|
| Terra + old timers | ~1.65 s / 2.1 s |
| gpt-4.1-mini + short timers (**current default**) | ~1.6 s caller-side (worker log 1.18 s) |
| + pre-recorded clip (off) | 0.61 s / 0.70 s first sound, answer still ~1.8 s |
| Realtime mini, server VAD 200 ms | 1.56 s / 2.44 s (not faster; feel not judged) |
Budget target is 0.7 s p50. Remaining ideas: start LLM on interim transcripts, priority tier, stable prompt prefix, fast model for first
sentence, Toronto hosting, real phone measurement. Per-stage logging is in `latency.py` (`stages_ms`) + `apps/worker/scripts/latency_report.py`.

### Cost at 600 min/month/client (estimates, unverified prices): ~$17 with Terra, ~$11 with 4.1-mini (Telnyx ~$6 of it; number is $1 + $1/mo).

## Accounts / keys
- In `.env.local` (git-ignored): SONIOX, OPENAI, GEMINI, plus local Supabase and test secrets. `~/.openai_key` also exists.
- Fly: `fly auth login` done; app **maya-voice-worker** created (region yyz), `apps/worker/fly.toml` bound to it, **not deployed**.
- Supabase cloud project (Canada Central) ref saved in `~/.supabase_project_ref`; **no token / DB password yet**, no migrations pushed.
- Telnyx: account still TRIAL (needs upgrade + credit; trial blocks Canadian numbers). No number bought, no API key saved.
- Vercel: not started. Missing key files: `~/.supabase_token`, `~/.supabase_db_password`, `~/.telnyx_key`, `~/.vercel_token`.
- User wants "maya" (not a personal name) in public names; the Supabase project name still contains an email: rename it to `maya-voice`.

## Migrations (apply in order; local DB has them): ...130700 en-IN, ...130800 te, ...130900 ar (widen language checks) plus the earlier
admin-console fix (Postgres 17.6 `grant ... to current_user` workaround) — **all need the reviewer pass** (security/data-integrity rule).

## Known problems
1. Browser test calls only work on the same Wi-Fi: no TURN relay. The free public relay failed. Real phone number removes this.
2. Two phone test calls dropped after ~35-40 s (same cause, unconfirmed). A friend on another network could not connect.
3. Test-tooling temp folder was wiped overnight; tools were rebuilt in `scripts/dev/voice-test/` (clips are git-ignored: run `gen_clips.sh`).
4. Not done: reviewer pass on migrations, `check-env`/`docs/GO-LIVE.md` still lack `OPENAI_API_KEY` and `WEBRTC_ICE_SERVERS`, privacy wording
   (caller speech now goes to OpenAI), native review of te/ar/ur/pa/hi phrases, no test covering the WebRTC builder imports (a missing import slipped past 168 tests once).
5. gpt-4.1-mini quality in ur/pa/te and with tools is only lightly checked; mini wrote local-language numbers before the code transform existed.

## Next steps (in order)
1. Get from the user: Supabase token + DB password files, Telnyx upgrade + API key file + purchased number. Ask before spending > $25.
2. Supabase: `supabase link`, `db push` (migrations + a minimal prod seed, not the demo calls), keys via CLI. Fly: set secrets from env without printing,
   `fly deploy -c apps/worker/fly.toml`, scale to 1 machine for testing. Telnyx: TeXML app + webhook to the worker + assign number + fallback.
3. Real call test from a phone: audio both ways, barge-in, language switch, booking/order, hangup, silence. Re-run latency in Toronto with 100+ turns.
4. Then: latency ideas above, native-speaker review, commit (local) before deploy, web app against cloud DB, landing page update.

## Prompt to paste into the new terminal
```
Read CLAUDE.md, docs/HANDOFF.md, the tail of docs/DECISIONS.md and scripts/dev/voice-test/README.md, then continue. Goal: first real phone call
through Telnyx on Fly Toronto + cloud Supabase, then cut reply latency toward 0.7 s. I will give API keys as files in my home folder
(~/.supabase_token, ~/.supabase_db_password, ~/.telnyx_key) and the Telnyx number; never print or paste secrets. Check what already exists
before starting (fly app maya-voice-worker, ~/.supabase_project_ref). Keep my personal name out of every name, use "maya". Do not play audio aloud
on the Mac (use scripts/dev/voice-test). Be short and non-technical in messages. Ask before any spend over $25 or any push/commit I haven't approved.
```
