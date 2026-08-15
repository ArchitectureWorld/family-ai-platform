#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for file in \
  runtime-release-lib.mjs runtime-tool-manifest.mjs runtime-backup-preflight.mjs \
  runtime-stop-evidence.mjs runtime-snapshot.mjs runtime-rollback-assets.mjs \
  runtime-exchange-preflight.mjs runtime-restore.mjs; do
  node --check "$ROOT_DIR/scripts/$file" >/dev/null
done
bash -n "$ROOT_DIR/scripts/runtime-backup.sh" "$ROOT_DIR/scripts/runtime-restore.sh"

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
chmod 700 "$TEST_ROOT"

bash "$ROOT_DIR/scripts/build-atomic-dir-exchange.sh" \
  --output "$TEST_ROOT/atomic-dir-exchange" \
  --receipt "$TEST_ROOT/build-receipt.json" >/dev/null

mkdir -m 700 "$TEST_ROOT/parent"
node "$ROOT_DIR/scripts/runtime-exchange-preflight.mjs" \
  --helper "$TEST_ROOT/atomic-dir-exchange" \
  --target-parent "$TEST_ROOT/parent" \
  --output "$TEST_ROOT/exchange.json" >/dev/null

[[ "$(stat -c %a "$TEST_ROOT/exchange.json")" == 600 ]]
[[ "$(stat -c %a "$TEST_ROOT/exchange.json.sha256")" == 600 ]]
node -e '
  const fs = require("node:fs");
  const receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (receipt.manifestKind !== "runtime-exchange-capability-v1" || receipt.probeResult !== "exchanged-and-restored") process.exit(1);
' "$TEST_ROOT/exchange.json"

printf 'runtime backup/restore focused tests: PASS\n'
