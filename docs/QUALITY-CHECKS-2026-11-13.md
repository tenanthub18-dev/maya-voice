# Conversation quality checks — 2026-11-13

Scope: shorter, more useful browser-call replies and response speed. Existing UI,
OpenAI gpt-4.1-mini, Soniox STT/TTS and Priya remain. No paid priority tier,
additional inference stage, real orders/bookings/SMS or deployment service added.

## Conversation changes

Consolidated repetitive instructions into conversation/language/action sections.
The host answers directly, uses short complete opening sentences and gives each
requested recommendation with a sourced brief reason. Planning statements get a
brief readback rather than unsolicited prices/food descriptions. Full readbacks
retain corrected quantities, modifiers, dates and time. Consent, tool-success,
allergen uncertainty, pilot restrictions and English-spoken numbers remain.
Stable business/owner facts still precede the changing Toronto time suffix.

The existing numeric transform now speaks $15.99 as "fifteen dollars ninety-nine".
Explicit dollars and exact cents remain; whole-dollar, sub-dollar and 1-9cent
amounts retain their previous unambiguous pronunciation. Raw LLM/tool amounts,
phone/date/time and Unicode numeric handling are unchanged.

## Fixed-case evidence

Identical cached synthetic callers, local production web3101, same models/rates.
Client latency is approximate microphone-to-audible-output energy timing. These
small samples are not physical-phone results or the PRD200-turn p95 gate.
Costs below are known partial USD estimates, not final provider invoices.

| Scenario/version | Client median / slowest ms | Known USD/min | Observation |
| --- | --- | --- | --- |
| Menu baseline |1135 /1647|0.009736|Long first recommendations interrupted by next scripted turn; second choices incomplete. |
| Compact policy experiment |1536 /1619|0.007382|Both recommendations complete,23/24 spoken words; slower first audio, not retained unchanged. |
| Short complete sentences |1199 /1733|0.007869|Both requested choices/prices/reasons complete; allergy certification unknown. |
| Order baseline |1179 /1520|0.009756|Unsolicited prices and follow-up questions. |
| Final planning policy |1243 /1355|0.007499|Brief plan/correction,3 Butter Chicken/no onions/1 Garlic Naan/tomorrow7PM retained; complete readback, no submission. |

Private reports: tmp/phone-test/quality-{menu,order}-1113-*.json. All recorded
scenarios persisted browser call history/usage, showed the mobile dashboard,
released microphone/audio on hang-up and left business tables unchanged.
An occasional unnecessary closing phrase remained in the planning replay;
this is improved behavior, not a guarantee of human-like dialogue.

## Speed investigation

Tracing confirmed the instruction reaches the native OpenAI request. Changing
system/developer roles alone did not reliably improve brevity; no role change.
An existing Responses WebSocket service was benchmarked with the same model:
Chat TTFT713/552/389ms versus WebSocket1985cold/558/505ms. No speed benefit was
established; the application keeps its current API/transport semantics.

The bundled Smart Turn detector produced menu samples1216/1128/4125/4409ms,
including unacceptable long pauses. Its published23-language list also omits
Urdu, Punjabi and Telugu. It is not enabled for this multilingual pilot.
[Upstream language list](https://github.com/pipecat-ai/smart-turn).

An isolated HTTPX protocol trace confirmed HTTP/1.1 opened a new TCP connection
after an interrupted stream, whereas HTTP/2 reused its connection. Eight tiny
same-model requests returned TTFT810cold/326interrupt/532after/420repeat ms for
HTTP/1 versus323cold/367interrupt/468after/268repeat for HTTP/2. This is a bounded
transport probe, not proof of an end-to-end latency percentile.
[HTTPX HTTP/2 documentation](https://www.python-httpx.org/http2/).

## Retained client cleanup and rejected transport experiment

The final application keeps the native Pipecat/OpenAI client factory, HTTP/1.1,
settings, authentication, endpoint and dependencies. Each call owns its client;
cleanup now closes it in a finally block even if processor cleanup fails or is
cancelled. No caller context/client is shared.530worker tests pass, including
real-client lifecycle tests that were red before the fix, then green.

HTTP/2 was briefly deployed for verification, then reverted before committing.
Although its connection reuse was observed, installed httpcore1.0.9 does not send
a stream reset when a streaming response is closed early. That can leave unwanted
upstream work running and makes interruption-cost behavior uncertain. No billing
increase is claimed or measured; the optimization was rejected to protect the
cost constraint. All three optional dependencies were removed and the lockfile
restored. [Upstream cancellation fix](https://github.com/encode/httpcore/pull/1098).

During that discarded transport trial the same prompt produced a16word initial
order readback versus29baseline and an18word correction versus31baseline, with
all corrected details and no follow-up question. This is an example of improved
prompt behavior, not a guarantee across calls. Full-call timing was not a general
speed win (menu1148ms median/1930slowest, order1271/1789), so no such claim is made.

All seven language scripts/tags and English-spoken menu prices were verified
in synthetic call records. Native style, including occasional unnecessary English
phrases/follow-ups, still needs human listening. Consistent sub-second speed,
physical Android and real telephone acceptance remain open. Final public native-client checks follow.


## Final public native-client acceptance

Deployed the unchanged Vercel UI against the final Mac worker and refreshed only
public tunnel endpoints. Access code/login unchanged; administrator credentials
remain on the Mac. No dependencies, providers, models, voice or rates changed.

Five consecutive real-provider browser calls each received a simulated2200ms
audio burst. All5passed: native scheduling lead≤0.240s, microphone tracks ended,
no audio scheduled after hang-up, no page errors. Final public fixed order replay
also passed mobile call-history/usage/cost rendering and zero business writes.
The first plan was16spoken words (baseline29), correction19(baseline31), complete
readback27 with3Butter Chicken/no onions/1Garlic Naan/tomorrow7PM and no order/text
consent; cancellation ended practice without an unsolicited follow-up.

Public audible gaps1551/1584/1629/1281ms: median1551ms, slowest1629ms,4samples.
This does not establish a speed improvement. Public latency remains an unresolved
quality target. Cached greeting first audio arrived291.5ms after worker-ready;
this excludes tap/auth/provider startup. Known partial cost estimate0.005561USD/min
for this call; billing/caching/turn counts vary, so no guaranteed savings claim.
Private reports: quality-1113-native-playback.json and
quality-order-1113-native-public.json under ignored tmp/phone-test.
