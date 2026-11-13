# Existing app quality checks — 2026-11-12

Scope is the existing restaurant demo: same UI, Priya voice, speech/LLM models,
rates, practice-only tools and Mac/tunnel deployment. No new service, paid tier,
telephony/SMS capability, extra summary AI or customer-write activation.

| Fixed check | Result and evidence |
|---|---|
| Reported Codex browser connection failure | Old tab displayed pre-update UI and reproduced generic WebSocket error. Fresh public Chromium connected; all local/public health endpoints200. Reloaded existing Codex tab to current page. Browser redacts saved input, so owner re-entered code. Server recorded an18.36s AI session and tab ended without the error. Exact stale-client network mechanism was not captured; do not claim a specific CSP fault. |
| Five same-page calls + brief disrupted delivery | Five26s synthetic calls,2.2s incoming-audio batch each, all passed. Native scheduled lead≤0.240s, ended mic tracks, zero after-hang-up frames/page errors. Private playback-live.json and /private/tmp/maya-five-call-quality.log. |
| Retry after error/remote-close/manual stop | Added deterministic five-attempt regression with late callbacks from old sockets, mic/worklet/audio/timers. Full764web tests/typecheck/lint pass. Production change is one error-copy line; no automatic reconnect or security changes. Independent review approved. |
| Deployed recovery message | Injected blocked .invalid WebSocket only in test browser; shows reload/re-enter/start guidance and mobile browser fallback. Tracks ended, retry enabled, no mobile overflow, no provider call started. Private connection-recovery-live.json and screenshot. |
| Quantity correction and conversation memory | Synthetic order changed2ButterChicken→1, retained1GarlicNaan. Later recall returned correct quantities and item prices17.99/4.00. No customer order was saved. |
| Unknown policy + interruption | Caller asked about certified nut-free kitchen, interrupted with Please do not guess. Reply admitted certification unknown and referred to staff; previous speech stopped after I do not have. No invented certification. |
| Change of mind/cancellation | Caller cancelled practice request; assistant said nothing had been placed/saved. bookings/orders/sms_log/usage_ledger unchanged. |
| All seven advertised base languages | Existing EN/FR-CA/HI/PA run plus new EN→UR→TE→AR run. Correct scripts/tags and English price/time words checked. en-IN initial-language plumbing has automated coverage. This is functional evidence, not native-speaker pronunciation approval. |

Correction scenario:85.382s,31275LLM tokens; approximate client reply intervals
1504/1177/1516/1336/2329ms, median1504ms. One overlap was the intended caller
interruption. Partial known cost estimateUS$0.00946/min. Scenario transcript is
synthetic and private under tmp/phone-test/correction-unknown-transcript.json.

Final EN/UR/TE/AR run:63.395s,22220LLM tokens; replies1428/1230/1143/985ms,
median1143ms (n=4), first greeting audio1423ms afterready. Partial known cost
estimateUS$0.01029/min. Arabic reply correctly retained Arabic language and
English seventeen dollars and ninety-nine cents / ten thirty. Synthetic record
0782c1b3-c7c9-4f8f-8be1-914a97eeb8ae. Latest UI deployment rebuilt/scanned
successfully; current tunnel URLs, voice/model and access credentials unchanged.

## Limits and next human check

Meaningful sub-second replies occurred, but typical sub-second response and PRD
p95 are not established. Short synthetic runs are not statistically robust.
Provider connections/network remain variable. Costs are partial configured USD
estimates, not invoice reconciliation; no guarantee of a fixed per-minute price.

Owner should listen on physical Android Chrome/mobile data and use the same
menu/hours, quantity correction, uncertainty, language switch and interruption
scenarios. Native speakers must judge every advertised language. Record clipped
words, accent/pronunciation, whether the previous answer stops, understood
correction, facts and actual audible reply delay. Do not mark these human gates
passed from script labels or text alone. No launch milestone was closed.

If an old tab fails after a deployment/tunnel restart, reload the main /demo URL
and re-enter the existing code. Do not loosen CSP/authentication to hide that
condition. The Mac, network, local Supabase and managed launcher must stay up.


## Repeatable acceptance and initial-publication checks

The fixed scripts are now versioned in
`apps/web/tests/fixtures/voice-quality-scenarios.json`. Use the existing-library
CLI documented in `scripts/dev/voice-test/README.md`: offline list/plan, explicit
preparation of private cached caller WAVs, then opt-in replay through the existing
browser/history checker. No extra evaluator service or automatic semantic grade.
Reports correlate a distinctive caller phrase to a new browser call, reject
ambiguous matches and reserve runtime.json before any credential/network work.
Actual runtime/codes/audio/transcripts stay ignored and private.

This layered approach follows the [official voice-testing guidance](https://docs.vapi.ai/test/voice-testing): narrow decision checks, complete
conversations and audio/turn-taking checks provide different evidence. Human
listening still determines pronunciation and real-world conversation quality.
No Vapi service or SDK was added.

| Fixed scenario | Factual/outcome review | Before: client median / partial USD per minute | Latest deployed prompt: client median / partial USD per minute |
|---|---|---|---|
| order-correction | Two→three Butter Chicken, no-onions request, one Garlic Naan, tomorrow at7PM all retained in requested readback; no consent or success/SMS claim; no business writes |1314ms /0.00717|1342ms /0.00965 (local browser after run)|
| menu-recommendation | Vegetarian/chicken recommendations and prices; changed to both vegetarian under17CAD; nut-free certification unknown; no order/SMS/business writes |1282ms /0.00938|1288ms /0.00834 (public browser after run)|

Small samples, differing cache/turn counts and network path: these do not prove a
latency or cost improvement. Unit rates, voice/models and pricing tiers are
unchanged. The fixed caller can interrupt long recommendations in its12-second
response window; both-name/price-first brevity is still inconsistent. Some
correction replies still add unnecessary follow-ups. Treat these as **open
quality findings**, not a passed premium-conversation gate.

An extra late prompt reminder was tried only in a loopback worker. It did not
show reliable benefit and was removed, along with its temporary ordering-test
adjustments. A lower-sampling text-only probe also was not promoted. No
experimental reminder, temperature override, provider switch or automatic
reconnect was retained. The public prompt has clearer guidance for sourced
recommendations, correction retention, no-consent planning and kitchen requests,
but instructions alone do not establish consistent model compliance.

Final software/security gates for this snapshot:510worker,764web,8shared;
project type/lint and production builds/client-secret scans pass. Node production
audit and patched Python audit report no known vulnerabilities. A clean source
snapshot also typechecked without local generated Next build directories. Exact
local-credential comparison found no credential values in publication candidates;
repository secret-policy scan passed. Generic default-scan findings were reviewed
as documentation environment references and a public fixture UUID; a secret-like
unit-test literal was replaced by generated test bytes without weakening rules.

This is a reviewed **pilot snapshot**, not a production/Friday-night readiness
claim. Native-speaker/physical-phone approval, consistent sub-second speed,
concise dialogue, actual restaurant policy/capacity and all launch gates remain
explicitly open. User requested publication to tenanthub18-dev/maya-voice; final
commit/push status is recorded separately after GitHub write access is verified.


Final deployed-language regression after the security/prompt update passed:
English→Urdu→Telugu, English prices, saved call/usage/dashboard, no audio
recording/business writes/page errors, ended mic and no post-hang-up audio.
Synthetic record3eb138fb-05e7-4778-8c79-f3ca391a9ad1: reply intervals
1409/984/1089ms (median1089ms, n=3), first greeting audio325ms afterready,
partial known estimateUS$0.01193/min. These samples do not establish typical
sub-second phone response or native language approval.
