#!/usr/bin/env bash
set -euo pipefail
{ set +x; } 2>/dev/null
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_ROOT="$(mktemp -d /tmp/family-ai-build-contract.XXXXXXXX)"
chmod 700 "$FIXTURE_ROOT"
cleanup() {
  find "$FIXTURE_ROOT" -depth -mindepth 1 -delete 2>/dev/null || true
  rmdir "$FIXTURE_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  printf 'GATEWAY IMAGE CONTRACT TEST FAILED: %s\n' "$1" >&2
  exit 1
}
expect_failure() {
  local expected="$1"
  shift
  local output status=0
  output="$("$@" 2>&1)" || status=$?
  [[ "$status" -ne 0 && "$output" == *"$expected"* ]] \
    || fail "expected failure $expected, got status=$status output=$output"
}

for required in \
  scripts/build-gateway-image.sh \
  scripts/gateway-schema-capabilities.mjs \
  scripts/gateway-schema-capabilities.json \
  scripts/gateway-release-capabilities.json \
  scripts/release-build-inputs.json \
  scripts/release-build-inputs.mjs; do
  [[ -f "$ROOT_DIR/$required" ]] || fail "missing contract input: $required"
done

grep -Fq 'MEMBER_CACHE_DATABASE_VERSION' "$ROOT_DIR/apps/gateway/member-public/cache.js" \
  || fail 'client database version is not exported from runtime source'
grep -Fq 'manifestKind: "gateway-image-v1"' "$ROOT_DIR/scripts/build-gateway-image.sh" \
  || fail 'build wrapper does not write the gateway-image-v1 manifest'
grep -Fq 'buildInputTreeHash' "$ROOT_DIR/scripts/build-gateway-image.sh" \
  || fail 'build wrapper does not bind the canonical build input tree'

CAPABILITY_DIR="$FIXTURE_ROOT/capability"
mkdir -m 700 "$CAPABILITY_DIR"
cp "$ROOT_DIR/scripts/gateway-schema-capabilities.mjs" "$CAPABILITY_DIR/validator.mjs"
cp "$ROOT_DIR/scripts/gateway-schema-capabilities.json" "$CAPABILITY_DIR/schema.json"
cp "$ROOT_DIR/scripts/gateway-release-capabilities.json" "$CAPABILITY_DIR/release.json"
printf 'export const MIGRATION_V9 = `fixture`;\n' > "$CAPABILITY_DIR/database.ts"
printf '%s\n' \
  'export const MEMBER_CACHE_DATABASE_VERSION = 2;' \
  'export function open(databaseName, indexedDBImpl) {' \
  '  return indexedDBImpl.open(databaseName, MEMBER_CACHE_DATABASE_VERSION);' \
  '}' > "$CAPABILITY_DIR/cache.js"
node "$CAPABILITY_DIR/validator.mjs" validate \
  --schema-registry "$CAPABILITY_DIR/schema.json" \
  --release-capabilities "$CAPABILITY_DIR/release.json" \
  --database-source "$CAPABILITY_DIR/database.ts" \
  --client-cache-source "$CAPABILITY_DIR/cache.js" \
  --output "$CAPABILITY_DIR/receipt.json" >/dev/null
[[ "$(stat -c '%a' "$CAPABILITY_DIR/receipt.json")" == 600 ]] || fail 'capability receipt mode is not 0600'
[[ "$(sha256sum "$CAPABILITY_DIR/receipt.json" | awk '{print $1}')" == \
  "$(awk 'NR==1 {print $1}' "$CAPABILITY_DIR/receipt.json.sha256")" ]] || fail 'capability sidecar is not replayable'
cp "$CAPABILITY_DIR/release.json" "$CAPABILITY_DIR/release-bad.json"
sed -i 's/"clientDatabaseVersion": 2/"clientDatabaseVersion": 3/' "$CAPABILITY_DIR/release-bad.json"
expect_failure CLIENT_DATABASE_VERSION_MISMATCH \
  node "$CAPABILITY_DIR/validator.mjs" validate \
    --schema-registry "$CAPABILITY_DIR/schema.json" \
    --release-capabilities "$CAPABILITY_DIR/release-bad.json" \
    --database-source "$CAPABILITY_DIR/database.ts" \
    --client-cache-source "$CAPABILITY_DIR/cache.js" \
    --output "$CAPABILITY_DIR/receipt-bad.json"
