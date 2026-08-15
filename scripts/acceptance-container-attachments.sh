#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { printf 'ATTACHMENT ACCEPTANCE FAILED: %s\n' "$1" >&2; exit 1; }
source "$ROOT_DIR/scripts/runtime-isolation-lib.sh"

[[ -n "${FAMILY_AI_RUNTIME_ROOT:-}" && -n "${COMPOSE_PROJECT_NAME:-}" ]] \
  || fail "必须提供隔离 runtime 与 Compose project。"
validate_isolated_runtime_path "$FAMILY_AI_RUNTIME_ROOT"
validate_isolated_project "$COMPOSE_PROJECT_NAME"
RUNTIME_DIR="$FAMILY_AI_RUNTIME_ROOT"
ISOLATED_PROJECT="$COMPOSE_PROJECT_NAME"
CONFIG_DIR="$RUNTIME_DIR/config"
RUN_DIR="$RUNTIME_DIR/run"
COMPOSE_ENV="$CONFIG_DIR/compose.env"
ISOLATED_COMPOSE_FILE="$RUN_DIR/compose.isolated.yaml"
MANIFEST="$RUN_DIR/isolated-runtime-manifest.json"
[[ -f "$MANIFEST" && ! -L "$MANIFEST" && "$(stat -c '%a' "$MANIFEST")" == 600 ]] \
  || fail "isolated-runtime-manifest.json 无效。"
FORMAL_8790="$(read_manifest_field "$MANIFEST" formal8790)"
CONTAINER_ID="$(read_manifest_field "$MANIFEST" containerId)"
PORT="$(read_manifest_field "$MANIFEST" port)"
BASE_URL="http://127.0.0.1:$PORT"
[[ "$(capture_formal_8790_identity)" == "$FORMAL_8790" ]] || fail "正式 8790 与 manifest 不一致。"

compose() { isolated_compose "$@"; }
[[ "$(compose ps -q gateway)" == "$CONTAINER_ID" ]] || fail "隔离容器与 manifest 不一致。"

FIXTURE_DIR="$(mktemp -d "$RUN_DIR/attachment-acceptance.XXXXXXXX")"
chmod 700 "$FIXTURE_DIR"
cleanup() {
  rm -f "$FIXTURE_DIR/source.pdf" "$FIXTURE_DIR/chunk-0" "$FIXTURE_DIR/chunk-1" \
    "$FIXTURE_DIR/response.json" "$FIXTURE_DIR/download-before.pdf" "$FIXTURE_DIR/download-after.pdf"
  rmdir "$FIXTURE_DIR" 2>/dev/null || true
}
trap cleanup EXIT

json_field() {
  node --input-type=module - "$1" "$2" <<'NODE'
import { readFileSync } from "node:fs";
const value = process.argv[3].split(".").reduce((current, key) => current?.[key], JSON.parse(readFileSync(process.argv[2], "utf8")));
if (typeof value !== "string" && typeof value !== "number") process.exit(2);
process.stdout.write(String(value));
NODE
}

DEVICE_TOKEN="$(<"$CONFIG_DIR/device-token")"
curl --fail --silent --show-error --output "$FIXTURE_DIR/response.json" \
  --request POST "$BASE_URL/api/v1/onboarding/family" \
  --header "Authorization: Bearer $DEVICE_TOKEN" --header 'X-Device-Ref: device:test' \
  --header 'Content-Type: application/json' \
  --data '{"familyName":"附件容器验收家庭","ownerName":"附件容器验收成员","deviceName":"附件容器验收设备"}'
ENTRY_REF="$(json_field "$FIXTURE_DIR/response.json" entries.personal.entrySessionRef)"
ENTRY_TOKEN="$(json_field "$FIXTURE_DIR/response.json" entries.personal.token)"

printf '%%PDF-1.7\n' > "$FIXTURE_DIR/source.pdf"
dd if=/dev/zero bs=1M count=8 status=none >> "$FIXTURE_DIR/source.pdf"
printf '\ncontainer attachment acceptance\n' >> "$FIXTURE_DIR/source.pdf"
SOURCE_SIZE="$(stat -c '%s' "$FIXTURE_DIR/source.pdf")"
SOURCE_SHA="$(sha256sum "$FIXTURE_DIR/source.pdf" | awk '{print $1}')"
dd if="$FIXTURE_DIR/source.pdf" of="$FIXTURE_DIR/chunk-0" bs=8388608 count=1 status=none
dd if="$FIXTURE_DIR/source.pdf" of="$FIXTURE_DIR/chunk-1" bs=8388608 skip=1 status=none

