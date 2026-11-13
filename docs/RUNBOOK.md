# Runbook

## Deploy worker

Run these commands from the repository root. They create and configure the Fly app, but only the final command deploys it. Fly configuration keys are documented in the [Fly.io app configuration reference](https://fly.io/docs/reference/configuration/), and secret values belong in Fly secrets rather than `fly.toml`.

1. Create the Fly app without deploying it. Choose Toronto (`yyz`) if Fly prompts for a region, and keep the generated app name that `fly launch` adds to `apps/worker/fly.toml`.

   ```sh
   fly launch --no-deploy --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile
   ```

2. Export the required values into the current shell, then set the worker secrets. The command intentionally shows names only; do not paste secret values into this runbook or commit them.

   ```sh
   fly secrets set --config apps/worker/fly.toml \
     SUPABASE_URL="$SUPABASE_URL" \
     SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
     TELNYX_API_KEY="$TELNYX_API_KEY" \
     TELNYX_PUBLIC_KEY="$TELNYX_PUBLIC_KEY" \
     TELNYX_TEXML_APP_ID="$TELNYX_TEXML_APP_ID" \
     TELNYX_MESSAGING_PROFILE_ID="$TELNYX_MESSAGING_PROFILE_ID" \
     SONIOX_API_KEY="$SONIOX_API_KEY" \
     GEMINI_API_KEY="$GEMINI_API_KEY" \
     FALLBACK_LLM_API_KEY="$FALLBACK_LLM_API_KEY" \
     WORKER_HMAC_SECRET="$WORKER_HMAC_SECRET" \
     WS_AUTH_SECRET="$WS_AUTH_SECRET" \
     TEST_CALL_HMAC_SECRET="$TEST_CALL_HMAC_SECRET" \
     PRIVACY_REQUEST_HASH_SECRET="$PRIVACY_REQUEST_HASH_SECRET" \
     SONIOX_HEALTHCHECK_URL="$SONIOX_HEALTHCHECK_URL" \
     GEMINI_HEALTHCHECK_URL="$GEMINI_HEALTHCHECK_URL" \
     NEXT_PUBLIC_APP_URL="$NEXT_PUBLIC_APP_URL" \
     RESEND_API_KEY="$RESEND_API_KEY" \
     RESEND_FROM_EMAIL="$RESEND_FROM_EMAIL" \
     RESEND_BASE_URL="$RESEND_BASE_URL"
   ```

3. Deploy from the repository root so Docker can include both `apps/worker` and the runtime files under `config` in the build context.

   ```sh
   fly deploy --config apps/worker/fly.toml .
   ```
