# Real phone test on a Mac

This uses the existing local Supabase database, Pipecat worker, Soniox, OpenAI,
Gemini and Telnyx. Only the worker and the existing signed SMS webhook are
reachable through the temporary tunnel; the dashboard and database stay local.
No command here buys a number, places a call or sends an SMS by itself.

From the repository root:

```sh
apps/worker/.venv/bin/python scripts/dev/phone-test/local.py prepare
apps/worker/.venv/bin/python scripts/dev/phone-test/local.py serve
```

`prepare` requires an already running local Supabase stack and the existing local
test seed. It refuses a remote API URL and never resets the database. It prepares
only the reserved `owner@maya.test` account, its membership and test restaurant.
Private login details are saved with mode 0600 in `tmp/phone-test/login.txt`.

The real-data dashboard is at `http://localhost:3101/login`; the isolated worker
is on port 8187. An already occupied port stops startup rather than killing an
existing service. Alternate Next.js output is `.next-phone-test/`.

Keep `serve` running. In another terminal, after it prints the tunnel URL:

```sh
apps/worker/.venv/bin/python scripts/dev/phone-test/local.py configure
node scripts/dev/phone-test/check.mjs
```

`configure` creates or updates only the named `maya-local-phone-test` TeXML app
and CA-only messaging profile. The first run creates provider IDs: stop and start
the stack once to load those IDs, then run `configure` again for the new tunnel
hostname. Later runs reuse the IDs. Tunnel hostnames change on every restart.

```sh
apps/worker/.venv/bin/python scripts/dev/phone-test/local.py stop
```

Ctrl-C, SIGINT and SIGTERM also stop the managed process groups and release the
Mac's keep-awake assertion. Unrelated applications are untouched.

## Finish after the Telnyx account upgrade

1. Upgrade the account; Canadian number searches currently return masked trial
   inventory. Recheck availability and the actual quote before approving purchase.
2. Put the account's public webhook verification key in `.env.local` as
   `TELNYX_PUBLIC_KEY` (Portal → API Keys → Public Key). Do not replace the API key.
3. Purchase one approved Canadian number with voice and SMS. Assign its voice
   connection to this test TeXML app and messaging to this test profile.
4. Map the owned number to the existing local test restaurant in `phone_numbers`,
   with its actual Telnyx ID and active status. Mark the seed's `demo-number-1`
   route released so it cannot be chosen as the outbound SMS sender.
5. Restart the stack and refresh the tunnel URLs with `configure`.
6. Call from the phone, ask about the menu, book a future open time, agree to the
   confirmation text, and verify both receipt and the saved booking/call.

The test restaurant has no real transfer destination configured. Transfer/failover
acceptance needs an owner-provided number; no call should be routed to seed data.

## Authentication and delivery

The local launcher opts into a 32-byte random shared secret for TeXML instruction
fetches. Signature mode remains the production default. Turning signature mode
off without a strong secret now fails closed. Do not print the configured voice
URL: it includes the secret. Worker access logs are disabled. SMS callbacks keep
their independent Ed25519 signature check; missing public-key configuration returns
503, never a login redirect or an authentication bypass.

SMS `sent` means Telnyx accepted the request, not confirmed delivery. The existing
receipt handler updates `provider_message_id` to delivered/failed and handles
STOP/START. A timeout leaves the SMS queued with unknown acceptance; the same tool
invocation is not automatically resent. Reconcile an uncertain send with its
original provider idempotency key before trying a new send.

Logs, screenshots, local keys and measurements live in ignored `tmp/phone-test/`.
The browser check verifies real login and Home/Calls/Bookings; it does not place
a phone call. Production deployment and PRD latency/language gates remain separate.

Sources: [Telnyx TeXML](https://developers.telnyx.com/docs/voice/programmable-voice/texml-instruction-fetching),
[SMS](https://developers.telnyx.com/api-reference/messages/send-a-message),
[trial limits](https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/trial),
[Cloudflare temporary tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
