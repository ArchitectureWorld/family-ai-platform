#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_ID="family-ai-gateway-foundation"
DEVICE_REF="device:test"
AGENT_REF="agent:personal-assistant"

fail() {
  printf 'ACCEPTANCE FAILED: %s\n' "$1" >&2
  if [[ -n "${RESPONSE_BODY:-}" ]]; then
    printf 'HTTP %s\n%s\n' "${RESPONSE_STATUS:-unknown}" "$RESPONSE_BODY" >&2
  fi
  exit 1
}

source "$ROOT_DIR/scripts/runtime-isolation-lib.sh"

ISOLATED_MODE=false
if [[ -n "${FAMILY_AI_RUNTIME_ROOT:-}${COMPOSE_PROJECT_NAME:-}" ]]; then
  [[ -n "${FAMILY_AI_RUNTIME_ROOT:-}" && -n "${COMPOSE_PROJECT_NAME:-}" ]] \
    || fail "隔离 acceptance 必须同时提供 FAMILY_AI_RUNTIME_ROOT 与 COMPOSE_PROJECT_NAME。"
  ISOLATED_MODE=true
fi

if [[ "$ISOLATED_MODE" == true ]]; then
  validate_isolated_runtime_path "$FAMILY_AI_RUNTIME_ROOT"
  validate_isolated_project "$COMPOSE_PROJECT_NAME"
  RUNTIME_DIR="$FAMILY_AI_RUNTIME_ROOT"
  ISOLATED_PROJECT="$COMPOSE_PROJECT_NAME"
  [[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" ]] || fail "隔离 runtime 不存在或不是普通目录。"
  require_runtime_mode "$RUNTIME_DIR"
else
  RUNTIME_DIR="$ROOT_DIR/.runtime"
fi

TOKEN_FILE="$RUNTIME_DIR/config/device-token"
COMPOSE_ENV="$RUNTIME_DIR/config/compose.env"
REPORT_DIR="$([[ "$ISOLATED_MODE" == true ]] && printf '%s' "$RUNTIME_DIR/reports" || printf '%s' "$ROOT_DIR/docs/acceptance/runtime")"
ISOLATED_COMPOSE_FILE="$RUNTIME_DIR/run/compose.isolated.yaml"
ISOLATED_MANIFEST="$RUNTIME_DIR/run/isolated-runtime-manifest.json"
BASE_URL="http://127.0.0.1:8790"

if [[ "$ISOLATED_MODE" == true ]]; then
  [[ -f "$ISOLATED_MANIFEST" && ! -L "$ISOLATED_MANIFEST" ]] || fail "缺少隔离 runtime manifest。"
  [[ "$(stat -c '%a' "$ISOLATED_MANIFEST")" == "600" ]] || fail "隔离 runtime manifest 权限必须是 0600。"
  MANIFEST_PROJECT="$(read_manifest_field "$ISOLATED_MANIFEST" project)"
  MANIFEST_CONTAINER="$(read_manifest_field "$ISOLATED_MANIFEST" containerId)"
  MANIFEST_NETWORK="$(read_manifest_field "$ISOLATED_MANIFEST" network)"
  MANIFEST_IMAGE="$(read_manifest_field "$ISOLATED_MANIFEST" imageId)"
  MANIFEST_PORT="$(read_manifest_field "$ISOLATED_MANIFEST" port)"
  MANIFEST_DEVICE="$(read_manifest_field "$ISOLATED_MANIFEST" runtimeDevice)"
  MANIFEST_INODE="$(read_manifest_field "$ISOLATED_MANIFEST" runtimeInode)"
  MANIFEST_FORMAL_8790="$(read_manifest_field "$ISOLATED_MANIFEST" formal8790)"
  [[ "$MANIFEST_PROJECT" == "$ISOLATED_PROJECT" ]] || fail "隔离 Compose project 与 manifest 不匹配。"
  [[ "$MANIFEST_DEVICE" == "$(stat -c '%d' "$RUNTIME_DIR")" && "$MANIFEST_INODE" == "$(stat -c '%i' "$RUNTIME_DIR")" ]] \
    || fail "隔离 runtime device/inode 与 manifest 不匹配。"
  [[ -z "${FAMILY_AI_IMAGE_REF:-}" || "$FAMILY_AI_IMAGE_REF" == "$MANIFEST_IMAGE" ]] \
    || fail "FAMILY_AI_IMAGE_REF 与 manifest 不匹配。"
  [[ "$MANIFEST_PORT" =~ ^[1-9][0-9]{0,4}$ && "$MANIFEST_PORT" != "8790" ]] \
    || fail "manifest 隔离端口无效。"
  BASE_URL="http://127.0.0.1:$MANIFEST_PORT"
  [[ "$(capture_formal_8790_identity)" == "$MANIFEST_FORMAL_8790" ]] \
    || fail "正式 8790 身份与 dev-up manifest 不一致。"
fi

[[ -f "$TOKEN_FILE" ]] || fail "missing .runtime Token; run ./scripts/dev-up.sh first"
[[ -f "$COMPOSE_ENV" ]] || fail "missing Compose environment; run ./scripts/dev-up.sh first"
command -v curl >/dev/null 2>&1 || fail "curl is required"
DEVICE_TOKEN="$(cat "$TOKEN_FILE")"

compose() {
  if [[ "$ISOLATED_MODE" == true ]]; then
    isolated_compose "$@"
  else
    docker compose --env-file "$COMPOSE_ENV" "$@"
  fi
}

refresh_isolated_port_after_restart() {
  [[ "$ISOLATED_MODE" == true ]] || return 0
  [[ "$(compose ps -q gateway)" == "$MANIFEST_CONTAINER" ]] \
    || fail "restart 后隔离 Gateway 容器与 manifest 不匹配。"
  local port_rows next_port
  port_rows="$(compose port gateway 8790)"
  [[ "$(printf '%s\n' "$port_rows" | sed '/^$/d' | wc -l)" -eq 1 ]] \
    || fail "restart 后必须解析到唯一隔离端口。"
  [[ "$port_rows" =~ ^127\.0\.0\.1:([1-9][0-9]{0,4})$ ]] \
    || fail "restart 后隔离端口必须保持在 loopback。"
  next_port="${BASH_REMATCH[1]}"
  [[ "$next_port" != "8790" ]] || fail "restart 后隔离端口不得占用正式 8790。"
  node --input-type=module - "$ISOLATED_MANIFEST" "$next_port" <<'NODE'
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [path, port] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.port = port;
const temporary = `${path}.tmp`;
writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
chmodSync(temporary, 0o600);
renameSync(temporary, path);
NODE
  MANIFEST_PORT="$next_port"
  BASE_URL="http://127.0.0.1:$MANIFEST_PORT"
}

json_get() {
  local json="$1"
  local path="$2"
  printf '%s' "$json" | compose exec -T gateway node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const value = process.argv[1].split(".").reduce((current, key) => current?.[key], JSON.parse(input));
      if (value === undefined || value === null) process.exit(2);
      process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
    });
  ' "$path"
}

