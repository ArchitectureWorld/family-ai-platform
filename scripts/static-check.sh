#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for script in scripts/*.sh; do
  bash -n "$script"
done

grep -Fq '127.0.0.1:8790:8790' compose.yaml || {
  printf 'compose.yaml must publish Gateway on loopback only.\n' >&2
  exit 1
}

if grep -Eq '(^|[[:space:]])["'"']?0\.0\.0\.0:8790:8790' compose.yaml; then
  printf 'compose.yaml exposes Gateway outside loopback.\n' >&2
  exit 1
fi

grep -Fxq '.runtime/' .gitignore || {
  printf '.runtime must be ignored by Git.\n' >&2
  exit 1
}

grep -Fxq 'docs/acceptance/runtime/' .gitignore || {
  printf 'runtime acceptance reports must be ignored by Git.\n' >&2
  exit 1
}

for forbidden in 'agent-control-center.sqlite' '/home/youran/' 'family-ai-platform-legacy/data'; do
  if grep -R --exclude-dir=.git --exclude='*.md' -Fq "$forbidden" .; then
    printf 'Forbidden production reference found: %s\n' "$forbidden" >&2
    exit 1
  fi
done

printf 'Static deployment checks passed.\n'
