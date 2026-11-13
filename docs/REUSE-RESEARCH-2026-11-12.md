# Reuse research for the browser voice pilot

Verified against installed source and primary project documentation on 2026-11-12 (America/New_York). This is a recommendation, not an integration or a live quality result. Application code, dependencies and deployments were not changed.

## Decision

Keep the current UI, Supabase and Pipecat worker. Reuse Pipecat's existing observers and selected UI components; keep Soniox for the first language-quality improvements. Add provider-specific POS connections only after confirming the pilot restaurant's actual system and required order workflow. No additional hosted service is necessary for the proposed lightweight call history.

Free library code does not make hosted infrastructure, AI inference, POS subscriptions or payment processing free. License conclusions below identify published licenses; they do not establish security certification or suitability for every commercial use.

## Feature-by-feature fit

| Requested feature | Reusable option | Remaining application work | Recommendation |
|---|---|---|---|
| Browser calls appear in dashboard | Installed Pipecat transcription/usage events; existing Supabase calls, turns and metrics tables | Create and finalize browser call records, including failed/disconnected calls; adapt telephone-specific required fields without inventing phone numbers | First priority. This is primarily missing persistence, not a missing voice framework. |
| Minutes, tokens and price per call | Installed Pipecat `ServiceMetricsObserver` and usage metric types | Enable usage metrics; associate every event with a call; aggregate provider-reported tokens and versioned rates | Use existing worker/database, without another LLM summarization pass. |
| Lightweight conversation logs | Existing caller transcription, assistant text and structured tool outcomes | Save only the desired text/events; choose retention; keep audio storage disabled for this pilot | No additional transcription or summary model needed. |
| Browser call UI | Pipecat UI call controls, device selector, conversation, visualizers and metrics panels | Adapt props-driven view components to current call state and theme | Reuse selected components; preserve the working audio transport initially. |
| Urdu/Hindi switching and natural replies | Existing Soniox token language identification and Pipecat conversation pipeline | Coordinate detected/explicitly requested language across recognition, LLM and TTS; shorten replies and tune endpointing | No separate language-detection service initially. Test ambiguous short replies and interruptions. |
| English numbers in Telugu/Urdu/etc. | Existing number processor; optional `num2words` for English number/currency conversion; Soniox TTS language mixing | Preserve phone/date/time context; render prices clearly; verify spoken output with native speakers | Extend existing code only where a library replaces actual formatting complexity. |
| Opener finishes within two seconds | Pre-generated greeting audio and existing cache infrastructure | Generate at publish time, verify clip duration, play immediately; place accurate AI/text-log disclosure before browser Start | No per-call LLM/TTS request for the fixed greeting. Measure audible pickup time as well as clip length. |
| Menu sync and POS order creation | Official POS APIs/SDKs, beginning with the confirmed pilot provider | Merchant authorization, location/item/modifier mapping, prices/taxes, idempotent submission, status reconciliation and fulfillment verification | Supported connectors can feel plug-and-play after this integration work. |