cp "$CAPABILITY_DIR/schema.json" "$CAPABILITY_DIR/schema-gap.json"
node --input-type=module - "$CAPABILITY_DIR/schema-gap.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const value = JSON.parse(readFileSync(path, "utf8"));
value.schemas.splice(2, 1);
writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
NODE
expect_failure SCHEMA_SEQUENCE_INVALID \
  node "$CAPABILITY_DIR/validator.mjs" validate \
    --schema-registry "$CAPABILITY_DIR/schema-gap.json" \
    --release-capabilities "$CAPABILITY_DIR/release.json" \
    --database-source "$CAPABILITY_DIR/database.ts" \
    --client-cache-source "$CAPABILITY_DIR/cache.js" \
    --output "$CAPABILITY_DIR/receipt-gap.json"

INPUT_REPO="$FIXTURE_ROOT/input-repo"
mkdir -p "$INPUT_REPO/scripts" "$INPUT_REPO/docs"
chmod 700 "$INPUT_REPO" "$INPUT_REPO/scripts" "$INPUT_REPO/docs"
cp "$ROOT_DIR/scripts/release-build-inputs.mjs" "$INPUT_REPO/validator.mjs"
printf 'runtime-v1\n' > "$INPUT_REPO/runtime.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "$INPUT_REPO/scripts/check.sh"
chmod 755 "$INPUT_REPO/scripts/check.sh"
printf 'docs-v1\n' > "$INPUT_REPO/docs/README.md"
cp "$ROOT_DIR/scripts/release-build-inputs.json" "$INPUT_REPO/scripts/release-build-inputs.json"
node --input-type=module - "$INPUT_REPO/scripts/release-build-inputs.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const value = JSON.parse(readFileSync(path, "utf8"));
value.rules = [
  { pattern: "scripts/release-build-inputs.json", classification: "runtime-build" },
  { pattern: "runtime.txt", classification: "runtime-build" },
  { pattern: "scripts/**", classification: "quality-tool" },
  { pattern: "docs/**", classification: "docs-only" }
];
writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
NODE
git -C "$INPUT_REPO" init -q
git -C "$INPUT_REPO" config user.email fixture@family-ai.invalid
git -C "$INPUT_REPO" config user.name 'Family AI Fixture'
git -C "$INPUT_REPO" add runtime.txt scripts/check.sh scripts/release-build-inputs.json docs/README.md
git -C "$INPUT_REPO" commit -qm baseline
BASE_COMMIT="$(git -C "$INPUT_REPO" rev-parse HEAD)"
node "$INPUT_REPO/validator.mjs" validate \
  --repository "$INPUT_REPO" --source-commit "$BASE_COMMIT" \
  --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
  --output "$INPUT_REPO/receipt-base.json" >/dev/null
BASE_HASH="$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.buildInputTreeHash)' "$INPUT_REPO/receipt-base.json")"

printf 'dirty-copy-that-must-not-affect-commit\n' > "$INPUT_REPO/runtime.txt"
node "$INPUT_REPO/validator.mjs" validate \
  --repository "$INPUT_REPO" --source-commit "$BASE_COMMIT" \
  --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
  --output "$INPUT_REPO/receipt-dirty.json" >/dev/null
[[ "$BASE_HASH" == "$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.buildInputTreeHash)' "$INPUT_REPO/receipt-dirty.json")" ]] \
  || fail 'dirty external worktree polluted the commit tree hash'
git -C "$INPUT_REPO" restore runtime.txt

printf 'docs-v2\n' > "$INPUT_REPO/docs/README.md"
git -C "$INPUT_REPO" add docs/README.md
git -C "$INPUT_REPO" commit -qm docs-only-change
DOCS_COMMIT="$(git -C "$INPUT_REPO" rev-parse HEAD)"
node "$INPUT_REPO/validator.mjs" validate \
  --repository "$INPUT_REPO" --source-commit "$DOCS_COMMIT" \
  --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
  --output "$INPUT_REPO/receipt-docs.json" >/dev/null
[[ "$BASE_HASH" == "$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.buildInputTreeHash)' "$INPUT_REPO/receipt-docs.json")" ]] \
  || fail 'allowlisted docs-only drift changed the candidate tree hash'

printf 'runtime-v2\n' > "$INPUT_REPO/runtime.txt"
git -C "$INPUT_REPO" add runtime.txt
git -C "$INPUT_REPO" commit -qm runtime-change
RUNTIME_COMMIT="$(git -C "$INPUT_REPO" rev-parse HEAD)"
node "$INPUT_REPO/validator.mjs" validate \
  --repository "$INPUT_REPO" --source-commit "$RUNTIME_COMMIT" \
  --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
  --output "$INPUT_REPO/receipt-runtime.json" >/dev/null
