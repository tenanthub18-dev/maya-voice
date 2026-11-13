# Local phone test

Current owner direction: telephone testing is deferred. The deployed browser
pilot and real restaurant data are documented in `docs/BROWSER-DEMO.md`.
Keep this document for the later authorized telephony test; do not purchase or
assign numbers as the next step for the browser pilot.

Goal: dial a Telnyx number, ask about the menu, make a real booking, receive an SMS,
and review the saved call and booking in the local dashboard. This is a development
test; the Mac must remain awake and connected.

## Progress — 2026-11-12

- Working branch: `codex/phone-e2e-local`; existing changes are preserved; no commit or push.
- Local Supabase and the isolated worker/dashboard are running. Dashboard: `http://localhost:3101/login`; worker: port 8187.
- Existing Telnyx credential is valid; the named test TeXML application and CA-only messaging profile are created and configured. No number was purchased.
- Canadian number search returns a masked number rather than a purchasable E.164 number; account readiness needs owner attention.
- Local database has the test restaurant, menu, hours, booking capacity, published agent and reserved owner membership. Private login details: ignored `tmp/phone-test/login.txt`.
- Worker SMS now calls Telnyx with a restaurant-owned active sender and provider idempotency, records accepted message IDs, respects opt-outs and keeps uncertain sends pending.
- Voice instruction URLs use a strong local shared secret; signed SMS callbacks are proxied through the worker tunnel without exposing the dashboard.
- Browser test calls remain dry-run and cannot establish real booking/SMS acceptance.
- Owner subsequently reported a Telnyx update. A fresh read-only check confirms USD 10 credit and zero owned numbers, but Canadian best-effort search still returns masked inventory. The later screenshot shows Paid prerequisites met, with Verified KYC/evaluation still incomplete. Owner confirms full Canadian numbers are visible in the portal, while the API continues to mask them. One portal-visible voice/SMS number is requested for quote verification; public webhook key, approved purchase/assignment and real phone/SMS acceptance remain pending. Dashboard/worker/tunnel still return 200. No number was purchased and no real phone call or SMS was sent.

## Execution ledger

1. Account/readiness inventory: complete; authenticated read-only checks succeed.
2. Real SMS delivery code and webhook protection: implemented and tested; live SMS receipt pending.
3. Local dashboard authentication and shared database: verified by real login and browser checks.
4. Temporary tunnel and Telnyx application/profile configuration: complete; refresh with `configure` after a restart.
5. Number assignment and actual phone acceptance: pending account readiness and purchase approval.

No phone number or credential values belong in this document or the comms log.

## Verification

- 236 worker tests, 640 web tests and 8 shared tests pass; web typecheck/lint pass. The final web suite used four workers after an unrelated import-flow timing failure under full concurrency; that test also passed independently.
- Real local browser login: Home, Calls and Bookings return 200, display the local restaurant and produce zero page errors. Screenshots are in ignored `tmp/phone-test/`.
- Public tunnel/worker health: 200; dashboard through the tunnel: 404; unauthenticated voice request: 401; missing SMS verification configuration: 503 without a login redirect.
- One silent local dry-run conversation used real speech/AI providers and heard one response. It was not a Telnyx call; the single first-sound observation was 2667 ms and does not meet or establish the PRD latency gate.
- Independent cross-review found three issues (shutdown, recreated login, ambiguous SMS status); all were reproduced/fixed and the narrow follow-up approved them.
- No production build/deployment, real-number routing, receipt delivery, interruption or multilingual phone acceptance was claimed. M0 and the PRD live gates remain open.

Restart and finish instructions: [phone-test README](../scripts/dev/phone-test/README.md).

## Acceptance

- A real incoming call reaches the assigned restaurant's published agent.
- Audio works in both directions; language switching and interruption work.
- A confirmed booking is saved once and appears in the authenticated dashboard.
- SMS is accepted by Telnyx and received by the caller; queued alone is not success.
- Hang-up ends the stream and saves the call/transcript; latency is measured, not assumed.
- Invalid requests cannot create call records; the tunnel does not expose the dashboard or database.

Sources: [Telnyx streaming](https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/stream),
[Telnyx SMS](https://developers.telnyx.com/api-reference/messages/send-a-message),
[Cloudflare temporary tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