Sources: [Pipecat metrics observer](https://docs.pipecat.ai/api-reference/server/utilities/observers/service-metrics-observer), [Pipecat UI](https://ui.pipecat.ai/docs), [ready-made metrics views](https://ui.pipecat.ai/docs/blocks/metrics), [Soniox language identification](https://docs.soniox.com/stt/concepts/language-identification), [Soniox mixed-language speech](https://docs.soniox.com/tts/concepts/language-mixing), [num2words](https://github.com/savoirfairelinux/num2words).

## What the current application already provides

- Pipecat 1.14.0 is installed, including `ServiceMetricsObserver`, LLM token usage, STT audio-second usage and TTS character usage. Pipeline settings currently enable timing metrics, but do not enable usage collection/persistence for these requested reports.
- Browser test sessions use synthetic `test-...` identifiers and dry-run business tools. Their launch path does not create/finalize the dashboard call record. Logging browser sessions must remain independent of whether bookings/orders/SMS are simulated.
- Existing database tables already cover calls, transcript turns, latency and cost metadata. Their original telephone-specific constraints need deliberate adaptation for browser sessions. Do not insert fake telephone identifiers or bill browser demo time as restaurant telephone usage.
- A spoken-number processor and multilingual prompt already exist. The language processor currently changes TTS language from final recognition results; shared recognition/LLM/TTS language state needs improvement.
- The current greeting is assembled and synthesized during call startup, and can repeat the restaurant identity. A short pre-generated opener avoids this work at pickup.

Evidence locations: `apps/worker/src/voice_receptionist_worker/main.py`, `pipeline/builder.py`, `pipeline/prompt.py`, `pipeline/spoken_numbers.py`, `resilience/runtime.py`, and installed `pipecat/metrics/metrics.py`. Later migrations already add Telugu and Arabic: do not assume the initial five-language enum is still the complete schema.

## License, hosting and compatibility shortlist

| Project | Published license | Fit here |
|---|---|---|
| Pipecat server/client/UI | BSD-2-Clause | Best reuse. Core is already installed. UI has controlled `*View` exports for existing application state. |
| Square Node SDK | MIT | Preferred SDK if Square is confirmed. Merchant platform and processing terms remain separate. |
| num2words | LGPL-2.1 | Optional local English number helper; not a complete phone/date/time interpreter. |
| LiteLLM library | MIT outside enterprise directory | Optional multi-provider cost helper. Do not introduce a proxy just to multiply a small set of known rates. |
| Langfuse | MIT core; enterprise exceptions | Useful later for deeper tracing/evaluation. Self-hosting adds web/worker, Postgres, Redis/Valkey, ClickHouse and blob storage; unnecessary for current minimal logs. |
| Activepieces | MIT core; enterprise exceptions | Possible later asynchronous workflows. Another service, and not a universal restaurant POS/order connector. |
| Nango | Elastic License 2.0 | Potential OAuth integration infrastructure; source-available with restrictions, not the first choice for a no-new-service pilot. |
| n8n | Sustainable Use License; enterprise exceptions | Do not assume embedded multi-customer commercial use is freely licensed. Not needed for the first connectors. |
| whisper.cpp | MIT | Local ASR experiment on the Mac; needs a multilingual accuracy/latency benchmark. Free code still consumes compute and does not remove the always-on host requirement. |
| LiveKit Agents | Apache-2.0 | Alternative voice framework, but adds migration/server/networking work. No reason to replace Pipecat for these features. |

License sources: [Pipecat](https://github.com/pipecat-ai/pipecat/blob/main/LICENSE), [Pipecat UI](https://github.com/pipecat-ai/pipecat-ui/blob/main/LICENSE), [Square](https://github.com/square/square-nodejs-sdk/blob/master/LICENSE), [num2words](https://github.com/savoirfairelinux/num2words/blob/master/COPYING), [LiteLLM](https://github.com/BerriAI/litellm/blob/main/LICENSE), [Langfuse](https://github.com/langfuse/langfuse/blob/main/LICENSE), [Activepieces](https://github.com/activepieces/activepieces/blob/main/LICENSE), [Nango](https://github.com/NangoHQ/nango/blob/master/LICENSE), [n8n](https://github.com/n8n-io/n8n/blob/master/LICENSE.md), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [LiveKit](https://github.com/livekit/agents).

Pipecat's standard [WebSocket client transport](https://docs.pipecat.ai/api-reference/client/js/transports/websocket) expects a corresponding server protocol/serializer. Our custom authenticated PCM protocol is not established as compatible. Reusing UI views does not require replacing it. Pipecat recommends WebRTC for robust production browser media; that is a separate transport evaluation, not a prerequisite for the requested dashboard work.

## POS connection catalogue

| Provider | Existing building blocks | Connection UX and limitations |
|---|---|---|
| Square | Official MIT SDK, Catalog, Orders and OAuth APIs | Connect Square, authorize scopes, select restaurant location. Test menu/modifiers and order fulfillment. Creating an unpaid order does not automatically prove POS/kitchen delivery. |
| Clover | Official REST inventory/orders APIs and OAuth | Multi-merchant application uses merchant authorization and refresh tokens. Merchant-generated tokens are documented for controlled single-merchant/internal integrations. |
| Toast | Official menu/order APIs and client-credentials authentication | Available access depends on integration type. Partner/custom access requires approval; standard access is not proof of permission to submit the required orders. |
| Lightspeed Restaurant | Product-specific APIs, including K-Series | Confirm exact product, access and ordering capability before offering a working Connect action. Do not treat every Lightspeed product as one API. |
| ERPNext/Frappe | Open-source application with native REST API and key/secret authentication | Viable for restaurants already using it; map their actual items and order documents. The official `frappe/frappe-client` Python repository is archived, so prefer maintained native REST rather than that SDK. |
| TouchBistro / other providers | Published partner integrations where available | Show Request integration until access and supported operations are verified. No generic API-key box that falsely promises instant compatibility. |

Sources: [Square OAuth](https://developer.squareup.com/docs/oauth-api/overview), [Square Orders and fulfillment visibility](https://developer.squareup.com/docs/orders-api/what-it-does), [Clover token rules](https://docs.clover.com/dev/docs/oauth-and-tokens-faqs), [Toast credentials and approval](https://doc.toasttab.com/doc/devguide/authentication.html), [Lightspeed K-Series](https://api-docs.lsk.lightspeed.app/), [Frappe REST integration](https://docs.frappe.io/erpnext/integrating-erpnext-with-other-applications), [archived Frappe client](https://github.com/frappe/frappe-client), [TouchBistro integrations](https://www.touchbistro.com/features/integrations/).

The pilot's public ordering site is Square Online. This does not establish its in-store POS, merchant credentials, kitchen workflow or authorization to create live orders. Confirm these before choosing the first connector. Provider cards should disclose menu-sync/order capabilities and distinguish available, connected, access-required and requested states. Requesting a missing provider records demand; it cannot implement an unknown API automatically.

## Quality and accounting rules for the update

1. Save call history plus usage first. Reuse emitted events; no audio recording or extra summary-model pass. Count actual provider usage even in a demo, while keeping it distinct from billable customer minutes.
2. LLM tokens can be provider-reported. Pipecat's TTS character counts are not Soniox billing tokens. Separate measured usage, calculated estimates and reconciled provider costs; unknown cost must not appear as zero. Include model/rate version and currency. [LiteLLM helpers](https://docs.litellm.ai/docs/completion/token_usage) can assist LLM estimates; [Soniox pricing](https://soniox.com/pricing) uses provider-specific units.
3. Honor explicit language requests; share chosen language with LLM and TTS. A number-only reply or borrowed English word should not reset the conversation language. Soniox supports mixed text within one request; the primary language biases the overall delivery. Native-speaker testing remains necessary for English numbers inside Urdu/Telugu.
4. Evaluate the newly announced [Soniox STT v6](https://soniox.com/blog/soniox-stt-v6), including its documented agent-text/echo-handling features, against the configured v5. These are vendor claims, not measured improvements in this application; verify installed adapter support before enabling them.
5. Cache a short opener per published voice/language/restaurant. Put an accurate AI and transcript notice before browser Start; future telephone disclosures need their own flow. Do not claim audio is recorded when it is not stored.
6. Add the confirmed POS provider using its official API/SDK. Acceptance is menu sync plus a duplicate-safe order that the restaurant can actually receive and act on, with status visible in our dashboard.

No new packages were installed, no provider credentials requested and no live POS orders submitted during this research.
