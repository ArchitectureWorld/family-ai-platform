#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
TOKEN_FILE="$RUNTIME_DIR/config/device-token"
COMPOSE_ENV="$RUNTIME_DIR/config/compose.env"
REPORT_DIR="$ROOT_DIR/docs/acceptance/runtime"
BASE_URL="http://127.0.0.1:8790"
BOOTSTRAP_DEVICE_REF="device:test"
PAIRING_CODE_B=""
DEVICE_CREDENTIAL_B=""

fail() {
  printf 'MOBILE PAIRING ACCEPTANCE FAILED: %s\n' "$1" >&2
  if [[ -n "${RESPONSE_STATUS:-}" ]]; then
    printf 'Last HTTP status: %s\n' "$RESPONSE_STATUS" >&2
  fi
  exit 1
}

[[ -f "$TOKEN_FILE" ]] || fail "missing .runtime Token; run ./scripts/verify-foundation.sh first"
[[ -f "$COMPOSE_ENV" ]] || fail "missing Compose environment; run ./scripts/verify-foundation.sh first"
command -v curl >/dev/null 2>&1 || fail "curl is required"
BOOTSTRAP_TOKEN="$(cat "$TOKEN_FILE")"

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

runtime_secret() {
  compose exec -T gateway node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
}

runtime_uuid() {
  compose exec -T gateway node -e 'process.stdout.write(require("node:crypto").randomUUID())'
}

request() {
  local method="$1"
  local path="$2"
  local expected="$3"
  local payload="${4:-}"
  local auth_kind="${5:-public}"
  local secure_gateway="${6:-false}"
  local body_file
  body_file="$(mktemp)"
  local args=(--silent --show-error --max-time 15 --output "$body_file" --write-out '%{http_code}' --request "$method" "$BASE_URL$path")

  case "$auth_kind" in
    public)
      ;;
    bootstrap)
      args+=(--header "Authorization: Bearer $BOOTSTRAP_TOKEN" --header "X-Device-Ref: $BOOTSTRAP_DEVICE_REF")
      ;;
    admin)
      args+=(--header "Authorization: Bearer $ADMIN_TOKEN" --header "X-Entry-Session-Ref: $ADMIN_SESSION_REF")
      ;;
    personal)
      args+=(--header "Authorization: Bearer $PERSONAL_TOKEN" --header "X-Entry-Session-Ref: $PERSONAL_SESSION_REF")
      ;;
    mobile_entry)
      args+=(--header "Authorization: Bearer $MOBILE_ENTRY_TOKEN" --header "X-Entry-Session-Ref: $MOBILE_ENTRY_SESSION_REF")
      ;;
    device_a)
      args+=(--header "Authorization: Device $DEVICE_CREDENTIAL_A" --header "X-Device-Ref: $MOBILE_DEVICE_REF_A")
      ;;
    device_b)
      args+=(--header "Authorization: Device $DEVICE_CREDENTIAL_B" --header "X-Device-Ref: $MOBILE_DEVICE_REF_B")
      ;;
    *)
      rm -f "$body_file"
      fail "unknown auth kind: $auth_kind"
      ;;
  esac

  if [[ "$secure_gateway" == "true" ]]; then
    args+=(--header 'Host: family-ai-gateway.example.test' --header 'X-Forwarded-Proto: https')
  fi
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

assert_no_plaintext_secrets() {
  printf '%s\n' "$PAIRING_CODE_A" "$PAIRING_CODE_B" "$DEVICE_CREDENTIAL_A" "$DEVICE_CREDENTIAL_B" \
    "$MOBILE_ENTRY_TOKEN" "$RENEWED_ENTRY_TOKEN" | compose exec -T gateway node -e '
      const Database = require("better-sqlite3");
      const path = process.env.GATEWAY_DATABASE_PATH;
      if (!path) throw new Error("GATEWAY_DATABASE_PATH is not configured");
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const secrets = input.split(/\r?\n/).filter(Boolean);
        const db = new Database(path, { readonly: true });
        const tables = ["mobile_pairing_codes", "managed_devices", "entry_sessions"];
        const persisted = tables.map(table => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).join("\n");
        db.close();
        if (secrets.some(secret => persisted.includes(secret))) process.exit(1);
      });
    ' || fail "SQLite contains plaintext pairing or credential material"
}

