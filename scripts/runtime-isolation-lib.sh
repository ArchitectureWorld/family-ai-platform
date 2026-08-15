#!/usr/bin/env bash

capture_formal_8790_identity() {
  local health_hash docker_rows listener_rows
  health_hash="$(curl --silent --show-error --max-time 2 http://127.0.0.1:8790/health 2>/dev/null | sha256sum | awk '{print $1}' || true)"
  docker_rows="$(docker ps --filter publish=8790 --format '{{.ID}}|{{.Image}}|{{.Ports}}' 2>/dev/null || true)"
  listener_rows="$(ss -H -ltnp 'sport = :8790' 2>/dev/null || true)"
  printf 'health=%s\ndocker=%s\nlistener=%s\n' "$health_hash" "$docker_rows" "$listener_rows" \
    | sha256sum | awk '{print $1}'
}

validate_isolated_runtime_path() {
  local path="$1"
  [[ "$path" == /* ]] || fail "FAMILY_AI_RUNTIME_ROOT 必须是绝对路径。"
  [[ "$path" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "FAMILY_AI_RUNTIME_ROOT 只能包含安全路径字符。"
  [[ "$path" != "$ROOT_DIR" && "$path" != "$ROOT_DIR/.runtime" ]] \
    || fail "隔离 runtime 不得使用仓库或正式 .runtime。"
  [[ "$(realpath -m "$path")" == "$path" ]] || fail "隔离 runtime 不得经过符号链接。"
}

validate_isolated_project() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{2,48}$ ]] \
    || fail "COMPOSE_PROJECT_NAME 必须是 3-49 位安全小写标识。"
}

require_runtime_mode() {
  local path="$1"
  [[ "$(stat -c '%a' "$path")" == "700" ]] || fail "隔离 runtime 权限必须是 0700。"
}

read_manifest_field() {
  local manifest="$1" field="$2"
  node --input-type=module - "$manifest" "$field" <<'NODE'
import { readFileSync } from "node:fs";
const value = JSON.parse(readFileSync(process.argv[2], "utf8"))[process.argv[3]];
if (typeof value !== "string" || value.length === 0) process.exit(2);
process.stdout.write(value);
NODE
}

validate_isolated_compose_json() {
  local rendered="$1" expected_image="$2" expected_data="$3"
  node --input-type=module - "$rendered" "$expected_image" "$expected_data" "$ROOT_DIR/.runtime" <<'NODE'
import { readFileSync } from "node:fs";
const [path, expectedImage, expectedData, formalRuntime] = process.argv.slice(2);
const definition = JSON.parse(readFileSync(path, "utf8"));
const services = definition.services ?? {};
const gateway = services.gateway;
const fail = message => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
if (!gateway || Object.keys(services).length !== 1) fail("isolated Compose must contain only gateway");
if ("build" in gateway) fail("isolated Compose must not contain build");
if (gateway.image !== expectedImage) fail("isolated Compose image mismatch");
if (gateway.read_only !== true) fail("isolated Compose root must remain read-only");
const ports = gateway.ports ?? [];
if (
  ports.length !== 1 ||
  ports[0].target !== 8790 ||
  ports[0].host_ip !== "127.0.0.1" ||
  ![undefined, "0", 0].includes(ports[0].published)
) fail("isolated Compose must use one random loopback port");
const volumes = gateway.volumes ?? [];
if (
  volumes.length !== 1 ||
  volumes[0].type !== "bind" ||
  volumes[0].source !== expectedData ||
  volumes[0].target !== "/app/.runtime/data"
) fail("isolated Compose must use only the isolated data bind mount");
const serialized = JSON.stringify(definition);
if (serialized.includes(formalRuntime) || serialized.includes('"published":"8790"')) {
  fail("isolated Compose inherited formal runtime or port");
}
NODE
}

isolated_compose() {
  docker compose \
    --project-name "$ISOLATED_PROJECT" \
    --env-file "$COMPOSE_ENV" \
    --file "$ISOLATED_COMPOSE_FILE" \
    "$@"
}
