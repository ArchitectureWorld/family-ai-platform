#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
LOG_DIR="$RUNTIME_DIR/logs"
NODE_IMAGE="node:22.16.0-bookworm-slim"

fail() {
  printf 'FOUNDATION VERIFICATION FAILED: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "未找到 Docker。"
docker compose version >/dev/null 2>&1 || fail "当前 Docker 不支持 'docker compose'。"
command -v curl >/dev/null 2>&1 || fail "未找到 curl。"

umask 077
mkdir -p "$LOG_DIR"
chmod 700 "$RUNTIME_DIR" "$LOG_DIR"
cd "$ROOT_DIR"

printf '\n[1/4] Preparing the repository dependency lock...\n'
if [[ ! -f package-lock.json ]]; then
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp \
    --volume "$ROOT_DIR:/workspace" \
    --workdir /workspace \
    "$NODE_IMAGE" \
    npm install --package-lock-only --ignore-scripts \
    2>&1 | tee "$LOG_DIR/package-lock.log"

  [[ -f package-lock.json ]] || fail "Node 22.16.0 容器未生成 package-lock.json。"
  printf '\nA new package-lock.json was generated from this repository.\n'
  printf 'Review and commit it before the Foundation PR becomes Ready.\n'
else
  printf 'Using the existing package-lock.json.\n'
fi

printf '\n[2/4] Building and verifying the Docker image...\n'
printf 'The Docker build runs npm ci, all tests, static checks, type checking, and builds.\n'
docker compose build 2>&1 | tee "$LOG_DIR/docker-build.log"

printf '\n[3/4] Starting the local Gateway...\n'
./scripts/dev-up.sh

printf '\n[4/4] Running the full scripted acceptance journey...\n'
./scripts/acceptance.sh 2>&1 | tee "$LOG_DIR/acceptance.log"

TOKEN_FILE="$RUNTIME_DIR/config/device-token"
[[ -f "$TOKEN_FILE" ]] || fail "验收完成后未找到开发 Token 文件。"
DEVICE_TOKEN="$(cat "$TOKEN_FILE")"
ACCEPTANCE_URL="http://127.0.0.1:8790/#token=$DEVICE_TOKEN&device=device%3Atest"

cat <<EOF

============================================================
Family AI Gateway Foundation automated verification: PASS
============================================================

The Gateway is still running for browser acceptance.

Open this local URL:
$ACCEPTANCE_URL

Complete the browser journey:
1. Read identity.
2. Create a conversation.
3. Send the first message and verify turn 1.
4. Send the second message and verify turn 2.
5. Refresh and verify four messages remain.
6. Restart the gateway container.
7. Refresh history and send another message; verify turn 3.

Logs are stored under:
$LOG_DIR

Stop without deleting data:
./scripts/dev-down.sh

Delete disposable runtime data:
./scripts/dev-reset.sh
EOF