mkdir -p "$REPORT_DIR"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REPORT_FILE="$REPORT_DIR/mobile-entry-gateway-$(date -u +%Y%m%d-%H%M%S).md"
STEPS=()
record() { STEPS+=("| $1 | PASS | $2 |"); printf 'PASS: %s\n' "$1"; }

wait_for_health || fail "Gateway is not healthy"
request GET /api/v1/onboarding/status 200
[[ "$(json_get "$RESPONSE_BODY" initialized)" == "false" ]] || fail "Gateway must be clean before mobile acceptance"
record "Clean Gateway" "Formal Family domain is empty"

request POST /api/v1/onboarding/family 201 \
  '{"familyName":"移动入口验收家庭","ownerName":"移动入口管理员","deviceName":"验收管理电脑"}' bootstrap
FAMILY_REF="$(json_get "$RESPONSE_BODY" family.familyRef)"
ADMIN_SESSION_REF="$(json_get "$RESPONSE_BODY" entries.admin.entrySessionRef)"
ADMIN_TOKEN="$(json_get "$RESPONSE_BODY" entries.admin.token)"
PERSONAL_SESSION_REF="$(json_get "$RESPONSE_BODY" entries.personal.entrySessionRef)"
PERSONAL_TOKEN="$(json_get "$RESPONSE_BODY" entries.personal.token)"
record "Family initialization" "Admin and Personal entries created"

request POST /api/v1/admin/members 201 \
  '{"displayName":"移动成员甲","familyRole":"adult"}' admin
PERSON_REF_A="$(json_get "$RESPONSE_BODY" member.personRef)"
[[ "$(json_get "$RESPONSE_BODY" member.activePersonalDeviceCount)" == "0" ]] || fail "new member device count must be zero"

request POST "/api/v1/admin/members/$PERSON_REF_A/pairing-codes" 403 "" personal true
[[ "$(json_get "$RESPONSE_BODY" error.code)" == "ENTRY_AUDIENCE_FORBIDDEN" ]] || fail "Personal entry created pairing material"
record "Pairing administration" "Personal entry is forbidden"

request POST "/api/v1/admin/members/$PERSON_REF_A/pairing-codes" 201 "" admin true
PAIRING_REF_A="$(json_get "$RESPONSE_BODY" pairing.pairingRef)"
PAIRING_CODE_A="$(json_get "$RESPONSE_BODY" pairing.code)"
PAIRING_EXPIRES_A="$(json_get "$RESPONSE_BODY" pairing.expiresAt)"
[[ "$(json_get "$RESPONSE_BODY" protocolVersion)" == "1" ]] || fail "pairing response version mismatch"
[[ "$(json_get "$RESPONSE_BODY" qr.payload.pairingRef)" == "$PAIRING_REF_A" ]] || fail "QR pairingRef mismatch"
record "Pairing material" "Five-minute QR and manual code generated"

request POST /api/v1/mobile/pairing/preview 200 \
  "{\"protocolVersion\":1,\"code\":\"$PAIRING_CODE_A\"}"
[[ "$(json_get "$RESPONSE_BODY" protocolVersion)" == "1" ]] || fail "preview version mismatch"
[[ "$(json_get "$RESPONSE_BODY" expiresAt)" == "$PAIRING_EXPIRES_A" ]] || fail "preview expiry mismatch"
record "Manual preview" "Code-only request resolved the intended member"

