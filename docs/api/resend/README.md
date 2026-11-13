# Resend API reference (as of 2026-10-27)

Every item cites its source. Items marked **UNVERIFIED** were inferred or not visible in the fetched docs. The fetch tool summarises pages, so literal JSON examples for webhooks were not available: webhook fixtures use docs-listed field names with placeholder values.

Base URL: `https://api.resend.com`. Auth on all calls: `Authorization: Bearer re_xxxxxxxxx`, `Content-Type: application/json`.

## POST /emails — send email
Source: https://resend.com/docs/api-reference/emails/send-email
- Headers: `Authorization`, `Content-Type`, optional `Idempotency-Key` (unique per request, expires after 24h, max 256 chars).
- Body: `from` (req), `to` (req, string|string[], max 50), `subject` (req), `cc`, `bcc`, `reply_to`, `html`, `text` (auto-generated from html if omitted; "" opts out), `headers` (object), `tags` ([{name,value}], ASCII letters/numbers/_/-, max 256 chars each), `attachments` (max 40MB after Base64), `template` ({id, variables}; cannot combine with html/text/react), `react` (Node SDK only), a scheduling param (natural language or ISO 8601; its name is `scheduled_at` in the REST API but **UNVERIFIED** because the page did not show it; the batch page lists it as `scheduledAt`), a topic id param.
- Example: see curl below and `fixtures/send-email.request.json`.
```bash
curl -X POST 'https://api.resend.com/emails' -H 'Authorization: Bearer re_xxxxxxxxx' -H 'Content-Type: application/json' \
 -d '{"from":"Acme <onboarding@resend.dev>","to":["delivered@resend.dev"],"subject":"hello world","html":"<p>it works!</p>"}'
```
- Success: 200 `{"id":"49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"}` (`fixtures/send-email.response.json`).
- Errors/rate limits: see sections below.

## POST /emails/batch
Source: https://resend.com/docs/api-reference/emails/send-batch-emails
- Same headers incl. optional `Idempotency-Key`. Body is a JSON array, up to 100 emails; `to` max 50; **attachments not supported**; same field set as above (`topic_id`, `scheduledAt` shown on this page).
- Success: `{"data":[{"id":"..."},{"id":"..."}]}`, index-aligned with request (`fixtures/batch.*.json`).

## Errors
Source: https://resend.com/docs/api-reference/errors (JSON body shape NOT shown on fetched page; see `fixtures/error.rate_limit_exceeded.UNVERIFIED-shape.json`). Match on name AND status.
| name | status | meaning |
|---|---|---|
| invalid_idempotency_key | 400 | key must be 1-256 chars |
| validation_error | 400/401/403 | invalid fields / invalid API key / domain not verified / test-send limited to own address until domain verified |
| missing_api_key | 401 | no Bearer token |
| restricted_api_key | 401/403 | key send-only, or not active |
| email_above_quota | 403 | content unavailable (quota on receipt) |
| invalid_permission | 403 | token lacks scopes |
| suspended_api_key | 403 | key suspended |
| not_found | 404 | endpoint missing |
| method_not_allowed | 405 | |
| concurrent_idempotent_requests | 409 | same key in progress |
| invalid_idempotent_request | 409 | key reused with different body within 24h |
| resource_locked | 409 | retry after delay |
| invalid_attachment / invalid_parameter / missing_required_field / missing_required_parameter | 422 | |
| daily_quota_exceeded | 429 | resets midnight UTC |
| monthly_quota_exceeded | 429 | |
| rate_limit_exceeded | 429 | too many req/sec |
| application_error | 500 | |
| service_unavailable | 503 | |

## Rate limits
Source: https://resend.com/docs/api-reference/rate-limit — default 10 requests/second per team (all keys). Response headers: `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `retry-after`. Raise via support.

## Webhooks
Sources: https://resend.com/docs/webhooks/event-types, https://resend.com/docs/webhooks/verify-webhooks-requests, https://resend.com/docs/webhooks/retries-and-replays
- Events we need: `email.delivered` (delivered to recipient mail server), `email.bounced` (permanently rejected), `email.complained` (delivered, marked spam). Others exist: email.sent, delivery_delayed, failed, opened, clicked, received, scheduled, suppressed, plus domain.*, contact.*, suppression.*, topic.*, inbox.*.
- Payload shape: `{type, created_at, data:{broadcast_id, created_at, email_id, message_id, from, to[], subject, template_id, tags{}}}`; bounced adds `data.bounce:{diagnosticCode[], message, subType, type}`. Sources for fields: https://resend.com/docs/webhooks/emails/bounced (and /delivered, /complained). Fixtures: `fixtures/webhook.email.*.json` (placeholder values).
- Signature (Svix): headers `svix-id`, `svix-timestamp`, `svix-signature`. Must verify against the RAW request body (do not parse/re-stringify). Options: `resend.webhooks.verify({payload, headers, webhookSecret})` (Node SDK; throws if invalid) or `new Webhook(secret).verify(payload, headers)` from `svix` npm. No Python example on Resend page; use Svix's Python lib (**UNVERIFIED** here; see https://docs.svix.com).
- Retries reuse the same `svix-id` — use for dedupe. Schedule: immediately, 5s, 5m, 30m, 2h, 5h, 10h, 10h. Success criteria / timeout / source IPs: NOT FOUND in fetched docs.

## Domain verification
Sources: https://resend.com/docs/api-reference/domains/create-domain, https://resend.com/docs/add-a-domain.md
- `POST /domains` body: `name` (req), `region` (default us-east-1; also eu-west-1, sa-east-1, ap-northeast-1), `custom_return_path` (default `send`), `open_tracking`, `click_tracking`, `tracking_subdomain`, `tls` (opportunistic|enforced), `capabilities.sending|receiving`.
- Response includes `status` (initial `not_started`) and `records[]` {record, name, type, value, ttl, status, priority(MX only)}: DKIM TXT at `resend._domainkey`; SPF MX + TXT at `send` (MX -> `feedback-smtp.<region>.amazonses.com`, priority 10); optional Tracking CNAME. Copy exactly; no proxying on CNAMEs. Verification usually <15 min, up to 72h; "Restart verification" in dashboard.
- DMARC is not generated; add after verification (https://resend.com/docs/dashboard/domains/dmarc.md, not fetched).
- Full list of domain status values: NOT FOUND.

## Not confirmed
Literal webhook JSON examples, error JSON body shape, webhook timeout/IPs/2xx criteria, bounce type enums, exact scheduling param name in REST, domain status enum, GET/verify domain endpoints (not fetched).
