# Response-speed checks — November 13, 2026

## Final change

Keep the UI, OpenAI gpt-4.1-mini, Soniox STT/TTS, Priya voice, existing
English-number rules, dialogue policy, VAD and interruption thresholds, native
HTTP/1.1 client and configured prices. No new dependency or paid completion stage.

- `tts.phrase_words: 4` streams complete-word batches continuously through
  Pipecat 1.14's native TOKEN-mode Soniox context/sequencer. Numeric groups stay
  together before the existing number transform; whitespace/text are preserved.
  Native sentence boundaries still take precedence. No forced punctuation,
  audio acceleration or word truncation. Set zero/remove to disable.
- `voice_llm.preconnect: true` schedules a bounded metadata-only models.retrieve
  GET at pipeline start/after interruption, sharing that call's existing SDK
  pool. No caller text, tools or completion are sent; inference does not await
  it. No retries; cancel/join on cleanup and close the native client. Remove/set
  false to disable. Model changes clear stale model-specific extra settings.
- Keep the native cancellation behavior; do not reintroduce HTTP/2. No speculative
  inference, paid tier, reduced listening allowance or filler acknowledgements.

Library contracts: [Pipecat text aggregator](https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/utils/text/simple_text_aggregator.py),
[Pipecat TTS](https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/tts_service.py),
[Soniox streaming](https://docs.soniox.com/tts/rt/real-time-generation),
[OpenAI metadata request](https://developers.openai.com/api/reference/resources/models/methods/retrieve).

## Isolated experiments

Same cached synthetic callers, existing dashboard and local authenticated DB.
The original-model control below used the temporary planning-notice prompt trial;
that unproven prompt change was discarded before the final public replay.
Times are caller speech end to scheduled meaningful output energy, not first
LLM token, greeting, silent packets or acknowledgement filler. Nearest-rank p50/
p95 are descriptive order statistics; four samples cannot establish tail latency.

| Configuration | Caller-end to audible reply, ms | p50 / p95, ms | Known partial USD/min |
|---|---|---|---|
| Previous public original-model order |1551,1584,1629,1281|1551 /1629|0.00556|
| Luna Fast only, local menu |1339,1198,1185,1670|1198 /1670|0.00481|
| Luna Fast, first phrase only, local order |1382,1145,1379,1099|1145 /1382|0.00667|
| Luna Fast, continuous six-word batches + preconnect, local order |1341,1036,1651,1027|1036 /1651|0.00591|
| Same six-word candidate, local menu |1164,1112,1156,1770|1156 /1770|0.00529|
| Luna Fast, continuous four-word batches + preconnect, EN/FR/HI/PA |1063,1051,1291,1163|1063 /1291|0.00780|
| Same four-word candidate, EN/UR/TE/AR |1239,1143,1371,1118|1143 /1371|0.00768|
| Original model, four-word batches + preconnect, local order |1156,1032,1162,1174|1156 /1174|0.00712|

The second language run overlapped an unrelated Node-suite run; its timing is
not a clean isolated benchmark. All language/script/English-price assertions
passed. Native-speaker pronunciation and physical-phone quality remain ungraded.

GPT-6 Luna Standard did not consistently outperform the existing model in paired
text probes. Fast had useful warm text results but no clear whole-call win;
retain the original model. Experimental cache-write/ceiling accounting and
planning-notice prompt edits were discarded. No change to model/rates/accounting.
[Model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna),
[Fast-mode documentation](https://developers.openai.com/api/docs/guides/fast-mode).

Partial USD/min is a duration-sensitive estimate of reported/estimated units,
not an invoice or a controlled cost comparison. STT context/output usage is
unreported, and spoken reply length varies. No browser business writes or billing.

## Verification

957 worker tests passed after discarding experimental accounting/prompt changes.
All 764 web tests passed with two workers, and 8 shared tests passed. Unrestricted
parallel web runs hit existing five-second PGlite test timeouts; no timeout or
assertion was weakened. Independent source/config review found no blockers.

Public technical replay results follow. The speed target is not achieved.
Consistent sub-second replies, the 200-turn PRD latency gate, native-speaker and
physical Android approval remain open until supported by appropriate evidence.

## Final public demo replay

Original model/voice/prices/prompt, four-word native TOKEN batches and metadata
preconnect. Five consecutive delayed-audio calls passed; maximum native playback
lead 0.2394s, all microphones closed, no frames after hang-up or browser errors.
Both fixed scenarios and seven-language replay infrastructure/dashboard checks
passed with zero business writes and zero billing seconds. Saved language tags,
scripts and English price speech passed all seven language checks.

| Scenario | Reply samples, ms | p50 / p95, ms | Known partial USD/min |
|---|---|---|---|
|order-correction|1456,1032,1148,2220|1148 / 2220|0.00788|
|menu-recommendation|1162,1309,1358,1631|1309 / 1631|0.00868|
|languages-fr-hi-pa|1270,1195,1337,1379|1270 / 1379|0.01077|
|languages-ur-te-ar|1144,1092,1186,1153|1144 / 1186|0.01088|

Combined 16 replies: nearest-rank p50 **1195ms**, p95/slowest **2220ms**,
fastest **1032ms**. None was under 1000 ms. The matched public order p50
improved 1551→1148ms (~26%), while its slowest reply increased 1629→2220ms.
Small, non-randomized samples do not establish a causal tail-latency change.

Configured prices are unchanged, but these partial estimates are higher than
the earlier public order sample (0.00556 USD/min versus 0.00788 USD/min now).
Reply length and reported usage vary; invoice-level cost neutrality is unproven.
No new inference stage, paid tier or dependency was added.

Functional transcript review retained the corrected quantities, no-onions request,
tomorrow/date/time and no-submission consent. Allergy certification remained
unknown. The menu replies were still verbose and the fixed caller interrupted
their endings; concise/natural speech is not certified by an infrastructure pass.
Human listening rubrics remain pending.

**Result: buffering/setup changes delivered; consistent sub-second replies not
achieved.** The PRD 200-turn latency/cost gate and physical Android/native-speaker
approval remain open. Refresh the existing demo tab after tunnel rotation; login
and access code are unchanged. The Mac must remain running for this demo.
