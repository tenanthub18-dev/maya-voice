#!/usr/bin/env bash
# Stop hook: append one line per turn to comms/MASTER.md (timestamp + recently changed files).
# Never logs prompt text, secrets, or file contents.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/comms/MASTER.md"
[ -f "$LOG" ] || exit 0
cd "$ROOT" || exit 0
TS="$(TZ=America/Toronto date '+%Y-%m-%d %H:%M %Z')"
if git rev-parse --git-dir >/dev/null 2>&1; then
  CHANGED="$(git status --porcelain | grep -v ' comms/' | awk '{print $2}' | head -8 | paste -sd, -)"
else
  CHANGED="$(find . -type f -mmin -15 -not -path './.git/*' -not -path './comms/*' -not -path './node_modules/*' -not -name '.env*' 2>/dev/null | head -8 | paste -sd, -)"
fi
printf -- '- %s | auto | turn ended | changed: %s\n' "$TS" "${CHANGED:-none}" >> "$LOG"
exit 0
