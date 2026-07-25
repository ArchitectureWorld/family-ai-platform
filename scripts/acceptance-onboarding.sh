#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
TOKEN_FILE="$RUNTIME_DIR/config/device-token"
COMPOSE_ENV="$RUNTIME_DIR/config/compose.env"
MEMBER_WEB_URL_FILE="$RUNTIME_DIR/config/member-web-url"
REPORT_DIR="$ROOT_DIR/docs/acceptance/runtime"
BASE_URL="http://127.0.0.1:8790"
DEVICE_REF="device:test"

fail() {
  printf 'ONBOARDING ACCEPTANCE FAILED: %s\n' "$1" >&2
  if [[ -n "${RESPONSE_STATUS:-}" ]]; then
    printf 'Last HTTP status: %s\n' "$RESPONSE_STATUS" >&2
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

urlencode() {
  compose exec -T gateway node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

request() {
  local method="$1"
  local path="$2"
  local expected="$3"
  local payload="${4:-}"
  local auth_kind="${5:-public}"
  local body_file
  body_file="$(mktemp)"
  local args=(--silent --show-error --max-time 15 --output "$body_file" --write-out '%{http_code}' --request "$method" "$BASE_URL$path")

  case "$auth_kind" in
    public)
      ;;
    bootstrap)
      args+=(--header "Authorization: Bearer $DEVICE_TOKEN" --header "X-Device-Ref: $DEVICE_REF")
      ;;
    admin)
      args+=(--header "Authorization: Bearer $ADMIN_TOKEN" --header "X-Entry-Session-Ref: $ADMIN_SESSION_REF")
      ;;
    personal)
      args+=(--header "Authorization: Bearer $PERSONAL_TOKEN" --header "X-Entry-Session-Ref: $PERSONAL_SESSION_REF")
      ;;
    *)
      rm -f "$body_file"
      fail "unknown auth kind: $auth_kind"
      ;;
  esac

  if [[ -n "$payload" ]]; then
    args+=(--header 'Content-Type: application/json' --data "$payload")
  fi
  RESPONSE_STATUS="$(curl "${args[@]}")" || { rm -f "$body_file"; fail "curl failed for $method $path"; }
  RESPONSE_BODY="$(cat "$body_file")"
  rm -f "$body_file"
  [[ "$RESPONSE_STATUS" == "$expected" ]] || fail "$method $path expected HTTP $expected"
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
REPORT_FILE="$REPORT_DIR/family-onboarding-$(date -u +%Y%m%d-%H%M%S).md"
STEPS=()
record() { STEPS+=("| $1 | PASS | $2 |"); printf 'PASS: %s\n' "$1"; }

request GET /api/v1/onboarding/status 200 "" public
[[ "$(json_get "$RESPONSE_BODY" initialized)" == "false" ]] || fail "formal Family domain should start empty"
record "Empty formal Family domain" "initialized=false"

request POST /api/v1/onboarding/family 201 \
  '{"familyName":"自动体验家庭","ownerName":"自动体验管理员","deviceName":"自动体验电脑"}' bootstrap
FAMILY_REF="$(json_get "$RESPONSE_BODY" family.familyRef)"
PERSON_REF="$(json_get "$RESPONSE_BODY" owner.personRef)"
MANAGED_DEVICE_REF="$(json_get "$RESPONSE_BODY" device.deviceRef)"
ADMIN_SESSION_REF="$(json_get "$RESPONSE_BODY" entries.admin.entrySessionRef)"
ADMIN_TOKEN="$(json_get "$RESPONSE_BODY" entries.admin.token)"
PERSONAL_SESSION_REF="$(json_get "$RESPONSE_BODY" entries.personal.entrySessionRef)"
PERSONAL_TOKEN="$(json_get "$RESPONSE_BODY" entries.personal.token)"
[[ "$FAMILY_REF" == family:* ]] || fail "invalid Family reference"
[[ "$PERSON_REF" == person:* ]] || fail "invalid Person reference"
[[ "$MANAGED_DEVICE_REF" == device:* ]] || fail "invalid managed Device reference"
[[ "$ADMIN_SESSION_REF" != "$PERSONAL_SESSION_REF" ]] || fail "Admin and Personal sessions must differ"
[[ "$ADMIN_TOKEN" != "$PERSONAL_TOKEN" ]] || fail "Admin and Personal tokens must differ"
record "One-time family initialization" "$FAMILY_REF"
record "Independent entry sessions" "Admin and Personal refs differ"

request GET /api/v1/portal/context 200 "" admin
[[ "$(json_get "$RESPONSE_BODY" audience)" == "family_admin" ]] || fail "Admin audience mismatch"
[[ "$(json_get "$RESPONSE_BODY" person.personRef)" == "$PERSON_REF" ]] || fail "Admin Person mismatch"
[[ "$(json_get "$RESPONSE_BODY" device.deviceRef)" == "$MANAGED_DEVICE_REF" ]] || fail "Admin Device mismatch"
[[ "$(json_get "$RESPONSE_BODY" agent.agentRef)" == "agent:family-manager" ]] || fail "Admin did not route to family manager"
[[ "$RESPONSE_BODY" != *"$ADMIN_TOKEN"* ]] || fail "Admin context leaked its token"
record "Family Admin route" "agent:family-manager"

