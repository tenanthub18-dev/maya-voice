# Shorter, natural voice replies Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task by task.

**Goal:** Improve concise, relevant replies and measured response speed without changing UI, provider/model/voice, safety, or practice scope.

**Architecture:** Consolidate repeated style instructions into one short conversation policy. Preserve source business facts, full readbacks, consent, language/English numbers and static prefix caching. Keep sentence-based synthesis and natural pause handling. Compare identical cached synthetic callers through the existing isolated worker before rollout; discard variants without a demonstrated benefit.

**Tech Stack:** Existing Pipecat1.14, OpenAI gpt-4.1-mini, Soniox, Supabase and Playwright; no new dependencies or inference stages.

**Spec:** User request 2026-11-13; PRD §§0,1,12. Demo validation does not close production, native-speaker or physical-phone gates.

## Global Constraints
- Current UI, models, voice, provider rates and tool scope unchanged.
- No response truncation, token-cap reduction, extra paid inference, speculative tools or fabricated facts.
- Browser order/booking/SMS remain dry-run. No credentials, private reports/audio or runtime files committed.
- Keep Toronto local runtime context after stable business/owner facts.

## Review Focus
- Brief replies must retain all requested choices/prices and corrected quantities/modifiers/date/time.
- Reasons must come from supplied descriptions; no inferred allergy/certification or guaranteed accommodation.
- Planning without consent must not submit or repeatedly offer an order.
- Language switches and English-spoken numbers must survive buffered TTS.
- Short response timing samples do not establish PRD p95 or native pronunciation quality.

### Task 1: Consolidate the prompt
Files: worker pipeline/prompt.py, existing prompt tests if wording assumptions need adapting.
- [x] Record baseline failures using fixed cases and controlled same-model text replay. Role change alone did not reliably improve brevity; do not retain it.
- [x] Replace repeated style paragraphs with compact positive instructions while retaining every functional safety/language/tool guard and business fact. No brittle word-for-word new tests.
- [x] Run existing prompt/pipeline/language tests; inspect the diff for guard loss.

### Task 2: Verify audio quality and speed
Files: existing voice-test tools, private reports (ignored).
- [x] Start isolated candidate worker; run identical menu and order cases. Compare transcript brevity, requested facts, first-audible timing, token usage and partial USD/min against current baseline. Investigate verified regressions before rollout.
- [x] Run representative language-switch and repeated-call checks as warranted by changes. Keep UI unchanged and business tables untouched.

### Task 3: Review, rollout and publish
Files: docs/QUALITY-CHECKS-2026-11-13.md, docs/LATENCY-BRIEF.md, docs/CHANGELOG.md, worker README, private comms ledger.
- [x] Read-only cross-review; run required worker checks and any checks justified by changed files.
- [x] Refresh managed worker only after quality checks; verify public voice connection and save real result evidence. Do not rotate tunnels unnecessarily.
- [ ] Document measured gains and unresolved limits; commit/push the reviewed update to existing maya-voice main and verify CI.

### Task 2a: Conversational English prices
Measured prompt candidate completes both choices, but expands every price into a long currency phrase. Use the existing numeric TTS transform to omit only redundant 'and'/'cents' for whole-dollar amounts with 10-99 cents (e.g. $15.99 -> 'fifteen dollars ninety-nine'). Preserve explicit dollars, exact cents, singular dollars, sub-dollar amounts, 1-9cent amounts, phone/time/date rules and numeric LLM/tool context. Add meaningful pronunciation regressions first, watch old implementation fail, then run number/language tests and full worker suite. Ownership spoken_numbers.py/tests only; no provider or UI changes.

### Task 2b: Reuse HTTP/2 connections after interruption
Wire-traced same-model experiment: HTTP/1 stream cancellation forces a new TCP connection on the next turn; HTTP/2 retains its connection. HTTP/1 TTFT810cold/326interrupt/532after/420repeat ms vs HTTP/2 323cold/367interrupt/468after/268repeat (small sample, no end-to-end guarantee). Use existing HTTPX http2 extra and Pipecat public create_client override, same auth/default SDK endpoint/settings/limits. Retain automatic HTTP/1 fallback when server cannot negotiate HTTP/2. Explicitly close per-call client in cleanup after processor cleanup. Add failing real-client lifecycle/config tests first, then minimal adapter, frozen dependency resolution, full tests/audit and live menu/order/language/repeated-call regressions. No extra inference, paid tier, model change or shared cross-caller context.


Task2b final decision: HTTP/2 reuse rejected after source review confirmed missing
RST_STREAM on early response close in installed httpcore1.0.9 (upstream PR1098).
All optional dependencies removed; pyproject/lock restored exactly. Retain only
native per-call SDK-client finally cleanup, preserving factory/auth/settings and
cancellation behavior.530tests pass. All speed experiments documented; do not
claim consistent sub-second replies or an end-to-end transport speedup.

Final acceptance:530worker tests pass; native-client source review approved;
final public5delayed-audio calls and corrected-order/dashboard/usage/no-writes
checks passed. Plan16vs29words, correction19vs31. Public median1551ms/slowest1629ms
(n4), so consistent sub-second and general speed improvement remain unachieved.
All7language functional checks passed; physical-phone/native ratings still open.
