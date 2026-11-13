# Existing-product quality acceptance and initial repository push

Goal: keep the existing UI, voice/providers/pricing and practice scope, make the
approved quality checks repeatable, verify outstanding correction/recommendation
cases, then publish the complete reviewed project to the user's maya-voice repo.

- [x] Extend existing opt-in Playwright caller checks with two fixed scenarios:
  quantity/modifier/date correction and concise menu recommendations/unknown facts.
  Reuse existing Soniox fixture generation, private cached PCM and Supabase logs.
  No extra judge service, dependencies or production capability.
- [x] Run the new scenarios, inspect synthetic transcripts, compare timing/cost
  and fix the verified report-file overwrite. Record factual passes and open
  brevity, latency and native/physical-phone gates; discard unproven variants.
- [x] Prepare a clean first snapshot: keep sources/tests/migrations/docs, exclude
  secrets/runtime/generated artifacts, update README to maya-voice with current
  setup/limits, scan all publication candidates and run relevant gates.
- [ ] Commit as requested, configure the user-specified origin, push main without
  force, and verify remote SHA/CI. Current GitHub identity anyappx lacks write
  access; user asked to grant access/sign in while preparation continues.

Do not reset the existing index or overwrite other edits/history. No API keys,
private audio/call data/login, local caches, agent state or build output may be
published. No PRD launch milestone closes from these limited demo checks.

Verified510worker/764web/8shared; type/lint/build/client-secret scans, clean
source typecheck, credential comparison and policy secret scan. Dependency
audits clean after reviewed compatible updates. Human style/phone/native and
consistent sub-second gates remain open. No unproven reminder/sampling rollout.
