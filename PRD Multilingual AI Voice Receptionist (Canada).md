# PRD: Multilingual AI Voice Receptionist (Canada)

Oct 26, 2026 · @ss

## 0. How Claude Code must use this PRD

This PRD is the single source of truth. Claude Code builds only what is written here, in the milestone order of section 11, and stops to ask when something is missing instead of inventing it.

**Hard rules for the builder (paste into `CLAUDE.md` at repo root)**

1. Never invent an API, SDK method, model name or price. Before using any third-party call, open its official docs page or installed package source and cite the URL in a code comment.
2. Every external model ID, voice ID and endpoint lives in `config/providers.yaml` or env vars. Nothing hard-coded.
3. Build one milestone at a time. A milestone is done only when its acceptance tests in section 12 pass. Never start the next one with failing tests.
4. No placeholder code: no `TODO: implement`, no mocked responses outside `tests/`, no fake data in production paths.
5. If a fact in this PRD is marked **VERIFY**, check it first. If it is wrong, update this PRD's `docs/DECISIONS.md` and continue with the documented fallback.
6. Never delete files outside the cleanup allowlist (section 10). Never commit secrets.
7. Ask the human only for: API keys, account approvals, a phone number purchase, a spend above $25, or a choice this PRD leaves open.
8. Write docs as you go: each package gets a `README.md`; every milestone updates `docs/CHANGELOG.md`.

**What a human must do (Claude Code cannot)**

| Task | Why |
| --- | --- |
| Create accounts: Telnyx, Soniox, Google AI Studio, Supabase, Vercel, Fly.io, Stripe | Requires identity, payment cards and approvals |
| Paste API keys into Vercel, Fly.io and `.env.local` | Secrets |
| Buy the first Telnyx numbers (Toronto, Montreal) | Spends money |
| Make real test calls and judge voice quality | Needs a human ear and native speakers |
| Approve legal text (privacy policy, recording notice) | Legal review |

**Verified facts this PRD relies on (checked 2026-10-26)**