request() {
  local method="$1"
  local path="$2"
  local expected="$3"
  local payload="${4:-}"
  local body_file
  body_file="$(mktemp)"
  local args=(--silent --show-error --max-time 15 --output "$body_file" --write-out '%{http_code}' --request "$method" "$BASE_URL$path")
  if [[ "$path" != "/health" ]]; then
    args+=(--header "Authorization: Bearer $DEVICE_TOKEN" --header "X-Device-Ref: $DEVICE_REF")
  fi
  if [[ -n "$payload" ]]; then
    args+=(--header 'Content-Type: application/json' --data "$payload")
  fi
  RESPONSE_STATUS="$(curl "${args[@]}")" || { rm -f "$body_file"; fail "curl failed for $method $path"; }
  RESPONSE_BODY="$(cat "$body_file")"
  rm -f "$body_file"
  [[ "$RESPONSE_STATUS" == "$expected" ]] || fail "$method $path expected HTTP $expected"
}

uuid() {
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid
  else
    printf '%s-%s-%s-%s-%s\n' \
      "$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')" \
      "$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')" \
      "$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')" \
      "$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')" \
      "$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  fi
}

message_payload() {
  local number="$1"
  local key="$2"
  local text="$3"
  printf '{"protocolVersion":"1.0","messageRef":"message:%s","correlationRef":"correlation:%s","idempotencyKey":"%s","occurredAt":"%s","source":{"kind":"device","ref":"%s"},"target":{"kind":"agent","ref":"%s"},"payload":{"type":"text","text":"%s","language":"zh-CN"}}' \
    "$(uuid)" "$(uuid)" "$key" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$DEVICE_REF" "$AGENT_REF" "$text"
}

