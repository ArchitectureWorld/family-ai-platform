#!/usr/bin/env bash
set -euo pipefail
{ set +x; } 2>/dev/null

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT=""
RECEIPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --receipt) RECEIPT="${2:-}"; shift 2 ;;
    *) printf 'ATOMIC_DIR_EXCHANGE_BUILD_FAILED:INVALID_ARGUMENTS\n' >&2; exit 1 ;;
  esac
done
[[ "$OUTPUT" == /* && "$RECEIPT" == /* && ! -e "$OUTPUT" && ! -e "$RECEIPT" ]] \
  || { printf 'ATOMIC_DIR_EXCHANGE_BUILD_FAILED:UNSAFE_OUTPUT\n' >&2; exit 1; }
umask 077
gcc -std=c11 -O2 -Wall -Wextra -Werror "$ROOT_DIR/scripts/atomic-dir-exchange.c" -o "$OUTPUT"
chmod 700 "$OUTPUT"
node "$ROOT_DIR/scripts/runtime-exchange-preflight.mjs" build-receipt \
  --helper "$OUTPUT" --source "$ROOT_DIR/scripts/atomic-dir-exchange.c" \
  --build-script "$ROOT_DIR/scripts/build-atomic-dir-exchange.sh" --output "$RECEIPT"