[[ "$BASE_HASH" != "$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.buildInputTreeHash)' "$INPUT_REPO/receipt-runtime.json")" ]] \
  || fail 'runtime content drift did not change tree hash'

chmod 644 "$INPUT_REPO/scripts/check.sh"
git -C "$INPUT_REPO" add scripts/check.sh
git -C "$INPUT_REPO" commit -qm mode-change
MODE_COMMIT="$(git -C "$INPUT_REPO" rev-parse HEAD)"
node "$INPUT_REPO/validator.mjs" validate \
  --repository "$INPUT_REPO" --source-commit "$MODE_COMMIT" \
  --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
  --output "$INPUT_REPO/receipt-mode.json" >/dev/null
[[ "$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.buildInputTreeHash)' "$INPUT_REPO/receipt-runtime.json")" != \
  "$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.buildInputTreeHash)' "$INPUT_REPO/receipt-mode.json")" ]] \
  || fail 'executable bit drift did not change tree hash'

printf '#!/usr/bin/env bash\nexit 1\n' > "$INPUT_REPO/scripts/check.sh"
git -C "$INPUT_REPO" add scripts/check.sh
git -C "$INPUT_REPO" commit -qm quality-content-change
QUALITY_COMMIT="$(git -C "$INPUT_REPO" rev-parse HEAD)"
node "$INPUT_REPO/validator.mjs" validate \
  --repository "$INPUT_REPO" --source-commit "$QUALITY_COMMIT" \
  --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
  --output "$INPUT_REPO/receipt-quality.json" >/dev/null
[[ "$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.buildInputTreeHash)' "$INPUT_REPO/receipt-mode.json")" != \
  "$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.buildInputTreeHash)' "$INPUT_REPO/receipt-quality.json")" ]] \
  || fail 'quality tool content drift did not change tree hash'

git -C "$INPUT_REPO" reset --hard -q "$MODE_COMMIT"
node --input-type=module - "$INPUT_REPO/scripts/release-build-inputs.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const value = JSON.parse(readFileSync(path, "utf8"));
value.fixtureNote = "manifest-self-drift";
writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
NODE
git -C "$INPUT_REPO" add scripts/release-build-inputs.json
git -C "$INPUT_REPO" commit -qm manifest-self-drift
MANIFEST_COMMIT="$(git -C "$INPUT_REPO" rev-parse HEAD)"
node "$INPUT_REPO/validator.mjs" validate \
  --repository "$INPUT_REPO" --source-commit "$MANIFEST_COMMIT" \
  --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
  --output "$INPUT_REPO/receipt-manifest.json" >/dev/null
[[ "$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.buildInputTreeHash)' "$INPUT_REPO/receipt-mode.json")" != \
  "$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.buildInputTreeHash)' "$INPUT_REPO/receipt-manifest.json")" ]] \
  || fail 'manifest self drift did not change tree hash'

git -C "$INPUT_REPO" reset --hard -q "$MODE_COMMIT"
printf 'unknown\n' > "$INPUT_REPO/unknown.root"
git -C "$INPUT_REPO" add unknown.root
git -C "$INPUT_REPO" commit -qm unclassified
expect_failure UNCLASSIFIED_PATH:unknown.root \
  node "$INPUT_REPO/validator.mjs" validate \
    --repository "$INPUT_REPO" --source-commit "$(git -C "$INPUT_REPO" rev-parse HEAD)" \
    --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
    --output "$INPUT_REPO/receipt-unclassified.json"
git -C "$INPUT_REPO" reset --hard -q "$MODE_COMMIT"

node --input-type=module - "$INPUT_REPO/scripts/release-build-inputs.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const value = JSON.parse(readFileSync(path, "utf8"));
value.rules[2].classification = "docs-only";
writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
NODE
git -C "$INPUT_REPO" add scripts/release-build-inputs.json
git -C "$INPUT_REPO" commit -qm misclassified-quality
expect_failure EXECUTABLE_OR_QUALITY_PATH_MARKED_DOCS:scripts/check.sh \
  node "$INPUT_REPO/validator.mjs" validate \
    --repository "$INPUT_REPO" --source-commit "$(git -C "$INPUT_REPO" rev-parse HEAD)" \
    --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
    --output "$INPUT_REPO/receipt-misclassified.json"
git -C "$INPUT_REPO" reset --hard -q "$MODE_COMMIT"

