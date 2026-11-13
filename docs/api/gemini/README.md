# Gemini API notes (LLM for the voice agent)

Researched 2026-10-27 from official docs only (ai.google.dev). Fixtures in `fixtures/` carry `_source` / `_status`. Page text was read via a summarising fetcher; whatever is labelled UNVERIFIED was not seen verbatim in docs.

## 0. Big finding: two API surfaces
Google's docs are now centred on the **Interactions API** (`POST /v1beta/interactions`, `input`, `steps`, `previous_interaction_id`, snake_case). `generateContent` is described as "legacy" in page titles but "remains fully supported" and Google gives no end-of-support date (https://ai.google.dev/gemini-api/docs/migrate-to-interactions). Google says new agentic features/models beyond the core line will land on Interactions only. This project (Pipecat `GoogleLLMService`, google-genai SDK) uses generateContent / streamGenerateContent, so the fixtures follow that surface. Risk: a later migration. Interactions gaps vs generateContent per search summary: Batch API, explicit caching, Python auto function calling (UNVERIFIED, from search snippet).

## 1. Model and pricing (VERIFY, read 2026-10-27)

Model page: https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
- ID: **`gemini-3.5-flash-lite`**, status Stable. Input 1,048,576 tokens, output 65,536. Supports function calling, structured outputs, thinking, caching, batch. Not Live API. Text output only. Knowledge cutoff / release date / deprecation date: not stated.
- Described as a previous-generation model "that remains available for production"; newest Flash line is Gemini 3.8 Flash (https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.6). Also listed on the pricing page: `gemini-3.1-flash-lite` (and preview), `gemini-2.5-flash-lite`.

