#!/usr/bin/env bash
set -euo pipefail
{ set +x; } 2>/dev/null
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST=""

fail() {
  printf 'CI_CONTAINER_SMOKE_FAILED:%s\n' "$1" >&2
  exit 1
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --image-manifest) [[ "$#" -ge 2 && -z "$MANIFEST" ]] || fail INVALID_ARGUMENTS; MANIFEST="$2"; shift 2 ;;
    *) fail INVALID_ARGUMENTS ;;
  esac
done
[[ "$MANIFEST" == /* && -f "$MANIFEST" && ! -L "$MANIFEST" ]] || fail IMAGE_MANIFEST_INVALID
ARTIFACT_DIR="$(dirname "$MANIFEST")"
[[ "$(basename "$MANIFEST")" == gateway-image-manifest.json ]] || fail IMAGE_MANIFEST_NAME_INVALID
[[ "$(find "$ARTIFACT_DIR" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | sort | tr '\n' ' ')" == \
  "gateway-image-manifest.json gateway-image.tar gateway-image.tar.sha256 " ]] || fail ARTIFACT_FILE_SET_INVALID

command -v node >/dev/null 2>&1 || fail NODE_UNAVAILABLE
command -v sha256sum >/dev/null 2>&1 || fail SHA256SUM_UNAVAILABLE

cd "$ARTIFACT_DIR"
sha256sum --check --status gateway-image.tar.sha256 || fail ARCHIVE_HASH_MISMATCH
cd "$ROOT_DIR"

json_field() {
  node --input-type=module - "$1" "$2" <<'NODE'
import { readFileSync } from "node:fs";
const [path, field] = process.argv.slice(2);
const value = field.split(".").reduce((current, key) => current?.[key], JSON.parse(readFileSync(path, "utf8")));
if (typeof value !== "string" && typeof value !== "number") process.exit(2);
process.stdout.write(String(value));
NODE
}

[[ "$(json_field "$MANIFEST" manifestKind)" == gateway-image-v1 ]] || fail MANIFEST_KIND_INVALID
SOURCE_COMMIT="$(json_field "$MANIFEST" sourceCommit)"
IMAGE_ID="$(json_field "$MANIFEST" imageId)"
ARCHIVE_SHA="$(json_field "$MANIFEST" archiveSha256)"
CLIENT_VERSION="$(json_field "$MANIFEST" clientDatabaseVersion)"
CAPABILITY_SHA="$(json_field "$MANIFEST" releaseCapabilityReceiptSha256)"
RELEASE_INPUTS_SHA="$(json_field "$MANIFEST" releaseBuildInputsSha256)"
BUILD_INPUT_TREE_HASH="$(json_field "$MANIFEST" buildInputTreeHash)"
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ && "$SOURCE_COMMIT" == "$(git rev-parse HEAD)" ]] || fail SOURCE_COMMIT_MISMATCH
[[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ && "$ARCHIVE_SHA" =~ ^[0-9a-f]{64}$ ]] || fail IMAGE_ID_OR_ARCHIVE_HASH_INVALID
[[ "$ARCHIVE_SHA" == "$(sha256sum "$ARTIFACT_DIR/gateway-image.tar" | awk '{print $1}')" ]] || fail MANIFEST_ARCHIVE_HASH_MISMATCH

VERIFY_ROOT="$(mktemp -d /tmp/family-ai-ci-verify.XXXXXXXX)"
RUNTIME_ROOT="$(mktemp -d /tmp/family-ai-ci-runtime.XXXXXXXX)"
chmod 700 "$VERIFY_ROOT" "$RUNTIME_ROOT"
PROJECT_NAME="faici${GITHUB_RUN_ID:-0}${GITHUB_RUN_ATTEMPT:-0}${RANDOM}"
PROJECT_NAME="${PROJECT_NAME,,}"
PROJECT_NAME="${PROJECT_NAME:0:40}"
cleanup() {
  local status=$?
  if [[ -f "$RUNTIME_ROOT/run/compose.isolated.yaml" && -f "$RUNTIME_ROOT/config/compose.env" ]]; then
    docker compose --project-name "$PROJECT_NAME" \
      --env-file "$RUNTIME_ROOT/config/compose.env" \
      --file "$RUNTIME_ROOT/run/compose.isolated.yaml" \
      down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  find "$VERIFY_ROOT" -depth -mindepth 1 -delete 2>/dev/null || true
  rmdir "$VERIFY_ROOT" 2>/dev/null || true
  find "$RUNTIME_ROOT" -depth -mindepth 1 -delete 2>/dev/null || true
  rmdir "$RUNTIME_ROOT" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

node "$ROOT_DIR/scripts/gateway-schema-capabilities.mjs" validate \
  --schema-registry "$ROOT_DIR/scripts/gateway-schema-capabilities.json" \
  --release-capabilities "$ROOT_DIR/scripts/gateway-release-capabilities.json" \
  --database-source "$ROOT_DIR/apps/gateway/src/database.ts" \
  --client-cache-source "$ROOT_DIR/apps/gateway/member-public/cache.js" \
  --output "$VERIFY_ROOT/capability.json" >/dev/null
[[ "$(awk 'NR==1 {print $1}' "$VERIFY_ROOT/capability.json.sha256")" == "$CAPABILITY_SHA" ]] \
  || fail CAPABILITY_RECEIPT_MISMATCH
node "$ROOT_DIR/scripts/release-build-inputs.mjs" validate \
  --repository "$ROOT_DIR" \
  --source-commit "$SOURCE_COMMIT" \
  --manifest "$ROOT_DIR/scripts/release-build-inputs.json" \
  --output "$VERIFY_ROOT/build-inputs.json" >/dev/null
[[ "$(json_field "$VERIFY_ROOT/build-inputs.json" releaseBuildInputsSha256)" == "$RELEASE_INPUTS_SHA" ]] \
  || fail RELEASE_INPUTS_MISMATCH
[[ "$(json_field "$VERIFY_ROOT/build-inputs.json" buildInputTreeHash)" == "$BUILD_INPUT_TREE_HASH" ]] \
  || fail BUILD_INPUT_TREE_MISMATCH

command -v docker >/dev/null 2>&1 || fail DOCKER_UNAVAILABLE
docker load --input "$ARTIFACT_DIR/gateway-image.tar" >/dev/null
[[ "$(docker image inspect --format '{{.Id}}' "$IMAGE_ID" 2>/dev/null || true)" == "$IMAGE_ID" ]] \
  || fail LOADED_IMAGE_ID_MISMATCH
label() { docker image inspect --format "{{index .Config.Labels \"$1\"}}" "$IMAGE_ID"; }
[[ "$(label org.opencontainers.image.revision)" == "$SOURCE_COMMIT" ]] || fail REVISION_LABEL_MISMATCH
[[ "$(label org.architectureworld.family-ai.client-database-version)" == "$CLIENT_VERSION" ]] || fail CLIENT_LABEL_MISMATCH
[[ "$(label org.architectureworld.family-ai.release-capability-receipt-sha256)" == "$CAPABILITY_SHA" ]] || fail CAPABILITY_LABEL_MISMATCH
[[ "$(label org.architectureworld.family-ai.release-build-inputs-sha256)" == "$RELEASE_INPUTS_SHA" ]] || fail INPUT_LABEL_MISMATCH
[[ "$(label org.architectureworld.family-ai.build-input-tree-hash)" == "$BUILD_INPUT_TREE_HASH" ]] || fail TREE_LABEL_MISMATCH

FAMILY_AI_RUNTIME_ROOT="$RUNTIME_ROOT" \
COMPOSE_PROJECT_NAME="$PROJECT_NAME" \
FAMILY_AI_HOST_PORT=0 \
FAMILY_AI_IMAGE_REF="$IMAGE_ID" \
FAMILY_AI_IMAGE_MANIFEST="$MANIFEST" \
  bash "$ROOT_DIR/scripts/dev-up.sh" >/dev/null

CONTAINER_ID="$(docker compose --project-name "$PROJECT_NAME" \
  --env-file "$RUNTIME_ROOT/config/compose.env" \
  --file "$RUNTIME_ROOT/run/compose.isolated.yaml" ps -q gateway)"
[[ "$CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] || fail CONTAINER_ID_INVALID
[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$CONTAINER_ID")" == true ]] || fail ROOT_NOT_READ_ONLY
CONTAINER_USER="$(docker inspect --format '{{.Config.User}}' "$CONTAINER_ID")"
[[ "$CONTAINER_USER" =~ ^[1-9][0-9]*(:[0-9]+)?$ ]] || fail CONTAINER_RUNS_AS_ROOT
docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$CONTAINER_ID" | grep -Fq 'no-new-privileges:true' \
  || fail NO_NEW_PRIVILEGES_MISSING

FAMILY_AI_RUNTIME_ROOT="$RUNTIME_ROOT" COMPOSE_PROJECT_NAME="$PROJECT_NAME" \
  bash "$ROOT_DIR/scripts/acceptance-container-attachments.sh" >/dev/null

printf 'CI container smoke passed: source=%s image=%s attachmentRestart=passed\n' "$SOURCE_COMMIT" "$IMAGE_ID"
