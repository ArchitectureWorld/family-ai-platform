#!/usr/bin/env bash
set -euo pipefail
{ set +x; } 2>/dev/null

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_MANIFEST="${1:-}"
[[ "$IMAGE_MANIFEST" == /* && -f "$IMAGE_MANIFEST" ]] || { printf 'real image manifest must be an absolute file\n' >&2; exit 1; }
IMAGE_ID="$(node -e 'const value=require(process.argv[1]); if(value.manifestKind!=="gateway-image-v1"||!/^sha256:[0-9a-f]{64}$/.test(value.imageId))process.exit(1); process.stdout.write(value.imageId)' "$IMAGE_MANIFEST")"

TEST_ROOT="$(mktemp -d)"
PROJECT="a5fixture${RANDOM}${RANDOM}"
CONTAINER="$PROJECT-gateway"
cleanup() {
  docker rm "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT
umask 077
chmod 700 "$TEST_ROOT"
mkdir -m 700 "$TEST_ROOT/runtime" "$TEST_ROOT/runtime/data" "$TEST_ROOT/runtime/data/attachments" "$TEST_ROOT/snapshot-output" "$TEST_ROOT/evidence"

node "$ROOT_DIR/apps/gateway/dist/migrate.js" --database "$TEST_ROOT/runtime/data/gateway.sqlite" >/dev/null
chmod 600 "$TEST_ROOT/runtime/data/gateway.sqlite"
printf 'fixture-attachment\n' > "$TEST_ROOT/runtime/data/attachments/example.txt"
chmod 600 "$TEST_ROOT/runtime/data/attachments/example.txt"

node "$ROOT_DIR/scripts/gateway-schema-capabilities.mjs" validate \
  --schema-registry "$ROOT_DIR/scripts/gateway-schema-capabilities.json" \
  --release-capabilities "$ROOT_DIR/scripts/gateway-release-capabilities.json" \
  --database-source "$ROOT_DIR/apps/gateway/src/database.ts" \
  --client-cache-source "$ROOT_DIR/apps/gateway/member-public/cache.js" \
  --output "$TEST_ROOT/evidence/capability.json" > "$TEST_ROOT/capability-sha"
CAPABILITY_SHA="$(<"$TEST_ROOT/capability-sha")"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { sealJson } from "./scripts/runtime-release-lib.mjs";
  const [source, output] = process.argv.slice(1);
  const value = JSON.parse(readFileSync(source, "utf8"));
  value.release = { ...value.release, capabilitySetId: "fixture-required-v9", rollbackClientRequired: true, rollbackClientBundleFormat: "sealed-static-v1", rollbackGuardFormat: "static-guard-v1" };
  process.stdout.write(sealJson(output, value));
' "$TEST_ROOT/evidence/capability.json" "$TEST_ROOT/evidence/capability-required.json" > "$TEST_ROOT/capability-required-sha"
CAPABILITY_REQUIRED_SHA="$(<"$TEST_ROOT/capability-required-sha")"
printf '{"fixture":"controller-source-v1"}\n' > "$TEST_ROOT/evidence/controller-source.json"
chmod 600 "$TEST_ROOT/evidence/controller-source.json"
node -e 'const fs=require("node:fs"); const [path,image,project,source]=process.argv.slice(1); fs.writeFileSync(path, JSON.stringify({kind:"docker-compose",imageId:image,projectName:project,service:"gateway",sourceFiles:[source]},null,2)+"\n",{mode:0o600,flag:"wx"});' \
  "$TEST_ROOT/evidence/controller.json" "$IMAGE_ID" "$PROJECT" "$TEST_ROOT/evidence/controller-source.json"

docker create --name "$CONTAINER" \
  --label "com.docker.compose.project=$PROJECT" \
  --label 'com.docker.compose.service=gateway' \
  "$IMAGE_ID" node -e 'setInterval(()=>{},1000)' >/dev/null
docker start "$CONTAINER" >/dev/null
docker stop -t 1 "$CONTAINER" >/dev/null

if node "$ROOT_DIR/scripts/runtime-backup-preflight.mjs" \
  --scope fixture-rehearsal --phase fixture-source-snapshot --release-id fixture-required-a5 \
  --runtime-root "$TEST_ROOT/runtime" --controller-definition "$TEST_ROOT/evidence/controller.json" \
  --capability-receipt "$TEST_ROOT/evidence/capability-required.json" \
  --expected-capability-receipt-sha256 "$CAPABILITY_REQUIRED_SHA" \
  --source-image-role fixture-baseline --source-image-id "$IMAGE_ID" \
  --output "$TEST_ROOT/evidence/required-must-fail.json" >/dev/null 2>&1; then
  printf 'required rollback capability accepted a missing asset set\n' >&2
  exit 1
fi
[[ ! -e "$TEST_ROOT/evidence/required-must-fail.json" ]]

HEAD_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
node "$ROOT_DIR/scripts/runtime-tool-manifest.mjs" create \
  --repository "$ROOT_DIR" --source-commit "$HEAD_SHA" --expected-source-commit "$HEAD_SHA" \
  --release-build-inputs "$ROOT_DIR/scripts/release-build-inputs.json" \
  --output "$TEST_ROOT/evidence/tools.json" > "$TEST_ROOT/tool-sha"
TOOL_SHA="$(<"$TEST_ROOT/tool-sha")"

node "$ROOT_DIR/scripts/runtime-backup-preflight.mjs" \
  --scope fixture-rehearsal --phase fixture-source-snapshot --release-id fixture-a5 \
  --runtime-root "$TEST_ROOT/runtime" --controller-definition "$TEST_ROOT/evidence/controller.json" \
  --capability-receipt "$TEST_ROOT/evidence/capability.json" \
  --expected-capability-receipt-sha256 "$CAPABILITY_SHA" \
  --source-image-role fixture-baseline --source-image-id "$IMAGE_ID" \
  --output "$TEST_ROOT/evidence/preflight.json" > "$TEST_ROOT/preflight-sha"
PREFLIGHT_SHA="$(<"$TEST_ROOT/preflight-sha")"
node "$ROOT_DIR/scripts/runtime-stop-evidence.mjs" capture \
  --scope fixture-rehearsal --phase fixture-source-snapshot --release-id fixture-a5 \
  --expected-preflight-sha256 "$PREFLIGHT_SHA" --controller docker-compose \
  --project-name "$PROJECT" --service gateway --expected-bind none \
  --output "$TEST_ROOT/evidence/stop.json" >/dev/null

bash "$ROOT_DIR/scripts/runtime-backup.sh" \
  --scope fixture-rehearsal --phase fixture-source-snapshot --release-id fixture-a5 \
  --preflight "$TEST_ROOT/evidence/preflight.json" --expected-preflight-sha256 "$PREFLIGHT_SHA" \
  --stop-evidence "$TEST_ROOT/evidence/stop.json" --runtime-root "$TEST_ROOT/runtime" \
  --output-root "$TEST_ROOT/snapshot-output" --backup-tool-manifest "$TEST_ROOT/evidence/tools.json" \
  --expected-backup-tool-manifest-sha256 "$TOOL_SHA" > "$TEST_ROOT/snapshot-path"
SNAPSHOT="$(<"$TEST_ROOT/snapshot-path")"

node -e 'const fs=require("node:fs"); const [path,image,receipt]=process.argv.slice(1); fs.writeFileSync(path, JSON.stringify({manifestKind:"gateway-migration-definition-v1",imageId:image,releaseCapabilityReceiptSha256:receipt,entrypoint:["node","apps/gateway/dist/migrate.js"],workerDisabled:true,networkMode:"none",runtimeMount:"/runtime",databasePath:"/runtime/data/gateway.sqlite",attachmentRoot:"/runtime/data/attachments"},null,2)+"\n",{mode:0o600,flag:"wx"});' \
  "$TEST_ROOT/evidence/migration.json" "$IMAGE_ID" "$CAPABILITY_SHA"
bash "$ROOT_DIR/scripts/runtime-candidate-stage.sh" \
  --release-id fixture-a5 --source-snapshot "$SNAPSHOT" \
  --candidate-image-manifest "$IMAGE_MANIFEST" --capability-receipt "$TEST_ROOT/evidence/capability.json" \
  --expected-capability-receipt-sha256 "$CAPABILITY_SHA" --candidate-definition "$TEST_ROOT/evidence/migration.json" \
  --target-parent "$TEST_ROOT" --output-name candidate-a5 --manifest "$TEST_ROOT/evidence/candidate.json" >/dev/null
node "$ROOT_DIR/scripts/runtime-candidate-manifest.mjs" validate \
  --manifest "$TEST_ROOT/evidence/candidate.json" \
  --expected-sha256 "$(sha256sum "$TEST_ROOT/evidence/candidate.json" | cut -d' ' -f1)" >/dev/null

cp "$TEST_ROOT/runtime/data/attachments/example.txt" "$TEST_ROOT/original-attachment"
printf 'corrupted\n' > "$TEST_ROOT/runtime/data/attachments/example.txt"
bash "$ROOT_DIR/scripts/build-atomic-dir-exchange.sh" \
  --output "$TEST_ROOT/evidence/exchange-helper" --receipt "$TEST_ROOT/evidence/helper-build.json" >/dev/null
node "$ROOT_DIR/scripts/runtime-exchange-preflight.mjs" \
  --helper "$TEST_ROOT/evidence/exchange-helper" --target-parent "$TEST_ROOT" \
  --output "$TEST_ROOT/evidence/exchange.json" >/dev/null
node "$ROOT_DIR/scripts/runtime-stop-evidence.mjs" capture \
  --scope fixture-rehearsal --phase restore-previous --release-id fixture-a5 \
  --expected-preflight-sha256 "$PREFLIGHT_SHA" --controller docker-compose \
  --project-name "$PROJECT" --service gateway --expected-bind none \
  --output "$TEST_ROOT/evidence/restore-stop.json" >/dev/null
bash "$ROOT_DIR/scripts/runtime-restore.sh" \
  --scope fixture-rehearsal --phase restore-previous --release-id fixture-a5 \
  --preflight "$TEST_ROOT/evidence/preflight.json" --expected-preflight-sha256 "$PREFLIGHT_SHA" \
  --stop-evidence "$TEST_ROOT/evidence/restore-stop.json" --exchange-capability "$TEST_ROOT/evidence/exchange.json" \
  --snapshot "$SNAPSHOT" --target-runtime-root "$TEST_ROOT/runtime" --client-rollback-mode previous-native \
  --receipt "$TEST_ROOT/evidence/restore.json" >/dev/null

cmp "$TEST_ROOT/runtime/data/attachments/example.txt" "$TEST_ROOT/original-attachment"
node -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1])); const c=JSON.parse(fs.readFileSync(process.argv[2])); const r=JSON.parse(fs.readFileSync(process.argv[3])); if(m.schemaVersion!==9||c.beforeSchema!==9||c.afterSchema!==9||r.manifestKind!=="runtime-restore-receipt-v1")process.exit(1)' \
  "$SNAPSHOT/manifest.json" "$TEST_ROOT/evidence/candidate.json" "$TEST_ROOT/evidence/restore.json"

mkdir -m 700 "$TEST_ROOT/runtime-v3" "$TEST_ROOT/runtime-v3/data" "$TEST_ROOT/snapshot-v3-output"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import Database from "better-sqlite3";
  const [sourcePath, databasePath] = process.argv.slice(1);
  const source = readFileSync(sourcePath, "utf8");
  const db = new Database(databasePath);
  try {
    for (let version = 1; version <= 3; version += 1) {
      const match = source.match(new RegExp("const MIGRATION_V" + version + " = `([\\s\\S]*?)`;"));
      if (!match) process.exit(1);
      db.exec(match[1]);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(version, new Date().toISOString());
    }
  } finally { db.close(); }
' "$ROOT_DIR/apps/gateway/src/database.ts" "$TEST_ROOT/runtime-v3/data/gateway.sqlite"
chmod 600 "$TEST_ROOT/runtime-v3/data/gateway.sqlite"
node "$ROOT_DIR/scripts/runtime-backup-preflight.mjs" \
  --scope fixture-rehearsal --phase fixture-source-snapshot --release-id fixture-a5-v3 \
  --runtime-root "$TEST_ROOT/runtime-v3" --controller-definition "$TEST_ROOT/evidence/controller.json" \
  --capability-receipt "$TEST_ROOT/evidence/capability.json" \
  --expected-capability-receipt-sha256 "$CAPABILITY_SHA" --legacy-attachments absent-if-schema-before-v8 \
  --source-image-role fixture-baseline --source-image-id "$IMAGE_ID" \
  --output "$TEST_ROOT/evidence/preflight-v3.json" > "$TEST_ROOT/preflight-v3-sha"
PREFLIGHT_V3_SHA="$(<"$TEST_ROOT/preflight-v3-sha")"
node "$ROOT_DIR/scripts/runtime-stop-evidence.mjs" capture \
  --scope fixture-rehearsal --phase fixture-source-snapshot --release-id fixture-a5-v3 \
  --expected-preflight-sha256 "$PREFLIGHT_V3_SHA" --controller docker-compose \
  --project-name "$PROJECT" --service gateway --expected-bind none \
  --output "$TEST_ROOT/evidence/stop-v3.json" >/dev/null
bash "$ROOT_DIR/scripts/runtime-backup.sh" \
  --scope fixture-rehearsal --phase fixture-source-snapshot --release-id fixture-a5-v3 \
  --preflight "$TEST_ROOT/evidence/preflight-v3.json" --expected-preflight-sha256 "$PREFLIGHT_V3_SHA" \
  --stop-evidence "$TEST_ROOT/evidence/stop-v3.json" --runtime-root "$TEST_ROOT/runtime-v3" \
  --output-root "$TEST_ROOT/snapshot-v3-output" --backup-tool-manifest "$TEST_ROOT/evidence/tools.json" \
  --expected-backup-tool-manifest-sha256 "$TOOL_SHA" > "$TEST_ROOT/snapshot-v3-path"
SNAPSHOT_V3="$(<"$TEST_ROOT/snapshot-v3-path")"
printf 'broken-sqlite\n' > "$TEST_ROOT/runtime-v3/data/gateway.sqlite"
node "$ROOT_DIR/scripts/runtime-stop-evidence.mjs" capture \
  --scope fixture-rehearsal --phase restore-previous --release-id fixture-a5-v3 \
  --expected-preflight-sha256 "$PREFLIGHT_V3_SHA" --controller docker-compose \
  --project-name "$PROJECT" --service gateway --expected-bind none \
  --output "$TEST_ROOT/evidence/restore-stop-v3.json" >/dev/null
bash "$ROOT_DIR/scripts/runtime-restore.sh" \
  --scope fixture-rehearsal --phase restore-previous --release-id fixture-a5-v3 \
  --preflight "$TEST_ROOT/evidence/preflight-v3.json" --expected-preflight-sha256 "$PREFLIGHT_V3_SHA" \
  --stop-evidence "$TEST_ROOT/evidence/restore-stop-v3.json" --exchange-capability "$TEST_ROOT/evidence/exchange.json" \
  --snapshot "$SNAPSHOT_V3" --target-runtime-root "$TEST_ROOT/runtime-v3" --client-rollback-mode previous-native \
  --receipt "$TEST_ROOT/evidence/restore-v3.json" >/dev/null
node --input-type=module -e 'import Database from "better-sqlite3"; const db=new Database(process.argv[1],{readonly:true}); const version=db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version; db.close(); if(version!==3)process.exit(1);' "$TEST_ROOT/runtime-v3/data/gateway.sqlite"
[[ ! -e "$TEST_ROOT/runtime-v3/data/attachments" ]]

printf 'runtime retained V3/V9 snapshot/candidate/restore fixtures: PASS\n'
