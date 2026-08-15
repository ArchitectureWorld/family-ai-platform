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
trap 'chmod -R u+w "$TEST_ROOT" 2>/dev/null || true; rm -rf -- "$TEST_ROOT"' EXIT
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

mkdir -m 700 "$TEST_ROOT/bundle-source" "$TEST_ROOT/release-root"
printf 'read-only recovery asset\n' > "$TEST_ROOT/bundle-source/index.html"
chmod 600 "$TEST_ROOT/bundle-source/index.html"
ASSET_SHA="$(sha256sum "$TEST_ROOT/bundle-source/index.html" | cut -d' ' -f1)"
node -e 'const fs=require("node:fs"); const [path,hash]=process.argv.slice(1); fs.writeFileSync(path,JSON.stringify({manifestKind:"rollback-client-bundle-v1",formatVersion:1,files:[{path:"index.html",sha256:hash}]},null,2)+"\n",{mode:0o600,flag:"wx"});' "$TEST_ROOT/bundle-source/manifest.json" "$ASSET_SHA"
tar -C "$TEST_ROOT/bundle-source" -cf "$TEST_ROOT/recovery.tar" index.html manifest.json
chmod 600 "$TEST_ROOT/recovery.tar"
BUNDLE_SHA="$(sha256sum "$TEST_ROOT/recovery.tar" | cut -d' ' -f1)"
node "$ROOT_DIR/scripts/runtime-rollback-assets.mjs" validate --bundle "$TEST_ROOT/recovery.tar" --expected-bundle-sha256 "$BUNDLE_SHA" >/dev/null
node "$ROOT_DIR/scripts/runtime-rollback-assets.mjs" materialize \
  --bundle "$TEST_ROOT/recovery.tar" --expected-bundle-sha256 "$BUNDLE_SHA" \
  --release-root "$TEST_ROOT/release-root" --receipt "$TEST_ROOT/materialized.json" >/dev/null
[[ "$(stat -c %a "$TEST_ROOT/release-root/recovery/$BUNDLE_SHA")" == 500 ]]
[[ "$(stat -c %a "$TEST_ROOT/release-root/recovery/$BUNDLE_SHA/index.html")" == 400 ]]

mkdir -m 700 "$TEST_ROOT/unsafe-source"
ln -s /etc/passwd "$TEST_ROOT/unsafe-source/link"
tar -C "$TEST_ROOT/unsafe-source" -cf "$TEST_ROOT/unsafe.tar" link
chmod 600 "$TEST_ROOT/unsafe.tar"
if node "$ROOT_DIR/scripts/runtime-rollback-assets.mjs" validate \
  --bundle "$TEST_ROOT/unsafe.tar" \
  --expected-bundle-sha256 "$(sha256sum "$TEST_ROOT/unsafe.tar" | cut -d' ' -f1)" >/dev/null 2>&1; then
  printf 'rollback materializer accepted a symlink entry\n' >&2
  exit 1
fi

printf 'runtime backup/restore focused tests: PASS\n'

if [[ "${1:-}" == "--real-image-manifest" && -n "${2:-}" ]]; then
  exec bash "$ROOT_DIR/scripts/test-runtime-retained-fixture.sh" "$2"
fi
[[ $# -eq 0 ]] || { printf 'test-runtime-backup-restore: invalid arguments\n' >&2; exit 1; }
