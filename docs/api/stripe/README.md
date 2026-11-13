# Stripe API reference notes (for the voice receptionist billing milestone)

Researched 2026-10-27 from official docs.stripe.com only. Status labels:
- **VERIFIED**: read on the cited docs page (fixtures marked verbatim are copied from it).
- **UNVERIFIED**: inference or composition. Do not treat as fact; confirm with `stripe listen` / a test-mode call.

Fixtures: `./fixtures/*.json` (each carries `_source` and `_status`).

## 0. Decisions you must make first (read this)

| # | Finding | Source |
|---|---------|--------|
| 1 | **Billing Meters + Meter Events is the current Stripe-native usage API.** Legacy Usage Records are documented as "legacy"; SDKs from the Basil API version onward deprecated `UsageRecords` (legacy still reachable by pinning a pre-Basil API version via RawRequest). Do not build on Usage Records. | https://docs.stripe.com/billing/subscriptions/usage-based-legacy |
| 2 | **Stripe's own docs now say Billing Meters are "Not Recommended" for new integrations** and point new usage-based builds, including adding metering to flat-rate subscriptions, to **Metronome** (separate Stripe-owned product). Billing Meters "isn't going away": "If you already use Billing Meters, you don't need to migrate." Metronome drawbacks of Meters: usage visible only at invoice time, no prepaid credits burn-down in real time, max 1000 events/s. Metronome was NOT researched here (out of scope); the PRD names Stripe, so flag this to the human before M-billing. | https://docs.stripe.com/billing/subscriptions/usage-based/implementation-guide |
| 3 | **No native hard spend cap** was found in the docs. Alerts and thresholds notify or trigger an invoice; credit grants discount invoices; none of them block usage. See section L. | see L |
| 4 | Docs use "customer-configured Account (Accounts v2)" as the new way to model customers but still fully document v1 `Customer`. This note uses v1 Customers. | implementation-guide |

## Common conventions (VERIFIED unless noted)

