# maya-voice

A multilingual AI voice receptionist for Canadian restaurants, with an existing
Next.js dashboard and browser voice demo. The current language configuration
covers seven base languages: English, Canadian French, Urdu, Hindi, Punjabi,
Telugu and Arabic, plus the Indian English (`en-IN`) variant. Human approval of
pronunciation and conversational quality remains open for every language.

## Current architecture and demo

| Component | Current role |
| --- | --- |
| `apps/web` | Next.js dashboard, Supabase authentication/RLS, `/demo` browser calls and `/calls` history/detail UI |
| `apps/worker` | Python Pipecat worker with Soniox speech recognition/synthesis and OpenAI in-call responses |
| `supabase` | Database migrations, restaurant data, call transcripts and usage records |
| `config/providers.yaml` | Provider/model/voice configuration and approximate USD estimate rates |

The browser demo uses the existing UI, a Vercel web entry, and the existing Mac
worker and local Supabase through temporary tunnels. The Mac, local services,
internet connection and managed launcher must stay running; tunnel addresses
can change on restart. Telnyx, a phone-number purchase and Fly.io are not required
for browser calls. Follow the [browser demo runbook](docs/BROWSER-DEMO.md) for
setup and recovery.

Browser calls are practice-only for business operations: bookings, orders and
SMS are not saved or sent. Call transcripts, actual duration, latency and
provider usage are persisted for review; audio is not recorded. The Calls UI
shows reported input/output/cached LLM tokens and partial **USD cost estimates**.
Missing usage stays unavailable. These estimates are not invoices, and browser
practice calls are excluded from customer billing and admin revenue usage.

Native-speaker listening, physical-device/mobile-network quality and consistent
responses below one second remain unverified. Short synthetic checks do not
establish the PRD latency percentiles or close the launch gates. See the
[current quality checks and limits](docs/QUALITY-CHECKS-2026-11-12.md).

## Quick start

Use pnpm **10.33.4** (the installed and package-pinned version), Python **3.12**
(the worker's pinned version), and uv. Node.js **24** is recommended to match CI;
the web package declares a minimum of 20.19.0.

Install dependencies and run the local checks from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test

cd apps/worker
uv sync --frozen
uv run pytest -q
```

For dashboard development, run `pnpm --filter @voice-receptionist/web dev` from
the repository root. Configure your own environment using [.env.example](.env.example);
dependency installation alone does not connect a live voice session. Keep
credentials and runtime configuration in private environment files.

## Documentation

- [Web setup and checks](apps/web/README.md) and [worker setup](apps/worker/README.md)
- [Browser demo operations](docs/BROWSER-DEMO.md) and [quality checks](docs/QUALITY-CHECKS-2026-11-12.md)
- [Repeatable voice scenarios](scripts/dev/voice-test/README.md) (offline planning; cached opt-in live replay)
- [Automated gates and their limits](docs/GATES.md)
- [Web data ownership](docs/ARCHITECTURE.md)
- [Deployment runbook](docs/RUNBOOK.md) and [phone testing](docs/PHONE-TEST.md)
- [Product requirements and milestone plan](./PRD%20Multilingual%20AI%20Voice%20Receptionist%20%28Canada%29.md)
