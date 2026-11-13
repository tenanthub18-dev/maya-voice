# Sub-second response speed Implementation Plan

> Use superpowers:executing-plans task by task.

Goal: typical meaningful caller-end to audible reply under1000ms on the public browser demo, same UI/providers and no material cost increase. Report p50/p95 and cold/outlier behavior; no filler/silent audio counted as a reply. Physical-phone/native approval remains a human gate.

Architecture: keep the existing Pipecat/Soniox/OpenAI cascade and native HTTP/1 client cleanup. Compare newer cheaper OpenAI models/Fast mode using identical tools/prompt. Stream safe complete-word phrases continuously into the existing Soniox TOKEN-mode stream, retaining native sentence boundaries and text conservation. Do not truncate text, split numeric spans, add inference, change listening/barging rules or speculative tool execution. No HTTP/2 experiment repetition.

1. [x] Trace actual call stages and run bounded native Chat/tools probes. GPT6Luna standard had no consistent speed advantage; warmed Fast first-sentence times388–520ms versus current model444–951ms in small paired tests. Verify all costs through official docs. No public change yet.
2. [x] Implement continuous safe phrase aggregation using installed SimpleTextAggregator, opt-in config, unit regressions first for exact text/numeric equivalence, Unicode, per-response reset and interruption cleanup. No new dependencies. Files: pipeline/first_phrase.py, builder.py narrow TTS wiring, tests/test_first_phrase.py.
3. [x] Isolated real-provider tests: current baseline, Luna Fast only, then first-phrase combination. Keep source voice/model IDs/pricing in YAML once a candidate wins. Confirm tool consent, correction readbacks, unknown facts, languages and cost accounting. Reject unproven variants.
4. [x] Independent source/security review; full worker checks and unchanged-web validation. Refresh public worker after local technical checks, run public fixed cases/multiple calls, and document limits. Release to existing maya-voice main; use GitHub commit checks for final CI status.

Acceptance: customer hears a useful response, no swallowed words/digits, both requested menu facts and full corrected details retained, seven language/English number regressions, no browser business writes, dashboard usage and client cleanup intact. Faster timing must be actual audible content, not changed statistics. Fast tier estimates must use verified tier-aware conservative rates or be labeled unavailable, never silently standard rates.

Additional measured bottleneck: native HTTP/1 stream cancellation closes its
connection, adding a new TLS handshake to the next inference. Test opt-in
voice_llm.preconnect: background native models.retrieve on Start/afterInterruption,
bounded timeout/no retries, same per-call pool, never awaited by paid inference,
no prompt/tools/caller text or completion. Cancel/join on cleanup. Preserve native
HTTP/1 cancellation; on actual model change clear stale model-specific extra
settings unless explicitly supplied (Fast/reasoning must not reach GPT4.1 fallback).
Files: existing pipeline/openai_llm.py + factory arg + tests/test_openai_llm.py.

First-phrase-only experiment did not reach target: local order median1145ms,
Soniox TTFB315–431ms despite first-prefix aggregation~11ms. A single short prefix
followed by a sentence-sized hold starves the native incremental stream. Revise
to continuous safe phrase batches using the existing TOKEN-mode audio/context
sequencer, preserving complete number groups and exact concatenated text; no
individual-token number transforms and no forced punctuation. New opt-in
setting tts.phrase_words replaces the unpublished first-only prototype setting.

Final selection: original gpt-4.1-mini, no paid tier, same Soniox/Priya/UI/prices/prompt. Default safe continuous batches are 4 words and metadata preconnect is enabled. Model/Fast-tier/pricing/prompt experiments were discarded.957 worker tests, 764 web (two workers), 8 shared and independent source/config review pass. Public technical replays passed (5 delayed-audio calls,16 replies and7 languages); the under 1000 ms / 200-turn gate remains open unless measurements establish it.

Measured result: public p50=1195ms, slowest2220ms, none under 1000 ms. Implementation delivered; goal remains unmet. Original models/rates/UI retained, no new inference/dependencies; partial call estimates varied upward, no invoice-neutrality claim. Native/physical-phone and 200-turn PRD gates remain open. Release validation is tracked in the GitHub commit checks.
