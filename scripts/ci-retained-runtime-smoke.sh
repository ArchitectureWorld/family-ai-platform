#!/usr/bin/env bash
set -euo pipefail
{ set +x; } 2>/dev/null
umask 077

fail() { printf 'CI_RETAINED_SMOKE_FAILED:%s\n' "$1" >&2; exit 1; }
repository=""
source_commit=""
image_artifact=""
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || fail ARGUMENTS_INVALID
  case "$1" in
    --repository) [[ -z "$repository" ]] || fail ARGUMENTS_INVALID; repository="$2" ;;
    --source-commit) [[ -z "$source_commit" ]] || fail ARGUMENTS_INVALID; source_commit="$2" ;;
    --image-artifact) [[ -z "$image_artifact" ]] || fail ARGUMENTS_INVALID; image_artifact="$2" ;;
    *) fail ARGUMENTS_INVALID ;;
  esac
  shift 2
done
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || fail SOURCE_INVALID
for path in "$repository" "$image_artifact"; do
  [[ "$path" == /* && -d "$path" && ! -L "$path" && "$(realpath -- "$path")" == "$path" ]] || fail INPUT_PATH_INVALID
done
[[ "$(git -C "$repository" rev-parse HEAD)" == "$source_commit" ]] || fail SOURCE_MISMATCH
for command in sudo setpriv docker npm node git stat realpath; do
  command -v "$command" >/dev/null || fail REQUIRED_TOOL_UNAVAILABLE
done
# Use the existing rootful daemon and exactly the runner's existing Docker group.
# No Docker socket is mounted in a new container and no account/group is changed.
[[ -S /var/run/docker.sock && ! -L /var/run/docker.sock ]] || fail ROOTFUL_SOCKET_REQUIRED
read -r socket_uid socket_gid socket_mode < <(stat -c '%u %g %a' /var/run/docker.sock)
[[ "$socket_uid" == 0 && "$socket_gid" =~ ^[1-9][0-9]*$ && "$socket_mode" == 660 ]] || fail SOCKET_METADATA_INVALID
[[ "$(id -u)" == 0 || " $(id -G) " == *" $socket_gid "* ]] || fail EXISTING_DOCKER_GROUP_REQUIRED
docker_security="$(DOCKER_HOST=unix:///var/run/docker.sock docker info --format '{{json .SecurityOptions}}')" || fail ROOTFUL_DOCKER_UNAVAILABLE
[[ "$docker_security" != *rootless* ]] || fail ROOTFUL_DOCKER_REQUIRED
sudo -n true || fail SUDO_REQUIRED
[[ "$(sudo -n setpriv --reuid=1000 --regid=1000 --groups="$socket_gid" -- id -u)" == 1000 ]] || fail FIXED_UID_UNAVAILABLE

fixture_root="$(mktemp -d /tmp/family-ai-retained-ci.XXXXXXXX)"
fixture_identity="$(stat -c '%d:%i' "$fixture_root")"
cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$fixture_root" =~ ^/tmp/family-ai-retained-ci\.[A-Za-z0-9]{8}$ && -d "$fixture_root" && ! -L "$fixture_root" \
    && "$(realpath -- "$fixture_root")" == "$fixture_root" \
    && "$(stat -c '%d:%i' "$fixture_root")" == "$fixture_identity" ]]; then
    # find -P never follows any child symlink. Only this captured temporary inode is removed.
    sudo -n find -P "$fixture_root" -depth -mindepth 1 -delete
    sudo -n rmdir -- "$fixture_root"
  else
    printf 'CI_RETAINED_SMOKE_FAILED:CLEANUP_IDENTITY_INVALID\n' >&2
    result=1
  fi
  exit "$result"
}
trap cleanup EXIT
git clone --quiet --no-hardlinks -- "$repository" "$fixture_root/source"
git -C "$fixture_root/source" checkout --quiet --detach "$source_commit"
[[ "$(git -C "$fixture_root/source" rev-parse HEAD)" == "$source_commit" ]] || fail CLONE_IDENTITY_INVALID
mkdir -m 700 "$fixture_root/image" "$fixture_root/docker-config" "$fixture_root/npm-cache"
for name in gateway-image.tar gateway-image.tar.sha256 gateway-image-manifest.json gateway-image-manifest.json.sha256 gateway-runtime-tools.json gateway-runtime-tools.json.sha256; do
  [[ -f "$image_artifact/$name" && ! -L "$image_artifact/$name" ]] || fail ARTIFACT_FILE_INVALID
  cp -- "$image_artifact/$name" "$fixture_root/image/$name"
  chmod 600 "$fixture_root/image/$name"
done
node --input-type=module - "$fixture_root/image" <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";
for (const name of ["gateway-image.tar", "gateway-image-manifest.json", "gateway-runtime-tools.json"]) {
  const line = readFileSync(join(process.argv[2], name + ".sha256"), "utf8");
  const hash = line.slice(0, 64);
  if (!/^[0-9a-f]{64}$/.test(hash) || line !== `${hash}  ${name}\n`) process.exit(1);
}
NODE
(
  cd "$fixture_root/image"
  sha256sum --check --status gateway-image.tar.sha256 gateway-image-manifest.json.sha256 gateway-runtime-tools.json.sha256
) || fail ARTIFACT_HASH_INVALID
node -e 'const v=require(process.argv[1]);if(v.sourceCommit!==process.argv[2]||v.protectedWalRecoveryV1!==true)process.exit(1)' \
  "$fixture_root/image/gateway-image-manifest.json" "$source_commit" || fail ARTIFACT_SOURCE_INVALID
(
  cd "$fixture_root/source"
  npm --cache "$fixture_root/npm-cache" ci
  npm --cache "$fixture_root/npm-cache" run build
)
DOCKER_HOST=unix:///var/run/docker.sock docker load --input "$fixture_root/image/gateway-image.tar" >/dev/null
# All ownership changes are confined to the fresh captured temporary root.
[[ ! -L "$fixture_root" && "$(stat -c '%d:%i' "$fixture_root")" == "$fixture_identity" ]] || fail FIXTURE_IDENTITY_INVALID
sudo -n chown -hR 1000:1000 -- "$fixture_root"
sudo -n setpriv --reuid=1000 --regid=1000 --groups="$socket_gid" -- \
  env "PATH=$PATH" "DOCKER_CONFIG=$fixture_root/docker-config" DOCKER_HOST=unix:///var/run/docker.sock \
  bash -c 'cd "$1" && exec bash scripts/test-runtime-backup-restore.sh --real-image-manifest "$2"' \
  ci-retained "$fixture_root/source" "$fixture_root/image/gateway-image-manifest.json"
printf 'CI retained runtime smoke passed: fixedUid=1000 fixedGid=1000 isolatedSource=true\n'