request GET /api/v1/portal/context 200 "" personal
[[ "$(json_get "$RESPONSE_BODY" audience)" == "personal" ]] || fail "Personal audience mismatch"
[[ "$(json_get "$RESPONSE_BODY" person.personRef)" == "$PERSON_REF" ]] || fail "Personal Person mismatch"
[[ "$(json_get "$RESPONSE_BODY" device.deviceRef)" == "$MANAGED_DEVICE_REF" ]] || fail "Personal Device mismatch"
[[ "$(json_get "$RESPONSE_BODY" agent.agentRef)" == "agent:personal-assistant" ]] || fail "Personal did not route to personal assistant"
[[ "$RESPONSE_BODY" != *"$PERSONAL_TOKEN"* ]] || fail "Personal context leaked its token"
record "Personal route" "agent:personal-assistant"

request POST /api/v1/admin/members 201 \
  '{"displayName":"自动体验孩子","familyRole":"child"}' admin
NEW_PERSON_REF="$(json_get "$RESPONSE_BODY" member.personRef)"
[[ "$NEW_PERSON_REF" == person:* ]] || fail "new member reference invalid"
[[ "$(json_get "$RESPONSE_BODY" member.entryStatus)" == "unclaimed" ]] || fail "new member must not inherit current device session"
[[ "$(json_get "$RESPONSE_BODY" member.personalAssistant.agentRef)" == "agent:personal-assistant" ]] || fail "new member assistant assignment missing"
record "Admin creates member" "new member is unclaimed"

request GET /api/v1/admin/members 403 "" personal
[[ "$(json_get "$RESPONSE_BODY" code)" == "ENTRY_AUDIENCE_FORBIDDEN" ]] || fail "Personal entry was not blocked from Admin API"
[[ "$(json_get "$RESPONSE_BODY" category)" == "permission" ]] || fail "wrong forbidden error category"
record "Audience authorization" "Personal receives HTTP 403"

compose restart gateway >/dev/null
wait_for_health || fail "Gateway did not recover after restart"
request GET /api/v1/portal/context 200 "" admin
[[ "$(json_get "$RESPONSE_BODY" entrySessionRef)" == "$ADMIN_SESSION_REF" ]] || fail "Admin session did not survive restart"
request GET /api/v1/portal/context 200 "" personal
[[ "$(json_get "$RESPONSE_BODY" entrySessionRef)" == "$PERSONAL_SESSION_REF" ]] || fail "Personal session did not survive restart"
record "Restart recovery" "both entry sessions restored"

request POST "/api/v1/admin/members/$PERSON_REF/pairing-codes" 201 "" admin
PAIRING_REF="$(json_get "$RESPONSE_BODY" pairing.pairingRef)"
PAIRING_CODE="$(json_get "$RESPONSE_BODY" pairing.code)"
PAIRING_EXPIRES_AT="$(json_get "$RESPONSE_BODY" pairing.expiresAt)"
MEMBER_WEB_URL="$BASE_URL/member/?pairingRef=$(urlencode "$PAIRING_REF")&code=$(urlencode "$PAIRING_CODE")"
umask 077
printf '%s\n' "$MEMBER_WEB_URL" > "$MEMBER_WEB_URL_FILE"
chmod 600 "$MEMBER_WEB_URL_FILE"
record "Normal product workbench handoff" "real Web Device pairing link generated"

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf '# Family Onboarding Runtime Verification\n\n'
  printf -- '- Started: `%s`\n' "$STARTED_AT"
  printf -- '- Finished: `%s`\n' "$FINISHED_AT"
  printf -- '- Family: `%s`\n' "$FAMILY_REF"
  printf -- '- Owner Person: `%s`\n' "$PERSON_REF"
  printf -- '- Result: **PASS**\n\n'
  printf '| Step | Result | Evidence |\n|---|---|---|\n'
  printf '%s\n' "${STEPS[@]}"
  printf '\nThe report intentionally excludes pairing codes, product deep links, bootstrap Tokens, entry Session Tokens, Authorization headers, SQL details, host paths, and Provider internals.\n'
} > "$REPORT_FILE"

printf '\nVerified Family state is ready in the real Member Web product.\n'
printf 'Product URL (expires %s):\n%s\n' "$PAIRING_EXPIRES_AT" "$MEMBER_WEB_URL"
printf 'Runtime report: %s\n' "$REPORT_FILE"

unset ADMIN_TOKEN PERSONAL_TOKEN DEVICE_TOKEN PAIRING_CODE