Pricing, USD per 1M tokens, Standard tier (https://ai.google.dev/gemini-api/docs/pricing):

| Model | Paid input | Paid output | Cached input | Free tier |
|---|---|---|---|---|
| gemini-3.5-flash-lite | $0.30 (text/image/video/audio) | $2.50 | $0.03 + $1.00/1M/hr storage | free in/out, no caching |
| gemini-3.1-flash-lite | $0.25 text, $0.50 audio | $1.50 | $0.025 | free |
| gemini-2.5-flash-lite | $0.10 text, $0.30 audio | $0.40 | $0.01 | free |

Batch/Flex 3.5-flash-lite: $0.15 in / $1.25 out. Priority: $0.54 in / $4.50 out. Output price includes thinking tokens.

Cost sanity: 1 call-minute at, say, 6 turns x ~1,500 prompt tokens + 60 output tokens ~ 9,000 in + 360 out = ~$0.0036 on 3.5-flash-lite (ours, assumes no caching) vs the $0.033/min total budget. Prompt caching helps; storage fee applies.

## 2. Free vs paid; data use
Terms: https://ai.google.dev/gemini-api/terms and the pricing page "Used to improve products" column.
- **Free/unpaid**: Google uses prompts and responses to improve products, human reviewers may read them (disconnected from account/key), "do not submit sensitive, confidential, or personal information". Never use the free tier for real calls.
- **Paid** (billed project): not used to improve products. Prompts/responses logged "for a limited period" for abuse/security/legal; **no duration stated** on the page (55 days is NOT confirmed). May be stored transiently in any country where Google has facilities. Processed under Google's Data Processor addendum. Canada is not mentioned; no regional pinning from the Gemini Developer API found. Flag for PIPEDA/Law 25 review (human task, not legal advice). Paid-vs-Vertex distinction: https://ai.google.dev/gemini-api/docs/migrate-to-cloud (not read; Vertex AI offers regional endpoints - UNVERIFIED).
- Rate limit tiers (https://ai.google.dev/gemini-api/docs/rate-limits): Free, Tier 1 (billing linked), Tier 2 ($100 spend + 3 days), Tier 3 ($1,000 + 30 days). Limits per project, RPD resets midnight Pacific; spend caps rolling 10 min (T1 $10, T2 $50, T3 $200). Per-model RPM/TPM/RPD for Flash-Lite are not on the page (see AI Studio).

## 3. generateContent request
Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, header `x-goog-api-key`. Fixture `generate_request_basic.json`.
- `systemInstruction` (reference) / `system_instruction` (REST sample): content object, text only.
- `contents[]`: `{role: "user"|"model", parts:[{text}]}`; stateless: resend history. **Last turn must be `user`** (prefilled model turn returns 400 on these models).
- `generationConfig`: `maxOutputTokens`, `thinkingConfig.thinkingLevel` ("minimal" is default for 3.5 Flash-Lite; also low/medium/high), `responseMimeType`/`responseSchema` or `responseFormat` (section 6), `stopSequences`, etc.
- **Do not send `temperature`, `topP`, `topK`**: deprecated and ignored on Gemini 3.6+ and 3.5 Flash-Lite docs; future generations return 400. `candidateCount` unsupported for Gemini 3+. Any "temperature" setting from the PRD must be dropped; control style via system instruction. (whats-new-gemini-3.6 page.)
- `maxOutputTokens` counts thinking tokens too; keep thinking `minimal` for latency or a low cap can truncate.
- Other top-level: `tools`, `toolConfig`, `safetySettings`, `cachedContent`, `serviceTier`, `store`, `labels`.

## 4. Response and usage
Fixture `generate_response.json`. `candidates[].content.parts[]`, `finishReason`, `index`; top-level `usageMetadata`, `modelVersion`, `responseId`, `promptFeedback` (`blockReason`, `safetyRatings`).
`usageMetadata`: `promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `toolUsePromptTokenCount`, `thoughtsTokenCount`, `totalTokenCount`, plus `*TokensDetails[]` per modality and `serviceTier`. Bill by prompt + (candidates + thoughts) output.

## 5. Streaming
`POST .../models/{model}:streamGenerateContent?alt=sse` (docs text-generation page). Each SSE event is a partial GenerateContentResponse; usage on the final chunk (event framing UNVERIFIED from docs). Fixture `stream_request_and_chunks.json`.

## 6. Function calling
Fixtures `function_calling_request.json`, `function_call_roundtrip.json`. Source: https://ai.google.dev/gemini-api/docs/generate-content/function-calling and API reference.
- Declare: `tools:[{functionDeclarations:[{name,description,parameters:{type:"object",properties,required}}]}]`.
- Model returns a part `functionCall:{id?,name,args}` (name up to 128 chars `[A-Za-z0-9_-]`). Parallel calls = several parts; match by `id`.
- Reply with a `user` turn containing `functionResponse:{id,name,response:{...}}` (`response` must be a JSON object; use an `error` key for failures). Also `willContinue`, `scheduling` (SILENT/WHEN_IDLE/INTERRUPT) for non-blocking calls.
- Modes (SDK docs): `AUTO` (default), `ANY`, `NONE`, `VALIDATED`; `allowedFunctionNames`. REST wire spelling UNVERIFIED.
- **Thought signatures**: Gemini 3 models attach `thoughtSignature` to parts; when managing history manually you must send each model part back unchanged (same part, not merged/split). Missing signature can end with `MISSING_THOUGHT_SIGNATURE`. Pipecat/SDK handles it; custom code must not strip parts.

## 7. Structured output for post-call summaries
Fixture `structured_summary_request.json`. Docs now recommend `response_json_schema` (SDK) = REST `generationConfig.responseFormat.text{mimeType:"APPLICATION_JSON",schema}` (as read through summarizer, exact REST sample UNVERIFIED). Older docs use `responseMimeType:"application/json"` + `responseSchema`. Test both on `gemini-3.5-flash-lite` and record the winner in `docs/DECISIONS.md`. Supported keywords: type (incl. null), title, description, properties, required, additionalProperties, enum, format, minimum, maximum, items, prefixItems, minItems, maxItems, `$ref`. Ignored (validate in code): min/maxLength, uniqueItems, min/maxProperties, contains. Output keys follow schema order. Structured output + built-in tools is Preview. Structured output works on 3.5 Flash-Lite (listed).

## 8. Errors and finish reasons
Fixture `errors_and_finish_reasons.json`.
- 429 `RESOURCE_EXHAUSTED` (backoff + jitter), 503 `UNAVAILABLE` (backoff), 403 `PERMISSION_DENIED`, 408 transient, 400/402 not retryable (https://ai.google.dev/gemini-api/docs/troubleshooting). Daily quota => `quota_exceeded`. Note: the api-errors page (https://ai.google.dev/gemini-api/docs/api-errors) documents `{"error":{"code":"<snake_case>","message"}}` and SSE `event_type:"error"` events; this looks Interactions-specific. The classic generateContent body (`error.code` int, `error.status`) is UNVERIFIED. Parse both.
- `finishReason`: STOP, MAX_TOKENS, SAFETY, RECITATION, LANGUAGE, OTHER, BLOCKLIST, PROHIBITED_CONTENT, SPII, MALFORMED_FUNCTION_CALL, UNEXPECTED_TOOL_CALL, TOO_MANY_TOOL_CALLS, MISSING_THOUGHT_SIGNATURE, MALFORMED_RESPONSE, ESCALATION, PUP_LIMITED_DISABLED, CONTINUATION, plus IMAGE_* ones. The agent must handle: empty text with SAFETY/PROHIBITED (say fallback line, offer human transfer), MAX_TOKENS (truncated reply), MALFORMED_FUNCTION_CALL (retry once). `promptFeedback.blockReason`: SAFETY, OTHER, BLOCKLIST, PROHIBITED_CONTENT, IMAGE_SAFETY.

## 9. Not confirmed
- Real captured JSON from `gemini-3.5-flash-lite` (all instances in fixtures are illustrations; capture at M0).
- Time to first token / latency figures (none published); Flash-Lite RPM/TPM; paid-tier log retention duration; Canadian data location.
- REST spelling of `toolConfig` and `thoughtSignature`; SSE framing; classic error body.
- Whether `gemini-3.5-flash-lite` has a published shutdown date (page silent; the model is called "previous-generation", so watch https://ai.google.dev/gemini-api/docs/deprecations - not read).
- Whether Pipecat's `GoogleLLMService` still sends `temperature` by default (check source; would trigger warnings/400s in future).
