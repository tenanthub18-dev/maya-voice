# Voice worker

Existing Pipecat/Soniox/OpenAI pipeline; provider identifiers and USD estimate
rates are configured in `../../config/providers.yaml`. Run `uv run pytest` here.

Browser calls persist final conversation text, latency and provider usage in
Supabase without recording audio or billing practice calls. Browser business
tools remain dry-run. See `../../docs/BROWSER-DEMO.md` for operating the Mac
worker, warming a short greeting, temporary tunnels and verified limitations.
Keep secrets only in private environment/runtime files; never export the local
database administrator key to the web host.

Voice replies use the compact conversation policy in pipeline/prompt.py. Required
readbacks remain complete; English price speech keeps exact amounts with fewer
words. The native OpenAI client now closes on per-call teardown, even when processor
cleanup fails. No transport/dependency change or shared caller context is added. See ../../docs/QUALITY-CHECKS-2026-11-13.md for measured limits and checks.
