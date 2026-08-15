#!/usr/bin/env bash
set -euo pipefail
{ set +x; } 2>/dev/null
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT_DIR/scripts/runtime-snapshot.mjs" create "$@"
