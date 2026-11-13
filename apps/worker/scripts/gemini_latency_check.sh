#!/usr/bin/env bash
# Streaming time-to-first-byte for the configured Gemini models (what a live call feels).
# Usage: bash apps/worker/scripts/gemini_latency_check.sh [runs=8]. Reads GEMINI_API_KEY from ../../.env.local; never prints it.
# https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RUNS="${1:-8}"
K=$(grep '^GEMINI_API_KEY=' "$ROOT/.env.local" | head -1 | cut -d= -f2- | tr -d "\"'")
BODY='{"contents":[{"parts":[{"text":"You are a restaurant receptionist. Caller: do you have butter chicken? Reply in one short sentence."}]}],"generationConfig":{"maxOutputTokens":512,"thinkingConfig":{"thinkingLevel":"minimal"}}}'
for MODEL in $(grep -E '^\s+model: gemini' "$ROOT/config/providers.yaml" | awk '{print $2}' | sort -u); do
  : > /tmp/gl.$$
  ERR=0
  for i in $(seq "$RUNS"); do
    OUT=$(curl -s -N -m 60 -o /dev/null -w '%{http_code} %{time_starttransfer}' -H "x-goog-api-key: $K" -H 'Content-Type: application/json' -d "$BODY" "https://generativelanguage.googleapis.com/v1beta/models/$MODEL:streamGenerateContent?alt=sse")
    CODE=${OUT%% *}; T=${OUT##* }
    if [ "$CODE" = 200 ]; then echo "$T" >> /tmp/gl.$$; else ERR=$((ERR+1)); fi
  done
  python3 - "$MODEL" "$ERR" "$RUNS" <<'PY'
import sys
m,err,runs=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
v=sorted(float(x) for x in open(f"/tmp/gl.{__import__('os').getppid()}").read().split())
if not v: print(f"{m}: no successful runs ({err}/{runs} errors)"); sys.exit()
p=lambda q: v[min(len(v)-1,int(q*len(v)))]
print(f"{m}: ok {len(v)}/{runs} errors {err} | first-byte p50 {p(.5):.2f}s p95 {p(.95):.2f}s max {v[-1]:.2f}s")
PY
done
rm -f /tmp/gl.$$