node --input-type=module - "$INPUT_REPO/scripts/release-build-inputs.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const value = JSON.parse(readFileSync(path, "utf8"));
value.buildMaterials.platform = "linux/arm64";
writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
NODE
git -C "$INPUT_REPO" add scripts/release-build-inputs.json
git -C "$INPUT_REPO" commit -qm material-drift
expect_failure BUILD_MATERIALS_INVALID \
  node "$INPUT_REPO/validator.mjs" validate \
    --repository "$INPUT_REPO" --source-commit "$(git -C "$INPUT_REPO" rev-parse HEAD)" \
    --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
    --output "$INPUT_REPO/receipt-material.json"

git -C "$INPUT_REPO" reset --hard -q "$MODE_COMMIT"
ln -s runtime.txt "$INPUT_REPO/runtime-link"
node --input-type=module - "$INPUT_REPO/scripts/release-build-inputs.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const value = JSON.parse(readFileSync(path, "utf8"));
value.rules.unshift({ pattern: "runtime-link", classification: "runtime-build" });
writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
NODE
git -C "$INPUT_REPO" add runtime-link scripts/release-build-inputs.json
git -C "$INPUT_REPO" commit -qm unapproved-symlink
expect_failure SYMLINK_NOT_EXPLICITLY_ALLOWED:runtime-link \
  node "$INPUT_REPO/validator.mjs" validate \
    --repository "$INPUT_REPO" --source-commit "$(git -C "$INPUT_REPO" rev-parse HEAD)" \
    --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
    --output "$INPUT_REPO/receipt-symlink.json"

git -C "$INPUT_REPO" reset --hard -q "$MODE_COMMIT"
node --input-type=module - "$INPUT_REPO/scripts/release-build-inputs.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const value = JSON.parse(readFileSync(path, "utf8"));
value.rules.unshift({ pattern: "vendor/submodule", classification: "runtime-build" });
writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
NODE
git -C "$INPUT_REPO" add scripts/release-build-inputs.json
git -C "$INPUT_REPO" update-index --add --cacheinfo "160000,$MODE_COMMIT,vendor/submodule"
git -C "$INPUT_REPO" commit -qm submodule-entry
expect_failure SUBMODULE_NOT_ALLOWED:vendor/submodule \
  node "$INPUT_REPO/validator.mjs" validate \
    --repository "$INPUT_REPO" --source-commit "$(git -C "$INPUT_REPO" rev-parse HEAD)" \
    --manifest "$INPUT_REPO/scripts/release-build-inputs.json" \
    --output "$INPUT_REPO/receipt-submodule.json"

SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
EXPECTED_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD~1)"
expect_failure SOURCE_COMMIT_MISMATCH \
  bash "$ROOT_DIR/scripts/build-gateway-image.sh" \
    --source-commit "$SOURCE_COMMIT" --expected-source-commit "$EXPECTED_COMMIT" \
    --output-dir "$FIXTURE_ROOT/mismatch-output"
expect_failure SOURCE_COMMIT_INVALID \
  bash "$ROOT_DIR/scripts/build-gateway-image.sh" \
    --source-commit deadbeef --expected-source-commit "$EXPECTED_COMMIT" \
    --output-dir "$FIXTURE_ROOT/missing-output"
BLOB_OBJECT="$(git -C "$ROOT_DIR" rev-parse HEAD:README.md)"
expect_failure SOURCE_COMMIT_INVALID \
  bash "$ROOT_DIR/scripts/build-gateway-image.sh" \
    --source-commit "$BLOB_OBJECT" --expected-source-commit "$EXPECTED_COMMIT" \
    --output-dir "$FIXTURE_ROOT/noncommit-output"
expect_failure INVALID_ARGUMENTS \
  bash "$ROOT_DIR/scripts/build-gateway-image.sh" \
    --source-commit "$SOURCE_COMMIT" --expected-source-commit "$SOURCE_COMMIT" \
    --client-database-version 999 --output-dir "$FIXTURE_ROOT/forged-version-output"

TAMPER_DIR="$FIXTURE_ROOT/tampered-artifact"
mkdir -m 700 "$TAMPER_DIR"
printf 'tampered archive\n' > "$TAMPER_DIR/gateway-image.tar"
printf '%064d  gateway-image.tar\n' 0 > "$TAMPER_DIR/gateway-image.tar.sha256"
printf '{"manifestKind":"gateway-image-v1"}\n' > "$TAMPER_DIR/gateway-image-manifest.json"
expect_failure ARCHIVE_HASH_MISMATCH \
  bash "$ROOT_DIR/scripts/ci-compose-smoke.sh" \
    --image-manifest "$TAMPER_DIR/gateway-image-manifest.json"

printf 'Gateway image contract fixture tests passed.\n'
