#!/usr/bin/env bash
set -euo pipefail
{ set +x; } 2>/dev/null
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf 'GATEWAY_IMAGE_BUILD_FAILED:%s\n' "$1" >&2
  exit 1
}

SOURCE_INPUT=""
EXPECTED_INPUT=""
OUTPUT_DIR=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --source-commit) [[ "$#" -ge 2 && -z "$SOURCE_INPUT" ]] || fail INVALID_ARGUMENTS; SOURCE_INPUT="$2"; shift 2 ;;
    --expected-source-commit) [[ "$#" -ge 2 && -z "$EXPECTED_INPUT" ]] || fail INVALID_ARGUMENTS; EXPECTED_INPUT="$2"; shift 2 ;;
    --output-dir) [[ "$#" -ge 2 && -z "$OUTPUT_DIR" ]] || fail INVALID_ARGUMENTS; OUTPUT_DIR="$2"; shift 2 ;;
    *) fail INVALID_ARGUMENTS ;;
  esac
done
[[ -n "$SOURCE_INPUT" && -n "$EXPECTED_INPUT" && -n "$OUTPUT_DIR" ]] || fail MISSING_ARGUMENT
[[ "$SOURCE_INPUT" =~ ^[0-9a-f]{40}$ ]] || fail SOURCE_COMMIT_INVALID
[[ "$EXPECTED_INPUT" =~ ^[0-9a-f]{40}$ ]] || fail EXPECTED_SOURCE_COMMIT_INVALID
[[ "$OUTPUT_DIR" == /* && "$OUTPUT_DIR" != / && "$OUTPUT_DIR" != "$ROOT_DIR" && "$OUTPUT_DIR" != "$HOME" ]] \
  || fail OUTPUT_PATH_UNSAFE
[[ ! -e "$OUTPUT_DIR" && ! -L "$OUTPUT_DIR" ]] || fail OUTPUT_MUST_BE_NEW
OUTPUT_PARENT="$(dirname "$OUTPUT_DIR")"
[[ -d "$OUTPUT_PARENT" && ! -L "$OUTPUT_PARENT" ]] || fail OUTPUT_PARENT_INVALID
[[ "$(realpath "$OUTPUT_PARENT")/$(basename "$OUTPUT_DIR")" == "$OUTPUT_DIR" ]] || fail OUTPUT_PATH_NOT_CANONICAL

command -v git >/dev/null 2>&1 || fail GIT_UNAVAILABLE
command -v node >/dev/null 2>&1 || fail NODE_UNAVAILABLE
command -v sha256sum >/dev/null 2>&1 || fail SHA256SUM_UNAVAILABLE

SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse --verify "$SOURCE_INPUT^{commit}" 2>/dev/null || true)"
EXPECTED_COMMIT="$(git -C "$ROOT_DIR" rev-parse --verify "$EXPECTED_INPUT^{commit}" 2>/dev/null || true)"
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail SOURCE_COMMIT_INVALID
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail EXPECTED_SOURCE_COMMIT_INVALID
[[ "$SOURCE_COMMIT" == "$EXPECTED_COMMIT" ]] || fail SOURCE_COMMIT_MISMATCH
command -v docker >/dev/null 2>&1 || fail DOCKER_UNAVAILABLE

TEMP_ROOT="$(mktemp -d /tmp/family-ai-gateway-build.XXXXXXXX)"
chmod 700 "$TEMP_ROOT"
WORKTREE_DIR="$TEMP_ROOT/source"
RECEIPT_DIR="$TEMP_ROOT/receipts"
mkdir -m 700 "$RECEIPT_DIR"
OUTPUT_CREATED=false
WORKTREE_CREATED=false
cleanup() {
  local status=$?
  if [[ "$WORKTREE_CREATED" == true ]]; then
    git -C "$ROOT_DIR" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
  fi
  if [[ "$status" -ne 0 && "$OUTPUT_CREATED" == true && -d "$OUTPUT_DIR" && ! -L "$OUTPUT_DIR" ]]; then
    find "$OUTPUT_DIR" -depth -mindepth 1 -delete 2>/dev/null || true
    rmdir "$OUTPUT_DIR" 2>/dev/null || true
  fi
  find "$TEMP_ROOT" -depth -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TEMP_ROOT" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

git -C "$ROOT_DIR" worktree add --detach "$WORKTREE_DIR" "$SOURCE_COMMIT" >/dev/null
WORKTREE_CREATED=true
[[ -z "$(git -C "$WORKTREE_DIR" status --porcelain=v1 --untracked-files=all)" ]] || fail DETACHED_WORKTREE_NOT_CLEAN
[[ "$(git -C "$WORKTREE_DIR" rev-parse HEAD)" == "$SOURCE_COMMIT" ]] || fail DETACHED_WORKTREE_COMMIT_MISMATCH
if [[ -f "$WORKTREE_DIR/.gitmodules" ]]; then
  fail SUBMODULES_NOT_ALLOWED
fi

CAPABILITY_RECEIPT="$RECEIPT_DIR/gateway-capability-receipt.json"
node "$WORKTREE_DIR/scripts/gateway-schema-capabilities.mjs" validate \
  --schema-registry "$WORKTREE_DIR/scripts/gateway-schema-capabilities.json" \
  --release-capabilities "$WORKTREE_DIR/scripts/gateway-release-capabilities.json" \
  --database-source "$WORKTREE_DIR/apps/gateway/src/database.ts" \
  --client-cache-source "$WORKTREE_DIR/apps/gateway/member-public/cache.js" \
  --output "$CAPABILITY_RECEIPT" >/dev/null
CAPABILITY_SHA="$(awk 'NR==1 {print $1}' "$CAPABILITY_RECEIPT.sha256")"
[[ "$CAPABILITY_SHA" =~ ^[0-9a-f]{64}$ ]] || fail CAPABILITY_RECEIPT_HASH_INVALID

INPUT_RECEIPT="$RECEIPT_DIR/release-build-input-tree.json"
node "$WORKTREE_DIR/scripts/release-build-inputs.mjs" validate \
  --repository "$WORKTREE_DIR" \
  --source-commit "$SOURCE_COMMIT" \
  --manifest "$WORKTREE_DIR/scripts/release-build-inputs.json" \
  --output "$INPUT_RECEIPT" >/dev/null

json_field() {
  node --input-type=module - "$1" "$2" <<'NODE'
import { readFileSync } from "node:fs";
const [path, field] = process.argv.slice(2);
const value = field.split(".").reduce((current, key) => current?.[key], JSON.parse(readFileSync(path, "utf8")));
if (typeof value !== "string" && typeof value !== "number") process.exit(2);
process.stdout.write(String(value));
NODE
}

CLIENT_VERSION="$(json_field "$CAPABILITY_RECEIPT" release.clientDatabaseVersion)"
[[ "$CLIENT_VERSION" =~ ^[1-9][0-9]*$ ]] || fail CLIENT_DATABASE_VERSION_INVALID
RELEASE_INPUTS_SHA="$(json_field "$INPUT_RECEIPT" releaseBuildInputsSha256)"
BUILD_INPUT_TREE_HASH="$(json_field "$INPUT_RECEIPT" buildInputTreeHash)"
PLATFORM="$(json_field "$INPUT_RECEIPT" buildMaterials.platform)"
BASE_REF="$(json_field "$INPUT_RECEIPT" buildMaterials.baseImageRef)"
BASE_DIGEST="$(json_field "$INPUT_RECEIPT" buildMaterials.baseImageDigest)"
DEBIAN_SNAPSHOT="$(json_field "$INPUT_RECEIPT" buildMaterials.debianSnapshot)"
DEBIAN_SECURITY_SNAPSHOT="$(json_field "$INPUT_RECEIPT" buildMaterials.debianSecuritySnapshot)"
PYTHON3_VERSION="$(json_field "$INPUT_RECEIPT" buildMaterials.toolchainPackages.python3)"
MAKE_VERSION="$(json_field "$INPUT_RECEIPT" buildMaterials.toolchainPackages.make)"
GXX_VERSION="$(json_field "$INPUT_RECEIPT" buildMaterials.toolchainPackages.g++)"
GIT_VERSION="$(json_field "$INPUT_RECEIPT" buildMaterials.toolchainPackages.git)"
TOOLCHAIN_MATERIAL="python3=$PYTHON3_VERSION;make=$MAKE_VERSION;g++=$GXX_VERSION;git=$GIT_VERSION"
[[ "$PLATFORM" == linux/amd64 && "$BASE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || fail BASE_MATERIAL_INVALID

docker pull --platform "$PLATFORM" "$BASE_REF@$BASE_DIGEST" >/dev/null
RESOLVED_BASE="$(docker image inspect --format '{{.Id}}' "$BASE_REF@$BASE_DIGEST")"
[[ "$RESOLVED_BASE" =~ ^sha256:[0-9a-f]{64}$ ]] || fail BASE_IMAGE_RESOLUTION_FAILED

IMAGE_TAG="family-ai-platform/gateway:$SOURCE_COMMIT"
docker build --platform "$PLATFORM" --pull=false \
  --build-arg "SOURCE_COMMIT=$SOURCE_COMMIT" \
  --build-arg "CLIENT_DATABASE_VERSION=$CLIENT_VERSION" \
  --build-arg "RELEASE_CAPABILITY_RECEIPT_SHA256=$CAPABILITY_SHA" \
  --build-arg "RELEASE_BUILD_INPUTS_SHA256=$RELEASE_INPUTS_SHA" \
  --build-arg "BUILD_INPUT_TREE_HASH=$BUILD_INPUT_TREE_HASH" \
  --build-arg "BASE_IMAGE_DIGEST=$BASE_DIGEST" \
  --build-arg "TARGET_PLATFORM=$PLATFORM" \
  --build-arg "DEBIAN_SNAPSHOT=$DEBIAN_SNAPSHOT" \
  --build-arg "DEBIAN_SECURITY_SNAPSHOT=$DEBIAN_SECURITY_SNAPSHOT" \
  --build-arg "PYTHON3_VERSION=$PYTHON3_VERSION" \
  --build-arg "MAKE_VERSION=$MAKE_VERSION" \
  --build-arg "GXX_VERSION=$GXX_VERSION" \
  --build-arg "GIT_VERSION=$GIT_VERSION" \
  --build-arg "TOOLCHAIN_MATERIAL=$TOOLCHAIN_MATERIAL" \
  --tag "$IMAGE_TAG" "$WORKTREE_DIR"

IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")"
[[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || fail IMAGE_ID_INVALID
inspect_label() {
  docker image inspect --format "{{index .Config.Labels \"$1\"}}" "$IMAGE_ID"
}
[[ "$(inspect_label org.opencontainers.image.revision)" == "$SOURCE_COMMIT" ]] || fail REVISION_LABEL_MISMATCH
[[ "$(inspect_label org.architectureworld.family-ai.client-database-version)" == "$CLIENT_VERSION" ]] || fail CLIENT_VERSION_LABEL_MISMATCH
[[ "$(inspect_label org.architectureworld.family-ai.release-capability-receipt-sha256)" == "$CAPABILITY_SHA" ]] || fail CAPABILITY_LABEL_MISMATCH
[[ "$(inspect_label org.architectureworld.family-ai.release-build-inputs-sha256)" == "$RELEASE_INPUTS_SHA" ]] || fail BUILD_INPUT_MANIFEST_LABEL_MISMATCH
[[ "$(inspect_label org.architectureworld.family-ai.build-input-tree-hash)" == "$BUILD_INPUT_TREE_HASH" ]] || fail BUILD_INPUT_TREE_LABEL_MISMATCH
[[ "$(inspect_label org.architectureworld.family-ai.base-image-digest)" == "$BASE_DIGEST" ]] || fail BASE_DIGEST_LABEL_MISMATCH
[[ "$(inspect_label org.architectureworld.family-ai.target-platform)" == "$PLATFORM" ]] || fail PLATFORM_LABEL_MISMATCH
[[ "$(inspect_label org.architectureworld.family-ai.debian-snapshot)" == "$DEBIAN_SNAPSHOT" ]] || fail SNAPSHOT_LABEL_MISMATCH
[[ "$(inspect_label org.architectureworld.family-ai.toolchain-material)" == "$TOOLCHAIN_MATERIAL" ]] || fail TOOLCHAIN_LABEL_MISMATCH

mkdir -m 700 "$OUTPUT_DIR"
OUTPUT_CREATED=true
ARCHIVE="$OUTPUT_DIR/gateway-image.tar"
docker save --output "$ARCHIVE" "$IMAGE_ID"
ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
printf '%s  gateway-image.tar\n' "$ARCHIVE_SHA" > "$OUTPUT_DIR/gateway-image.tar.sha256"
chmod 600 "$ARCHIVE" "$OUTPUT_DIR/gateway-image.tar.sha256"
REPO_DIGESTS="$(docker image inspect --format '{{json .RepoDigests}}' "$IMAGE_ID")"

node --input-type=module - \
  "$OUTPUT_DIR/gateway-image-manifest.json" "$SOURCE_COMMIT" "$IMAGE_ID" "$ARCHIVE_SHA" \
  "$CLIENT_VERSION" "$CAPABILITY_SHA" "$RELEASE_INPUTS_SHA" "$BUILD_INPUT_TREE_HASH" \
  "$BASE_REF" "$BASE_DIGEST" "$PLATFORM" "$RESOLVED_BASE" "$DEBIAN_SNAPSHOT" \
  "$DEBIAN_SECURITY_SNAPSHOT" "$TOOLCHAIN_MATERIAL" "$REPO_DIGESTS" <<'NODE'
import { chmodSync, writeFileSync } from "node:fs";
const [
  path, sourceCommit, imageId, archiveSha256, clientVersion, capabilitySha,
  releaseInputsSha, inputTreeHash, baseRef, baseDigest, platform, resolvedBase,
  debianSnapshot, debianSecuritySnapshot, toolchainMaterial, repoDigestsJson
] = process.argv.slice(2);
const labels = {
  "org.opencontainers.image.revision": sourceCommit,
  "org.architectureworld.family-ai.client-database-version": clientVersion,
  "org.architectureworld.family-ai.release-capability-receipt-sha256": capabilitySha,
  "org.architectureworld.family-ai.release-build-inputs-sha256": releaseInputsSha,
  "org.architectureworld.family-ai.build-input-tree-hash": inputTreeHash,
  "org.architectureworld.family-ai.base-image-digest": baseDigest,
  "org.architectureworld.family-ai.target-platform": platform,
  "org.architectureworld.family-ai.debian-snapshot": debianSnapshot,
  "org.architectureworld.family-ai.toolchain-material": toolchainMaterial
};
const manifest = {
  manifestKind: "gateway-image-v1",
  sourceCommit,
  imageId,
  archiveSha256,
  clientDatabaseVersion: Number(clientVersion),
  releaseCapabilityReceiptSha256: capabilitySha,
  releaseBuildInputsSha256: releaseInputsSha,
  buildInputTreeHash: inputTreeHash,
  baseImageRef: baseRef,
  baseImageDigest: baseDigest,
  baseImagePlatform: platform,
  buildStageResolvedImageId: resolvedBase,
  runtimeStageResolvedImageId: resolvedBase,
  debianSnapshot,
  debianSecuritySnapshot,
  toolchainMaterial,
  labels,
  repoDigests: JSON.parse(repoDigestsJson ?? "null")
};
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
chmodSync(path, 0o600);
NODE

[[ "$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | sort | tr '\n' ' ')" == \
  "gateway-image-manifest.json gateway-image.tar gateway-image.tar.sha256 " ]] || fail ARTIFACT_CONTRACT_INVALID
printf 'Gateway image artifact ready: source=%s image=%s archiveSha256=%s\n' "$SOURCE_COMMIT" "$IMAGE_ID" "$ARCHIVE_SHA"
trap - EXIT
git -C "$ROOT_DIR" worktree remove --force "$WORKTREE_DIR" >/dev/null
WORKTREE_CREATED=false
find "$TEMP_ROOT" -depth -mindepth 1 -delete
rmdir "$TEMP_ROOT"
