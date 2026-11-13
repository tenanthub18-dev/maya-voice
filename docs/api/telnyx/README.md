# Telnyx API reference (project extract)

Researched 2026-10-27 from official Telnyx sources. Every fixture in `fixtures/*.json` is an envelope `{ "_source", "_provenance", "body" }`. `_provenance` is one of:

- `verbatim` : copied from a docs page example.
- `composed` : field names and shapes from the docs or OpenAPI, values chosen by us or taken from schema property examples. Not a captured live response.
- `UNVERIFIED` : inferred, not shown in official docs.

Sources used (all official): `developers.telnyx.com/**.md` pages, the consolidated OpenAPI spec the docs link to (`https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json`, called "spec3" below), and `https://telnyx.com/pricing.md` (linked from `developers.telnyx.com/pricing.md`).

Common to all REST calls

- Base URL: `https://api.telnyx.com/v2`
- Auth header: `Authorization: Bearer <TELNYX_API_KEY>` (source: https://developers.telnyx.com/docs/development/api-fundamentals/authentication.md)
- Rate limit headers when present: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` (unit product-specific), `retry-after`. 429 body in `fixtures/error-429.json`. Docs say do not hard-code a global rate and retry only if the operation is safe to repeat (https://developers.telnyx.com/docs/development/api-fundamentals/reliability/rate-limiting.md). Pricing.md lists "API: 100/sec" and "SMS: 50/sec" (VERIFY, marketing summary).
- Errors: `{"errors":[{"code","title","detail","source":{"pointer"|"parameter"},"meta"}]}`. Read all members; `source.pointer` = body field, `source.parameter` = query param (troubleshooting page).
- Idempotency: the only documented REST idempotency is the optional `Idempotency-Key` header on `POST /messages` (see F). No idempotency documented for number orders; a timed-out mutating request may have completed, so reconcile by `GET` before retrying (https://developers.telnyx.com/docs/development/api-fundamentals/troubleshooting.md).
- Query encoding: brackets need `curl --globoff` or `%5B`/`%5D`.

---

## A. Search available phone numbers (Canada, 416 / 647, voice + sms)

- `GET /v2/available_phone_numbers`
- Source: https://developers.telnyx.com/api-reference/phone-number-search/list-available-phone-numbers.md
- Query (deepObject) keys: `filter[country_code]`, `filter[national_destination_code]` (area code), `filter[locality]` (city), `filter[administrative_area]` (US state or CA province), `filter[rate_center]` (US/CA only), `filter[phone_number_type]` (`local|toll_free|mobile|national|shared_cost`), `filter[features]` (array of `sms|mms|voice|fax|emergency|hd_voice|international_sms|local_calling`), `filter[limit]`, `filter[best_effort]` (US/CA only), `filter[quickship]` (+1 toll-free only), `filter[reservable]`, `filter[exclude_held_numbers]`, `filter[phone_number][starts_with|ends_with|contains]`.
- Request: `fixtures/search-numbers-416.request.json`, `search-numbers-647.request.json`.

```bash
curl --globoff -G "https://api.telnyx.com/v2/available_phone_numbers" \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  --data-urlencode "filter[country_code]=CA" \
  --data-urlencode "filter[national_destination_code]=416" \
  --data-urlencode "filter[phone_number_type]=local" \
  --data-urlencode "filter[features][]=sms" \
  --data-urlencode "filter[features][]=voice" \
  --data-urlencode "filter[limit]=5"
```

  The `filter[features]` array encoding is UNVERIFIED (page says nothing; deepObject+explode suggests repeated keys). Test against the live API in M0.
- Success: `fixtures/search-numbers.response.json` (verbatim schema example, a US number; no CA example is published). Note `cost_information.upfront_cost/monthly_cost` are strings, and the response has both `meta` and `metadata` (docs do not say how they differ).
- Errors: `fixtures/error-401.json`, `error-422.json`, `error-429.json`.
- Notes: "Only phone numbers that were previously returned in a search request can be ordered" (number-orders guide). Whether 416/647 search by `national_destination_code` vs `locality=Toronto` returns more stock is not documented. Also available: reservations (https://developers.telnyx.com/docs/numbers/phone-numbers/number-reservations.md), not researched in depth.

## B. Create number order / get order status

- `POST /v2/number_orders`, `GET /v2/number_orders/{number_order_id}`
- Sources: https://developers.telnyx.com/api-reference/phone-number-orders/create-a-number-order.md, https://developers.telnyx.com/api-reference/phone-number-orders/retrieve-a-number-order.md, guide https://developers.telnyx.com/docs/numbers/phone-numbers/number-orders.md
- Create request body fields: `phone_numbers[].phone_number` (required), `phone_numbers[].requirement_group_id`, `phone_numbers[].bundle_id`, `connection_id`, `messaging_profile_id`, `billing_group_id`, `customer_reference`. Fixture: `fixtures/number-order-create.request.json`. Setting `connection_id` and `messaging_profile_id` here can assign the number at purchase (the docs list them as order fields, see also E).
- Responses: `fixtures/number-order-create.response.json`, `number-order-get.response.json` (both composed from schema property examples). Order `status` enum in schema: `pending|success|failure`; the guide also lists `cancelled`, `deleted`. Phone-number sub-statuses while pending: `requirement-info-pending`, `requirement-info-under-review`, `requirement-info-exception`, `approved`.
- Regulatory requirements: if present, order stays `pending` until requirements are satisfied (PATCH `/sub_number_orders/{id}`); otherwise it "should activate momentarily". Canada local-number requirement groups: UNVERIFIED (not researched; check `GET /requirement_groups` / country coverage before M0 purchase).
- Webhook: `number_order.complete` style event, see `fixtures/number-order-status-update.webhook.json` (composed). Enable via the portal Notification Setting "Number Order Notifications" (https://support.telnyx.com/en/articles/4277896-notification-settings). Signed with the same Ed25519 headers (callback page says so).
- Errors: `error-401.json`, `error-422.json`, `error-429.json`, plus `20100 Insufficient Funds`, `20012 Account inactive`, `20014/20016/20017` verification levels (catalog).
- Idempotency: none documented. Do not blind-retry a POST; list orders (`GET /v2/number_orders`, filterable) and match `customer_reference` first. Using a unique `customer_reference` per attempt is our suggestion, not a documented guarantee.

## C. List owned numbers

- `GET /v2/phone_numbers`
- Source: https://developers.telnyx.com/api-reference/phone-number-configurations/list-phone-numbers.md
- Query: `page[size]` (1-250, default 20), `page[number]`, `sort` (`purchased_at|phone_number|connection_name|usage_payment_method`), `filter[status]` (`purchase-pending|purchase-failed|port-pending|active|deleted|port-failed|emergency-only|ported-out|port-out-pending`), `filter[phone_number]` (min 3 digits), `filter[country_iso_alpha2]`, `filter[connection_id]`, `filter[tag]`, `filter[without_tags]`, `filter[billing_group_id]`, `filter[customer_reference]`, `filter[number_type]`, `filter[source]`, `filter[voice.connection_name][contains|starts_with|ends_with|eq]`, `handle_messaging_profile_error`.
- Request `fixtures/numbers-list.request.json`; response `fixtures/numbers-list.response.json` (composed; data[].id is a string id, `connection_id` and `messaging_profile_id` show current assignment; `meta` = `total_pages,total_results,page_number,page_size`).
- A lighter, "higher performance and rate limit" variant exists: "Slim List phone numbers" (index entry; schema not researched).

## D. Delete / release a number

- `DELETE /v2/phone_numbers/{id}`
- Source: https://developers.telnyx.com/api-reference/phone-number-configurations/delete-a-phone-number.md
- No body. Response 200 returns the final representation with `status:"deleted"`: `fixtures/number-delete.response.json` (composed). Request: `fixtures/number-delete.request.json`.
- Errors: 404 (`error-404.json`), 422 (e.g. `10021 Resource in use`, `10036 Resource is being processed`, `deletion_lock_enabled` field exists on the number, effect of the lock on DELETE is UNVERIFIED). Deletion is a release; billing effect, number-recycling and re-acquisition guarantees are UNVERIFIED. Per project rule (PRD §10) never delete outside the cleanup allowlist.

## E. Assign number to a TeXML application / connection

Voice routing:

1. Create a TeXML application: `POST /v2/texml_applications` (spec3; docs entry https://developers.telnyx.com/api-reference/texml-applications/creates-a-texml-application.md). Key fields: `friendly_name`, `voice_url`, `voice_method` (`get|post`, doc says default GET), `voice_fallback_url`, `status_callback`, `status_callback_method`, `active`, `inbound.{channel_limit,shaken_stir_enabled,sip_subdomain}`, `outbound.{channel_limit,outbound_voice_profile_id}`, `first_command_timeout(_secs)`, `call_cost_in_webhooks`, `anchorsite_override`, `dtmf_type`, `tags`. Fixtures `texml-app-create.request.json`, `texml-app-create.response.json` (201; `data.id` is the app id).
2. Attach the number: `PATCH /v2/phone_numbers/{id}` with `connection_id` (https://developers.telnyx.com/api-reference/phone-number-configurations/update-a-phone-number.md). Fixtures `number-assign-connection.request.json/.response.json`. That the TeXML app id is the value to use for `connection_id` is UNVERIFIED as an explicit statement: docs say a number is "assigned" to the TeXML application and call it a "connection ID" in `create-a-connection-scoped-texml-call`, and the portal dropdown is "Connection or Application". Confirm on first purchase (response `connection_name` should show the app). Purchase-time alternative: set `connection_id` in the number order (B).
   - Related: `PATCH /v2/phone_numbers/{id}/voice` updates voice settings (call forwarding, recording, CNAM) of an already-assigned number (spec3 example in the OpenAPI).

Messaging routing:

- `PATCH /v2/phone_numbers/{id}/messaging` body `{"messaging_profile_id": "...", "messaging_product": "P2P|A2P"}` (spec3). Fixtures `number-assign-messaging-profile.*`. Each number needs a messaging profile for SMS webhooks (https://developers.telnyx.com/docs/messaging/messages/send-message.md).

Inbound call behavior: Telnyx fetches TeXML from the app's `voice_url` for calls to an assigned number (https://developers.telnyx.com/docs/voice/programmable-voice/texml-instruction-fetching.md).

## F. Send SMS

- `POST /v2/messages`
- Source: https://developers.telnyx.com/api-reference/messages/send-a-message.md, guide https://developers.telnyx.com/docs/messaging/messages/send-message.md
- Body: `from`, `to` (E.164), `text`, optional `messaging_profile_id`, `subject`, `media_urls`, `webhook_url`, `webhook_failover_url`, `use_profile_webhooks`, `type` (`SMS|MMS`). Fixture `messages-send.request.json` (body verbatim from guide). Alphanumeric sender IDs are not supported to US/Canada destinations; Canada supports long code, short code, toll-free (https://developers.telnyx.com/docs/messaging/messages/international-sms-compliance.md).
- Response 200: `data.id`, `data.to[].status:"queued"`, `cost`, `cost_breakdown`, `parts`, `encoding`, `tcr_campaign_*`, `wait_seconds`, etc. Fixture `messages-send.response.json` (composed; this spec example is an MMS).
- Idempotency: optional header `Idempotency-Key` (1-255 chars `[A-Za-z0-9_-]`, use UUID v4). Same key while in progress: 409 (code 10036). Same key with different request: 422. Bad header: 400 code 10015. Only successful responses replayed, for up to 24 h. Body over 256 KB with a key: 413 (code 10007). Edge protection unavailable: 503 (code 10016). Source: spec3 `IdempotencyKey` parameter and response descriptions. Fixture `error-idempotency-conflict.json`.
- Throughput (delivery, not API): account SMS 50 msg/s; long code 0.1 msg/s per number "applies to non-US destinations" (US is campaign-level 10DLC); toll-free 20 MPS per number; queue up to 4 h; queue full returns `40318` (https://developers.telnyx.com/docs/messaging/messages/rate-limiting.md). Whether Canada destinations from a Canadian long code follow the 0.1 MPS default is not stated explicitly (it says non-US) : treat as yes and VERIFY.
- Errors at send time (403xx): `40300` blocked (STOP) (`error-messages-40300-blocked-stop.json`), `40305` invalid from / number not on messaging profile, `40310` invalid to, `40309` destination region not whitelisted on profile, `40312` profile disabled, `40314` messaging disabled, `40318` queue full, `40333` spend limit. See L.

## G. Messaging webhooks

Source: https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks.md

- Delivery: HTTP POST JSON to per-message `webhook_url`, else messaging-profile URL. Respond 2xx within 2 s; up to 3 attempts per URL with exponential backoff, then failover URL (up to 6 total). Non-2xx and 3xx count as failure. Events may be duplicated or out of order; dedupe on `data.id`, order by `data.occurred_at`. Allowlist subnet in docs: `192.76.120.192/27`.
- Envelope: `{"data":{"event_type","id","occurred_at","payload","record_type":"event"},"meta":{"attempt","delivered_to"}}`.
- `message.received` : `fixtures/webhook-message-received.json` (verbatim). `payload.from.phone_number`, `payload.to[0].phone_number`, `payload.text`, `payload.media[]` (MMS media links expire after 30 days), `payload.messaging_profile_id`, `payload.id`.
- `message.sent` : `fixtures/webhook-message-sent.json` (verbatim); `to[0].status:"sent"`.
- `message.finalized` (delivery receipt) : `fixtures/webhook-message-finalized.json` (verbatim), failure shape `webhook-message-finalized-failed.json` (composed). `to[].status` values: `queued, sending, sent, delivered, sending_failed, delivery_failed, delivery_unconfirmed`. Failures populate `errors[]` with `code,title,detail,source.pointer`.
- STOP handling (https://developers.telnyx.com/docs/messaging/messages/advanced-opt-in-out.md): by default Telnyx itself handles opt-out keywords `STOP, STOPALL, STOP ALL, UNSUBSCRIBE, CANCEL, END, QUIT` by creating a block rule and `START, UNSTOP` by removing it. Block rules operate at the messaging-profile level (all numbers on that profile). Subsequent sends to a blocked recipient fail with `40300` (`error-messages-40300-blocked-stop.json`). The inbound `message.received` webhook still arrives and, for keyword messages, "includes an `autoresponse_type` field" (e.g. `"STOP"`); see `webhook-message-received-stop.json` (partial payload as in docs). Custom keywords and auto-responses: `POST /v2/messaging_profiles/{profile_id}/autoresp_configs` with `op` (`start|stop|help`), `keywords`, `resp_text`, `country_code`. Whether the auto-response text is sent automatically in Canada (`country_code` CA) or only for configured countries is UNVERIFIED, and French-language STOP variants (ARRET, etc.) are not documented as defaults: configure custom keywords. Our app must also record opt-outs itself (CASL: "Unsubscribe mechanism required" per compliance page).

## H. Webhook signature (Ed25519)

Sources: https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks.md, https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks.md. Fixture `fixtures/webhook-signature.json`.

- Headers: `telnyx-signature-ed25519` (base64 signature), `telnyx-timestamp` (Unix seconds).
- Signed string: `{telnyx-timestamp}|{raw JSON request body}` (UTF-8 bytes). Use the exact bytes received; do not parse and re-serialise.
- Public key: Mission Control Portal > API Keys > Public Key (https://portal.telnyx.com/#/app/api-keys), account-level key pair. Doc examples (Go, PHP, .NET) base64-decode it to the raw key before verifying.
- Replay window: docs recommend rejecting timestamps older than 5 minutes. Failure response in doc examples: 403.
- SDK helper: `telnyx.webhooks.constructEvent(payload, signature, timestamp, publicKey)` (Node). Helpers named `unsafe*` do not verify.
- Applies to: messaging webhooks, number order webhooks, and the TeXML callback webhooks listed under "Callbacks" (their API pages say they use these headers). Whether the TeXML instruction-fetch request (voice URL GET/POST) itself is signed is UNVERIFIED: the instruction-fetching page only advises checking `CallSid`.
- Media-stream WebSocket connections are also signed: signed string `{telnyx-timestamp}|{stream_url}` (`fixtures/ws-signature.json`, https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming.md).

## I. TeXML inbound call, `<Connect><Stream>`, WebSocket frames

### I.1 Voice webhook (instruction fetch)

- Source: https://developers.telnyx.com/docs/voice/programmable-voice/texml-instruction-fetching.md. Method configurable GET (default) or POST (form-encoded body). Fixture `fixtures/texml-inbound-voice.request.json`.
- Always sent: `AccountSid`, `CallSid`, `CallSidLegacy`, `CallerId`, `CallingPartyType` (`sip|pstn`), `From`, `FromSipUri`, `To`, `ToSipUri`, `ConnectionId`. The doc's GET example also shows `CallStatus=in-progress`. Respond 200 with XML rooted at `<Response>`; keep fast; failover URL optional.
- Separate status callbacks (initiated/ringing/answered/completed) are form-encoded with fields such as `CallStatus`, `CallbackSource`, `SequenceNumber`, `Timestamp`, `CallInitiatedAt`, `ShakenStirAttestation` (https://developers.telnyx.com/api-reference/callbacks/texml-call-initiated.md).

### I.2 TeXML

Docs show only the asynchronous form (`fixtures/texml-start-stream.response.json`, verbatim):

```xml
<Response><Start><Stream url="wss://yourdomain.com/stream" track="both_tracks" /></Start></Response>
```

The `<Connect>` page says `<Stream>` is a valid child ("Start media stream over websocket") and that Connect runs the service synchronously, with following instructions executed when it stops (https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/connect.md; "Synchronous streaming via `<Connect>`" in https://developers.telnyx.com/docs/voice/texml/rest-api/streams.md). No verbatim `<Connect><Stream>` document is published, so `fixtures/texml-connect-stream.response.json` is UNVERIFIED as to exact form:

```xml
<Response><Connect><Stream url="wss://example.com/stream" bidirectionalMode="rtp" bidirectionalCodec="PCMU" /></Connect></Response>
```

Stream attributes (https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/stream.md): `url`, `track` (`inbound_track|outbound_track|both_tracks`, default inbound), `name`, `codec` (`PCMU|PCMA|G722|OPUS|AMR-WB|default`), `bidirectionalMode` (`mp3|rtp`, default `mp3`), `bidirectionalCodec` (`PCMU|PCMA|G722|OPUS|AMR-WB`, default PCMU; only with rtp), `bidirectionalSamplingRate` (`8000|16000|24000`, default 8000), `statusCallback`, `statusCallbackMethod`, `enableReconnect` (default true). Child `<Parameter name= value=>` : delivered in the `start` message (stream page). Note: the Call Control page lists L16 and OPUS/AMR-WB at 8/16 kHz; the TeXML attribute table does not list L16 : do not assume L16 in TeXML (UNVERIFIED).

Stream status callback (form-encoded): `StreamEvent` ∈ `stream-started|stream-stopped|stream-error`, `StreamName`, `StreamSid`, `StreamError`, `CallSid`, `AccountSid`, `Timestamp` (`fixtures/texml-stream-status.webhook.json`). Doc inconsistency: the Stream verb page says `stream-failed`, the callback schema says `stream-error`; handle both.

### I.3 WebSocket frames

Source (Call Control page; the TeXML docs point to it and publish no separate frame spec, so identical frames for TeXML are UNVERIFIED but expected): https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming.md

- On connect: `ws-connected.json` `{"event":"connected","version":"1.0.0"}`.
- `start`: `ws-start.json` (has `stream_id`, `start.media_format{encoding,sample_rate,channels}`, `call_control_id`, `call_session_id`, `from`, `to`, `client_state`, `tags`). For TeXML, `<Parameter>` values are said to be included in `start`, exact key name UNVERIFIED (likely under `start`, not shown).
- Inbound media: `ws-media-inbound.json` : `media.track`, `media.chunk`, `media.timestamp`, `media.payload` (base64 RTP payload, no headers). Order not guaranteed; use `chunk` to reorder.
- Bidirectional audio send (to the caller):
  - `bidirectionalMode=rtp`: `{"event":"media","media":{"payload":"<base64 audio in bidirectionalCodec>"}}` (`ws-media-outbound-rtp.json`). Chunks 20 ms to 30 s. One bidirectional stream per call. Audio in a different encoding than the call is transcoded (quality loss).
  - mp3 mode (default): `{"event":"media","media":{"payload":"<base64 mp3>"}}` (`ws-media-outbound-mp3.json`), queued in order, max one media message per second.
  - `{"event":"clear"}` flushes playing and queued media (barge-in) (`ws-clear.json`); `mark` send/receive (`ws-mark-send.json`, `ws-mark-receive.json`) confirms playback finished; `dtmf` (`ws-dtmf.json`); `stop` (`ws-stop.json`); `error` frames with codes 100002 unknown_error, 100003 malformed_frame, 100004 invalid_media, 100005 rate_limit_reached (`ws-error.json`).
- Open questions for M-series: sample rate/encoding of rtp payload frames inbound is whatever `media_format` says; exact framing of 8 kHz PCMU 20 ms is not specified beyond "RTP payload".

## J. Call transfer / Dial TeXML

- Source: https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/dial.md. `fixtures/texml-dial-transfer.response.json` (verbatim example).
- `<Dial>` attributes: `action`, `method` (default POST), `callerId` (E.164), `fromDisplayName`, `privacy`, `hangupOnStar`, `timeout` (5-120, default 30), `timeLimit` (60-14400), `record*`, `sequential`; nouns `Number`, `Sip`, `Queue`. Multiple nouns dial simultaneously unless `sequential="true"`.
- When `action` is set, Telnyx requests it when the dialed call ends (callback fields: https://developers.telnyx.com/api-reference/callbacks/texml-call-completed.md; `error_code`/`error_message` only on failure). `statusCallbackEvent` on `<Number>` sends initiated/ringing/answered/completed.
- Alternative: `<Refer>` transfers to external SIP infrastructure via SIP REFER (https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/refer.md), not researched in depth.
- Hand-off from a stream: `<Connect action="...">` re-fetches instructions after the service ends, but the docs say `action` on `<Connect>` is supported for `ConversationRelay` and `AIAssistant` only. For `<Connect><Stream>`, subsequent instructions in the same document run after the stream stops (our reading of "executed when the service is stopped"); how to transfer mid-stream: use the REST call-update (`POST /texml/Accounts/{AccountSid}/Calls/{CallSid}`, "Update call", CamelCase keys; https://developers.telnyx.com/api-reference/texml-rest-commands/update-call.md) to point the live call at new TeXML (UNVERIFIED for this use; schema not read). Terminating the websocket from our side with enableReconnect=false should end the Connect and continue to the next verb (UNVERIFIED).

## K. Canada pricing (VERIFY all)

Source: https://telnyx.com/pricing.md (fetched 2026-10-27; marketing price list, not contract). `fixtures/pricing-canada.json`.

| Item | Rate (USD) |
|---|---|
| Canadian local number, monthly | 0.35 |
| Canadian local number, one-time | 1.00 |
| Canadian toll-free number, monthly / one-time | 1.00 / 1.00 |
| Inbound local voice, per min (from landline or mobile) | 0.004 |
| Inbound toll-free, per min | 0.015 |
| Voice API (TeXML) platform fee, per min | 0.002 (plus SIP/telephony charges) |
| Media streaming over WebSockets, per min | 0.0035 |
| SMS long code CA inbound / outbound, per part (sms-api table) | 0.0025 / 0.0025, plus carrier fees (rows exist per carrier) |
| Messaging-outbound table, CA per operator | 0.004 (so outbound SMS = 0.004 or 0.0025 : which table governs is unclear) |
| MMS CA inbound / outbound, per part | 0.005 / 0.015 |
| CA short code SMS in / out; short code monthly / one-time | 0.007 / 0.0255; 975 / 450 |
| E911 for CA, monthly | 1.50 |

Not found: Canadian outbound voice per-minute (for `<Dial>` transfers and callbacks) : check https://telnyx.com/pricing/elastic-sip or the account rate deck. 10DLC fees listed on the page are US-only; Canada has no 10DLC (compliance page says "Short code approval" pre-registration for Canada, and toll-free verification exists for toll-free). Budget check vs project target (<$0.033 per call-minute): inbound 0.004 + platform 0.002 + streaming 0.0035 = 0.0095/min before STT/LLM/TTS (VERIFY, may omit other per-feature fees).

## L. Common error codes

Source: https://developers.telnyx.com/docs/development/api-fundamentals/api-errors.md (also machine-readable https://developers.telnyx.com/data/api-errors.json) and https://developers.telnyx.com/docs/messaging/messages/error-codes.md.

General (code : title):
`10001` Inactive phone number; `10002` Invalid phone number; `10003` Invalid URL; `10004` Missing required parameter; `10005` Resource not found; `10006` Invalid ID; `10007` Unexpected error; `10008` Request timeout; `10009` Authentication failed; `10010` Authorization failed; `10011` Too many requests; `10012` Duplicate resource; `10013` Missing association; `10015` Bad Request; `10016` Phone number must be in +E.164 format; `10021` Resource in use; `10023` Invalid JSON; `10027` Unprocessable Entity; `10031` Invalid request filter; `10032` Invalid enumerated value; `10036` Resource is being processed; `10037` Service unavailable; `10038` Feature not permitted at this account level; `20002` API Key revoked; `20003` API Key forbidden; `20008` Invalid API Key; `20012` Account inactive (may be out of funds); `20013` Account blocked; `20014` Account unverified; `20100` Insufficient Funds.

Doc inconsistency to note: `10016` is "Phone number must be in +E.164 format" in the catalog but the idempotency 503 description in spec3 says "Service unavailable (10016)", and `10037` is "Service unavailable" in the catalog. Trust catalog; treat idempotency descriptions as UNVERIFIED.

HTTP mapping (troubleshooting page): 401 missing/invalid/revoked Bearer; 403 authenticated but not permitted (verification/provisioning/ownership); 404 wrong path/ID/other account's resource; 400 or 422 validation (read every `errors[]`); 429 throttled; 5xx retry only if safe. Fixtures: `error-401/403/404/422/429.json` (401/403/404/422 composed from catalog codes; exact live bodies UNVERIFIED).

Messaging delivery (in `message.finalized` `errors[]`): `40001` not routable (landline); `40002` blocked as spam (temporary); `40003` blocked as spam (permanent); `40004` rejected by destination; `40005` message expired; `40006` recipient unavailable (retry); `40008` undeliverable (retry); `40009` invalid body; `40011` upstream rate limit; `40012` invalid destination number; `40013` invalid source number; `40014` expired in queue; `40015` internal spam filter; `40329` toll-free not verified; `40330` toll-free not provisioned.
Messaging API-request errors: `40300` blocked (STOP) (permanent, do not retry); `40301` unsupported message type; `40305` invalid from / not on profile; `40309` invalid destination region; `40310` invalid to; `40312` profile disabled; `40314` messaging disabled; `40316` no content; `40318` queue full; `40322` blocked content; `40333` spend limit reached.
Doc inconsistency: `40010` is "Not 10DLC registered" in error-codes.md but "Message blocked (spam/content filter)" and `47000` "10DLC campaign required" on the receiving-webhooks page. 10DLC is US-only so likely irrelevant for Canada; VERIFY if ever seen.

Retry guidance from the error page: auto-retriable `40006`, `40008` (backoff); retriable after fixing rate/content `40002, 40005, 40011, 40014, 40318`; permanent `40001, 40003, 40010, 40300, 40314, 40322`.

Media-stream errors: `100002-100005` (see I.3). Call Control webhook errors: https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks.md (not researched).

---

## Could not confirm (summary)

1. Encoding of `filter[features]` array in the query string; no Canadian search response example published.
2. That a TeXML application id is accepted as `connection_id` on `PATCH /phone_numbers/{id}` (strongly implied, not stated).
3. A verbatim `<Connect><Stream>` TeXML document; TeXML-specific WebSocket frames (assumed identical to Call Control framing); where `<Parameter>` values appear in `start`; L16 support in TeXML.
4. Whether TeXML instruction-fetch requests are signed (only callbacks documented as Ed25519 signed).
5. Canadian number regulatory requirements and number-order lead time; effect of `deletion_lock_enabled`; release/billing semantics of DELETE.
6. Exact live error bodies per HTTP status (fixtures 401/403/404/422 are composed from the catalog).
7. Canadian outbound voice per-minute price; which SMS price table applies to Canadian long-code outbound (0.0025 vs 0.004); Canadian opt-out auto-response behaviour and French keywords.
8. Idempotency for number orders and deletes (none documented). The `Idempotency-Key` header is documented for `POST /messages` only.
9. Rate limits for number/order endpoints specifically (only generic guidance and header names).
