#!/usr/bin/env bash
set -euo pipefail

# Gitleaks directory scanning command: https://github.com/gitleaks/gitleaks#commands
if ! command -v gitleaks >/dev/null 2>&1; then
  echo 'gitleaks is required to scan the repository' >&2
  exit 127
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  scan_root=$(mktemp -d "${TMPDIR:-/tmp}/voice-receptionist-gitleaks.XXXXXX")
  trap 'rm -rf "$scan_root"' EXIT
  while IFS= read -r -d '' file; do
    if [[ -f "$file" ]] && [[ $(wc -c <"$file") -le 1048576 ]]; then
      mkdir -p "$scan_root/$(dirname "$file")"
      cp "$file" "$scan_root/$file"
    fi
  done < <(git ls-files --cached --others --exclude-standard -z)
  gitleaks dir --redact --no-banner --verbose --max-target-megabytes 1 "$scan_root"
else
  exec gitleaks dir --redact --no-banner --max-target-megabytes 1 .
fi
