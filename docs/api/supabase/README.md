# Supabase API notes (researched 2026-10-27, official supabase.com/docs only)
Items marked **UNVERIFIED** were not confirmed on a docs page. Fixtures in `fixtures/`.

## Regions
Canada (Central) `ca-central-1` EXISTS. Source: https://supabase.com/docs/guides/platform/regions (also lists us-east-1/2, us-west-1/2, eu-*, ap-*, sa-east-1; "general" regions Americas/Europe/APAC have no codes). Pick it at project creation. Fly `yyz` (Toronto) is near it. Whether region is changeable later: UNVERIFIED.

## API keys (current)
https://supabase.com/docs/guides/api/api-keys : publishable `sb_publishable_...` (browser, enforces RLS, role anon/authenticated); secret `sb_secret_...` (backend only, bypasses RLS, 401 in browsers by User-Agent). Send both on the `apikey` header, NOT `Authorization: Bearer` (not JWTs). Legacy anon/service_role JWT keys still work until disabled. Use separate secret key per backend component (e.g. Python worker).

## Auth (GoTrue) REST
Endpoint list + body params: https://supabase.com/docs/reference/self-hosting-auth/introduction -> `fixtures/auth-requests.json`. Raw example response JSON was NOT retrievable; only key names of token response. Base path `/auth/v1` UNVERIFIED on docs fetched.
- Sign-up: JS `signUp` -> with email confirmation on, returns user with `null` session; duplicate-email errors may be obfuscated. https://supabase.com/docs/reference/javascript/auth-signup
- Password sign-in: https://supabase.com/docs/reference/javascript/auth-signinwithpassword (errors don't distinguish unknown account vs wrong password)
- Magic link/OTP: `signInWithOtp({email, options:{emailRedirectTo}})`; template `{{ .ConfirmationURL }}` = link, `{{ .Token }}` = OTP code; phone = OTP only. https://supabase.com/docs/reference/javascript/auth-signinwithotp
- Google OAuth: `supabase.auth.signInWithOAuth({provider:'google', options:{redirectTo}})` (redirectTo must be in allow list); Google console redirect URI = Supabase callback `https://<ref>.supabase.co/auth/v1/callback` (local: `http://127.0.0.1:54321/auth/v1/callback`); Next.js route `app/auth/callback/route.ts` calls `supabase.auth.exchangeCodeForSession(code)` then redirects to `next`. https://supabase.com/docs/guides/auth/social-login/auth-google
- Session/JWT claims: `fixtures/jwt-claims.json` (iss, aud, exp, iat, sub, role, aal, session_id, email, phone, is_anonymous; optional jti, nbf, app_metadata, user_metadata, amr; `ref` only on anon/service keys). https://supabase.com/docs/guides/auth/jwt-fields
- Refresh: refresh tokens single-use, never expire; 10 s default reuse interval; reuse outside it revokes the whole session. https://supabase.com/docs/guides/auth/sessions
- Sign-out: JS scopes `global` (default), `local`, `others`. https://supabase.com/docs/reference/javascript/auth-signout . REST `/logout` returns 204; REST scope param UNVERIFIED.
- Errors: `fixtures/auth-error-codes.json`. Raw error body shape UNVERIFIED.

