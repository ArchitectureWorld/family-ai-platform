#!/usr/bin/env bash
set -euo pipefail

{ set +x; } 2>/dev/null

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_ID="family-ai-gateway-foundation"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

source "$ROOT_DIR/scripts/runtime-isolation-lib.sh"

ISOLATED_MODE=false
if [[ -n "${FAMILY_AI_RUNTIME_ROOT:-}${COMPOSE_PROJECT_NAME:-}${FAMILY_AI_HOST_PORT:-}${FAMILY_AI_IMAGE_REF:-}${FAMILY_AI_IMAGE_MANIFEST:-}" ]]; then
  for required in FAMILY_AI_RUNTIME_ROOT COMPOSE_PROJECT_NAME FAMILY_AI_HOST_PORT FAMILY_AI_IMAGE_REF FAMILY_AI_IMAGE_MANIFEST; do
    [[ -n "${!required:-}" ]] || fail "隔离模式缺少 $required。"
  done
  ISOLATED_MODE=true
fi

if [[ "$ISOLATED_MODE" == true ]]; then
  validate_isolated_runtime_path "$FAMILY_AI_RUNTIME_ROOT"
  validate_isolated_project "$COMPOSE_PROJECT_NAME"
  [[ "$FAMILY_AI_HOST_PORT" == "0" ]] || fail "隔离模式 FAMILY_AI_HOST_PORT 必须为 0。"
  [[ "$FAMILY_AI_IMAGE_REF" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "FAMILY_AI_IMAGE_REF 必须是不可变 sha256 image ID。"
  RUNTIME_DIR="$FAMILY_AI_RUNTIME_ROOT"
  ISOLATED_PROJECT="$COMPOSE_PROJECT_NAME"
else
  RUNTIME_DIR="$ROOT_DIR/.runtime"
fi

CONFIG_DIR="$RUNTIME_DIR/config"
DATA_DIR="$RUNTIME_DIR/data"
ATTACHMENT_DIR="$DATA_DIR/attachments"
RUN_DIR="$RUNTIME_DIR/run"
TOKEN_FILE="$CONFIG_DIR/device-token"
GATEWAY_ENV="$CONFIG_DIR/gateway.env"
COMPOSE_ENV="$CONFIG_DIR/compose.env"
DATABASE_FILE="$DATA_DIR/gateway.sqlite"
ISOLATED_COMPOSE_FILE="$RUN_DIR/compose.isolated.yaml"
ISOLATED_MANIFEST="$RUN_DIR/isolated-runtime-manifest.json"
BASE_URL="http://127.0.0.1:8790"
ISOLATED_CREATED=false

cleanup_isolated_failure() {
  local status=$?
  if [[ "$status" -ne 0 && "$ISOLATED_MODE" == true && "$ISOLATED_CREATED" == true ]]; then
    isolated_compose down --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup_isolated_failure EXIT

health_matches() {
  local response
  response="$(curl --silent --show-error --max-time 2 "$BASE_URL/health" 2>/dev/null || true)"
  [[ "$response" == *'"service":"family-ai-gateway-foundation"'* ]]
}

command -v docker >/dev/null 2>&1 || fail "未找到 Docker。请先安装 Docker Engine 或 Docker Desktop。"
docker compose version >/dev/null 2>&1 || fail "当前 Docker 不支持 'docker compose'。"
command -v curl >/dev/null 2>&1 || fail "未找到 curl，无法执行健康检查。"
command -v od >/dev/null 2>&1 || fail "未找到 od，无法生成安全开发 Token。"
command -v realpath >/dev/null 2>&1 || fail "未找到 realpath，无法校验隔离 runtime。"
command -v sha256sum >/dev/null 2>&1 || fail "未找到 sha256sum，无法保护正式 8790。"
command -v ss >/dev/null 2>&1 || fail "未找到 ss，无法保护正式 8790。"

umask 077
if [[ "$ISOLATED_MODE" == true ]]; then
  [[ "$FAMILY_AI_IMAGE_MANIFEST" == /* && -f "$FAMILY_AI_IMAGE_MANIFEST" && ! -L "$FAMILY_AI_IMAGE_MANIFEST" ]] \
    || fail "FAMILY_AI_IMAGE_MANIFEST 必须是绝对普通文件。"
  IMAGE_MANIFEST_SHA256="$(sha256sum "$FAMILY_AI_IMAGE_MANIFEST" | awk '{print $1}')"
  IMAGE_SOURCE_COMMIT="$(node --input-type=module - "$FAMILY_AI_IMAGE_MANIFEST" "$FAMILY_AI_IMAGE_REF" <<'NODE'
import { readFileSync } from "node:fs";
const [path, expectedImage] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(path, "utf8"));
const fail = () => process.exit(2);
if (
  manifest.manifestKind !== "gateway-image-v1" ||
  manifest.imageId !== expectedImage ||
  !/^[0-9a-f]{40}$/.test(manifest.sourceCommit ?? "") ||
  manifest.labels?.["org.opencontainers.image.revision"] !== manifest.sourceCommit ||
  manifest.labels?.["org.architectureworld.family-ai.client-database-version"] !== String(manifest.clientDatabaseVersion)
) fail();
process.stdout.write(manifest.sourceCommit);
NODE
)" || fail "Gateway image manifest 与 image ID/labels 不匹配。"
  FORMAL_8790_BEFORE="$(capture_formal_8790_identity)"
  if [[ -e "$RUNTIME_DIR" ]]; then
    [[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" ]] || fail "隔离 runtime 必须是普通目录。"
    require_runtime_mode "$RUNTIME_DIR"
    [[ -z "$(find "$RUNTIME_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail "dev-up 只接受不存在或空的隔离 runtime。"
  else
    mkdir -m 700 "$RUNTIME_DIR"
  fi
fi
# Initialization is limited to a new/empty disposable data directory. Existing
# databases remain subject to gateway-existing; missing files never imply reset.
INITIALIZE_DATABASE=false
for path in "$RUNTIME_DIR" "$CONFIG_DIR" "$DATA_DIR" "$ATTACHMENT_DIR" "$RUN_DIR" "$DATABASE_FILE" "$TOKEN_FILE"; do
  [[ ! -L "$path" ]] || fail "disposable runtime 不得包含符号链接。"
done
if [[ -e "$DATA_DIR" ]]; then
  [[ -d "$DATA_DIR" && -r "$DATA_DIR" && -x "$DATA_DIR" ]] \
    || fail "已有 data 目录不可安全检查；不会迁移或修改其所有权。"
  if [[ -e "$DATABASE_FILE" ]]; then
    [[ -f "$DATABASE_FILE" ]] || fail "已有数据库必须是普通文件。"
  else
    DATA_CONTENTS="$(find "$DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit)" \
      || fail "无法确认 data 目录为空。"
    [[ -z "$DATA_CONTENTS" ]] || fail "数据库缺失但 data 非空；不会自动迁移或清除保留数据。"
    INITIALIZE_DATABASE=true
  fi
else
  INITIALIZE_DATABASE=true
fi
mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$ATTACHMENT_DIR" "$RUN_DIR"
chmod 700 "$RUNTIME_DIR" "$CONFIG_DIR" "$DATA_DIR" "$ATTACHMENT_DIR" "$RUN_DIR"

if [[ -f "$DATABASE_FILE" && ! -f "$TOKEN_FILE" ]]; then
  fail "数据库存在但开发 Token 丢失。为避免静默重置身份，请执行 ./scripts/dev-reset.sh 后重新启动。"
fi

if [[ ! -f "$TOKEN_FILE" ]]; then
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
DEVICE_TOKEN="$(cat "$TOKEN_FILE")"
[[ ${#DEVICE_TOKEN} -ge 48 ]] || fail "生成的开发 Token 长度异常。"

cat > "$GATEWAY_ENV" <<EOF
GATEWAY_MODE=development
GATEWAY_PORT=8790
GATEWAY_DEVICE_TOKEN=$DEVICE_TOKEN
EOF
chmod 600 "$GATEWAY_ENV"

cat > "$COMPOSE_ENV" <<EOF
LOCAL_UID=$(id -u)
LOCAL_GID=$(id -g)
EOF
chmod 600 "$COMPOSE_ENV"

initialize_disposable_database() {
  local image_id="$1"
  [[ "$INITIALIZE_DATABASE" == true ]] || return 0
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "初始化必须使用已解析的不可变镜像。"
  [[ -d "$DATA_DIR" && ! -L "$DATA_DIR" && -d "$ATTACHMENT_DIR" && ! -L "$ATTACHMENT_DIR" && ! -e "$DATABASE_FILE" && ! -L "$DATABASE_FILE" ]] \
    || fail "初始化前 data 状态已变化；不会迁移已有数据库。"
  local unexpected_entries
  unexpected_entries="$(find "$DATA_DIR" -mindepth 1 ! -path "$ATTACHMENT_DIR" -print -quit)" \
    || fail "无法复核 disposable data 为空。"
  [[ -z "$unexpected_entries" ]] || fail "初始化前 data 出现保留内容；不会自动迁移。"
  if [[ "$(stat -c '%u:%g' "$DATA_DIR")" != "1000:1000" || "$(stat -c '%u:%g' "$ATTACHMENT_DIR")" != "1000:1000" ]]; then
    # Only these new empty directories may change owner. No recursive chown,
    # retained data, credentials, host socket, network, or additional mount.
    docker run --rm --network none --read-only --user 0:0 \
      --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE \
      --security-opt no-new-privileges:true --entrypoint python3 \
      --mount "type=bind,src=$DATA_DIR,dst=/app/.runtime/data" \
      "$image_id" -c '
import os, stat
from pathlib import Path
root = Path("/app/.runtime/data")
attachments = root / "attachments"
for path in (root, attachments):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700:
        raise SystemExit("DISPOSABLE_DATA_INVALID")
if {p.name for p in root.iterdir()} != {"attachments"} or any(attachments.iterdir()):
    raise SystemExit("DISPOSABLE_DATA_NOT_EMPTY")
for path in (attachments, root):
    os.chown(path, 1000, 1000, follow_symlinks=False)
'
  fi
  # Keep the image ENTRYPOINT: it claims the protected migration lock before
  # executing this CLI. The Gateway itself still refuses missing databases.
  docker run --rm --network none --read-only --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=64m,mode=1777 \
    --env GATEWAY_DATABASE_PATH=/app/.runtime/data/gateway.sqlite \
    --mount "type=bind,src=$DATA_DIR,dst=/app/.runtime/data" \
    "$image_id" node apps/gateway/dist/migrate.js \
    --database /app/.runtime/data/gateway.sqlite
}

cd "$ROOT_DIR"
printf 'Building and starting Family AI Gateway Foundation...\n'
if [[ "$ISOLATED_MODE" == true ]]; then
  RESOLVED_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$FAMILY_AI_IMAGE_REF" 2>/dev/null || true)"
  [[ "$RESOLVED_IMAGE_ID" == "$FAMILY_AI_IMAGE_REF" ]] || fail "隔离镜像不存在或 image ID 不匹配。"
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$ISOLATED_PROJECT")" ]] \
    || fail "隔离 Compose project 已存在资源。"
  cat > "$ISOLATED_COMPOSE_FILE" <<EOF
name: $ISOLATED_PROJECT
services:
  gateway:
    image: $FAMILY_AI_IMAGE_REF
    init: true
    restart: "no"
    user: "1000:1000"
    env_file:
      - $GATEWAY_ENV
    environment:
      GATEWAY_HOST: 0.0.0.0
      GATEWAY_CONTAINERIZED: "true"
      GATEWAY_DATABASE_PATH: /app/.runtime/data/gateway.sqlite
      FAMILY_AI_ATTACHMENT_ROOT: /app/.runtime/data/attachments
    ports:
      - "127.0.0.1::8790"
    volumes:
      - $DATA_DIR:/app/.runtime/data
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    security_opt:
      - no-new-privileges:true
EOF
  chmod 600 "$ISOLATED_COMPOSE_FILE"
  isolated_compose config --format json > "$RUN_DIR/compose.rendered.json"
  chmod 600 "$RUN_DIR/compose.rendered.json"
  validate_isolated_compose_json "$RUN_DIR/compose.rendered.json" "$FAMILY_AI_IMAGE_REF" "$DATA_DIR"
  initialize_disposable_database "$FAMILY_AI_IMAGE_REF"
  isolated_compose up -d --no-build
  ISOLATED_CREATED=true
  PORT_ROWS="$(isolated_compose port gateway 8790)"
  [[ "$(printf '%s\n' "$PORT_ROWS" | sed '/^$/d' | wc -l)" -eq 1 ]] \
    || fail "隔离 Gateway 必须解析到唯一端口。"
  [[ "$PORT_ROWS" =~ ^127\.0\.0\.1:([1-9][0-9]{0,4})$ ]] || fail "隔离 Gateway 端口必须是随机 loopback 端口。"
  ACTUAL_PORT="${BASH_REMATCH[1]}"
  [[ "$ACTUAL_PORT" != "8790" ]] || fail "隔离 Gateway 不得占用正式 8790。"
  BASE_URL="http://127.0.0.1:$ACTUAL_PORT"
else
  docker compose --env-file "$COMPOSE_ENV" build gateway
  DISPOSABLE_IMAGE="$(docker compose --env-file "$COMPOSE_ENV" config --format json \
    | node --input-type=module -e 'let text=""; for await (const chunk of process.stdin) text += chunk; const image=JSON.parse(text).services?.gateway?.image; if(typeof image !== "string" || !image) process.exit(1); process.stdout.write(image);')"
  DISPOSABLE_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$DISPOSABLE_IMAGE")"
  initialize_disposable_database "$DISPOSABLE_IMAGE_ID"
  docker compose --env-file "$COMPOSE_ENV" up -d --no-build
fi

printf 'Waiting for the Foundation Gateway health identity'
healthy=false
for _ in $(seq 1 60); do
  if health_matches; then
    healthy=true
    break
  fi
  printf '.'
  sleep 1
done
printf '\n'

if [[ "$healthy" != true ]]; then
  printf 'Port 8790 did not return service=%s.\n' "$SERVICE_ID" >&2
  printf 'Current response:\n' >&2
  curl --silent --show-error --max-time 2 "$BASE_URL/health" >&2 || true
  printf '\nContainers publishing port 8790:\n' >&2
  docker ps --filter publish=8790 --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}' >&2 || true
  docker compose --env-file "$COMPOSE_ENV" ps >&2 || true
  docker compose --env-file "$COMPOSE_ENV" logs --tail=120 gateway >&2 || true
  fail "8790 端口不是当前 Gateway Foundation，或服务未在 60 秒内启动。"
fi

if [[ "$ISOLATED_MODE" == true ]]; then
  CONTAINER_ID="$(isolated_compose ps -q gateway)"
  [[ "$CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] || fail "无法确认唯一隔离 Gateway 容器。"
  CONTAINER_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER_ID")"
  [[ "$CONTAINER_IMAGE_ID" == "$FAMILY_AI_IMAGE_REF" ]] || fail "隔离容器没有使用批准的不可变镜像。"
  NETWORK_NAME="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' "$CONTAINER_ID" | sed '/^$/d')"
  [[ "$(printf '%s\n' "$NETWORK_NAME" | wc -l)" -eq 1 && "$NETWORK_NAME" == "$ISOLATED_PROJECT"_* ]] \
    || fail "无法确认唯一隔离网络。"
  FORMAL_8790_AFTER="$(capture_formal_8790_identity)"
  [[ "$FORMAL_8790_AFTER" == "$FORMAL_8790_BEFORE" ]] || fail "正式 8790 身份在隔离启动期间发生变化。"
  RUNTIME_DEVICE="$(stat -c '%d' "$RUNTIME_DIR")"
  RUNTIME_INODE="$(stat -c '%i' "$RUNTIME_DIR")"
  node --input-type=module - "$ISOLATED_MANIFEST" "$ISOLATED_PROJECT" "$CONTAINER_ID" "$NETWORK_NAME" "$FAMILY_AI_IMAGE_REF" "$ACTUAL_PORT" "$RUNTIME_DEVICE" "$RUNTIME_INODE" "$FORMAL_8790_BEFORE" "$IMAGE_MANIFEST_SHA256" "$IMAGE_SOURCE_COMMIT" <<'NODE'
import { writeFileSync } from "node:fs";
const [path, project, containerId, network, imageId, port, runtimeDevice, runtimeInode, formal8790, gatewayImageManifestSha256, sourceCommit] = process.argv.slice(2);
writeFileSync(path, `${JSON.stringify({ project, containerId, network, imageId, port, runtimeDevice, runtimeInode, formal8790, gatewayImageManifestSha256, sourceCommit }, null, 2)}\n`, { mode: 0o600 });
NODE
  chmod 600 "$ISOLATED_MANIFEST"
fi

trap - EXIT

cat <<EOF

Family AI Gateway Foundation 已启动。

完整一键验收：
./scripts/verify-foundation.sh

单独运行旧消息内核验收：
./scripts/acceptance.sh

单独运行家庭初始化 API 验收：
bash ./scripts/acceptance-onboarding.sh

停止但保留数据：
./scripts/dev-down.sh

清空一次性开发数据：
./scripts/dev-reset.sh
EOF
