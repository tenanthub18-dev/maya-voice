#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

find "$REPO_ROOT" -xdev \
  \( -type d \( \
    -name .git -o \
    -name node_modules -o \
    -name docs -o \
    -name config -o \
    -name comms -o \
    -name '.env*' -o \
    -path '*/supabase/migrations' \
  \) -prune \) -o \
  \( -type d \( \
    -name .next -o \
    -name dist -o \
    -name coverage -o \
    -name .turbo -o \
    -name __pycache__ -o \
    -name .pytest_cache -o \
    -name tmp \
  \) -prune -print0 \) -o \
  \( -type f -name '*.log' ! -name '.env*' -print0 \) |
while IFS= read -r -d '' path; do
  relative_path="${path#"$REPO_ROOT"/}"
  printf 'Removing %q\n' "$relative_path"
  rm -rf -- "$path"
done
