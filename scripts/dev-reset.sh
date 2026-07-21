#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
COMPOSE_ENV="$RUNTIME_DIR/config/compose.env"

if [[ "$RUNTIME_DIR" != "$ROOT_DIR/.runtime" || "$RUNTIME_DIR" == "/.runtime" ]]; then
  printf 'ERROR: runtime path safety check failed.\n' >&2
  exit 1
fi

if [[ "${1:-}" != "--yes" ]]; then
  if [[ ! -t 0 ]]; then
    printf 'ERROR: non-interactive reset requires --yes.\n' >&2
    exit 1
  fi
  printf 'This will permanently delete the disposable Gateway database and development Token.\n'
  read -r -p "Type RESET to continue: " answer
  [[ "$answer" == "RESET" ]] || { printf 'Reset cancelled.\n'; exit 0; }
fi

if [[ -f "$COMPOSE_ENV" ]] && command -v docker >/dev/null 2>&1; then
  cd "$ROOT_DIR"
  docker compose --env-file "$COMPOSE_ENV" down --remove-orphans || true
fi

rm -rf -- "$RUNTIME_DIR"
printf 'Disposable Gateway runtime data has been removed. Run ./scripts/dev-up.sh to start clean.\n'