## PostgREST
Error shape `{code, details, hint, message}`; PGRST table and 42501/23505/23503 mapping in `fixtures/postgrest-error.json` (https://supabase.com/docs/guides/api/rest/postgrest-error-codes). 42501 -> 403 if authenticated else 401; 23505 -> 409.
Grants + RLS: a table is unreachable via Data API without grants; RLS with no policies denies all; RLS doesn't apply to functions (grant execute narrowly). https://supabase.com/docs/guides/api/securing-your-api
JS insert returns no rows unless `.select()` chained. RPC: `supabase.rpc(fn, args, {get:true})`; REST path `/rest/v1/rpc/<fn>`, `Prefer: return=representation`, `Prefer: resolution=merge-duplicates`, `Prefer: handling=strict` (PGRST122 mentions handling=strict; `max-affected` in PGRST124) - the other Prefer header values are **UNVERIFIED** on supabase.com (documented at postgrest.org, not fetched per scope). Empty-result-on-RLS-filtered-SELECT: UNVERIFIED in docs.

## Storage
`fixtures/storage.json`. Upload `POST /storage/v1/object/<bucket>/<path>` with apikey + Bearer; `x-upsert: true`; duplicate path -> 400 "Asset Already Exists". Upload needs INSERT policy on `storage.objects` (upsert also SELECT+UPDATE); no policy = denied. Signed URL: `createSignedUrl(path, expiresInSeconds, {download})`. Policy examples using `storage.foldername(name)[1]` and `owner_id`: https://supabase.com/docs/guides/storage/security/access-control . Response shapes UNVERIFIED. Tip (ours): path = `<restaurant_id>/...` and policy `(storage.foldername(name))[1]::uuid in (select private.user_restaurant_ids())` UNVERIFIED adaptation.

## Realtime (live-call banner)
`fixtures/realtime-live-call.md`. Recommend private broadcast + `realtime.messages` RLS, or postgres_changes on `calls` (needs publication add; RLS applies).

## @supabase/ssr + Next.js App Router (current)
https://supabase.com/docs/guides/auth/server-side/nextjs and /creating-a-client
- `npm install @supabase/supabase-js @supabase/ssr`; exports `createServerClient`, `createBrowserClient`, `parseCookieHeader`, `serializeCookieHeader`.
- Env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (not ANON_KEY).
- Cookie adapter: `cookies: { getAll, setAll }` (not get/set/remove). setAll also gets cache headers (Cache-Control, Expires, Pragma) to forward. Cookie name `sb-<project_ref>-auth-token`.
- Next.js 16 renamed middleware to `proxy.ts` (`export function proxy`); Next 15 and earlier use `middleware.ts`; a `proxy.ts` on 15 is never called. Proxy refreshes session via `supabase.auth.getClaims()`. Files live in `lib/supabase/` (client.ts, server.ts, proxy.ts). Full file bodies NOT shown in fetched pages (UNVERIFIED; copy from the Connect dialog / quickstart https://supabase.com/docs/guides/auth/quickstarts/nextjs).
- Server rule: use `getClaims()` to protect pages/data, `getUser()` for fresh record (network call); never trust `getSession()` on the server.
- Returning a custom response from proxy: copy `supabaseResponse.cookies` and the three cache headers (snippet on creating-a-client page).

## RLS multitenant
`fixtures/rls-multitenant.sql`. Docs rules: `to authenticated`; wrap `(select auth.uid())`; index filter columns; membership PK covers only first column so index `user_id`; policies reading each other recurse (42P17) -> use `security definer` function in non-exposed `private` schema with `set search_path = ''`. https://supabase.com/docs/guides/database/postgres/row-level-security

## Migrations (CLI)
`supabase init` (creates supabase/config.toml), `supabase link --project-ref <id>`, `supabase migration new <name>` -> `supabase/migrations/<timestamp>_<name>.sql` (e.g. 20250101000000_create_employees_table.sql), `supabase db reset` (local), `supabase db push`, `supabase db pull`, `supabase db diff --schema public`. https://supabase.com/docs/guides/local-development/overview . Docs recommend direct connection for migrations.

## Python worker connectivity
https://supabase.com/docs/guides/database/connecting-to-postgres
- Direct: `db.<ref>.supabase.co:5432`, user `postgres`; IPv6 by default, IPv4 needs paid add-on. Best for persistent servers.
- Shared pooler session mode `:5432` (user `postgres.<ref>`, IPv4-only, supports prepared statements) - use if worker network lacks IPv6 (Fly.io IPv6 support for the worker: UNVERIFIED, check).
- Shared pooler transaction mode `:6543`: for serverless; no prepared statements; asyncpg needs `statement_cache_size=0`; no LISTEN/NOTIFY or session state. Copy pooler host from Connect dialog (cannot be derived).
- supabase-py: `create_client(url, key, options=ClientOptions(postgrest_client_timeout=10, storage_client_timeout=10, schema="public"))` (https://supabase.com/docs/reference/python/initializing); async client not documented on that page (UNVERIFIED). supabase-py goes over PostgREST (HTTP, RLS applies; secret key bypasses). Recommendation (ours): PostgREST/supabase-py for simple writes; asyncpg via session-mode/direct for hot-path/transactions.
