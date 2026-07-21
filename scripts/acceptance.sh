#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
TOKEN_FILE="$RUNTIME_DIR/config/device-token"
COMPOSE_ENV="$RUNTIME_DIR/config/compose.env"
REPORT_DIR="$ROOT_DIR/docs/acceptance/runtime"
BASE_URL="http://127.0.0.1:8790"
DEVICE_REF="device:test"
AGENT_REF="agent:personal-assistant"

fail() {
  printf 'ACCEPTANCE FAILED: %s\n' "$1" >&2
  if [[ -n "${RESPONSE_BODY:-}" ]]; then
    printf 'HTTP %s\n%s\n' "${RESPONSE_STATUS:-unknown}" "$RESPONSE_BODY" >&2
  fi
  exit 1
}

[[ -f "$TOKEN_FILE" ]] || fail "missing .runtime Token; run ./scripts/dev-up.sh first"
[[ -f "$COMPOSE_ENV" ]] || fail "missing Compose environment; run ./scripts/dev-up.sh first"
command -v curl >/dev/null 2>&1 || fail "curl is required"
DEVICE_TOKEN="$(cat "$TOKEN_FILE")"

compose() {
  docker compose --env-file "$COMPOSE_ENV" "$@"
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
  for _ in $(seq 1 60); do
    if curl --silent --fail --max-time 2 "$BASE_URL/health" >/dev/null; then
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
record "Health" "HTTP 200"

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
wait_for_health || fail "Gateway did not recover after restart"
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
