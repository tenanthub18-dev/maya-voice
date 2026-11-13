# Browser call updates implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. No commits or pushes are requested.

**Goal:** Save browser calls and usage in the existing dashboard, then improve pickup speed, language switching and English numbers without redesigning the UI.

**Architecture:** Reuse installed Pipecat observers, pipeline events and Supabase. Keep browser business tools dry-run; persist real call/usage logs separately. Cache fixed greetings and coordinate caller language before the LLM and TTS.

**Tech Stack:** Pipecat 1.14, Soniox, OpenAI, Python, Supabase/Postgres, existing Next/React UI.

**Spec:** User-approved update order and `docs/REUSE-RESEARCH-2026-11-12.md`.

## Constraints

- Existing checkout and design; preserve unrelated edits, auth and bounded audio buffering.
- No new hosted service, recording, extra summary LLM call, POS implementation or customer billing for demo sessions.
- Provider identifiers/rates in configuration, official API references in comments; unknown usage/cost stays unknown.
- Browser disclosures describe AI and text logging accurately. Future telephone notice remains separate.
- Tests first for persistence, metrics, language state and number regressions; review migrations/RLS line by line.

## Tasks

- [x] Worker call logging: additive browser-source/usage schema; real UUID call lifecycle; incremental/final transcript, language, latency and provider usage persistence; configured USD cost estimates; cancellation/failure cleanup and no demo billing. Files: worker main/pipeline and tests, migration, provider config.
- [x] Dashboard: preserve list/detail design; label browser calls, show actual duration, input/output/cached tokens, service cost breakdown and estimate/unknown status; add accurate browser notice. Files: web data types, calls helpers/screens, locale messages and tests.
- [x] Voice: short cached opener, explicit/shared language state with dominance and number-only safeguards, precise English currencies/phones/times including non-ASCII digits; keep text context unchanged. Files: worker prompt/builder/runtime/number/cache modules and tests.
- [x] Verify and deliver: full relevant worker/web/shared suites, typecheck/lint/build, migration and tenant isolation checks, real public calls and dashboard inspection, greeting duration measurement, repeat/hang-up test; refresh existing deployment and docs.

## Review focus

Do not double-count observer events, cached input or interrupted usage. Capture actual generated speech in logs. Database failures must be visible, bounded and off the audio path. No invented telephone identity, misleading zero cost, privacy leak, changed business-write mode or inflated voice-quality claims.

## Authorized latency follow-up

Same voice/model/rates; full stable prompt prefix before runtime timestamp,
short first factual sentence, no extra inference/filler. Small live client runs
measure~1.28s median; sub-second target not achieved/guaranteed. Native-language
quality requires human listening. See LATENCY-BRIEF.md and private live reports.
