#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -x node_modules/.bin/tsc ]]; then
  echo "Missing node_modules/.bin/tsc. Run npm ci from the repository root first." >&2
  exit 1
fi

node -e 'const major = Number(process.versions.node.split(".")[0]); if (major !== 22) { throw new Error(`HarmonyOS core verification requires Node 22, got ${process.versions.node}`); }'

node_modules/.bin/tsc -p clients/harmonyos/core/tsconfig.json
NODE_NO_WARNINGS=1 node --experimental-strip-types --test clients/harmonyos/core/test/*.test.ts
