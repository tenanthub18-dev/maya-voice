# Roadmap after dashboard-on-mock (2026-10-27)
Docs-first: docs/api/<provider>/ (research agents) -> briefs 017+.
017 integration foundation: mode switch, /api/_mock handlers, typed clients + zod contract tests (Telnyx, Stripe, Resend, Firecrawl, Gemini, Soniox)
018 Supabase: migrations (PRD s7 all tables) + RLS + PGlite tests + seed + supabase DataSource
019 Auth/orgs/invites/roles + route protection (mock auth in mock mode)
020 API routes + webhooks (import, telnyx numbers, stripe, telnyx-sms) with signature verification + idempotency + usage ledger
021 Flows wired to clients: onboarding import, number picker, checkout/billing, notifications + daily digest
022 Worker: agent tools (hours/menu/availability/booking/order/sms/transfer/message/end), Supabase interface, post-call job
023 Browser test call UI + /webrtc/offer scaffold (dry-run tools)
024 PRD s8 edge-case + error-state sweep, i18n completeness, a11y
025 Design system overhaul + responsive pass (screenshots at 3 widths)
026 Playwright E2E in mock mode
027 Live-switch runbook + smoke-live
