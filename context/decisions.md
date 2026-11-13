# Decisions Log

| Date | Decision | Why |
|------|----------|-----|
| 2026-10-26 | v1 is restaurant-only; other verticals (clinics etc.) are future intent, refactor later | User choice; avoids speculative abstraction |
| 2026-10-26 | PRD stays at repo root as the single canonical copy; `docs/PRD.md` is a pointer | User choice |
| 2026-10-26 | Claude orchestrates/verifies, Codex executes micro-tasks | User workflow |
| 2026-10-26 | Anvi (ChatGPT) is an independent watcher via `comms/` files | User workflow |
| 2026-10-26 | Codex CLI 0.164.0 installed via npm; model read from `~/.codex/config.toml` (skill's model names are stale) | Verified |

## VERIFY list (PRD §0) — unresolved
- Gemini Flash-Lite model ID and price
- Soniox Urdu TTS quality (native-speaker rating)
- Telnyx Canadian per-minute rates
- Supabase Canada region availability
- Pipecat smart-turn analyzer and min-words interruption class names

## Open questions (PRD §13) — unanswered
- Pricing (suggested $99 CAD / 500 min)? · Brand name and domain? · 3 design-partner restaurants and cities? · Staff SMS per booking or daily digest only? · Recording on or off by default?

## 2026-10-27 — User-approved deviation: mock data for the web app until keys exist
PRD §0 rule 4 forbids mock data in production paths. The owner (user) explicitly approved building the dashboard on mock data until API keys exist. Constraints: all mock data lives under `apps/web/lib/data/mock/` behind a `DataSource` interface; selected by `DATA_SOURCE=mock|supabase` (default `mock` for now); a visible "Demo data" banner renders whenever mock is active; the `supabase` implementation is added at M3/M4 and mock becomes dev/test-only before M6 go-live. Must be removed from production paths before M9.

## 2026-10-27 — Architecture: contract-first integrations, mock at the HTTP boundary
User directive: build the complete production app now; only the third-party APIs are mocked, and swapping in real keys must "just flow".
- Every third-party call goes through a typed client in `apps/web/lib/integrations/<provider>/` (worker: `apps/worker/.../integrations/`). Clients speak real HTTP to `<PROVIDER>_BASE_URL`.
- `INTEGRATIONS_MODE=mock|live`. In mock mode base URLs point at dev-only Next route handlers `/api/_mock/<provider>/...` (404 when NODE_ENV=production) that return responses copied from the providers' official docs (fixtures + cited URLs in `docs/api/<provider>/`).
- Request/response zod schemas are derived from those fixtures and validate BOTH mock and live responses, so a live response that deviates fails loudly in the same place. `scripts/smoke-live.ts` runs the same contract suite against live when keys exist.
- Postgres: real SQL migrations with RLS, tested in-process with PGlite (auth.uid() shimmed); `DataSource` gets a Supabase implementation next to the in-memory one.
- Design: no generic template look; real design system, tested at 375/768/1280, light+dark, EN+FR, RTL transcripts.

## 2026-10-27 — Stripe research findings (docs/api/stripe)
- Billing Meters + Meter Events is the current usage API (Usage Records is legacy). Stripe labels Meters "Not Recommended" for new builds and points to Metronome. PRD says Stripe: proceed with Meters behind our own `BillingClient` interface so a Metronome swap stays local. **Human decision needed before M8 go-live.**
- No native hard spend cap. Decision: app-side counter in Supabase (`usage_ledger`) refuses calls past `spend_cap_cents`; Stripe does invoicing only; `billing.alert.triggered` used for notifications.
- Webhook fixtures are composed from docs, not literal; replace with `stripe trigger` payloads at go-live. Canadian GST/HST registration = accountant (human-tasks).

## 2026-10-27 — Soniox / Gemini research findings (docs/api/soniox, docs/api/gemini)
- Model IDs from docs (summaries, re-verify with key): STT `stt-rt-v5`, TTS `tts-rt-v2` (always pass explicitly), LLM `gemini-3.5-flash-lite`. Voice id still VERIFY (needs key: GET /v1/shared-voices).
- Gemini: do NOT send `temperature/topP/topK` (ignored, future 400); `maxOutputTokens` counts thinking tokens (100 can truncate -> raise, use thinkingLevel minimal). Free tier trains on data: never use for real calls. generateContent is "legacy" (Interactions API is new) - keep behind our LLM interface.
- Soniox: no `fr-CA` (use `fr`); TTS concurrency limit 3 streams (raise with Soniox before pilot); no Canada region; Gemini paid tier has no stated retention/Canada pinning. Both -> legal review list.
- Soniox pricing STT $0.12/h, TTS ~$0.70/h: within $0.033/call-minute budget (VERIFY).

## 2026-10-27 — Telnyx research findings (docs/api/telnyx)
- Auth Bearer to https://api.telnyx.com/v2. Webhook sig Ed25519 over `{timestamp}|{raw body}`; media-stream WS sig is over `{timestamp}|{stream_url}`. Messaging webhooks must 2xx within 2 s; dedupe on data.id.
- Telnyx auto-blocks STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT per messaging profile (send error 40300); French opt-out keywords likely need custom config. We still keep our own `sms_optouts`.
- Only `POST /messages` has an Idempotency-Key; number orders/deletes do not -> list-then-retry.
- Unconfirmed (VERIFY with key): TeXML app id as connection_id on number PATCH; `<Connect><Stream>` frames identical to Call Control; whether TeXML fetch request is signed; Canadian number order requirements; CA outbound voice price for <Dial>.
- Pricing (VERIFY): local number $0.35/mo, inbound $0.004/min, platform $0.002/min, streaming $0.0035/min, SMS ~$0.0025-0.004.

## 2026-10-27 — Vercel demo deployment (user request)
When the dashboard work (017-027) is done and verified: deploy apps/web to Vercel in mock mode, no real auth, one-click 'Log in' enters as demo owner, noindex. Mock data only, no provider keys on Vercel. Deploy only after user-visible quality gate (my screenshot review). Switching to live later = set env vars + INTEGRATIONS_MODE=live (docs/GO-LIVE.md).

## 2026-10-27 — F12 Stripe Connect contract verification
- Stripe now labels legacy Standard/Express/Custom connected-account types deprecated for new Connect platforms and recommends Accounts v2. Task 036 and PRD F12 explicitly require Standard accounts, so v1 Standard onboarding remains the approved implementation contract pending live Connect platform approval; do not enable the flag in production until Stripe confirms the platform may create Standard accounts. Source: https://docs.stripe.com/connect/standard-accounts.
- Verified that server-side calls scoped to a connected account use the `Stripe-Account` header: https://docs.stripe.com/connect/authentication.
- Verified that the Payment Links API accepts inline `line_items[0][price_data]` with product data, currency, and minor-unit amount: https://docs.stripe.com/payment-links/create. The dynamic order/deposit amount therefore remains server-computed without creating reusable catalog prices.
- Verified that metadata set on a Payment Link is inherited by each generated Checkout Session, while `payment_intent_data.metadata` is copied to generated PaymentIntents. This supports both required webhook event types without a follow-up Stripe read: https://docs.stripe.com/metadata/use-cases#track-affiliate-links and https://docs.stripe.com/api/payment_links/create.
- Verified that Payment Links expose `restrictions.completed_sessions.limit`. Target-specific links set the limit to `1`, and the web route refuses already-paid targets, to prevent ordinary replay/double-payment: https://docs.stripe.com/api/payment-link/object.
- A disconnected account is removed only from the restaurant's active connection field; its historical account-to-restaurant mapping is retained for signed webhook reconciliation. This avoids losing a valid late payment from a link issued before disconnect.
- Activation constraint: the required `call_id + target_id` Stripe idempotency key can create separate one-use links for the same still-unpaid target across different calls. The independent money/security review accepts this for flag-off-by-default delivery, but broad/default-on activation requires either persisted per-target active-link reuse/deactivation or an explicit risk acceptance.