curl --fail --silent --show-error --output "$FIXTURE_DIR/response.json" \
  --request POST "$BASE_URL/api/v1/attachments/uploads" \
  --header "Authorization: Bearer $ENTRY_TOKEN" --header "X-Entry-Session-Ref: $ENTRY_REF" \
  --header 'X-Family-AI-Web-Request: 1' --header 'Content-Type: application/json' \
  --data "{\"protocolVersion\":1,\"fileName\":\"container.pdf\",\"mediaType\":\"application/pdf\",\"sizeBytes\":$SOURCE_SIZE}"
ATTACHMENT_REF="$(json_field "$FIXTURE_DIR/response.json" attachmentRef)"
[[ "$(json_field "$FIXTURE_DIR/response.json" chunkCount)" == 2 ]] || fail "附件没有形成两个分片。"

for index in 0 1; do
  chunk="$FIXTURE_DIR/chunk-$index"
  curl --fail --silent --show-error --output "$FIXTURE_DIR/response.json" \
    --request PUT "$BASE_URL/api/v1/attachments/uploads/$ATTACHMENT_REF/chunks/$index" \
    --header "Authorization: Bearer $ENTRY_TOKEN" --header "X-Entry-Session-Ref: $ENTRY_REF" \
    --header 'X-Family-AI-Web-Request: 1' --header 'Content-Type: application/octet-stream' \
    --header "X-Family-AI-Chunk-Sha256: $(sha256sum "$chunk" | awk '{print $1}')" \
    --data-binary "@$chunk"
done

curl --fail --silent --show-error --output "$FIXTURE_DIR/response.json" \
  --request POST "$BASE_URL/api/v1/attachments/uploads/$ATTACHMENT_REF/complete" \
  --header "Authorization: Bearer $ENTRY_TOKEN" --header "X-Entry-Session-Ref: $ENTRY_REF" \
  --header 'X-Family-AI-Web-Request: 1' --header 'Content-Type: application/json' \
  --data "{\"protocolVersion\":1,\"sha256\":\"$SOURCE_SHA\",\"chunkCount\":2}"

download() {
  curl --fail --silent --show-error --output "$1" "$BASE_URL/api/v1/attachments/$ATTACHMENT_REF" \
    --header "Authorization: Bearer $ENTRY_TOKEN" --header "X-Entry-Session-Ref: $ENTRY_REF"
  [[ "$(sha256sum "$1" | awk '{print $1}')" == "$SOURCE_SHA" ]] || fail "下载附件 SHA-256 不一致。"
}
download "$FIXTURE_DIR/download-before.pdf"
compose restart gateway >/dev/null
port_row="$(compose port gateway 8790)"
[[ "$port_row" =~ ^127\.0\.0\.1:([1-9][0-9]{0,4})$ && "${BASH_REMATCH[1]}" != 8790 ]] \
  || fail "restart 后随机 loopback 端口无效。"
PORT="${BASH_REMATCH[1]}"
node --input-type=module - "$MANIFEST" "$PORT" <<'NODE'
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [path, port] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.port = port;
const temporary = `${path}.tmp`;
writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
chmodSync(temporary, 0o600);
renameSync(temporary, path);
NODE
BASE_URL="http://127.0.0.1:$PORT"
for _ in $(seq 1 60); do curl --fail --silent --max-time 2 "$BASE_URL/health" >/dev/null 2>&1 && break; sleep 1; done
download "$FIXTURE_DIR/download-after.pdf"

compose exec -T gateway sh -c 'test ! -w /app && test "$FAMILY_AI_ATTACHMENT_ROOT" = /app/.runtime/data/attachments' \
  || fail "只读根或 FAMILY_AI_ATTACHMENT_ROOT 不符合契约。"
if find "$RUNTIME_DIR/data/attachments" -mindepth 1 -perm /077 -print -quit | grep -q .; then
  fail "附件树存在 group/world 权限。"
fi
[[ "$(capture_formal_8790_identity)" == "$FORMAL_8790" ]] || fail "附件验收改变了正式 8790。"
printf 'Container attachment acceptance passed: 2 chunks, restart, SHA-256 preserved, FAMILY_AI_ATTACHMENT_ROOT verified.\n'
