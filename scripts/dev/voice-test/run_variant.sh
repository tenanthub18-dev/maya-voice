#!/bin/bash
# usage: CLIPS=en,fr,hi,... ./run_variant.sh NAME [ENV=VAL ...]
# Restarts the worker with the env overrides, places one scripted silent call, prints caller-side results and the
# worker's per-stage p50/p95. Outputs go to ./out (git-ignored). Run from anywhere; needs ./clips (gen_clips.sh).
NAME=$1; shift
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; OUT="$HERE/out"; mkdir -p "$OUT"
pkill -f "uvicorn voice_receptionist_worker"; sleep 1
cd "$ROOT" && set -a && source .env.local && set +a
unset TURN_DETECTION TTS_AGGREGATION SPEECH_TIMEOUT_SECS VAD_STOP_SECS ACK_CLIPS VOICE_MODE VOICE_LLM_MODEL VOICE_LLM_REASONING
for kv in "$@"; do export "$kv"; done
export LATENCY_JSONL_PATH="$OUT/lat_$NAME.jsonl"; rm -f "$LATENCY_JSONL_PATH"
(cd apps/worker && PYTHONPATH=src nohup uv run uvicorn voice_receptionist_worker.main:app --host 0.0.0.0 --port 8080 > "$OUT/w_$NAME.log" 2>&1 &)
for i in $(seq 1 30); do curl -s -o /dev/null localhost:8080/healthz && break; sleep 1; done
(cd "$HERE" && uv run --project "$ROOT/apps/worker" python call_client.py "${CLIPS:-en,fr,hi,pa,ur,te,en2}" 8 > "$OUT/client_$NAME.log" 2>&1)
echo "== $NAME ($*)"; grep RESULT "$OUT/client_$NAME.log"
(cd "$ROOT/apps/worker" && uv run python scripts/latency_report.py "$OUT/lat_$NAME.jsonl" 2>/dev/null | head -9)
echo "errors: $(grep -c 'ERROR\|pipeline failed' "$OUT/w_$NAME.log")"
