# Voice test tools (local only)

Scripted, silent test calls plus a phone test page. Nothing here is production code.

1. `set -a; source ../../../.env.local; set +a` then `./gen_clips.sh` (makes caller clips in ./clips, needs SONIOX_API_KEY).
2. `CLIPS=en,fr,hi,pa,ur,te,en,fr,hi,pa,ur,te ./run_variant.sh NAME [ENV=VAL ...]` restarts the worker with the overrides, places one
   silent WebRTC call, and prints caller-side `first_sound` / `second_burst` (answer start) p50/p95 plus worker per-stage latency.
   Env overrides: VOICE_LLM_MODEL, VOICE_LLM_REASONING, SPEECH_TIMEOUT_SECS, VAD_STOP_SECS, TTS_AGGREGATION, TURN_DETECTION,
   ACK_CLIPS=1, VOICE_MODE=realtime (+ REALTIME_MODEL, REALTIME_VAD=server, REALTIME_SILENCE_MS, REALTIME_REASONING).
3. Phone test: `node harness.mjs` (port 3100) then `cloudflared tunnel --url http://localhost:3100`; open the printed https link on a phone
   on the same Wi-Fi (no working TURN relay yet, mobile data will fail).

Needs the local Supabase seed (restaurant and agent-version ids in call_client.py/harness.mjs) and a running `supabase start`.
Caller-side numbers include about 0.3 s of harness delay versus the worker's own latency log.

## Fixed English quality scenarios

`quality_scenarios.py` adds repeatable synthetic practice calls only. It does not
change the prompt, UI, provider configuration, or restaurant. Run from repo root
with the existing worker virtualenv:

```sh
apps/worker/.venv/bin/python scripts/dev/voice-test/quality_scenarios.py --list
apps/worker/.venv/bin/python scripts/dev/voice-test/quality_scenarios.py --plan order-correction
apps/worker/.venv/bin/python scripts/dev/voice-test/quality_scenarios.py --plan menu-recommendation
```

List/plan never load runtime credentials, start subprocesses, or use the network.
The fixed scripts and manual rubric live in
`apps/web/tests/fixtures/voice-quality-scenarios.json`:

| ID | Manual review focus |
| --- | --- |
| `order-correction` | Two Butter Chicken + one Garlic Naan today → three Butter Chicken, no onions, one Garlic Naan tomorrow at 7 PM; explicit readback; no consent, success or SMS claim; cancel practice. |
| `menu-recommendation` | One vegetarian + one chicken recommendation with prices → both vegetarian under $17 each; concise reasons, accurate prices; unknown nut-free certification; no order wanted. |

Prices are CAD menu references from the existing sourced
`config/pilots/barbq-tonite-dixie.json`, not quotes of tax-inclusive totals.
Vegetarian suggestions do not establish allergy safety or certification.

Preparation and calls use billed AI **only when explicitly requested**. Use the
existing pilot runtime at `tmp/phone-test/runtime.json`, mode `0600`, and the pilot
local stack described in `scripts/dev/phone-test/README.md`. The runtime argument
must point to that file because the existing history checker uses it too.
Preparation obtains the environment through `phone-test/local.py`; it uses only
`greeting.endpoint`, `greeting.sample_rate`, `tts.model`, `tts.voice` from
`config/providers.yaml` and the existing `SONIOX_API_KEY`.

```sh
# Opt-in only; not part of offline verification. Repeat for the other scenario ID.
apps/worker/.venv/bin/python scripts/dev/voice-test/quality_scenarios.py \
  --prepare order-correction --allow-ai --runtime tmp/phone-test/runtime.json
apps/worker/.venv/bin/python scripts/dev/voice-test/quality_scenarios.py \
  --run order-correction --allow-ai --runtime tmp/phone-test/runtime.json \
  --base-url http://localhost:3101 --report quality-order-correction.json
```

Prepare makes sequential mono 16 kHz signed PCM16 requests, bounded to 16 seconds
per utterance, with bounded response bytes, HTTP timeouts and one bounded retry
only for HTTP 429. It writes standard WAV files, mode `0600`, under the existing
ignored `tmp/phone-test/quality-fixtures/`. Clip keys hash text/model/voice/language/
sample rate; the combined fixture also hashes timing. Cache hits make no TTS call.
Eight seconds lead-in and twelve-second pauses (including the final response
window) keep each four-turn script at or below 120 seconds. Run uses the prepared
WAV's actual duration and never regenerates missing, stale-identity or invalid
fixtures. Config or script changes require explicit preparation again.

Run invokes the existing `call-history-check.mjs` using a subprocess argument
list and `CALL_QA_SCENARIO`/`CALL_QA_REPORT`. It retains usage/cost, isolation,
mobile layout, hangup and latency checks. Correlation requires the scenario's
distinctive phrase in a **caller** turn of a new browser call. Missing matches
fail; multiple matches fail rather than selecting another tester's newest call.
Do not run the same scenario concurrently on the shared pilot: fixed anchors
cannot distinguish two simultaneous runs of the same script.

The report in `tmp/phone-test/quality-*.json` contains only the matched call's
synthetic transcript and manual checkpoints with status **pending**. Transcript
text is not printed. Actual persisted duration and existing usage/cost estimates
are retained; no semantic pass or native voice quality pass is inferred, and no
LLM judge runs. A human must listen, check the readback/recommendations/allergy
uncertainty, and review the private report. Root still owns live preparation,
provider calls, latency/cost assessment and human voice-quality checks.

Offline tests:

```sh
apps/worker/.venv/bin/python -m pytest apps/worker/tests/test_quality_scenarios.py -q
```