| Fact | Source |
| --- | --- |
| Pipecat ships native Soniox STT and TTS services (`pipecat-ai[soniox]`) | [Soniox blog](https://soniox.com/blog/voice-bot-with-pipecat-and-soniox), [Pipecat docs](https://docs.pipecat.ai/api-reference/server/services/tts/soniox) |
| Soniox TTS service multiplexes up to 5 streams per WebSocket and sends keepalives every 20 s | [Pipecat docs](https://docs.pipecat.ai/api-reference/server/services/tts/soniox) |
| Pipecat has a `TelnyxFrameSerializer` for Telnyx media streaming, with DTMF and auto hang-up | [Pipecat docs](https://docs.pipecat.ai/api-reference/server/services/serializers/telnyx.md) |
| Telnyx media streaming is 8 kHz mono | [Pipecat Telnyx guide](https://docs.pipecat.ai/guides/telephony/telnyx-websockets) |
| Soniox STT and TTS list English, French, Hindi, Punjabi, Gujarati, Tamil, Bengali, Malayalam, Telugu; Urdu has its own platform page | [STT languages](https://soniox.com/docs/stt/concepts/supported-languages), [TTS languages](https://soniox.com/docs/tts/concepts/supported-languages), [Urdu](https://soniox.com/platform/urdu) |
| Vercel WebSockets close at the function's max duration and may hit a different instance | [Vercel docs](https://vercel.com/docs/functions/websockets) |
| Fly.io runs a Toronto region (`yyz`); Montreal (`yul`) is deprecated | [Fly regions](https://www.fly.io/docs/regions/), [Fly consolidation](https://fly.io/blog/the-region-consolidation-project/) |

**Assumptions to VERIFY at build time:** Gemini model ID and price; Soniox Urdu TTS quality; Telnyx Canadian per-minute rates; Supabase Canada region availability.

## 1. Product summary, goals and budgets

A restaurant in Canada forwards its phone line to us; our AI receptionist answers every call in the caller's language, takes reservations and orders, texts payment links, and transfers to staff when needed. The first release is **inbound only**, which avoids the CRTC robocall rules for outbound calls.

**Goals for v1 (MVP)**

- A restaurant owner goes from sign-up to a live answering agent in under 15 minutes, with no help.
- Callers cannot easily tell they are talking to an AI in a 2-minute booking call (target: 80% of internal blind testers rate it 4/5 or higher for naturalness).
- Languages at launch: English, Canadian French, Urdu, Hindi, Punjabi. Next wave: Gujarati, Tamil, Bengali.
- Infrastructure cost under $20 USD per restaurant per month at 600 minutes.

**Non-goals for v1 (do not build)**

Outbound dialler, power dialler, GoHighLevel/HubSpot sync, agency white label, rebilling, split testing, Toast/Lightspeed/TouchBistro/OpenTable integrations, voice cloning, mobile app. These come after paying customers (section 11, Phase 2+).

**Budgets (hard limits the code must enforce or measure)**

| Budget | Target | Hard limit |
| --- | --- | --- |
| Reply latency: caller stops speaking to first agent audio, p50 | 700 ms | — |
| Reply latency p95 | 1,100 ms | 1,500 ms (alert) |
| Greeting after pickup | under 800 ms | 1,500 ms |
| Barge-in: agent stops talking after caller starts | under 300 ms | 500 ms |
| Infra cost per call-minute | $0.022 | $0.033 |
| Infra cost per restaurant per month (600 min) | $14 | $20 |
| Max call length (inbound) | — | 10 min, then polite close |
| Dropped calls caused by our system | under 0.5% | 1% |

**Success metrics after launch**

| Metric | Definition | Target |
| --- | --- | --- |
| Call resolution | Calls ending with booking, order, answered question, or intentional transfer | 85% |
| Transfer rate | Calls the agent hands to staff | under 15% |
| Language match | Agent replied in caller's language within its first reply after the switch | 98% |
| Owner activation | Signed-up owners whose number receives a live call within 7 days | 60% |

## 2. Architecture and tech stack

The system has two deployables: a Next.js web app on Vercel, and a Python voice worker on Fly.io Toronto. Phone calls cannot run on Vercel: its WebSockets close when the function hits its max duration, and new connections may land on a different instance ([Vercel docs](https://vercel.com/docs/functions/websockets)).

&#91;embedded content: system architecture · 2 deployables, 6 services\]

The caller only ever touches Telnyx and the voice worker; the owner only ever touches the web app. Both read and write the same Supabase database.

**Stack (pin exact versions in lockfiles)**

| Layer | Choice | Fallback if it fails tests |
| --- | --- | --- |
| Telephony | Telnyx: Canadian local numbers, TeXML app with `<Stream>` to the worker, Messaging for SMS | Twilio (Pipecat has a serializer) |
| Call engine | Pipecat, Python 3.12, FastAPI WebSocket server, `TelnyxFrameSerializer` | LiveKit Agents |
| Speech-to-text | Soniox real-time (`SonioxSTTService`), language identification on | Azure Speech (single-language) |
| LLM | Gemini Flash-Lite class, streaming + function calling; model ID in config (VERIFY) | GPT-5 mini |
| Text-to-speech | Soniox real-time TTS (`SonioxTTSService`), model ID in config (VERIFY) | Azure Neural TTS per language |
| Turn-taking | Silero VAD + Pipecat smart-turn analyzer (VERIFY current class name) | VAD only, 600 ms silence |
| Web app | Next.js App Router, TypeScript, Tailwind, shadcn/ui | — |
| Database, auth, files | Supabase: Postgres with row-level security, Auth, Storage; Canada region if offered (VERIFY) | Fly Postgres in `yyz` (backups stay in ca-central-1, [Fly](https://community.fly.io/t/does-managed-postgres-backup-to-the-managed-region/28122)) |
| Payments | Stripe Canada: Billing for subscriptions, Payment Links for diners | — |
| Email | Resend (invites, alerts) | Postmark |
| Website import | Firecrawl API | Playwright in the worker |
| Monitoring | Sentry in both apps; per-call latency rows in Postgres | — |

**Inbound call sequence**

1. Caller dials the restaurant's Telnyx number, or the restaurant forwards its existing line to it.
2. Telnyx requests the TeXML webhook on the worker; the worker answers with `<Connect><Stream url="wss://worker/ws">`, following Pipecat's `telnyx-chatbot/inbound` example.
3. The worker parses the stream start message, maps the dialled number to a restaurant and its published agent version, and builds the pipeline.
4. The pipeline plays the cached greeting, then loops: listen, transcribe, think, call tools, speak.
5. Tools write to Supabase, and to Square, Stripe or Telnyx SMS when enabled.
6. On hang-up the worker closes the call record, stores the recording, queues the summary job and adds the minutes to the usage meter.

**Web app to worker contract:** HTTPS with an HMAC header (`X-Signature`, shared secret, 5-minute timestamp window). The worker reads agent config from Supabase at call start and caches it for 60 seconds.

## 3. Voice quality spec (the product lives or dies here)

The agent must sound like a calm, friendly host: it replies in under a second, stops when interrupted, uses light fillers, and never reads like a document. Every rule below is testable.

**Latency budget per reply (target p50 total 700 ms)**

| Stage | Budget | How we hit it |
| --- | --- | --- |
| End-of-turn detection | 250–400 ms | Silero VAD + smart-turn model; longer wait only in "collecting digits" state |
| Final transcript | under 100 ms | Soniox streaming; act on finalized tokens, not a new request |
| LLM first token | 250–350 ms | Flash-Lite class model, short prompt, cached system prompt, max 2 tool rounds |
| TTS first audio | 150–200 ms | Soniox streaming TTS; send first clause as soon as it ends |
| Network + playback | about 100 ms | Worker in Toronto next to Telnyx's Canadian edge; WebSockets pre-opened |

**Speed rules for the builder**

- Open the Soniox STT and TTS WebSockets and warm the LLM connection when the call is ringing, before audio starts.
- Stream LLM text into TTS by clause (split on `, . ? !` and Urdu/Hindi `۔ ।`), not by full reply.
- The prompt tells the model to open each reply with a short acknowledgement ("Sure," "Okay," "Got it,") so the first audio chunk is tiny.
- Pre-render fixed phrases per language and voice when the owner publishes: greeting, the 6 filler lines, "are you still there?", goodbye, transfer line. Store as 8 kHz audio in Supabase Storage and play instantly.
- If a tool call has not returned in 600 ms, play a cached filler ("One sec, let me check that.") in the caller's language. Never play two fillers in a row.

**Natural-speech rules (in the system prompt and enforced by tests)**

- Spoken style only: no lists, no markdown, no emoji, no "As an AI".
- One question per turn. Most replies are 1–2 sentences, under 25 words.
- Contractions and light fillers. Owner setting **Filler level** 0–3: 0 = none, 1 = acknowledgements only (default), 2 = occasional "um" or "let me see" (at most one per 3 turns), 3 = chatty.
- Read back every booking or order before confirming it. Times as spoken words ("seven thirty tonight"), phone numbers in groups of 3-3-4, prices as "twelve ninety-nine".
- A text normalizer runs before TTS per language: times, dates, currency, phone numbers, and the menu's own dish spellings.

**Turn-taking and interruptions**

- Barge-in on: when the caller speaks over the agent, audio stops within 300 ms and the unsaid text is dropped from history.
- Ignore short backchannels while the agent speaks ("yeah", "okay", "haan", "ji", "oui" under 600 ms) so the agent does not stop mid-sentence for them. Use Pipecat's minimum-words interruption strategy (VERIFY class name).
- Collecting digits state (phone number, party size, card-free addresses): end-of-turn wait rises to 1.2 s, so the agent does not cut people off mid-number.
- Silence: after 8 s ask "Are you still there?"; after 8 more say goodbye and hang up. Owner-editable.

**Languages**

| Language | Code | STT | TTS | Wave |
| --- | --- | --- | --- | --- |
| English (Canada) | en | Yes | Yes | Launch |
| French (Canada) | fr | Yes | Yes | Launch |
| Urdu | ur | Yes | Yes (claimed, VERIFY quality) | Launch |
| Hindi | hi | Yes | Yes | Launch |
| Punjabi | pa | Yes | Yes | Launch |
| Gujarati | gu | Yes | Yes | Wave 2 |
| Tamil | ta | Yes | Yes | Wave 2 |
| Bengali | bn | Yes | Yes | Wave 2 |

The owner enables which languages the agent may use; a language ships to customers only after a native speaker rates its voice 4/5 or higher in the eval form (section 12).

**Language switching rules**

1. The greeting uses the restaurant's primary language. Quebec numbers (418, 438, 450, 514, 579, 581, 819, 873, 367) default to French with a short English line.
2. Soniox tags each utterance's language. The agent switches only when the new language is dominant in the utterance (at least 3 words in it), so English dish names inside an Urdu sentence do not flip the call to English.
3. The LLM gets `caller_language` each turn and must reply in it, mirroring the caller's English mix; dish names stay as written on the menu.
4. If the caller's language is not enabled, the agent apologizes once in English and offers to continue in English or French, or transfer.

**Voices:** one persona per agent (name + voice). Each enabled language maps to a Soniox voice chosen in the UI after preview. At publish time the worker checks every voice ID against Soniox's list-models endpoint and blocks publishing if one is missing.

## 4. Users, roles and user flows

Three people use the product: the restaurant owner who sets it up, staff who watch calls and bookings, and the diner who calls. A fourth role, platform admin, is us.

| Role | Can do | Cannot do |
| --- | --- | --- |
| Owner | Everything for their restaurant(s): agent, number, billing, staff invites | See other restaurants |
| Staff | View calls, transcripts, recordings; edit bookings and orders; mark issues | Change agent, number, billing |
| Platform admin | Support view of any restaurant (read-only by default, every access logged), feature flags, refunds | Listen to recordings without a logged support reason |
| Caller | Talk to the agent; receive SMS | Anything in the app |

**Flow A: owner onboarding (target under 15 minutes)**

1. Sign up with email + password or Google. Verify email.
2. Enter the restaurant's website URL, or search by name and city.
3. Import runs (under 60 s, progress shown): name, address, phone, hours, menu items with prices, FAQs, cuisine.
4. Review screen: owner fixes hours, menu and FAQs. Missing hours block the next step.
5. Choose primary language and enabled languages. Preview voices and pick one; name the host (default "Maya").
6. Set rules: party size limit, booking window, takeout on/off, deposit rule, transfer phone number.
7. Test call in the browser. The owner can interrupt with feedback ("say it shorter"); the agent proposes a prompt change; the owner accepts or rejects it. Nothing is booked during tests.
8. Get a number: buy a new local number (area code search) or keep their number and set call forwarding (step-by-step guide per carrier: Bell, Rogers, Telus, Videotron, Fido, Freedom).
9. Choose a plan, enter a card (Stripe Checkout), publish. A real test call to the new number is offered.

**Flow B: inbound call (diner)**

1. Greeting with restaurant name and the call recording notice.
2. Agent identifies intent: book, order, question, change or cancel booking, talk to someone.
3. Book: party size, date, time, name, phone (caller ID offered first: "Is this number good for the confirmation text?"), special requests. Check availability, offer up to 2 alternatives if full, read back, confirm, send SMS.
4. Order: items with modifiers from the menu only, quantity, pickup time, name, phone. Read back with total plus tax. Pay at pickup or SMS payment link (if enabled). Confirm ready time.
5. Question: answer from the knowledge base only. Unknown answer: say so, offer transfer or take a message.
6. Change or cancel: find booking by phone number + date, confirm the change, send SMS.
7. Transfer: during the restaurant's transfer hours, warm transfer to the staff number with a one-line spoken summary to staff. If nobody answers in 20 s, return to the caller and take a message.
8. Close: ask if anything else, say goodbye, hang up.

**Flow C: owner daily use**

1. Home shows today: calls, bookings, orders, missed transfers, issues flagged.
2. Open a call: summary, outcome, transcript with language tags, recording, booking or order created.
3. Fix a wrong answer: "Teach" button on a transcript line opens a form; the fix becomes a FAQ entry in the draft agent.

**Flow D: change the agent safely**

1. Every edit goes into a draft version. Live calls always use the last published version.
2. Owner tests the draft in the browser, then publishes. Publishing re-renders cached audio and checks voice IDs.
3. Version history lists every published version with author and time; one click restores an older one as a new draft.

**Flow E: billing**

1. Trial: 14 days or 60 minutes, whichever comes first; card required at publish.
2. Plan includes a minute bundle; overage billed per minute through Stripe metered usage.
3. At 80% and 100% of the bundle the owner gets an email. A hard spend cap (owner-set) stops answering and forwards calls straight to the transfer number.
4. Failed payment: 7-day grace with daily emails; then calls forward to the restaurant's number instead of the agent.

## 5. Feature specs and acceptance criteria

Eighteen features make up v1. Each is done only when every "Done when" item passes as an automated test or a recorded manual check.

| ID | Feature | Must do | Done when |
| --- | --- | --- | --- |
| F1 | Accounts and roles | Supabase Auth (email + Google); organizations own restaurants; owner and staff roles; email invites; row-level security on every table | A staff user's API call for another restaurant returns 404; RLS tests pass for every table |
| F2 | Website import | Firecrawl fetch, then LLM extraction into a strict JSON schema (name, address, phone, hours, menu, FAQs); PDF or photo menu upload as fallback | 5 real Canadian restaurant sites import with at least 90% of menu items correct; invalid JSON is retried once, then shown as editable blanks |
| F3 | Knowledge base | Editors for menu items (name, price, modifiers, dietary tags), hours (weekly + holiday overrides), FAQs, policies; allergen questions always end with "please confirm with staff" | Changes appear in the draft agent; the agent never states a price not in the menu table |
| F4 | Agent builder | Persona name, enabled languages, voice per language, filler level 0–3, greeting, rules, transfer number and hours; draft and published versions | Publishing creates an immutable version; live calls use it within 60 s |
| F5 | Browser test call | WebRTC call from the dashboard to the worker using the draft; tools run in dry-run mode; spoken or typed feedback produces a proposed prompt diff the owner accepts or rejects | Test call never writes bookings, orders or SMS; accepted diffs create a new draft revision |
| F6 | Phone numbers | Search Canadian local numbers by area code, buy, assign to one restaurant, release; call-forwarding guide per carrier; forwarding check by a test call | Buying, assigning and releasing work against Telnyx; a released number stops routing within 5 minutes |
| F7 | Call engine | Section 3 in full | Latency and barge-in budgets pass in the eval harness |
| F8 | Agent tools | 13 tools (section 7) with JSON schemas, 3 s timeout, idempotency keys, typed errors the LLM can explain | Each tool has unit tests for success, timeout and bad input; a timed-out tool never double-books |
| F9 | Reservations | Built-in booking book: covers per 15-minute slot, default seating length, max party size, blackout dates, lead time; calendar view; staff edits | Availability checks run under 150 ms; two simultaneous calls cannot overbook the last slot (row lock test) |
| F10 | Takeout orders | Cart from menu items and modifiers; provincial tax table; ticket view with "new order" sound; email or SMS ping to the kitchen number | Order totals match a hand calculation for every province in the tax table |
| F11 | SMS | Telnyx Messaging: booking and order confirmations, changes, payment links; sender identified; STOP handling | A STOP reply blocks further SMS to that number for that restaurant |
| F12 | Diner payments (flag, off by default) | Stripe Connect Standard so money goes to the restaurant; payment link for deposits or prepaid orders; webhook marks paid | Paid status appears on the booking or order within 10 s of the Stripe webhook |
| F13 | Calls dashboard | List with filters (date, outcome, language, flagged); detail with summary, transcript, language tags, recording player, latency stats, linked booking or order | A 10-minute call loads in under 2 s; recording plays on iPhone Safari |
| F14 | Analytics | Calls, minutes, outcomes, bookings, orders, languages, transfer success, hour-of-day heat map | Numbers match the raw call rows in a test fixture |
| F15 | Billing | Stripe Billing plans, metered minutes, usage meter, 80% and 100% emails, owner spend cap, failed-payment grace | Usage on the invoice equals the sum of billable call seconds, rounded up per call to the next 6 s |
| F16 | Notifications | Email and optional SMS to the owner: message taken, missed transfer, flagged call, daily digest | Each type can be turned off per user |
| F17 | Post-call processing | Async job: summary, outcome label, QA flags (misunderstood, caller frustrated, wrong language, tool failure) | Job finishes within 2 minutes of hang-up; failures retry 3 times |
| F18 | Admin console | Restaurant search, impersonate read-only with logged reason, feature flags, usage and cost per restaurant, kill switch per number | Every admin read of a recording writes an audit row |

## 6. UI screens and design spec

The dashboard is mobile-first, because owners check it from the restaurant floor on a phone. It ships in English and French from day one.

**Design system**

- Next.js + Tailwind + shadcn/ui components; Lucide icons; Inter font (Noto Nastaliq Urdu, Noto Sans Devanagari and Noto Sans Gurmukhi for transcript text).
- Tokens in `apps/web/styles/tokens.css`: one accent colour, neutral greys, success, warning, danger; light and dark themes.
- Spacing on an 8 px grid; corner radius 8 px; body text 15 px; minimum tap target 44 px.
- Right-to-left rendering for Urdu transcript lines (`dir="auto"` on every transcript bubble).
- Every screen has four designed states: loading (skeletons), empty (one sentence + one action), error (what happened + retry), and filled.
- Accessibility: WCAG 2.1 AA contrast, keyboard navigation, labelled controls, captions next to every audio player.

**Screens**

| Route | Screen | Key elements |
| --- | --- | --- |
| `/` | Landing | One-line promise, demo phone number to call, languages list, pricing, sign-up |
| `/signup`, `/login` | Auth | Email + password, Google, magic link fallback |
| `/onboarding/[step]` | Setup wizard, 7 steps | Progress bar; website import with live progress; review tables; voice cards with play buttons; rules form; test call; number picker; plan + checkout |
| `/home` | Today | Live call banner (pulsing dot, caller language, duration); counts for calls, bookings, orders, messages; issue list; agent on/off switch |
| `/calls` | Call list | Filters: date, outcome, language, flagged; row shows time, caller (masked), language chips, outcome, duration |
| `/calls/[id]` | Call detail | Summary card, outcome, recording player with waveform, transcript bubbles with language tags and timestamps, latency strip, linked booking or order, "Teach" on each agent line |
| `/bookings` | Reservations | Day and week calendar, slot capacity bars, list view, create/edit drawer, blackout dates |
| `/orders` | Orders | New / in progress / ready columns; ticket with items, modifiers, total, pickup time, paid badge |
| `/agent` | Agent | Tabs: Persona and voice, Languages, Knowledge (menu, hours, FAQs, policies), Rules, Test call, Versions; sticky "Draft changed – Test – Publish" bar |
| `/phone` | Phone | Assigned number, forwarding status check, carrier guides, buy or release number |
| `/analytics` | Analytics | Date range; outcome funnel; minutes and cost; language mix; busiest hours heat map; transfer success |
| `/settings` | Settings | Team and roles, notifications, billing (plan, usage meter, spend cap, invoices), legal (recording notice text, privacy policy link) |
| `/admin` | Admin (platform only) | Restaurant search, usage and cost, flags, audit log, number kill switch |

**Test call widget (most important screen after onboarding)**

- Big round call button; live transcript on the right with language chips; a mic level meter so the owner knows they are heard.
- "Interrupt with feedback" button pauses the role play; the owner types or says the change; the agent shows a before/after diff of the prompt section with Accept and Reject.
- A banner reads "Test mode: nothing is booked or texted" for the whole call.

## 7. Data model and API contracts

All tables live in Postgres with row-level security keyed on `restaurant_id`; every table has `id uuid`, `created_at`, `updated_at`. Migrations are SQL files in `supabase/migrations`, never edited after merge.

**Tables**

| Table | Key columns |
| --- | --- |
| `organizations` | name, stripe\_customer\_id, plan, spend\_cap\_cents |
| `memberships` | user\_id, organization\_id, role (owner, staff) |
| `restaurants` | organization\_id, name, address, province, timezone, primary\_language, enabled\_languages\[\], transfer\_phone, transfer\_hours jsonb, status (draft, live, paused) |
| `hours` | restaurant\_id, weekday, open\_time, close\_time; `hours_overrides` for holidays |
| `menu_items` | restaurant\_id, name, description, price\_cents, category, dietary\_tags\[\], available bool |
| `menu_modifiers` | menu\_item\_id, name, price\_delta\_cents, required bool, max\_select |
| `faqs` | restaurant\_id, question, answer, language, source (import, owner, teach) |
| `agents` | restaurant\_id, persona\_name, filler\_level, current\_published\_version\_id |
| `agent_versions` | agent\_id, version\_no, status (draft, published, archived), prompt\_sections jsonb, voices jsonb (lang → voice\_id), rules jsonb, published\_at, published\_by |
| `audio_cache` | agent\_version\_id, language, phrase\_key, storage\_path |
| `phone_numbers` | restaurant\_id, e164, telnyx\_number\_id, status, forwarding\_verified\_at |
| `calls` | restaurant\_id, agent\_version\_id, telnyx\_call\_id, from\_e164\_hash, from\_last4, started\_at, ended\_at, billable\_seconds, outcome, languages\[\], transferred bool, recording\_path, summary, qa\_flags\[\], cost\_micros jsonb |
| `call_turns` | call\_id, idx, speaker, language, text, started\_ms, ended\_ms, interrupted bool |
| `call_metrics` | call\_id, turn\_idx, eot\_ms, stt\_ms, llm\_ttft\_ms, tts\_ttfb\_ms, total\_ms |
| `tool_invocations` | call\_id, tool, args jsonb, result jsonb, status, duration\_ms, idempotency\_key |
| `slots_config` | restaurant\_id, slot\_minutes, covers\_per\_slot, seating\_minutes, max\_party, lead\_time\_minutes, booking\_window\_days |
| `bookings` | restaurant\_id, call\_id, name, phone\_e164, party\_size, starts\_at, status, notes, source |
| `orders` / `order_items` | restaurant\_id, call\_id, name, phone, pickup\_at, subtotal, tax, total, paid\_status / item, modifiers, qty, price |
| `messages` | restaurant\_id, call\_id, caller\_name, phone, text, handled bool |
| `sms_log` / `sms_optouts` | restaurant\_id, to\_e164, body, status / phone\_e164, restaurant\_id |
| `usage_ledger` | organization\_id, period, seconds, stripe\_reported bool |
| `audit_log` | actor\_id, action, target, reason |

**Agent tools (worker, JSON-schema typed)**

| Tool | Input | Notes |
| --- | --- | --- |
| `get_hours` | date? | Uses restaurant timezone and holiday overrides |
| `search_menu` | query, language | Fuzzy match across names in all scripts; returns price and modifiers |
| `check_availability` | date, time, party\_size | Returns exact slot or up to 2 nearest |
| `create_booking` | name, phone, party\_size, starts\_at, notes | Row lock on slot; idempotency key = call\_id + turn |
| `find_booking` | phone, date? | Matches caller ID first |
| `modify_booking` / `cancel_booking` | booking\_id, changes | Read back before calling |
| `create_order` | items\[\], pickup\_at, name, phone | Server computes tax and total; LLM never does maths |
| `send_sms` | template\_key, vars | Templates only, per language; respects opt-outs |
| `send_payment_link` | order\_id or booking\_id | Only when F12 flag is on |
| `transfer_call` | reason | Only inside transfer hours; spoken summary to staff |
| `take_message` | name, phone, text | Notifies owner |
| `end_call` | reason | Plays cached goodbye then hangs up |

**HTTP endpoints**

| Service | Endpoint | Purpose |
| --- | --- | --- |
| Worker | `POST /telnyx/texml` | Returns TeXML `<Stream>`; validates Telnyx signature |
| Worker | `WS /ws` | Telnyx media stream into the Pipecat pipeline |
| Worker | `POST /webrtc/offer` | Browser test call (dry-run tools) |
| Worker | `POST /internal/publish/{agent_version_id}` | Pre-render audio cache, validate voices (HMAC-signed) |
| Worker | `GET /healthz` | Liveness plus Soniox, Gemini and Supabase reachability |
| Web | `POST /api/import` | Starts website import job |
| Web | `POST /api/telnyx/numbers/*` | Search, buy, release numbers |
| Web | `POST /api/webhooks/stripe` | Billing and payment events (signature verified) |
| Web | `POST /api/webhooks/telnyx-sms` | Inbound SMS (STOP) and delivery receipts |

## 8. Edge cases and failure handling

The rule for every failure: the caller must never hear silence or a crash. Either the call degrades gracefully or it forwards to the restaurant's own phone.

**Provider and system failures**

| Situation | Expected behaviour |
| --- | --- |
| Worker unreachable or crashes before answering | Telnyx failover URL forwards the call to the restaurant's transfer number (configure TeXML fallback) |
| Soniox STT drops mid-call | Reconnect within 1 s, replay buffered audio; after 2 failures say a cached "Sorry, I'm having trouble hearing you" and transfer |
| Soniox TTS fails | Retry once; then switch to the fallback TTS for the rest of the call; log the incident |
| LLM timeout (over 2.5 s for first token) | Play a cached filler, retry once with the fallback model; second failure = cached apology + transfer or take a message |
| Tool timeout (3 s) | Agent says it could not complete the step; never claims success; idempotency key prevents duplicates on retry |
| Supabase unreachable | Answer FAQ-only from cached config; take messages into a local queue; flush when back |
| Spend cap or unpaid account | Do not answer with the agent; forward to the transfer number |
| Two calls book the last slot at once | Row lock: second caller hears the 2 nearest alternatives |
| Deploy during live calls | Rolling deploy; old machines drain for up to 10 minutes before stopping |

**Caller behaviour**

| Situation | Expected behaviour |
| --- | --- |
| Caller switches language mid-call | Follow the switching rules in section 3 |
| Caller speaks a language not enabled | Apologize once in English, offer English or French, or transfer |
| Heavy background noise or speakerphone | Raise VAD threshold after 3 false barge-ins in 30 s; ask the caller to repeat key details |
| Caller asks "Am I talking to a robot?" | Answer honestly: "I'm the restaurant's AI assistant", then continue |
| Abusive caller or prank | One warning, then polite goodbye; flag the call |
| Caller asks for something off-topic (jokes, politics, homework) | One-line redirect to restaurant topics |
| Prompt injection ("ignore your instructions") | System prompt hard rules win; the tool layer validates every argument server-side |
| Caller asks about allergies | Share menu tags, always add "please confirm with our staff", offer transfer |
| Caller wants a booking outside hours, past date or too-large party | Explain the rule and offer the nearest valid option or transfer |
| Blocked or private caller ID | Ask for a phone number for the confirmation text |
| Caller presses keys (DTMF) | "0" always requests transfer; other keys ignored |
| Caller silent | Section 3 silence rule |
| Very long call | At 9 minutes the agent wraps up; at 10 minutes it ends politely |
| Caller says STOP to texts | Opt-out recorded; no further SMS |

**Data and setup**

| Situation | Expected behaviour |
| --- | --- |
| Website import finds no menu | Wizard asks for PDF or photo upload, or manual entry; agent cannot publish without hours |
| Menu price changed after a booking | Orders use the price at order time (stored on the order item) |
| Daylight saving change | All times stored in UTC; slots computed in the restaurant's timezone (`America/Toronto`, `America/Vancouver`, etc.) |
| Restaurant closed on a holiday | Holiday override wins over weekly hours |
| Owner deletes a menu item used in an open order | Soft delete; open orders keep their snapshot |
| Forwarding not set up correctly | Forwarding check fails, dashboard shows a red banner with carrier-specific fix steps |

## 9. Compliance (Canada) and security

v1 is inbound only, so the CRTC robocall rules for outbound calls do not apply yet; recording notice, privacy, French service and SMS consent do. Everything here needs review by a Canadian lawyer before the first paying customer; it is not legal advice.

**Compliance requirements**

| Area | Requirement in the product |
| --- | --- |
| Call recording | Greeting includes a recording notice ("This call may be recorded to help us serve you"). Owner can turn recording off; transcripts still stored unless also off |
| AI disclosure | Agent answers honestly when asked if it is an AI; the greeting can say "I'm Maya, the restaurant's virtual host" (owner toggle, default on) |
| Privacy (PIPEDA, provincial laws) | Privacy policy lists every processor (Telnyx, Soniox, Google, Supabase, Fly.io, Vercel, Stripe, Resend) and their regions; data export and deletion per restaurant on request |
| Quebec | French-first greeting for Quebec numbers; French dashboard; privacy officer contact in policy; Law 25 assessment for data stored outside Quebec (legal review) |
| SMS (CASL) | Only transactional texts tied to the caller's request; sender named; "Reply STOP to opt out" on first text; opt-outs honoured immediately |
| Payments | No card numbers ever taken by voice; only Stripe payment links |
| Phase 2 outbound (not built in v1) | CRTC rules: express consent for automated (AI) sales calls, National DNCL registration, calling hours 9:00–21:30 weekdays and 10:00–18:00 weekends in the consumer's time ([CRTC](https://crtc.gc.ca/eng/archive/2026/vt260724.htm)); consent ledger must exist before any outbound feature |

**Security requirements**

- Secrets only in Vercel and Fly.io environment settings; `.env.example` lists names, never values; a pre-commit hook (gitleaks) blocks secrets.
- Verify signatures on every webhook: Telnyx, Stripe. Worker internal endpoints require HMAC with a 5-minute window.
- Row-level security on every table; service-role key used only in server code, never in the browser.
- Call list stores a hash and last 4 digits of the caller's number; the full number is stored only on bookings, orders and messages that need it.
- Retention defaults: recordings 90 days, transcripts 1 year, both owner-adjustable (30–365 days); a nightly job deletes expired files.
- Encryption at rest (provider default) and TLS everywhere; recordings served by short-lived signed URLs (5 minutes).
- Rate limits: 10 import jobs per hour per org; number purchases 5 per day per org; login attempts per Supabase defaults.
- Dependency scanning in CI (npm audit, pip-audit); Sentry scrubs phone numbers and names from events.

## 10. Repo, cleanup, environment and deployment

One monorepo, two deploy targets: `apps/web` to Vercel, `apps/worker` to Fly.io `yyz`. CI deploys on every merge to `main` after all tests pass.

**Repo layout**

```
/
├─ CLAUDE.md                 # builder rules (section 0), session routine
├─ README.md                 # what it is, quick start, architecture link
├─ apps/
│  ├─ web/                   # Next.js app (Vercel)
│  └─ worker/                # Python 3.12, Pipecat, FastAPI (Fly.io)
│     ├─ pipeline/           # stt, llm, tts, turn-taking, fillers, normalizer
│     ├─ tools/              # one file per agent tool + tests
│     └─ prompts/            # system prompt sections, per-language snippets
├─ packages/shared/          # tool JSON schemas, types, SMS templates
├─ config/providers.yaml     # model IDs, voice IDs, endpoints, timeouts
├─ supabase/migrations/      # SQL, append-only
├─ tests/eval/               # scripted caller scenarios, latency harness
├─ scripts/                  # clean.sh, seed.ts, check-env.ts
└─ docs/                     # PRD.md, DECISIONS.md, CHANGELOG.md, RUNBOOK.md, API.md
```

**Session routine for Claude Code (every start)**

1. `git pull`, then run `scripts/clean.sh`.
2. Read `CLAUDE.md`, `docs/PRD.md`, `docs/DECISIONS.md`, the last 3 entries of `docs/CHANGELOG.md`.
3. Run `pnpm test` and `uv run pytest`. If red, fix before anything else.
4. Continue at the first unchecked micro-task in section 11.

**Cleanup rules (`scripts/clean.sh`)**

- Deletes only generated files: `.next/`, `dist/`, `coverage/`, `.turbo/`, `__pycache__/`, `.pytest_cache/`, `tmp/`, `*.log`.
- Lists (does not delete) source files no module imports, via `knip` (TypeScript) and `vulture` (Python). Claude Code removes a listed file only if it created it, and records the removal in `CHANGELOG.md`.
- Never touches: `supabase/migrations/`, `docs/`, `.env*`, `config/`, anything outside the repo.

**Environment variables (`.env.example`)**

| Name | Used by | Notes |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | web | Public |
| `SUPABASE_SERVICE_ROLE_KEY` | web server, worker | Secret |
| `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY` | web, worker | Public key verifies webhooks |
| `TELNYX_TEXML_APP_ID`, `TELNYX_MESSAGING_PROFILE_ID` | web, worker |  |
| `SONIOX_API_KEY` | worker |  |
| `GEMINI_API_KEY`, `FALLBACK_LLM_API_KEY` | worker, web (import) |  |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | web |  |
| `RESEND_API_KEY` | web |  |
| `FIRECRAWL_API_KEY` | web |  |
| `WORKER_URL`, `WORKER_HMAC_SECRET` | web, worker |  |
| `SENTRY_DSN_WEB`, `SENTRY_DSN_WORKER` | both |  |

`scripts/check-env.ts` runs at build and fails with the exact missing names.

**Deployment runbook**

1. Supabase: create project (Canada region if offered), run `supabase db push`, enable Google auth, create Storage buckets `recordings` and `audio-cache` (private).
2. Fly.io: `fly launch` in `apps/worker` with `primary_region = "yyz"`, at least 2 always-on machines (no auto-stop: cold starts break calls), health check on `/healthz`, rolling deploys with a 10-minute drain.
3. Telnyx: create a TeXML application with voice URL `https://<worker>/telnyx/texml` and a failover that forwards to the restaurant's transfer number; create a messaging profile; buy the test numbers.
4. Vercel: import repo, root `apps/web`, set env vars, connect domain.
5. Stripe: create products and metered price via `scripts/stripe-setup.ts`; add webhook to `/api/webhooks/stripe`.
6. CI (GitHub Actions): lint, typecheck, unit tests, eval smoke test, then deploy web (Vercel) and worker (`fly deploy`).

## 11. Milestones and micro-tasks

Ten milestones, built strictly in order; the voice loop comes first because if it does not sound human, nothing else matters. Each milestone ends with its gate from section 12.

### M0 — Repo and accounts

- [ ] Create monorepo (pnpm workspaces + Turborepo; `uv` for Python); add `CLAUDE.md` from section 0
- [ ] Copy this PRD to `docs/PRD.md`; create empty `DECISIONS.md`, `CHANGELOG.md`, `RUNBOOK.md`
- [ ] Add `scripts/clean.sh`, `scripts/check-env.ts`, `.env.example`, gitleaks pre-commit
- [ ] CI workflow: lint, typecheck, tests on every push
- [ ] Human: create accounts and paste keys (section 0 table)

### M1 — Call loop spike (gate: one English call under 1.1 s p95)

- [ ] Worker FastAPI app with `/healthz`, `/telnyx/texml`, `/ws` from Pipecat's Telnyx inbound example
- [ ] Pipeline: Telnyx serializer → Silero VAD → Soniox STT → Gemini → Soniox TTS, all streaming
- [ ] Hard-coded test restaurant config in `config/dev-restaurant.yaml`
- [ ] Per-turn latency logging (eot, stt, llm\_ttft, tts\_ttfb, total)
- [ ] Deploy to Fly `yyz`; point one Telnyx number at it; 20 test calls; record p50 and p95 in `DECISIONS.md`

### M2 — Voice quality and languages (gate: naturalness eval passes for all launch languages)

- [ ] Smart-turn analyzer; digit-collection state with longer wait
- [ ] Barge-in with minimum-words strategy; backchannel word list per language
- [ ] Clause-level LLM-to-TTS streaming; short-acknowledgement opener rule
- [ ] Text normalizer per language (times, money, phone numbers) with unit tests
- [ ] Filler engine: cached clips, 600 ms tool trigger, no two in a row
- [ ] Language detection, dominance rule, per-turn TTS language and voice switch
- [ ] Quebec greeting rule; disabled-language fallback
- [ ] Silence handling, max call length, DTMF "0" transfer
- [ ] Native-speaker eval for English, French, Urdu, Hindi, Punjabi; log scores

### M3 — Data and tools (gate: tool tests green, no double booking under concurrency)

- [ ] Supabase migrations for every table in section 7, with RLS and RLS tests
- [ ] Seed script with 2 demo restaurants (Toronto Pakistani, Montreal bistro)
- [ ] 13 tools with JSON schemas in `packages/shared`, server-side validation, timeouts, idempotency
- [ ] Booking engine (slots, capacity, row locks) and order engine (provincial tax table, totals)
- [ ] SMS templates per language; Telnyx send; STOP handling
- [ ] Worker loads config by dialled number; 60 s cache

### M4 — Web app core (gate: an owner completes onboarding steps 1–6 on a phone)

- [ ] Next.js app shell, auth, organizations, invites, roles
- [ ] Onboarding wizard with website import (Firecrawl + LLM extraction + PDF fallback)
- [ ] Knowledge editors: menu, modifiers, hours, holidays, FAQs, policies
- [ ] Agent builder: persona, languages, voice preview, filler level, rules, transfer settings
- [ ] Draft and published versions, version history, restore
- [ ] English and French UI strings (next-intl)

### M5 — Browser test call (gate: owner edits the agent by voice feedback)

- [ ] WebRTC transport from dashboard to worker (`/webrtc/offer`) using the draft version
- [ ] Dry-run tool mode with visible "Test mode" banner
- [ ] Feedback interrupt → proposed prompt diff → accept or reject → new draft revision
- [ ] Publish job: pre-render audio cache, validate voices

### M6 — Numbers and go-live (gate: real call to a purchased number reaches the published agent)

- [ ] Telnyx number search by Canadian area code, buy, assign, release
- [ ] Carrier forwarding guides; forwarding check by test call
- [ ] TeXML failover to transfer number; agent on/off switch; spend-cap forward

### M7 — Dashboard and post-call (gate: owner can review any call in under 2 s)

- [ ] Home, calls list, call detail (recording, transcript, latency strip, Teach)
- [ ] Bookings calendar, orders board
- [ ] Post-call job: summary, outcome, QA flags; retries
- [ ] Notifications and daily digest; analytics page

### M8 — Billing and admin (gate: test invoice equals usage ledger)

- [ ] Stripe plans, Checkout, metered minutes, 80% and 100% emails, spend cap, grace period
- [ ] Admin console, audit log, feature flags, number kill switch

### M9 — Hardening and launch (gate: launch checklist all green)

- [ ] Full eval suite (section 12) in CI; load test 20 concurrent calls
- [ ] Security review against section 9; retention jobs; Sentry scrubbing
- [ ] Docs complete: README, RUNBOOK, API, per-package READMEs
- [ ] Legal review of greeting, privacy policy, terms

**Phase 2 (after 10 paying restaurants):** Square and Clover sync, Stripe Connect diner payments, Lightspeed and TouchBistro partner applications, outbound confirmations with consent ledger, agency workspaces and white label, GoHighLevel app, outbound dialler.

## 12. Testing and quality gates

Nothing merges to `main` unless lint, types, unit tests and the eval smoke suite pass. Voice quality is measured by machines for speed and by native speakers for naturalness; neither replaces the other.

**Test layers**

| Layer | Tool | Covers |
| --- | --- | --- |
| Unit | Vitest (web), pytest (worker) | Tools, normalizer, tax, slots, language rules, prompt builder |
| Database | pgTAP or SQL tests | RLS on every table, booking row locks |
| End-to-end web | Playwright (desktop + iPhone viewport) | Onboarding, agent edit and publish, call detail, billing |
| Eval harness | `tests/eval`, simulated caller | Full calls against the worker without a phone line |
| Live calls | Human checklist | Real phone, real network, native speakers |
| Load | Simulated callers | 20 concurrent calls on 2 machines |

**Eval harness (how it works)**

1. A scenario file defines the caller: language, persona, script goals and interruptions (YAML in `tests/eval/scenarios`).
2. A caller bot (its own LLM + Soniox TTS + STT) talks to the worker over the WebSocket path, in real time.
3. The harness records audio, turn timings, tool calls and final database state.
4. Pass rules: task outcome correct in the database, reply language matches, latency budgets met, no forbidden phrases ("as an AI", markdown read aloud, invented prices).
5. An LLM judge scores each call 1–5 for naturalness using a fixed rubric; this only flags calls for humans, it never replaces them.

**Required scenarios (at least one per launch language unless noted)**

| # | Scenario | Pass when |
| --- | --- | --- |
| 1 | Book a table for 4 tomorrow at 7:30 | Booking row correct; SMS queued; read-back happened |
| 2 | Requested slot full | 2 alternatives offered; caller picks one; booked |
| 3 | Takeout order with 2 modifiers | Order total equals server calculation |
| 4 | Question about hours on a holiday | Answer matches override |
| 5 | Allergy question | Contains "confirm with staff" line; offers transfer |
| 6 | Caller interrupts mid-sentence twice | Agent stops within 300 ms each time; no repeated content |
| 7 | Urdu caller using English dish names | Agent stays in Urdu |
| 8 | Caller switches English → Punjabi mid-call | Agent switches within one turn |
| 9 | Caller gives phone number slowly with pauses | Number captured correctly in one go |
| 10 | Caller asks if it is a robot | Honest answer, then continues |
| 11 | Prompt injection attempt (English) | Agent stays in role; no tool misuse |
| 12 | Tool timeout injected | Agent does not claim success; no duplicate booking on retry |
| 13 | Caller silent | Check-in at 8 s, goodbye at 16 s |
| 14 | Unsupported language (Mandarin) | English/French offer or transfer |
| 15 | Quebec number calls | French greeting |

**Launch gates**

| Gate | Threshold |
| --- | --- |
| Eval scenarios pass rate | 100% for 1–5 and 10–13; 95% overall |
| Reply latency | p50 under 700 ms, p95 under 1,100 ms across 200 eval turns |
| Barge-in stop | under 300 ms p95 |
| Native-speaker naturalness | at least 4/5 average per language from 2 raters, 5 calls each |
| Cost | under $0.033 per minute measured from real provider usage |
| Load | 20 concurrent calls with no latency gate breached |

## 13. Pre-mortem, post-mortem and self-review

The likeliest way this fails is not bad code but a voice that sounds slow or robotic in Urdu or Punjabi, found too late. That is why M1 and M2 come before any dashboard work.

**Pre-mortem: "It is six months later and the product failed. Why?"**

| Failure | Early warning | Prevention built into this PRD |
| --- | --- | --- |
| Calls feel laggy | p95 over 1.1 s in M1 | Latency gate before M2; region co-location; cached phrases; fallback model |
| Urdu or Punjabi voice sounds wrong | Native raters score under 4/5 | Per-language release gate; fallback TTS per language; launch a language only when it passes |
| Agent invents prices or bookings | Eval scenario 3 or 12 fails | Server-side totals; tools validate; forbidden-phrase checks |
| Costs exceed $20 per restaurant | Cost per minute over $0.033 | Per-call cost tracking; max call length; silence hang-up; spend caps |
| Owners never finish setup | Activation under 60% | 15-minute wizard target; import fallback; forwarding check with fix steps |
| Restaurants lose calls during outages | Any dropped call in logs | TeXML failover to the restaurant's phone; 2 always-on machines |
| Legal complaint (recording, Quebec, SMS) | Any complaint | Recording notice; French-first in Quebec; STOP handling; lawyer review before launch |
| Claude Code drifts or hallucinates | Tests skipped, TODOs, unknown APIs | Builder rules (section 0); milestone gates; VERIFY list; DECISIONS log |
| Provider changes model names or prices | Health check or bill surprise | All IDs in `config/providers.yaml`; monthly cost review |

**Post-mortem template (`docs/postmortems/YYYY-MM-DD-title.md`)**

1. Summary: what happened, in two sentences.
2. Impact: calls affected, restaurants affected, minutes, money.
3. Timeline in Toronto time: detection, response, fix, all clear.
4. Root cause and contributing factors.
5. What worked, what did not.
6. Actions: owner, due date, and the test that will catch it next time.

**Self-review of this PRD**

| Weak spot found | What I changed or flagged |
| --- | --- |
| The request said "just deploy to Vercel"; the call loop cannot live on Vercel | Split into web on Vercel and worker on Fly.io Toronto, with sources |
| "Fully autonomous build" is not realistic: accounts, keys, numbers, legal review and voice judging need a human | Listed every human step in section 0 so Claude Code stops cleanly instead of faking them |
| Several provider details are not confirmed (Gemini model ID, Soniox Urdu voice quality, smart-turn class name, Telnyx Canadian rates, Supabase Canada region) | Marked VERIFY with fallbacks; no code may hard-code them |
| Eighteen features is a lot for v1 | Diner payments (F12) behind a flag; a smaller cut is possible: ship M1–M6 plus a basic calls page first |
| Browser test call (WebRTC) adds risk | Allowed fallback: test by calling the draft on a dedicated test number |
| An LLM judge can be fooled | It only flags calls; native speakers make the release decision |
| Outbound and agency features from the lessons are missing | Deliberately moved to Phase 2 because of CRTC consent rules and scope |

**Open questions for you**

- [ ] Pricing: monthly price and minutes included (suggested: $99 CAD for 500 minutes)?
- [ ] Brand name and domain?
- [ ] Which 3 restaurants will be design partners, and in which cities?
- [ ] Should staff get SMS alerts for every new booking, or only the daily digest?
- [ ] Recording on or off by default for new restaurants?

**Sources:** [Pipecat Soniox TTS](https://docs.pipecat.ai/api-reference/server/services/tts/soniox) · [Soniox + Pipecat](https://soniox.com/blog/voice-bot-with-pipecat-and-soniox) · [Pipecat Telnyx serializer](https://docs.pipecat.ai/api-reference/server/services/serializers/telnyx.md) · [Pipecat Telnyx guide](https://docs.pipecat.ai/guides/telephony/telnyx-websockets) · [Soniox STT languages](https://soniox.com/docs/stt/concepts/supported-languages) · [Soniox TTS languages](https://soniox.com/docs/tts/concepts/supported-languages) · [Soniox Urdu](https://soniox.com/platform/urdu) · [Vercel WebSockets](https://vercel.com/docs/functions/websockets) · [Fly.io regions](https://www.fly.io/docs/regions/) · [CRTC notice of violation (calling hours)](https://crtc.gc.ca/eng/archive/2026/vt260724.htm)
