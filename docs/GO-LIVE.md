# Go-live: mock to live

Run commands from the repository root unless noted. Use provider test modes until final cutover. Never paste credentials into chat, source, command arguments, or committed files. Put local values in uncommitted `.env.local`; use Vercel environment variables and Fly secrets in hosted environments.

## 1. Accounts and approvals

- [ ] Create a Supabase project in Canada Central (`ca-central-1`) and record its project reference, URL, publishable key, and backend secret/service-role key ([regions](https://supabase.com/docs/guides/platform/regions), [API keys](https://supabase.com/docs/guides/api/api-keys)).
- [ ] Create the [Vercel](https://vercel.com/signup) project for `apps/web` and [Fly.io](https://fly.io/docs/flyctl/auth-signup/) app for the worker.
- [ ] Create [Telnyx](https://portal.telnyx.com/), [Soniox](https://console.soniox.com/), [Google AI Studio](https://aistudio.google.com/), [Stripe](https://dashboard.stripe.com/register), [Resend](https://resend.com/signup), and [Firecrawl](https://www.firecrawl.dev/) accounts.
- [ ] Keep Stripe and Telnyx in test mode. Do not buy numbers or enable paid smoke operations before the human approvals in section 10.

## 2. Supabase schema

Supabase documents this flow at <https://supabase.com/docs/guides/local-development/database-migrations>. Review the dry run and never use `--include-seed` in production.

```sh
supabase login
supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase migration list
supabase db push --dry-run
supabase db push
```

- [ ] Confirm the linked project is production and the dry run contains no unexpected destructive statement.
- [ ] Put `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` as applicable. The last two are server-only.

## 3. Configuration placement

| Provider | Live variables | `.env.local` | Vercel production | Fly worker |
|---|---|---:|---:|---:|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | yes | yes | URL + service-role key |
| Telnyx | `TELNYX_BASE_URL=https://api.telnyx.com/v2`, `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_TEXML_APP_ID`, `TELNYX_MESSAGING_PROFILE_ID` | yes | yes | API/public keys; IDs if operationally used |
| Stripe | `STRIPE_BASE_URL=https://api.stripe.com`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_STARTER_PRICE_ID`, `STRIPE_GROWTH_PRICE_ID`, `STRIPE_METERED_PRICE_ID` | yes | yes | no |
| Resend | `RESEND_BASE_URL=https://api.resend.com`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_FROM_EMAIL` | yes | yes | no |
| Firecrawl | `FIRECRAWL_BASE_URL=https://api.firecrawl.dev/v2`, `FIRECRAWL_API_KEY` | yes | yes | no |
| Gemini | `GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta`, `GEMINI_API_KEY`, `GEMINI_MODEL_ID` | yes | yes | API key |
| Soniox | `SONIOX_BASE_URL=https://api.soniox.com`, `SONIOX_API_KEY`, `SONIOX_TTS_MODEL_ID`, `SONIOX_TTS_PATH`, `SONIOX_VOICE_ID` | yes | yes | API key |

Official endpoint sources: [Telnyx](https://developers.telnyx.com/docs/development/api-fundamentals/authentication), [Stripe](https://docs.stripe.com/api), [Resend](https://resend.com/docs/api-reference/introduction), [Firecrawl](https://docs.firecrawl.dev/introduction), [Gemini](https://ai.google.dev/api), and [Soniox](https://soniox.com/docs/api-reference). Model and voice IDs stay in `config/providers.yaml` or environment variables.

Also put `INTEGRATIONS_MODE`, `NEXT_PUBLIC_APP_URL`, `WORKER_BASE_URL`, `TEST_CALL_HMAC_SECRET`, `PRIVACY_REQUEST_HASH_SECRET`, `CRON_SECRET`, and every other web name reported by `check-env --live` in `.env.local` and Vercel production. `TEST_CALL_HMAC_SECRET` must match on Vercel and Fly. Fly also needs `WS_AUTH_SECRET`, `WORKER_HMAC_SECRET`, `PRIVACY_REQUEST_HASH_SECRET` (same value as Vercel, so privacy requests match call records), `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_BASE_URL`, `SONIOX_HEALTHCHECK_URL`, `GEMINI_HEALTHCHECK_URL`, and `NEXT_PUBLIC_APP_URL`; `TRANSFER_PHONE_FALLBACK` is optional.

The root TypeScript utilities read the current process environment; they do not load `.env.local` themselves. Before running preflight, capture, or smoke commands, export values into the current shell using the password/secret manager. The unified `--live` check validates both deployments, so its shell must contain the Fly-only values as well as the Vercel values. After securely exporting `WS_AUTH_SECRET`, `SONIOX_HEALTHCHECK_URL`, and `GEMINI_HEALTHCHECK_URL` from the password/secret manager, linked Vercel production values can supply the rest without writing another env file ([`vercel env run`](https://vercel.com/docs/cli/env#running-commands-with-environment-variables)):

```sh
cd apps/web
vercel env run -e production -- sh -c 'cd ../.. && arch -arm64 pnpm exec tsx scripts/check-env.ts --live'
cd ../..
```

Never print the resulting environment.

Add Vercel values interactively so values do not enter shell history ([CLI reference](https://vercel.com/docs/cli/env)):

```sh
cd apps/web
vercel link
for name in \
  INTEGRATIONS_MODE DATA_SOURCE NEXT_PUBLIC_APP_URL WORKER_BASE_URL TEST_CALL_HMAC_SECRET \
  PRIVACY_REQUEST_HASH_SECRET CRON_SECRET \
  NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
  SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_SERVICE_ROLE_KEY \
  TELNYX_BASE_URL TELNYX_API_KEY TELNYX_PUBLIC_KEY TELNYX_TEXML_APP_ID TELNYX_MESSAGING_PROFILE_ID \
  STRIPE_BASE_URL STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_STARTER_PRICE_ID STRIPE_GROWTH_PRICE_ID STRIPE_METERED_PRICE_ID \
  RESEND_BASE_URL RESEND_API_KEY RESEND_WEBHOOK_SECRET RESEND_FROM_EMAIL \
  FIRECRAWL_BASE_URL FIRECRAWL_API_KEY \
  GEMINI_BASE_URL GEMINI_API_KEY GEMINI_MODEL_ID \
  SONIOX_BASE_URL SONIOX_API_KEY SONIOX_TTS_MODEL_ID SONIOX_TTS_PATH SONIOX_VOICE_ID
do
  vercel env add "$name" production
done
cd ../..
```

Set Fly values from an already populated shell; they are not stored in `fly.toml` ([Fly secrets](https://fly.io/docs/apps/secrets/)):

```sh
fly secrets set --config apps/worker/fly.toml \
  SUPABASE_URL="$SUPABASE_URL" \
  SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  TELNYX_API_KEY="$TELNYX_API_KEY" \
  TELNYX_PUBLIC_KEY="$TELNYX_PUBLIC_KEY" \
  SONIOX_API_KEY="$SONIOX_API_KEY" \
  GEMINI_API_KEY="$GEMINI_API_KEY" \
  TEST_CALL_HMAC_SECRET="$TEST_CALL_HMAC_SECRET" \
  WORKER_HMAC_SECRET="$WORKER_HMAC_SECRET" \
  PRIVACY_REQUEST_HASH_SECRET="$PRIVACY_REQUEST_HASH_SECRET" \
  RESEND_API_KEY="$RESEND_API_KEY" \
  RESEND_FROM_EMAIL="$RESEND_FROM_EMAIL" \
  RESEND_BASE_URL="$RESEND_BASE_URL" \
  WS_AUTH_SECRET="$WS_AUTH_SECRET" \
  SONIOX_HEALTHCHECK_URL="$SONIOX_HEALTHCHECK_URL" \
  GEMINI_HEALTHCHECK_URL="$GEMINI_HEALTHCHECK_URL" \
  NEXT_PUBLIC_APP_URL="$NEXT_PUBLIC_APP_URL"
```

Use `SONIOX_HEALTHCHECK_URL=https://api.soniox.com/v1/models` and `GEMINI_HEALTHCHECK_URL=https://generativelanguage.googleapis.com/v1beta/models`. These probes test reachability; runtime calls still authenticate through their provider clients.

## 4. Preflight

`--live` forces live validation even when the current mode is unset or mock. It groups missing names by provider and never prints values.

```sh
arch -arm64 pnpm exec tsx scripts/check-env.ts --live
arch -arm64 pnpm test
```

Success is no environment-check output and exit `0`. Output such as `[Telnyx]` followed by `TELNYX_API_KEY` blocks go-live.

## 5. Capture live responses over reconstructed fixtures

Fixtures directly under `docs/api/<provider>/fixtures/` are reconstructed. The capture script writes timestamped, sanitized JSON under `fixtures/live/`; it never overwrites reconstructed or prior live files. It accepts only each provider's official HTTPS API host, redacts configured credentials, sensitive-key fields, recognizable secret tokens, and phone-number fields/formats before writing, logs only the destination, rejects non-JSON responses, and requires `INTEGRATIONS_MODE=live`.

Review captured files before committing. Restaurant page content can contain personal data beyond phone numbers. Firecrawl and Gemini consume quota and require explicit opt-in.

```sh
INTEGRATIONS_MODE=live arch -arm64 pnpm exec tsx scripts/capture-fixtures.ts --provider telnyx
INTEGRATIONS_MODE=live LIVE_CAPTURE_STRIPE_EVENT_TYPE=checkout.session.completed arch -arm64 pnpm exec tsx scripts/capture-fixtures.ts --provider stripe
INTEGRATIONS_MODE=live arch -arm64 pnpm exec tsx scripts/capture-fixtures.ts --provider resend
INTEGRATIONS_MODE=live LIVE_SMOKE_ALLOW_MUTATIONS=1 arch -arm64 pnpm exec tsx scripts/capture-fixtures.ts --provider firecrawl
INTEGRATIONS_MODE=live LIVE_SMOKE_ALLOW_MUTATIONS=1 arch -arm64 pnpm exec tsx scripts/capture-fixtures.ts --provider gemini
INTEGRATIONS_MODE=live arch -arm64 pnpm exec tsx scripts/capture-fixtures.ts --provider soniox
```

Firecrawl also needs `LIVE_SMOKE_URL`; Gemini needs `GEMINI_MODEL_ID`; Telnyx uses `LIVE_SMOKE_AREA_CODE` or `416`. Expected output:

```text
WROTE docs/api/telnyx/fixtures/live/available-phone-numbers.2026-10-27T12-00-00-000Z.json
```

## 6. Stripe webhook fixtures

Use Stripe test mode. Stripe documents [local forwarding](https://docs.stripe.com/webhooks#local-listener) and [`stripe trigger`](https://docs.stripe.com/cli/trigger). Triggers create test API objects and have side effects.

1. Start a listener:

   ```sh
   stripe login
   stripe listen --forward-to http://localhost:3000/api/webhooks/stripe
   ```

2. In the web-server terminal, enter the printed signing secret without shell history and start the app:

   ```sh
   read -rsp "Stripe CLI webhook secret: " STRIPE_WEBHOOK_SECRET; echo
   export STRIPE_WEBHOOK_SECRET INTEGRATIONS_MODE=live
   arch -arm64 pnpm --filter @voice-receptionist/web dev
   ```

3. Trigger supported handler events in a third terminal:

   ```sh
   for event in \
     checkout.session.completed \
     customer.subscription.created customer.subscription.updated customer.subscription.deleted \
     invoice.paid invoice.payment_failed
   do
     stripe trigger "$event"
   done
   ```

4. After each trigger, capture the matching event through Stripe's [List events API](https://docs.stripe.com/api/events/list):

   ```sh
   for event in \
     checkout.session.completed \
     customer.subscription.created customer.subscription.updated customer.subscription.deleted \
     invoice.paid invoice.payment_failed
   do
     INTEGRATIONS_MODE=live LIVE_CAPTURE_STRIPE_EVENT_TYPE="$event" \
       arch -arm64 pnpm exec tsx scripts/capture-fixtures.ts --provider stripe
   done
   ```

`invoice.upcoming` is not listed by `stripe trigger`; capture it from an actual test subscription lifecycle rather than inventing it.

## 7. Deploy live

- [ ] Change Vercel production `INTEGRATIONS_MODE` from `mock` to `live` only after preflight is clean.
- [ ] Deploy Vercel ([production deploy](https://vercel.com/docs/projects/deploy-from-cli)):

  ```sh
  cd apps/web
  vercel deploy --prod
  cd ../..
  ```

- [ ] Deploy and check Fly from the repository root ([deploy reference](https://fly.io/docs/flyctl/deploy/)):

  ```sh
  fly deploy --config apps/worker/fly.toml .
  fly status --config apps/worker/fly.toml
  fly checks list --config apps/worker/fly.toml
  ```

- [ ] Point the Telnyx TeXML voice URL/status callback at the Fly HTTPS routes and the messaging-profile webhook at the Vercel Telnyx SMS route. Register Stripe and Resend webhook URLs, copy signing secrets to Vercel production, and redeploy Vercel.
- [ ] In the Telnyx TeXML application, set `voice_fallback_url` to a separately hosted, highly available TeXML endpoint that returns `<Response><Dial>TRANSFER_NUMBER</Dial></Response>`. The worker cannot set this on `/telnyx/texml`; Telnyx invokes the application-level fallback when the primary voice URL is unreachable. Verify by temporarily pointing `voice_url` at an unreachable host and confirming the real restaurant transfer phone rings. Keep the number in the secret manager as `TRANSFER_PHONE_FALLBACK`, not in source. ([TeXML application field reference](https://developers.telnyx.com/api-reference/texml-applications/creates-a-texml-application), [instruction fetching](https://developers.telnyx.com/docs/voice/programmable-voice/texml-instruction-fetching.md))

## 8. Smoke one provider at a time

The runner calls all six providers. Each command empties the other five credentials temporarily. `PASS` completed an operation; `SKIP` intentionally omitted a credential/test ID/opt-in; `FAIL:` sets non-zero exit status and blocks go-live.

### Telnyx

```sh
STRIPE_SECRET_KEY= RESEND_API_KEY= FIRECRAWL_API_KEY= GEMINI_API_KEY= SONIOX_API_KEY= \
INTEGRATIONS_MODE=live arch -arm64 pnpm --filter @voice-receptionist/web smoke:live
```

Expected: `PASS telnyx/searchNumbers`, `PASS telnyx/listNumbers`, then `SKIP telnyx/order/release/assign/sendSms` unless `LIVE_SMOKE_ALLOW_MUTATIONS=1` and operation IDs are set.

### Stripe

Set a test-mode `LIVE_SMOKE_STRIPE_CUSTOMER_ID` first.

```sh
TELNYX_API_KEY= RESEND_API_KEY= FIRECRAWL_API_KEY= GEMINI_API_KEY= SONIOX_API_KEY= \
INTEGRATIONS_MODE=live arch -arm64 pnpm --filter @voice-receptionist/web smoke:live
```

Expected: `PASS stripe/listInvoices`, then `SKIP stripe/customer/checkout/portal/meterEvent` unless mutation inputs are set.

### Resend

This sends one email. Set approved `LIVE_SMOKE_RESEND_FROM` and `LIVE_SMOKE_RESEND_TO` addresses.

```sh
TELNYX_API_KEY= STRIPE_SECRET_KEY= FIRECRAWL_API_KEY= GEMINI_API_KEY= SONIOX_API_KEY= \
INTEGRATIONS_MODE=live LIVE_SMOKE_ALLOW_MUTATIONS=1 arch -arm64 pnpm --filter @voice-receptionist/web smoke:live
```

Expected: `PASS resend/sendEmail`.

### Firecrawl

This consumes credits. Set `LIVE_SMOKE_URL` to a public test restaurant page.

```sh
TELNYX_API_KEY= STRIPE_SECRET_KEY= RESEND_API_KEY= GEMINI_API_KEY= SONIOX_API_KEY= \
INTEGRATIONS_MODE=live LIVE_SMOKE_ALLOW_MUTATIONS=1 arch -arm64 pnpm --filter @voice-receptionist/web smoke:live
```

Expected: `PASS` for `firecrawl/scrape`, `map`, `startCrawl`, `getCrawl`, `pollCrawl`, `startExtract`, `getExtract`, and `pollExtract`.

### Gemini

This consumes quota and requires `GEMINI_MODEL_ID`.

```sh
TELNYX_API_KEY= STRIPE_SECRET_KEY= RESEND_API_KEY= FIRECRAWL_API_KEY= SONIOX_API_KEY= \
INTEGRATIONS_MODE=live LIVE_SMOKE_ALLOW_MUTATIONS=1 arch -arm64 pnpm --filter @voice-receptionist/web smoke:live
```

Expected: `PASS gemini/generateStructured`.

### Soniox

```sh
TELNYX_API_KEY= STRIPE_SECRET_KEY= RESEND_API_KEY= FIRECRAWL_API_KEY= GEMINI_API_KEY= \
INTEGRATIONS_MODE=live arch -arm64 pnpm --filter @voice-receptionist/web smoke:live
```

Expected: `PASS soniox/listModels`, `PASS soniox/listTtsModels`, `PASS soniox/listSharedVoices`, then `SKIP soniox/previewTts` unless paid TTS is explicitly enabled with `LIVE_SMOKE_ALLOW_MUTATIONS=1` and `LIVE_SMOKE_SONIOX_VOICE`.

## 9. Rollback

This stops new web integration calls; it does not undo provider objects, messages, migrations, or a worker release.

```sh
cd apps/web
printf 'mock' | vercel env update INTEGRATIONS_MODE production
vercel deploy --prod
cd ../..
```

Confirm mock mode. Rotate any credential suspected of exposure. For worker regressions, use `fly releases` and `fly releases rollback <version> --config apps/worker/fly.toml` ([Fly releases](https://fly.io/docs/flyctl/releases/)). Never destructively roll back Supabase production; ship a forward migration.

## 10. Human-only items

Copied from `context/human-tasks.md`:

- [ ] Create accounts: Telnyx, Soniox, Google AI Studio, Supabase, Vercel, Fly.io, Stripe
- [ ] Paste API keys into Vercel, Fly.io, `.env.local` (never in chat or committed)
- [ ] Buy first Telnyx numbers (Toronto, Montreal)
- [ ] Real test calls; native speakers rate EN/FR/UR/HI/PA voices (>= 4/5)
- [ ] Legal review: privacy policy, recording notice, Quebec Law 25, CASL
- [ ] Answer PRD open questions (see `context/decisions.md`)
- [ ] Approve any spend above $25
- [ ] Stripe: Metronome steer + no native spend cap (see `context/decisions.md`); needs human decision before M8
- [ ] Legal review: Soniox (no Canada region) and Gemini paid tier (retention period unstated, no Canada pinning) vs PIPEDA/Law 25
- [ ] Ask Soniox to raise TTS concurrent streams above 3 before pilot
- [ ] Listening test for Urdu/Hindi/Punjabi TTS quality (native speakers)
