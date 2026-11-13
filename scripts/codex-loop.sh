#!/usr/bin/env bash
# Runs queued micro-task briefs through Codex, verifies each, retries with failure output, logs to comms/MASTER.md.
# Brief format: markdown; a line "VERIFY: <shell command>" is the acceptance check (must exit 0).
# Usage: scripts/codex-loop.sh [max_retries=2]   (processes tasks/queue/*.md in name order; stops on first failure)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
MAX_RETRIES="${1:-2}"
LOG="comms/MASTER.md"
log() { printf -- '- %s | %s | %s\n' "$(TZ=America/Toronto date '+%Y-%m-%d %H:%M %Z')" "$1" "$2" >> "$LOG"; }
run_codex() { arch -arm64 codex exec --skip-git-repo-check --sandbox workspace-write -C "$ROOT" "$1" > "tmp/codex-last.txt" 2>&1; }

for brief in tasks/queue/*.md; do
  [ -e "$brief" ] || { echo "queue empty"; exit 0; }
  name="$(basename "$brief" .md)"
  verify="$(grep -m1 '^VERIFY:' "$brief" | sed 's/^VERIFY:[[:space:]]*//')"
  [ -n "$verify" ] || { log "loop" "$name SKIPPED: no VERIFY line"; echo "no VERIFY in $brief"; exit 2; }
  prompt="$(cat "$brief")
RULES: follow CLAUDE.md builder rules; touch only files this brief names; no TODO/placeholder code; cite doc URLs for third-party APIs; do not commit; do not read or write .env files."
  attempt=0; ok=0
  while [ "$attempt" -le "$MAX_RETRIES" ]; do
    echo ">>> $name attempt $attempt"
    run_codex "$prompt"
    # Codex sandbox has no network: install deps outside it before verifying.
    arch -arm64 pnpm install --prefer-offline >> tmp/install.log 2>&1 || true
    if out="$(bash -c "$verify" 2>&1)"; then ok=1; break; fi
    attempt=$((attempt+1))
    prompt="$prompt

PREVIOUS ATTEMPT FAILED the check \`$verify\` with:
$(printf '%s' "$out" | tail -40)
Fix the cause (not the check) and make it pass."
  done
  if [ "$ok" = 1 ]; then
    log "Codex" "$name PASSED verify (attempts: $((attempt+1))) | check: $verify"
    mv "$brief" "tasks/done/"
  else
    log "Codex" "$name FAILED after $((MAX_RETRIES+1)) attempts | check: $verify"
    echo "FAILED: $name (see tmp/codex-last.txt)"; exit 1
  fi
done
echo "queue complete"
