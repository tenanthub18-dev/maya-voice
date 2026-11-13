# Security

This document describes engineering controls, operational response, and remaining launch work. It is not legal advice. Canadian counsel must review the product before the first paying customer.

## Threat model

| Asset | Likely attacker or failure | Primary mitigations | Delivery brief |
| --- | --- | --- | --- |
| Provider credentials and service-role keys | Repository reader, malicious dependency, accidental client bundle | Server-only secrets, environment allowlists, secret scanning, client-bundle scan, rotation runbook | 008, 029, 030 |
| Restaurant tenant data | Authenticated user from another tenant, broken query scope | Supabase RLS, organization membership checks, security-definer RPC checks, cross-tenant tests | 018, 019, 030 |
| Authentication sessions and role boundaries | Account takeover, staff privilege escalation | Supabase session validation, owner-only capabilities, invitation lifecycle, denial tests | 019 |
| Webhook-driven billing, SMS, and phone state | Forged or replayed provider event | Telnyx and Stripe signature verification, timestamp/order checks, idempotent event claims | 020 |
| Worker internal endpoints and call tools | Forged publish/test request, replay, prompt-triggered misuse | HMAC authentication with bounded clock skew, typed tool schemas, tenant-scoped repository calls | 008, 028 |
| Calls, transcripts, and recordings | Excess retention, leaked signed URL, storage/database drift | Hash plus last four on calls, five-minute recording URLs, owner retention limits, nightly storage-aware deletion, audited dry runs | 018, 030 |
| Logs and error telemetry | PII or secret copied into logs/Sentry | Shared recursive redaction for E.164 numbers, email, name fields, tokens and API keys; hostile-payload tests; DSN-gated hooks | 028, 029, 030 |
| Public web surface | XSS, SSRF, abusive imports, unsafe headers | Output encoding, URL allowlist/SSRF controls, rate limits, CSP/security headers | 029 |
| Dependency and source integrity | Known vulnerable package, committed secret, unsafe code pattern | `pnpm audit`, `pip-audit`, gitleaks, and public-repository CodeQL in CI | 030 |

## Retention and privacy operations

- Owners select recording and transcript retention independently from 30–365 days. Defaults are 90 and 365 days.
- `/api/cron/retention` requires `Authorization: Bearer $CRON_SECRET`. `?dryRun=true` calculates counts and writes an audit event without deleting data.
- A live run removes private storage objects before clearing recording paths, deletes expired transcript turns, and writes `retention.executed` to `audit_log`.
- The Python `run_retention` callable invokes the same protected transaction, so manual and scheduled runs have identical behavior.
- Caller requests are tenant checked and store a protected caller reference in the audit trail. Owner-only restaurant export/deletion uses a separate explicit scope and audit action.

## Incident runbook

### Suspected key leak

1. Pause the affected agent or all restaurant agents. Preserve relevant audit records; do not paste the leaked value into tickets or chat.
2. Rotate the credential at the source provider, update the corresponding Vercel or Fly secret, redeploy, and verify health checks.
3. Revoke the old credential only after the new deployment is healthy, unless active abuse requires immediate revocation.
4. Review provider audit/activity logs, application audit rows, unexpected spend, number changes, and outbound messages for the exposure window.
5. Rotate by provider:
   - Telnyx: create a replacement API key, update Fly/Vercel, validate inbound calling and webhook signatures, then revoke the exposed key.
   - Soniox: replace the API key, update Fly, verify STT/TTS health, then revoke the old key.
   - Google AI Studio/Gemini: replace the key, apply API restrictions where available, update Fly, verify generation, then revoke the old key.
   - Supabase: rotate affected publishable/service-role credentials using the project’s supported key-rotation flow, update both deploy targets, verify auth/RLS/storage, then retire old keys.
   - Fly.io: revoke the exposed access token, create a least-privilege replacement, and review app/deployment activity.
   - Vercel: revoke the exposed token, create a scoped replacement, and review deployments and environment-variable access.
   - Stripe: roll the secret key or webhook signing secret, update Vercel, verify a signed test event, then expire the prior secret.
   - Resend: create a replacement API key, update Vercel, verify a transactional test, then revoke the old key.
6. Run gitleaks across full history. If a secret was committed, treat history rewriting as a coordinated incident action; rotation is mandatory even if the commit is removed.
7. Document scope, timestamps, decisions, notifications, and follow-up controls. Engage Canadian privacy counsel when personal information may have been exposed.

### Number kill switch

1. In the platform admin console, disable the affected Telnyx number and record the reason in the audit log.
2. Set the restaurant agent to `paused`; confirm calls no longer enter the AI pipeline and use the approved fallback routing where available.
3. In Telnyx, disable or release the number only when containment requires it. Number release is destructive and requires owner/operations confirmation.
4. Review call volume, messaging activity, number-order history, and Telnyx spend before restoring service.

### Pause the agent

1. Set the restaurant status/agent switch to paused.
2. Confirm the dashboard shows the paused state and place a controlled inbound call to verify the fallback path.
3. Record incident owner, reason, affected restaurants, and restoration criteria. Restore only after credentials and routing have been verified.

## Residual risks and human tasks

| Risk | Required human action |
| --- | --- |
| Canadian federal/provincial privacy, recording notice, Quebec Law 25, and retention interpretation | Canadian legal review before the first paying customer |
| Unknown application/infrastructure vulnerabilities | Independent penetration test before launch and after material auth/telephony changes |
| Telnyx account takeover or unexpected spend | Configure and verify Telnyx toll-fraud controls, spend alerts, geographic restrictions, and escalation contacts |
| Caller-ID spoofing | Do not treat caller ID as identity proof; keep callback/account-record/written-document verification for privacy actions and sensitive booking changes |
| Processor regions and cross-border storage | Confirm current provider regions and complete the Quebec Law 25 assessment |

## Responsible disclosure

Report suspected vulnerabilities privately to **security-contact@example.com (replace with the monitored security address before launch)**. Include reproduction steps, affected endpoint, impact, and a safe contact method. Do not include live customer data or secrets. The team will acknowledge receipt, coordinate validation and remediation, and request coordinated disclosure timing.
