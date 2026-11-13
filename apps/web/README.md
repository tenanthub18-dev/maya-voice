# Restaurant dashboard

Existing Next.js UI with Supabase user authentication/RLS. Browser demo: `/demo`;
call history and usage: `/calls`. Browser test calls show actual duration, final
transcript, provider LLM tokens and partial USD cost estimates. Unknown usage
stays unavailable; these estimates do not represent restaurant invoices.

From the repository root: `pnpm --filter @voice-receptionist/web test --maxWorkers=2`,
`pnpm --filter @voice-receptionist/web typecheck`, `pnpm --filter @voice-receptionist/web lint`.
Production builds require the existing environment configuration.
See `../../docs/BROWSER-DEMO.md` for live test scripts and deployment operations.