wait_for_health() {
  local response
  for _ in $(seq 1 60); do
    response="$(curl --silent --show-error --max-time 2 "$BASE_URL/health" 2>/dev/null || true)"
    if [[ "$response" == *'"service":"family-ai-gateway-foundation"'* ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

mkdir -p "$REPORT_DIR"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REPORT_FILE="$REPORT_DIR/gateway-foundation-$(date -u +%Y%m%d-%H%M%S).md"
STEPS=()
record() { STEPS+=("| $1 | PASS | $2 |"); printf 'PASS: %s\n' "$1"; }

request GET /health 200
[[ "$(json_get "$RESPONSE_BODY" ok)" == "true" ]] || fail "health response did not report ok=true"
[[ "$(json_get "$RESPONSE_BODY" service)" == "$SERVICE_ID" ]] || fail "port 8790 is not the Gateway Foundation service"
record "Health identity" "$SERVICE_ID"

request GET /api/v1/me 200
[[ "$(json_get "$RESPONSE_BODY" deviceRef)" == "$DEVICE_REF" ]] || fail "authenticated device mismatch"
[[ "$(json_get "$RESPONSE_BODY" agentRef)" == "$AGENT_REF" ]] || fail "fixed Agent mismatch"
record "Device authentication" "member:test → agent:personal-assistant"

request POST /api/v1/conversations 201 '{"title":"一键验收会话"}'
CONVERSATION_REF="$(json_get "$RESPONSE_BODY" conversation.conversationRef)"
[[ "$CONVERSATION_REF" == conversation:* ]] || fail "invalid conversation reference"
CONVERSATION_PATH="$(printf '%s' "$CONVERSATION_REF" | sed 's/:/%3A/g')"
record "Create conversation" "$CONVERSATION_REF"

KEY_1="acceptance:$(uuid)"
PAYLOAD_1="$(message_payload 1 "$KEY_1" "第一轮自动验收消息。")"
request POST "/api/v1/conversations/$CONVERSATION_PATH/messages" 200 "$PAYLOAD_1"
[[ "$(json_get "$RESPONSE_BODY" replayed)" == "false" ]] || fail "first message was unexpectedly replayed"
[[ "$(json_get "$RESPONSE_BODY" response.payload.text)" == "Fake Provider 第 1 轮回复。" ]] || fail "first Provider turn mismatch"
record "First message" "Fake Provider turn 1"

KEY_2="acceptance:$(uuid)"
PAYLOAD_2="$(message_payload 2 "$KEY_2" "第二轮自动验收消息。")"
request POST "/api/v1/conversations/$CONVERSATION_PATH/messages" 200 "$PAYLOAD_2"
[[ "$(json_get "$RESPONSE_BODY" response.payload.text)" == "Fake Provider 第 2 轮回复。" ]] || fail "Provider Session continuity failed"
record "Second message" "Fake Provider turn 2"

request GET "/api/v1/conversations/$CONVERSATION_PATH/messages" 200
[[ "$(json_get "$RESPONSE_BODY" messages.length)" == "4" ]] || fail "history should contain four messages"
record "History before restart" "4 persisted messages"

request POST "/api/v1/conversations/$CONVERSATION_PATH/messages" 200 "$PAYLOAD_1"
[[ "$(json_get "$RESPONSE_BODY" replayed)" == "true" ]] || fail "identical request was not replayed"
record "Idempotent replay" "same request returned cached result"

CONFLICT_PAYLOAD="$(message_payload 99 "$KEY_1" "不同请求内容。")"
request POST "/api/v1/conversations/$CONVERSATION_PATH/messages" 409 "$CONFLICT_PAYLOAD"
[[ "$(json_get "$RESPONSE_BODY" code)" == "IDEMPOTENCY_CONFLICT" ]] || fail "wrong idempotency conflict code"
record "Idempotency conflict" "HTTP 409"

WRONG_AGENT_PAYLOAD="$(message_payload 98 "acceptance:$(uuid)" "错误 Agent 目标。")"
WRONG_AGENT_PAYLOAD="${WRONG_AGENT_PAYLOAD/\"ref\":\"$AGENT_REF\"/\"ref\":\"agent:other\"}"
request POST "/api/v1/conversations/$CONVERSATION_PATH/messages" 403 "$WRONG_AGENT_PAYLOAD"
[[ "$(json_get "$RESPONSE_BODY" code)" == "FIXED_ROUTE_REQUIRED" ]] || fail "wrong cross-Agent rejection code"
record "Cross-Agent rejection" "HTTP 403"

compose restart gateway >/dev/null
refresh_isolated_port_after_restart
RESPONSE_STATUS=""
RESPONSE_BODY=""
wait_for_health || fail "Gateway Foundation did not recover after restart"
request GET "/api/v1/conversations/$CONVERSATION_PATH/messages" 200
[[ "$(json_get "$RESPONSE_BODY" messages.length)" == "4" ]] || fail "history was lost after restart"
record "Restart history recovery" "4 messages restored"

KEY_3="acceptance:$(uuid)"
PAYLOAD_3="$(message_payload 3 "$KEY_3" "第三轮自动验收消息。")"
request POST "/api/v1/conversations/$CONVERSATION_PATH/messages" 200 "$PAYLOAD_3"
[[ "$(json_get "$RESPONSE_BODY" response.payload.text)" == "Fake Provider 第 3 轮回复。" ]] || fail "Provider Session did not continue after restart"
record "Post-restart continuation" "Fake Provider turn 3"

request GET "/api/v1/conversations/$CONVERSATION_PATH/messages" 200
[[ "$(json_get "$RESPONSE_BODY" messages.length)" == "6" ]] || fail "continued history should contain six messages"
record "Final history" "6 persisted messages"

if [[ "$ISOLATED_MODE" == true ]]; then
  [[ "$(compose ps -q gateway)" == "$MANIFEST_CONTAINER" ]] || fail "隔离 Gateway 容器与 manifest 不匹配。"
  [[ "$(docker inspect --format '{{.Image}}' "$MANIFEST_CONTAINER")" == "$MANIFEST_IMAGE" ]] \
    || fail "隔离 Gateway 镜像与 manifest 不匹配。"
  [[ "$(capture_formal_8790_identity)" == "$MANIFEST_FORMAL_8790" ]] \
    || fail "正式 8790 身份在隔离 acceptance 期间发生变化。"
fi

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf '# Gateway Foundation Runtime Acceptance\n\n'
  printf -- '- Started: `%s`\n' "$STARTED_AT"
  printf -- '- Finished: `%s`\n' "$FINISHED_AT"
  printf -- '- Conversation: `%s`\n' "$CONVERSATION_REF"
  printf -- '- Result: **PASS**\n\n'
  printf '| Step | Result | Evidence |\n|---|---|---|\n'
  printf '%s\n' "${STEPS[@]}"
  printf '\nThe report intentionally excludes device Tokens, Authorization headers, SQL details, local absolute paths, and Provider internals.\n'
} > "$REPORT_FILE"

printf '\nAll Gateway acceptance steps passed.\nReport: %s\n' "$REPORT_FILE"
