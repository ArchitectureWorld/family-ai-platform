#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  printf 'ERROR: 未找到 python3。\n' >&2
  exit 1
fi

exec python3 "$ROOT_DIR/scripts/configure-hermes.py" --repo-root "$ROOT_DIR" "$@"