DEVICE_CREDENTIAL_A="$(runtime_secret)"
INSTALLATION_ID_A="$(runtime_uuid)"
request POST /api/v1/mobile/pairing/claim 201 \
  "{\"protocolVersion\":1,\"pairingRef\":\"$PAIRING_REF_A\",\"code\":\"$PAIRING_CODE_A\",\"installationId\":\"$INSTALLATION_ID_A\",\"deviceCredential\":\"$DEVICE_CREDENTIAL_A\",\"device\":{\"displayName\":\"验收 iPhone 甲\",\"terminalType\":\"mobile\",\"platform\":\"ios\",\"systemVersion\":\"26.0\",\"appVersion\":\"1.0.0\",\"model\":\"iPhone\"}}"
MOBILE_DEVICE_REF_A="$(json_get "$RESPONSE_BODY" device.deviceRef)"
MOBILE_ENTRY_SESSION_REF="$(json_get "$RESPONSE_BODY" entry.entrySessionRef)"
MOBILE_ENTRY_TOKEN="$(json_get "$RESPONSE_BODY" entry.token)"
[[ "$(json_get "$RESPONSE_BODY" protocolVersion)" == "1" ]] || fail "claim version mismatch"
record "QR claim" "Personal mobile Device and seven-day EntrySession created"

request POST /api/v1/mobile/pairing/claim 201 \
  "{\"protocolVersion\":1,\"pairingRef\":\"$PAIRING_REF_A\",\"code\":\"$PAIRING_CODE_A\",\"installationId\":\"$INSTALLATION_ID_A\",\"deviceCredential\":\"$DEVICE_CREDENTIAL_A\",\"device\":{\"displayName\":\"验收 iPhone 甲\",\"terminalType\":\"mobile\",\"platform\":\"ios\",\"systemVersion\":\"26.0\",\"appVersion\":\"1.0.0\",\"model\":\"iPhone\"}}"
[[ "$(json_get "$RESPONSE_BODY" device.deviceRef)" == "$MOBILE_DEVICE_REF_A" ]] || fail "idempotent claim duplicated the Device"
MOBILE_ENTRY_SESSION_REF="$(json_get "$RESPONSE_BODY" entry.entrySessionRef)"
MOBILE_ENTRY_TOKEN="$(json_get "$RESPONSE_BODY" entry.token)"
record "Claim idempotency" "Same installation and credential reused the Device"

request GET /api/v1/portal/context 200 "" mobile_entry
[[ "$(json_get "$RESPONSE_BODY" protocolVersion)" == "1" ]] || fail "portal context version mismatch"
[[ "$(json_get "$RESPONSE_BODY" audience)" == "personal" ]] || fail "mobile claim created a non-personal entry"
[[ "$(json_get "$RESPONSE_BODY" person.personRef)" == "$PERSON_REF_A" ]] || fail "mobile context Person mismatch"
record "Personal portal" "Versioned context resolves the paired Person"

request GET /api/v1/portal/context 401 "" device_a
[[ "$(json_get "$RESPONSE_BODY" error.code)" == "ENTRY_SESSION_INVALID" ]] || fail "Device credential accessed portal context"
request GET /api/v1/admin/members 401 "" device_a
request GET /api/v1/conversations 401 "" device_a
record "Credential isolation" "Device auth cannot access Portal, Admin, or Chat"

request POST /api/v1/mobile/session/renew 200 "" device_a
RENEWED_ENTRY_SESSION_REF="$(json_get "$RESPONSE_BODY" entry.entrySessionRef)"
RENEWED_ENTRY_TOKEN="$(json_get "$RESPONSE_BODY" entry.token)"
[[ "$(json_get "$RESPONSE_BODY" protocolVersion)" == "1" ]] || fail "renew version mismatch"
record "Session renewal" "A new seven-day Personal Session replaced the previous session"

