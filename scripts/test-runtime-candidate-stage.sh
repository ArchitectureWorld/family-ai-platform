#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node --check "$ROOT_DIR/scripts/runtime-candidate-manifest.mjs" >/dev/null
bash -n "$ROOT_DIR/scripts/runtime-candidate-stage.sh"
if [[ ! -f "$ROOT_DIR/apps/gateway/dist/migrate.js" ]]; then
  npm run build -w @family-ai/gateway >/dev/null
fi
node --check "$ROOT_DIR/apps/gateway/dist/migrate.js" >/dev/null

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
chmod 700 "$TEST_ROOT"
mkdir -m 700 "$TEST_ROOT/runtime"
printf '{"manifestKind":"candidate-runtime-v1","formatVersion":1,"releaseId":"fixture-a5","candidateRuntimeRoot":"relative-is-forbidden"}\n' > "$TEST_ROOT/bad.json"
chmod 600 "$TEST_ROOT/bad.json"
if node "$ROOT_DIR/scripts/runtime-candidate-manifest.mjs" validate \
  --manifest "$TEST_ROOT/bad.json" --expected-sha256 "$(sha256sum "$TEST_ROOT/bad.json" | cut -d' ' -f1)" >/dev/null 2>&1; then
  printf 'candidate validator accepted unsafe manifest\n' >&2
  exit 1
fi

printf 'runtime candidate-stage focused tests: PASS\n'
