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
record "Create conversation" "$CONVERSATION_REF"

MESSAGE_ID_1="$(uuid)"
CORRELATION_ID_1="$(uuid)"
KEY_1="acceptance:$MESSAGE_ID_1"
PAYLOAD_1="{\"protocolVersion\":\"1.0\",\"messageRef\":\"message:$MESSAGE_ID_1\",\"correlationRef\":\"correlation:$CORRELATION_ID_1\",\"idempotencyKey\":\"$KEY_1\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"source\":{\"kind\":\"device\",\"ref\":\"$DEVICE_REF\"},\"target\":{\"kind\":\"agent\",\"ref\":\"$AGENT_REF\"},\"payload\":{\"type\":\"text\",\"text\":\"第一轮自动验收消息。\",\"language\":\"zh-CN\"}}"
request POST "/api/v1/conversations/$(printf '%s' "$CONVERSATION_REF" | sed 's/:/%3A/g')/messages" 200 "$PAYLOAD_1"
[[ "$(json_get "$RESPONSE_BODY" replayed)" == "false" ]] || fail "first message was unexpectedly replayed"
record "First message" "Fake Provider turn 1"

MESSAGE_ID_2="$(uuid)"
CORRELATION_ID_2="$(uuid)"
KEY_2="acceptance:$MESSAGE_ID_2"
PAYLOAD_2="{\"protocolVersion\":\"1.0\",\"messageRef\":\"message:$MESSAGE_ID_2\",\"correlationRef\":\"correlation:$CORRELATION_ID_2\",\"idempotencyKey\":\"$KEY_2\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"source\":{\"kind\":\"device\",\"ref\":\"$DEVICE_REF\"},\"target\":{\"kind\":\"agent\",\"ref\":\"$AGENT_REF\"},\"payload\":{\"type\":\"text\",\"text\":\"第二轮自动验收消息。\",\"language\":\"zh-CN\"}}"
request POST "/api/v1/conversations/$(printf '%s' "$CONVERSATION_REF" | sed 's/:/%3A/g')/messages" 200 "$PAYLOAD_2"
[[ "$(json_get "$RESPONSE_BODY" response.payload.text)" == "Fake Provider 第 2 轮回复。" ]] || fail "Provider Session continuity failed"
record "Second message" "Fake Provider turn 2"

request GET "/api/v1/conversations/$(printf '%s' "$CONVERSATION_REF" | sed 's/:/%3A/g')/messages" 200
[[ "$(json_get "$RESPONSE_BODY" messages.length)" == "4" ]] || fail "history should contain four messages"
record "History" "4 persisted messages"

request POST "/api/v1/conversations/$(printf '%s' "$CONVERSATION_REF" | sed 's/:/%3A/g')/messages" 200 "$PAYLOAD_1"
[[ "$(json_get "$RESPONSE_BODY" replayed)" == "true" ]] || fail "identical request was not replayed"
record "Idempotent replay" "same request returned cached result"

CONFLICT_PAYLOAD="{\"protocolVersion\":\"1.0\",\"messageRef\":\"message:$(uuid)\",\"correlationRef\":\"correlation:$(uuid)\",\"idempotencyKey\":\"$KEY_1\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"source\":{\"kind\":\"device\",\"ref\":\"$DEVICE_REF\"},\"target\":{\"kind\":\"agent\",\"ref\":\"$AGENT_REF\"},\"payload\":{\"type\":\"text\",\"text\":\"不同请求内容。\",\"language\":\"zh-CN\"}}"
request POST "/api/v1/conversations/$(printf '%s' "$CONVERSATION_REF" | sed 's/:/%3A/g')/messages" 409 "$CONFLICT_PAYLOAD"
[[ "$(json_get "$RESPONSE_BODY" code)" == "IDEMPOTENCY_CONFLICT" ]] || fail "wrong idempotency conflict code"
record "Idempotency conflict" "HTTP 409"

WRONG_AGENT_PAYLOAD="{\"protocolVersion\":\"1.0\",\"messageRef\":\"message:$(uuid)\",\"correlationRef\":\"correlation:$(uuid)\",\"idempotencyKey\":\"acceptance:$(uuid)\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"source\":{\"kind\":\"device\",\"ref\":\"$DEVICE_REF\"},\"target\":{\"kind\":\"agent\",\"ref\":\"agent:other\"},\"payload\":{\"type\":\"text\",\"text\":\"错误 Agent 目标。\",\"language\":\"zh-CN\"}}"
request POST "/api/v1/conversations/$(printf '%s' "$CONVERSATION_REF" | sed 's/:/%3A/g')/messages" 403 "$WRONG_AGENT_PAYLOAD"
[[ "$(json_get "$RESPONSE_BODY" code)" == "FIXED_ROUTE_REQUIRED" ]] || fail "wrong cross-Agent rejection code"
record "Cross-Agent rejection" "HTTP 403"

compose restart gateway >/dev/null
wait_for_health || fail "Gateway did not recover after restart"
request GET "/api/v1/conversations/$(printf '%s' "$CONVERSATION_REF" | sed 's/:/%3A/g')/messages" 200
[[ "$(json_get "$RESPONSE_BODY" messages.length)" == "4" ]] || fail "history was lost after restart"
record "Restart recovery" "4 messages restored"

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