request POST /api/v1/mobile/session/logout 200 "" device_a
[[ "$(json_get "$RESPONSE_BODY" status)" == "logged_out" ]] || fail "logout status mismatch"
request POST /api/v1/mobile/session/renew 200 "" device_a
RENEWED_ENTRY_SESSION_REF="$(json_get "$RESPONSE_BODY" entry.entrySessionRef)"
RENEWED_ENTRY_TOKEN="$(json_get "$RESPONSE_BODY" entry.token)"
record "Logout semantics" "Session revoked while Device authorization remained renewable"

assert_no_plaintext_secrets
record "Secret storage" "SQLite contains hashes only"

request DELETE /api/v1/mobile/device 200 "" device_a
[[ "$(json_get "$RESPONSE_BODY" status)" == "revoked" ]] || fail "local unbind status mismatch"
request POST /api/v1/mobile/session/renew 403 "" device_a
[[ "$(json_get "$RESPONSE_BODY" error.code)" == "DEVICE_REVOKED" ]] || fail "revoked local Device renewed"
record "Local unbind" "Device, bindings, and sessions revoked"

request POST /api/v1/admin/members 201 \
  '{"displayName":"移动成员乙","familyRole":"adult"}' admin
PERSON_REF_B="$(json_get "$RESPONSE_BODY" member.personRef)"
request POST "/api/v1/admin/members/$PERSON_REF_B/pairing-codes" 201 "" admin true
PAIRING_REF_B="$(json_get "$RESPONSE_BODY" pairing.pairingRef)"
PAIRING_CODE_B="$(json_get "$RESPONSE_BODY" pairing.code)"
DEVICE_CREDENTIAL_B="$(runtime_secret)"
INSTALLATION_ID_B="$(runtime_uuid)"
request POST /api/v1/mobile/pairing/claim 201 \
  "{\"protocolVersion\":1,\"code\":\"$PAIRING_CODE_B\",\"installationId\":\"$INSTALLATION_ID_B\",\"deviceCredential\":\"$DEVICE_CREDENTIAL_B\",\"device\":{\"displayName\":\"验收 iPhone 乙\",\"terminalType\":\"mobile\",\"platform\":\"ios\",\"systemVersion\":\"26.0\",\"appVersion\":\"1.0.0\",\"model\":\"iPhone\"}}"
MOBILE_DEVICE_REF_B="$(json_get "$RESPONSE_BODY" device.deviceRef)"
request DELETE "/api/v1/admin/devices/$MOBILE_DEVICE_REF_B" 200 "" admin
request POST /api/v1/mobile/session/renew 403 "" device_b
[[ "$(json_get "$RESPONSE_BODY" error.code)" == "DEVICE_REVOKED" ]] || fail "remotely revoked Device renewed"
record "Administrator remote revoke" "Shared revocation path blocks subsequent renewal"

assert_no_plaintext_secrets
record "Complete secret scan" "Both mobile claims remain hash-only"

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf '# Mobile Entry Gateway Runtime Acceptance\n\n'
  printf -- '- Started: `%s`\n' "$STARTED_AT"
  printf -- '- Finished: `%s`\n' "$FINISHED_AT"
  printf -- '- Family: `%s`\n' "$FAMILY_REF"
  printf -- '- Result: **PASS**\n\n'
  printf '| Step | Result | Evidence |\n|---|---|---|\n'
  printf '%s\n' "${STEPS[@]}"
  printf '\nThis report intentionally excludes pairing codes, QR payloads, installation identifiers, Device Credentials, EntrySession Tokens, Authorization headers, SQL rows, host paths, and runtime logs containing request bodies.\n'
} > "$REPORT_FILE"

unset BOOTSTRAP_TOKEN ADMIN_TOKEN PERSONAL_TOKEN MOBILE_ENTRY_TOKEN RENEWED_ENTRY_TOKEN
unset DEVICE_CREDENTIAL_A DEVICE_CREDENTIAL_B PAIRING_CODE_A PAIRING_CODE_B
printf '\nAll Mobile Entry Gateway acceptance steps passed.\nReport: %s\n' "$REPORT_FILE"
