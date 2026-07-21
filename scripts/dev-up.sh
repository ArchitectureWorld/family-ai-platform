#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
CONFIG_DIR="$RUNTIME_DIR/config"
DATA_DIR="$RUNTIME_DIR/data"
TOKEN_FILE="$CONFIG_DIR/device-token"
GATEWAY_ENV="$CONFIG_DIR/gateway.env"
COMPOSE_ENV="$CONFIG_DIR/compose.env"
DATABASE_FILE="$DATA_DIR/gateway.sqlite"
BASE_URL="http://127.0.0.1:8790"
SERVICE_ID="family-ai-gateway-foundation"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

health_matches() {
  local response
  response="$(curl --silent --show-error --max-time 2 "$BASE_URL/health" 2>/dev/null || true)"
  [[ "$response" == *'"service":"family-ai-gateway-foundation"'* ]]
}

command -v docker >/dev/null 2>&1 || fail "未找到 Docker。请先安装 Docker Engine 或 Docker Desktop。"
docker compose version >/dev/null 2>&1 || fail "当前 Docker 不支持 'docker compose'。"
command -v curl >/dev/null 2>&1 || fail "未找到 curl，无法执行健康检查。"
command -v od >/dev/null 2>&1 || fail "未找到 od，无法生成安全开发 Token。"

umask 077
mkdir -p "$CONFIG_DIR" "$DATA_DIR"
chmod 700 "$RUNTIME_DIR" "$CONFIG_DIR" "$DATA_DIR"

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

cd "$ROOT_DIR"
printf 'Building and starting Family AI Gateway Foundation...\n'
docker compose --env-file "$COMPOSE_ENV" up -d --build

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

ACCEPTANCE_URL="$BASE_URL/#token=$DEVICE_TOKEN&device=device%3Atest"

cat <<EOF

Family AI Gateway Foundation 已启动。

体验验收页面：
$ACCEPTANCE_URL

自动验收：
./scripts/acceptance.sh

停止但保留数据：
./scripts/dev-down.sh

清空一次性开发数据：
./scripts/dev-reset.sh
EOF

if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$ACCEPTANCE_URL" >/dev/null 2>&1 || true
  elif command -v gio >/dev/null 2>&1; then
    gio open "$ACCEPTANCE_URL" >/dev/null 2>&1 || true
  fi
fi