- Base URL `https://api.stripe.com`. Requests are `application/x-www-form-urlencoded`; nested params use brackets (`line_items[0][price]`). JSON bodies appear only on `/v2/*`.
- Auth: secret key via HTTP Basic (`curl -u "$KEY:"`, key as username, empty password). `Authorization: Bearer <key>` is shown for v2 calls. Never commit keys; keep in env (`config/providers.yaml` holds names only).
- Idempotency (https://docs.stripe.com/api/idempotent_requests): send header `Idempotency-Key: <v4 UUID>` on every `POST`. Max 255 chars. v1 saves status code + body of the first request once execution begins, replays it on retries (even 500s), prunes keys at >= 24 h. Reusing a key with different params -> `idempotency_error`. Params that fail validation or concurrent conflicts are not saved (safe to retry). Do not send on GET/DELETE.
- Pagination lists: `{object:"list", url, has_more, data[]}`; cursors `starting_after` / `ending_before`, `limit` 1-100 (default 10).
- Rate limits (https://docs.stripe.com/rate-limits): live 100 req/s global, sandbox 25 req/s; 25 req/s per endpoint; meter events are separate (see D). `429` + header `Stripe-Rate-Limited-Reason`; back off with jitter. Subscriptions API: 10 new invoices/subscription/minute.

Placeholders below: `{{CUSTOMER_ID}}`, `{{BASE_PRICE_ID}}`, `{{METERED_PRICE_ID}}`, `{{METER_ID}}`, `{{RESTAURANT_ID}}`.

---

## A. Create Customer

- `POST /v1/customers` | auth: secret key | source: https://docs.stripe.com/api/customers/create
- Request (VERIFIED; `fixtures/customers.create.request.json`):
```bash
curl https://api.stripe.com/v1/customers \
  -u "$STRIPE_SECRET_KEY:" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "name=Jenny Rosen" \
  --data-urlencode "email=jennyrosen@example.com" \
  -d "metadata[restaurant_id]={{RESTAURANT_ID}}"
```
(`metadata` is a documented param; the restaurant_id key is ours. The docs example itself has only name + email.)
- Success (200, VERIFIED, `fixtures/customers.create.response.json`): Customer object with `id` (`cus_...`), `object:"customer"`, `email`, `name`, `metadata:{}`, `invoice_settings{...}`, `livemode`, `tax_exempt:"none"`, `test_clock`.
- Tax note: `address` is "required if calculating taxes"; `tax` "recommended if calculating taxes".
- Error: section I. Idempotency: header above. Useful params: `address`, `email`, `metadata`, `name`, `phone`, `preferred_locales`, `tax_exempt`, `tax_id_data`, `payment_method`, `invoice_settings`.

## B. Create Checkout Session (subscription = base price + metered price)

- `POST /v1/checkout/sessions` | auth: secret key | source: https://docs.stripe.com/api/checkout/sessions/create
- Prereq prices (create once, store IDs in config):
  - Metered price attached to a meter (VERIFIED example from https://docs.stripe.com/billing/subscriptions/usage-based/implementation-guide; `fixtures/prices.create.metered.request.json`): `POST /v1/prices` with `currency`, `unit_amount`, `billing_scheme=per_unit`, `transform_quantity[divide_by]`, `transform_quantity[round]=up`, `recurring[usage_type]=metered`, `recurring[interval]=month`, `recurring[meter]={{METER_ID}}`, `product_data[name]`. The meter must exist first (section D).
  - Base flat price: `POST /v1/prices` with `currency`, `unit_amount`, `recurring[interval]=month`, `product_data[name]` (shape VERIFIED from the Checkout page prerequisite; our values UNVERIFIED; `fixtures/prices.create.base_licensed.request.json`).
- Request (`fixtures/checkout.sessions.create.subscription.request.json`). Every parameter is individually documented on the cited page; the combination is our composition:
```bash
curl https://api.stripe.com/v1/checkout/sessions \
  -u "$STRIPE_SECRET_KEY:" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d mode=subscription \
  -d customer={{CUSTOMER_ID}} \
  -d "line_items[0][price]={{BASE_PRICE_ID}}" -d "line_items[0][quantity]=1" \
  -d "line_items[1][price]={{METERED_PRICE_ID}}" \
  --data-urlencode "success_url=https://example.com/billing/success?session_id={CHECKOUT_SESSION_ID}" \
  --data-urlencode "cancel_url=https://example.com/billing/cancel" \
  -d client_reference_id={{RESTAURANT_ID}} \
  -d "metadata[restaurant_id]={{RESTAURANT_ID}}" \
  -d "subscription_data[metadata][restaurant_id]={{RESTAURANT_ID}}" \
  -d "automatic_tax[enabled]=true" -d "customer_update[address]=auto" -d billing_address_collection=required
```
- Verified parameter facts:
  - `mode` required: `payment|setup|subscription`. `subscription` for any recurring item.
  - `line_items` required for subscription mode; max 20 recurring + 20 one-time lines.
  - `success_url` allowed unless `ui_mode` is `embedded_page`/`elements`; `cancel_url` shows a back button; both not allowed for embedded/elements.
  - `customer` existing ID; in subscription mode the default payment method is prefilled if it is a card; if the Customer has a valid email it is prefilled and not editable.
  - `metadata` goes on the Session only. To get metadata onto the **Subscription** (and so onto invoices' subscription details), use `subscription_data[metadata]`. `client_reference_id` (max 200 chars) is returned on the Session.
  - `subscription_data` accepts `metadata`, `trial_period_days`, `trial_end`, `description`, `billing_mode[type]=classic|flexible` (default `flexible`), `billing_cycle_anchor`, `default_tax_rates`, etc.
  - `expires_at`: 30 min to 24 h after creation (default 24 h). `locale` supports `fr-CA` (also `en`, `fr`, `auto`; no ur/hi/pa).
  - `ui_mode` default `hosted_page`; response has `url` to redirect to.
- UNVERIFIED in this research: (a) omitting `quantity` on the metered line is documented only for legacy metered prices; for meter-backed prices confirm in test mode; (b) the literal `{CHECKOUT_SESSION_ID}` template in `success_url` (not seen on fetched pages; the hosted build-subscriptions page returned no body); (c) whether `customer_update[address]=auto` is needed with `automatic_tax` + an existing customer.
- Success (200). The only full docs example is **payment mode** (VERIFIED verbatim: `fixtures/checkout.sessions.create.response.docs_payment_mode.json`); a subscription-mode variant derived from it is in `fixtures/checkout.sessions.create.response.subscription_mode.derived.json` (UNVERIFIED values). Fields to use: `id` (`cs_test_...`), `url`, `status` (`open|complete|expired`), `mode`, `customer`, `subscription` (set on completion), `payment_status` (`paid|unpaid|no_payment_required`), `client_reference_id`, `metadata`.
- Idempotency: header above. Related: `POST /v1/checkout/sessions/{id}/expire` cancels an open session (referenced in object docs).

## C. Retrieve Subscription

- `GET /v1/subscriptions/{id}` | auth: secret key | source: https://docs.stripe.com/api/subscriptions/retrieve
- Request (VERIFIED): `curl https://api.stripe.com/v1/subscriptions/{{SUBSCRIPTION_ID}} -u "$STRIPE_SECRET_KEY:"`
- Success (VERIFIED verbatim, `fixtures/subscriptions.retrieve.response.json`). Fields we will use: `id`, `customer`, `status`, `cancel_at_period_end`, `canceled_at`, `ended_at`, `collection_method`, `latest_invoice`, `metadata`, `items.data[]` (`id` = `si_...`, `price`, `quantity`, `current_period_start/end`, now on the **item**, not the subscription), `billing_mode` absent in example.
- Statuses (VERIFIED, https://docs.stripe.com/billing/subscriptions/webhooks): `trialing, active, incomplete (pay within 23 h), incomplete_expired, past_due, canceled (terminal), unpaid, paused`. Revoke access on `canceled`/`unpaid`; notify on `past_due`.
- Idempotency: GET needs none. Error: `resource_missing` (404) for unknown ID.
- Optional: `?expand[]=latest_invoice` (expansion is a documented Stripe feature at https://docs.stripe.com/expand; this exact param on this endpoint UNVERIFIED).

## D. Billing Meters (current usage-reporting API)

**Current vs legacy:** Meters + Meter Events = current. `POST /v1/subscription_items/{id}/usage_records` (Usage Records) = legacy; see section 0, items 1-2. Credit grants and billing alerts only work with meter-based prices, not legacy Usage Records (VERIFIED, billing-credits page).

### D1. Create meter
- `POST /v1/billing/meters` | secret key | https://docs.stripe.com/api/billing/meter/create
```bash
curl https://api.stripe.com/v1/billing/meters -u "$STRIPE_SECRET_KEY:" \
  -d "display_name=Search API Calls" -d event_name=ai_search_api \
  -d "default_aggregation[formula]=sum" -d "value_settings[event_payload_key]=value" \
  -d "customer_mapping[type]=by_id" -d "customer_mapping[event_payload_key]=stripe_customer_id"
```
- Required: `display_name` (<=250), `event_name` (<=100), `default_aggregation[formula]` (`sum|count|last` per the dashboard guide). Optional: `customer_mapping`, `value_settings`, `event_time_window` (`day|hour`).
- Success: `mtr_...`, `object:"billing.meter"`, `status:"active"` (`fixtures/billing.meters.create.response.json`, VERIFIED).
- For us (minutes): `event_name=call_minutes` (our choice), formula `sum`, value = minutes (decimal values are accepted per the recording-usage-api page, so seconds/60 works).

### D2. Report meter event
- `POST /v1/billing/meter_events` | secret key | https://docs.stripe.com/api/billing/meter-event/create
```bash
curl https://api.stripe.com/v1/billing/meter_events -u "$STRIPE_SECRET_KEY:" \
  -d event_name=ai_search_api -d "payload[value]=25" \
  -d "payload[stripe_customer_id]={{CUSTOMER_ID}}" -d identifier=identifier_123
```
- Params: `event_name` (req), `payload` map (req; must contain the meter's customer key (default `stripe_customer_id`) and value key (default `value`)), `identifier` (<=100, UUID-like; **Stripe enforces uniqueness for a rolling >=24 h**; auto-generated if omitted), `timestamp` (unix s; **within past 35 days or up to 5 min in future**).
- Success (VERIFIED): `object:"billing.meter_event"`, `created`, `event_name`, `identifier`, `livemode`, `payload{}`, `timestamp` (`fixtures/billing.meter_events.create.response.json`). Payload values are strings.
- Idempotency: use `identifier` = our per-call, per-increment ID (e.g. `callid:segment`) AND/OR `Idempotency-Key`. Docs recommend idempotency keys to avoid double-reporting.
- Processing is **asynchronous**: summaries and upcoming invoices may lag. Report before the period's invoice finalizes (an accepted late event may not appear on a finalized invoice).
- Limits (VERIFIED, recording-usage-api): 1000 calls/s per account live; **1 concurrent call per customer per meter**; sandbox counts against global 25 req/s; dimension cardinality 10,000 combos/meter/hour, 100/customer. >limits: pre-aggregate or use API v2 `meter_event_stream` (10,000 events/s, live only, needs `meter_event_session` token valid 15 min).
- Errors found asynchronously arrive as **thin** events `v1.billing.meter.error_report_triggered` / `v1.billing.meter.no_meter_found` (separate thin event destination; example `fixtures/billing.meter.error_report_triggered.thin_event.json`). Codes: `meter_event_customer_not_found, meter_event_no_customer_defined, meter_event_dimension_count_too_high, archived_meter, timestamp_too_far_in_past, timestamp_in_future, meter_event_value_not_found, meter_event_invalid_value, no_meter`.
- Read-back: `GET /v1/billing/meters/{id}/event_summaries?customer=&start_time=&end_time=` (VERIFIED example in implementation-guide). Preview invoice: `POST /v1/invoices/create_preview` with `subscription=`.

## E. Customer billing portal session

- `POST /v1/billing_portal/sessions` | secret key | https://docs.stripe.com/api/customer_portal/sessions/create
```bash
curl https://api.stripe.com/v1/billing_portal/sessions -u "$STRIPE_SECRET_KEY:" \
  -d customer={{CUSTOMER_ID}} --data-urlencode "return_url=https://example.com/account"
```
- Params: `customer` (or `customer_account`), `return_url`, `configuration` (`bpc_...`; default config if omitted), `flow_data`, `locale`, `on_behalf_of`.
- Success (VERIFIED): `id bps_...`, `object:"billing_portal.session"`, `url` (redirect the user; single-use style secret link), `return_url`, `configuration`, `customer` (`fixtures/billing_portal.sessions.create.response.json`).
- UNVERIFIED: that a default portal configuration must be saved in the Dashboard (test and live separately) before first use.

## F. List invoices

- `GET /v1/invoices` | secret key | https://docs.stripe.com/api/invoices/list
- `curl -G https://api.stripe.com/v1/invoices -u "$STRIPE_SECRET_KEY:" -d customer={{CUSTOMER_ID}} -d limit=10`
- Filters: `customer`, `subscription`, `status` (`draft|open|paid|uncollectible|void`), `collection_method`, `created`, `limit`, cursors. Newest first.
- Success: list envelope + invoice objects (VERIFIED `fixtures/invoices.list.response.json`). Useful fields: `id`, `number`, `status`, `amount_due/paid/remaining`, `currency`, `hosted_invoice_url`, `invoice_pdf`, `period_start/end`, `billing_reason`, `total_taxes`, `lines`, and `parent.subscription_details.subscription` (API >= 2025-03-31.basil; older versions have `subscription` directly, per the webhooks page).

## G. Webhook events

Common facts (VERIFIED, https://docs.stripe.com/webhooks): register via Dashboard Workbench or `POST /v2/core/event_destinations`; up to 16 destinations; HTTPS in live mode; reply 2xx fast, process async; retries up to 3 days with exponential backoff in live mode (3 attempts over hours in sandbox); **no ordering guarantee**; dedupe by `event.id`; the account's API version fixes the payload shape; test with `stripe listen --forward-to localhost:4242/webhook` and `stripe trigger <event>`. Snapshot events carry the full object in `data.object`; thin events (`v1.*`/`v2.*`) carry a reference.

Event envelope (VERIFIED, https://docs.stripe.com/api/events/object): `id evt_..., object:"event", api_version, created (s), data:{object, previous_attributes?}, livemode, pending_webhooks, request:{id,idempotency_key}, type`.

**Stripe publishes no full per-event sample payloads**, so the files below are COMPOSED (UNVERIFIED values) from the real envelope plus the docs' object examples. Replace with captured payloads (`stripe trigger`) during the milestone.

| Event | Docs meaning (VERIFIED) | `data.object` | Fixture |
|---|---|---|---|
| `checkout.session.completed` | Checkout Session successfully completed. Read `subscription`, `customer`, `client_reference_id`, `metadata`; check `payment_status`. | checkout.session | `webhook.checkout.session.completed.json` |
| `customer.subscription.created` | Customer signed up to a plan; status may be `incomplete`. | subscription | `webhook.customer.subscription.created.json` |
| `customer.subscription.updated` | Any change (renewal, plan change, status change). `data.previous_attributes` holds old values. | subscription | `webhook.customer.subscription.updated.json` |
| `customer.subscription.deleted` | Subscription ends. | subscription | `webhook.customer.subscription.deleted.json` |
| `invoice.paid` | Payment attempt succeeded or marked paid out-of-band. Provision/extend access only after confirming the subscription is `active`. | invoice | `webhook.invoice.paid.json` |
| `invoice.payment_failed` | Payment attempt failed (decline incl. soft decline, or no stored payment method). Notify customer; consider Smart Retries. | invoice | `webhook.invoice.payment_failed.json` |
| `invoice.upcoming` | Sent X days before the subscription creates an auto-charged invoice (X = Dashboard "Upcoming renewal events"). "The received Invoice object will not have an invoice ID." Not sent for `collection_method=send_invoice`. | invoice (no `id`) | `webhook.invoice.upcoming.json` |

Others worth subscribing to: `customer.subscription.trial_will_end` (3 days before trial end), `customer.subscription.paused|resumed`, `invoice.created` (a failing response delays auto-finalization up to 72 h, so always 2xx it), `invoice.finalized`, `invoice.finalization_failed` (Stripe Tax location problems), `invoice.payment_action_required`, `charge.refunded`, `charge.dispute.created`, `billing.alert.triggered`, `customer.updated`.

Idempotent handling rule: store processed `event.id`; also dedupe by `data.object.id` + `type` (docs note two distinct events can occur).

## H. Webhook signature verification (VERIFIED, https://docs.stripe.com/webhooks "Verify manually")

- Header `Stripe-Signature` (single line): `t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd,v0=6ffbb5...` (`v0` is a fake scheme for test events; **ignore every scheme except `v1`**; multiple `v1` values appear while an old secret is still active after a roll, up to 24 h).
- Steps: split header on `,` then each on `=`; take `t` and all `v1`. `signed_payload = <t as string> + "." + <raw request body>`. `expected = HMAC_SHA256(key=endpoint signing secret (whsec_...), message=signed_payload)` hex digest. Compare to each `v1` with a **constant-time** comparison. Check `|now - t|` within tolerance.
- **Tolerance: libraries default to 5 minutes (300 s).** Never use 0 (disables the recency check). Retries get a new `t` and signature.
- Use the **raw body bytes**; any JSON re-serialization breaks verification. In Next.js route handlers read `await req.text()` before parsing. Prefer the official `stripe` library `webhooks.constructEvent(rawBody, sigHeader, secret)` (Python `stripe.Webhook.construct_event`).
- Each endpoint (and each test/live mode) has its own `whsec_` secret; the CLI `stripe listen` prints its own.
- Locally generated test vector for our verifier unit tests (NOT from Stripe): `fixtures/webhook.signature.test_vector.json`.
- Also recommended by Stripe: allowlist Stripe IPs (https://docs.stripe.com/ips) in addition to signatures; exempt the route from CSRF.

## I. Error object

Source https://docs.stripe.com/api/errors , https://docs.stripe.com/error-codes . Fixture `fixtures/errors.shape.json` (attribute list VERIFIED; the `{"error":{...}}` wrapper and example strings UNVERIFIED).

- Attributes: `type`, `code`, `decline_code`, `message`, `param`, `doc_url`, `request_log_url`, `charge`, `payment_intent`, `payment_method`, `setup_intent`, `source`, `payment_method_type`, `advice_code`, `network_advice_code`, `network_decline_code`.
- `type` enum: `api_error`, `card_error`, `idempotency_error`, `invalid_request_error`.
- HTTP: 200 ok; 400 bad request; 401 no valid key; 402 request failed; 403 key lacks permission; 404 not found; 409 conflict (e.g. idempotency key clash); 424 external dependency failed; 429 too many requests (`Stripe-Rate-Limited-Reason`); 500/502/503/504 Stripe-side (retry with the same Idempotency-Key).
- Codes relevant to us: `resource_missing`, `parameter_missing`, `parameter_unknown`, `parameter_invalid_*`, `parameters_exclusive`, `idempotency_key_in_use`, `rate_limit`, `lock_timeout` (429, retry), `api_key_expired`, `secret_key_required`, `livemode_mismatch`, `card_declined` (+ `decline_code`), `expired_card`, `incorrect_cvc`, `authentication_required`, `processing_error`, `customer_tax_location_invalid`, `invalid_tax_location`, `stripe_tax_inactive`, `taxes_calculation_failed`, `invoice_upcoming_none`, `invoice_not_editable`, `invoice_no_payment_method_types`, `coupon_expired`, `customer_max_subscriptions`, `billing_invalid_mandate`.
- Retry policy: retry 5xx, 429, network errors with the same idempotency key + exponential backoff and jitter; do not retry 4xx other than 409/429/`lock_timeout`.

## J. Test cards (VERIFIED, https://docs.stripe.com/testing ; `fixtures/test_cards.json`)

Expiry: any future date. CVC: any 3 digits. Success: Visa `4242 4242 4242 4242`, Visa debit `4000 0566 5566 5556`, Mastercard `5555 5555 5555 4444`, **Canada Visa `4000 0012 4000 0000`** (`pm_card_ca`, `tok_ca`). Declines: generic `4000 0000 0000 0002`; insufficient funds `4000 0000 0000 9995`; expired `4000 0000 0000 0069`; incorrect CVC `4000 0000 0000 0127`. 3DS: always `4000 0027 6000 3184`; unless set up `4000 0025 0000 3155` (useful for off-session renewal failure); US 3DS `4000 0084 0000 0027`; 3DS declined `4000 0084 0000 1629`. Invalid number (Luhn fail) `4242 4242 4242 4241`. Note: only the first 100,000 characters of the testing page were read; subscription-specific cards (e.g. attach-succeeds-then-charge-fails) were not reviewed.

## K. Tax: Stripe Tax and Canadian GST/HST

Sources: https://docs.stripe.com/tax/supported-countries/canada , https://docs.stripe.com/billing/subscriptions/webhooks , error-codes.

- Relevant: yes, if we sell SaaS to Canadian restaurants (federal GST 5% / HST / provincial PST/QST vary by province). Stripe Tax supports calculating tax on sales into Canadian provinces; behaviour depends on province, product tax code, and the registrations you add in the Dashboard (Tax > Locations).
- Checkout: `automatic_tax[enabled]=true` (VERIFIED param). Needs a usable customer location (country + postal code at minimum per error `customer_tax_location_invalid`), so collect billing address (`billing_address_collection=required`). Set a product tax code and price `tax_behavior` (field exists on Price; value choice UNVERIFIED).
- Failure mode (VERIFIED): if `automatic_tax[status]=requires_location_inputs` the invoice cannot finalize and `invoice.finalization_failed` fires; if `failed`, retry later.
- Registering and filing remain our legal duty: "You remain responsible for the accuracy of your returns and for paying your taxes." Stripe can only file simplified GST/HST for eligible non-resident businesses; otherwise use filing partners (Taxually, Marosa, HOST named on the page).
- UNVERIFIED / not researched: the small-supplier registration threshold, QST/PST specifics per province (subpages under /tax/supported-countries/canada/ not read), Stripe Tax per-transaction fee. Needs accountant/legal review (human task).

## L. Spend-cap options (no native cap: true per the docs researched)

I found **no Stripe setting that hard-stops usage or caps total spend** on a metered subscription. What exists (all VERIFIED):

| Tool | Behaviour | Blocks usage? | Source |
|---|---|---|---|
| Billing alerts `POST /v1/billing/alerts` (`alert_type=usage_threshold`, `usage_threshold[gte]`, `[meter]`, `[recurrence]=one_time`) | Fires `billing.alert.triggered` when meter usage crosses a threshold; max 25 alerts per meter+customer; not usable with test clocks. | No, notifies only | usage-based/alerts |
| Spend and credit-balance alerts | In **preview** (request access). | No | usage-based/monitor |
| Billing thresholds (subscription `billing_thresholds[amount_gte]` / item `usage_gte`) | Issues an invoice early when accrued amount or usage is reached; monetary threshold >= 50 currency units; single monetary threshold per subscription; not evaluated in the 24 h before period end; not for trials; invoices can slightly exceed threshold. | No, limits unbilled exposure | usage-based-legacy page; monitor page |
| Credit grants (prepaid/promotional) | Applied at invoice finalization to meter-based items only; max 100 unused grants per customer. | No, discounts invoices | billing-credits |

Practical options for "<$20/restaurant/month" (design is ours, UNVERIFIED as a pattern):
1. **App-side hard cap (recommended):** keep our own per-restaurant minutes counter in Supabase (we already know every call), refuse or degrade new calls past the cap, and still emit meter events for what was used. Stripe is then billing, not enforcing.
2. **Soft cap via alert webhook:** usage_threshold alert at e.g. 80%/100% -> `billing.alert.triggered` -> flip a `capped` flag, email owner.
3. **Early-invoice cap:** billing threshold so unbilled exposure cannot grow past X (protects us from non-payment, does not stop usage).
4. **Prepaid model:** credit grants + only allow calls while our computed balance > 0 (needs our own balance tracking; Stripe applies credits only at invoice time).
5. **Hard stop by subscription state:** on `invoice.payment_failed` / `past_due` / `unpaid`, pause the receptionist (Stripe does not do this for us).

## M. Idempotency summary for our worker

| Call | Key to use |
|---|---|
| Customer / Checkout Session / Portal create | `Idempotency-Key` = stable UUID derived from our request (e.g. uuid5(restaurant_id + intent + day)) |
| Meter event | `identifier` = deterministic per usage record (e.g. `call_id` or `call_id:seq`) plus `Idempotency-Key` |
| Webhook handler | dedupe on `event.id` in a processed-events table |

## N. Connect Standard diner payments (F12)

- Standard account creation: `POST /v1/accounts` with `type=standard` (VERIFIED from https://docs.stripe.com/connect/standard-accounts). Fixture: `fixtures/accounts.create.standard.response.json` (COMPOSED from documented Account fields; capture in Stripe test mode before go-live).
- Onboarding link: `POST /v1/account_links` with `account`, `refresh_url`, `return_url`, and `type=account_onboarding` (VERIFIED from https://docs.stripe.com/api/account_links/create). Fixture: `fixtures/account_links.create.response.json` (documented example adapted only to stable test IDs).
- Status: `GET /v1/accounts/{ACCOUNT_ID}`; this implementation maps `charges_enabled && details_submitted && payouts_enabled` to ready (VERIFIED fields from https://docs.stripe.com/api/accounts/retrieve; live account-state transitions still require test-mode validation).
- Connected-account calls: send `Stripe-Account: acct_...` on every server-side request (VERIFIED from https://docs.stripe.com/connect/authentication).
- One-time Payment Link: `POST /v1/payment_links` with inline `line_items[0][price_data]`, quantity `1`, and CAD minor-unit `unit_amount` (VERIFIED from https://docs.stripe.com/payment-links/create). Correlation metadata is set on both the Payment Link and generated PaymentIntent. Fixture: `fixtures/payment_links.create.response.json` (COMPOSED from the documented response).
- Each target-specific link sets `restrictions[completed_sessions][limit]=1` (VERIFIED from https://docs.stripe.com/api/payment-link/object), and the internal route rejects targets already marked paid.
- Payment Link metadata is inherited by the generated Checkout Session, so `checkout.session.completed` contains the target ID; `payment_intent_data.metadata` supplies the same ID to `payment_intent.succeeded` (VERIFIED from https://docs.stripe.com/metadata/use-cases#track-affiliate-links and the Payment Link API reference).
- Current Stripe guidance marks legacy Standard/Express/Custom account types deprecated for new Connect platforms and recommends Accounts v2. F12 explicitly requires Standard accounts, so this contract remains pending Stripe platform approval before live enablement.

## Could not confirm (open items)

1. Whether meter-backed prices in Checkout `subscription` mode require/forbid `line_items[].quantity` (legacy docs say omit for metered).
2. Literal `{CHECKOUT_SESSION_ID}` success_url template (hosted build-subscriptions page body did not load).
3. Real per-event webhook payloads (all `webhook.*.json` are composed); `invoice.upcoming` behaviour in the newest API versions beyond the one-line event description.
4. Exact `{"error": {...}}` wire wrapper text (attributes verified, wrapper not on fetched page).
5. Whether a Dashboard Customer Portal configuration must be saved before first portal session.
6. Whether meter event creation returns synchronous error bodies for an unknown `event_name` or missing customer (docs say invalid events are reported asynchronously via thin events).
7. Metronome details/pricing and whether it is mandatory for new integrations (docs say "recommended", Meters still supported). Needs a human decision.
8. Canadian small-supplier threshold, provincial PST/QST handling, Stripe Tax fees; accountant review.
9. Subscription-specific test cards beyond the first 100,000 characters of the testing page.
10. Any native hard spend cap (none found; Stripe may have unreleased/preview features: spend and credit-balance alerts are preview-gated).
11. Which Stripe API version our account/destinations will pin (affects `parent.subscription_details` vs `subscription`, and `current_period_*` location).
