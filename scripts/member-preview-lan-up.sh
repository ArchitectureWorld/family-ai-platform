#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 0 ]] || { printf 'usage: member-preview-lan-up.sh\n' >&2; exit 2; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REMOTE_USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
APPROVED_ROOT="$(cd "$REMOTE_USER_HOME/Development/family-ai-platform-worktrees/member-web-entry-hardening" && pwd -P)"
[[ "$(hostname -s)" == "Admin-YR" ]] || { printf 'LAN_PREVIEW_HOST_INVALID\n' >&2; exit 1; }
[[ "$(id -un)" == "youran" ]] || { printf 'LAN_PREVIEW_USER_INVALID\n' >&2; exit 1; }
[[ "$ROOT_DIR" == "$APPROVED_ROOT" ]] || { printf 'LAN_PREVIEW_ROOT_INVALID\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" rev-parse --show-toplevel)" == "$ROOT_DIR" ]] || { printf 'LAN_PREVIEW_REPOSITORY_INVALID\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" branch --show-current)" == "fix/member-web-entry-hardening" ]] || { printf 'LAN_PREVIEW_BRANCH_INVALID\n' >&2; exit 1; }

cd "$ROOT_DIR"
umask 077
RUNTIME_DIR="$ROOT_DIR/.runtime-preview"
TLS_DIR="$RUNTIME_DIR/lan-tls"
RUN_DIR="$RUNTIME_DIR/run"
LOG_DIR="$RUNTIME_DIR/logs"
NGINX_PREFIX="$RUNTIME_DIR/lan-nginx"
NGINX_CONFIG="$NGINX_PREFIX/nginx.conf"
NGINX_MANIFEST="$RUN_DIR/lan-nginx.pid.json"
NGINX_PID_FILE="$RUN_DIR/lan-nginx.pid"
NGINX_LOG="$LOG_DIR/lan-nginx.log"
BASELINE_FILE="$RUN_DIR/baseline-8790-lan.snapshot"
LIBRARY="$ROOT_DIR/scripts/member-preview-lan-lib.mjs"
NGINX_BIN="$(command -v nginx || true)"
GATEWAY_ORIGIN="http://127.0.0.1:8791"

fail() { printf '%s\n' "$1" >&2; exit 1; }

ensure_directory() {
  local path="$1"
  [[ ! -L "$path" && ( ! -e "$path" || -d "$path" ) ]] || fail LAN_PREVIEW_RUNTIME_INVALID
  [[ -d "$path" ]] || mkdir --mode=0700 "$path"
  chmod 0700 "$path"
}

ensure_regular() {
  local path="$1" mode="$2"
  [[ -f "$path" && ! -L "$path" ]] || fail LAN_PREVIEW_RUNTIME_INVALID
  chmod "$mode" "$path"
}

atomic_text() {
  local target="$1" mode="$2" source="$3" temporary="${1}.tmp.$$.$RANDOM"
  [[ -d "$(dirname "$target")" && ! -L "$(dirname "$target")" ]] || fail LAN_PREVIEW_RUNTIME_INVALID
  [[ ! -L "$target" && ( ! -e "$target" || -f "$target" ) ]] || fail LAN_PREVIEW_RUNTIME_INVALID
  [[ -f "$source" && ! -L "$source" ]] || fail LAN_PREVIEW_RUNTIME_INVALID
  cp -- "$source" "$temporary"
  chmod "$mode" "$temporary"
  sync -f "$temporary"
  mv -fT "$temporary" "$target"
  chmod "$mode" "$target"
  sync -f "$(dirname "$target")"
}

capture_8790() {
  local health docker_row listener_row
  health="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8790/health | sha256sum | awk '{print $1}')" \
    || return 1
  docker_row="$(docker ps --filter publish=8790 --format '{{.ID}}\t{{.Ports}}')" || return 1
  listener_row="$(ss -H -ltnp 'sport = :8790')" || return 1
  [[ "$health" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$(printf '%s\n' "$docker_row" | sed '/^$/d' | wc -l)" -eq 1 ]] || return 1
  [[ "$docker_row" == *"127.0.0.1:8790->8790/tcp"* ]] || return 1
  [[ "$(printf '%s\n' "$listener_row" | sed '/^$/d' | wc -l)" -eq 1 ]] || return 1
  [[ "$listener_row" == *"127.0.0.1:8790"* ]] || return 1
  CURRENT_8790_HEALTH="$health"
  CURRENT_8790_DOCKER="$docker_row"
  CURRENT_8790_LISTENER="$listener_row"
}

write_8790_baseline() {
  local temporary="${BASELINE_FILE}.tmp.$$"
  node --input-type=module - "$temporary" \
    "$CURRENT_8790_HEALTH" "$CURRENT_8790_DOCKER" "$CURRENT_8790_LISTENER" <<'NODE'
import { writeFileSync } from "node:fs";
const [path, healthSha256, dockerRow, listenerRow] = process.argv.slice(2);
writeFileSync(path, `${JSON.stringify({
  version: 1,
  healthSha256,
  dockerRow,
  listenerRow
})}\n`, { mode: 0o600, flag: "wx" });
NODE
  chmod 0600 "$temporary"
  sync -f "$temporary"
  mv -fT "$temporary" "$BASELINE_FILE"
  sync -f "$RUN_DIR"
}

compare_8790() {
  local before_health="$CURRENT_8790_HEALTH"
  local before_docker="$CURRENT_8790_DOCKER"
  local before_listener="$CURRENT_8790_LISTENER"
  capture_8790 || return 1
  [[ "$CURRENT_8790_HEALTH" == "$before_health" ]]
  [[ "$CURRENT_8790_DOCKER" == "$before_docker" ]]
  [[ "$CURRENT_8790_LISTENER" == "$before_listener" ]]
}

for path in "$RUNTIME_DIR" "$TLS_DIR" "$RUN_DIR" "$LOG_DIR" "$NGINX_PREFIX"; do
  ensure_directory "$path"
done
[[ -n "$NGINX_BIN" && -x "$NGINX_BIN" ]] || fail LAN_PREVIEW_NGINX_MISSING
command -v openssl >/dev/null 2>&1 || fail LAN_PREVIEW_OPENSSL_MISSING
capture_8790 || fail LAN_PREVIEW_8790_INVALID
write_8790_baseline

"$ROOT_DIR/scripts/member-preview-up.sh" >/dev/null \
  || fail LAN_PREVIEW_GATEWAY_INVALID
curl --fail --silent --show-error --max-time 5 "$GATEWAY_ORIGIN/health" >/dev/null \
  || fail LAN_PREVIEW_GATEWAY_INVALID

LAN_ROUTE="$(ip -json -4 route get 1.1.1.1)"
LAN_IP="$(node "$LIBRARY" --route-ip "$LAN_ROUTE")"
# Accepted private ranges include 10/8, 172.16/12 and 192.168/16.
node "$LIBRARY" --urls "$LAN_IP" >/dev/null \
  || fail LAN_PREVIEW_PRIVATE_IP_INVALID

CA_KEY="$TLS_DIR/ca.key"
CA_CERT="$TLS_DIR/ca.crt"
SERVER_KEY="$TLS_DIR/server.key"
SERVER_CERT="$TLS_DIR/server.crt"
if [[ ! -e "$CA_KEY" && ! -e "$CA_CERT" ]]; then
  ca_key_tmp="$TLS_DIR/.ca.key.$$"
  ca_cert_tmp="$TLS_DIR/.ca.crt.$$"
  openssl ecparam -name prime256v1 -genkey -noout -out "$ca_key_tmp" >/dev/null 2>&1 \
    || fail LAN_PREVIEW_CA_GENERATION_FAILED
  chmod 0600 "$ca_key_tmp"
  openssl req -x509 -new -sha256 \
    -key "$ca_key_tmp" \
    -out "$ca_cert_tmp" \
    -days 365 \
    -subj "/CN=Family AI Preview Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1 \
    || fail LAN_PREVIEW_CA_GENERATION_FAILED
  chmod 0644 "$ca_cert_tmp"
  atomic_text "$CA_KEY" 0600 "$ca_key_tmp"
  atomic_text "$CA_CERT" 0644 "$ca_cert_tmp"
  rm -f -- "$ca_key_tmp" "$ca_cert_tmp"
elif [[ ! -e "$CA_KEY" || ! -e "$CA_CERT" ]]; then
  fail LAN_PREVIEW_CA_INVALID
fi

ensure_regular "$CA_KEY" 0600
ensure_regular "$CA_CERT" 0644
openssl x509 -in "$CA_CERT" -noout -checkend 86400 >/dev/null 2>&1 \
  || fail LAN_PREVIEW_CA_EXPIRED
openssl x509 -in "$CA_CERT" -noout -text \
  | grep -Fq "CA:TRUE" || fail LAN_PREVIEW_CA_INVALID
ca_key_fingerprint="$(
  openssl pkey -in "$CA_KEY" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}'
)"
ca_cert_fingerprint="$(
  openssl x509 -in "$CA_CERT" -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | sha256sum | awk '{print $1}'
)"
[[ "$ca_key_fingerprint" == "$ca_cert_fingerprint" ]] || fail LAN_PREVIEW_CA_KEY_MISMATCH

leaf_valid=1
if [[ ! -e "$SERVER_KEY" || ! -e "$SERVER_CERT" ]]; then
  leaf_valid=0
else
  ensure_regular "$SERVER_KEY" 0600
  ensure_regular "$SERVER_CERT" 0644
  openssl verify -CAfile "$CA_CERT" "$SERVER_CERT" >/dev/null 2>&1 || leaf_valid=0
  openssl x509 -in "$SERVER_CERT" -noout -checkend 86400 >/dev/null 2>&1 || leaf_valid=0
  openssl x509 -in "$SERVER_CERT" -noout -ext subjectAltName 2>/dev/null \
    | grep -Fq "IP Address:$LAN_IP" || leaf_valid=0
fi

if [[ "$leaf_valid" -eq 0 ]]; then
  server_key_tmp="$TLS_DIR/.server.key.$$"
  server_csr_tmp="$TLS_DIR/.server.csr.$$"
  server_cert_tmp="$TLS_DIR/.server.crt.$$"
  leaf_extensions_tmp="$TLS_DIR/.server.ext.$$"
  node "$LIBRARY" --leaf-extensions "$LAN_IP" >"$leaf_extensions_tmp" \
    || fail LAN_PREVIEW_LEAF_GENERATION_FAILED
  chmod 0600 "$leaf_extensions_tmp"
  openssl ecparam -name prime256v1 -genkey -noout -out "$server_key_tmp" >/dev/null 2>&1 \
    || fail LAN_PREVIEW_LEAF_GENERATION_FAILED
  chmod 0600 "$server_key_tmp"
  openssl req -new -sha256 -key "$server_key_tmp" -out "$server_csr_tmp" \
    -subj "/CN=$LAN_IP" >/dev/null 2>&1 \
    || fail LAN_PREVIEW_LEAF_GENERATION_FAILED
  serial_hex="$(openssl rand -hex 16)"
  openssl x509 -req -sha256 \
    -in "$server_csr_tmp" \
    -CA "$CA_CERT" \
    -CAkey "$CA_KEY" \
    -set_serial "0x$serial_hex" \
    -days 30 \
    -extfile "$leaf_extensions_tmp" \
    -out "$server_cert_tmp" >/dev/null 2>&1 \
    || fail LAN_PREVIEW_LEAF_GENERATION_FAILED
  chmod 0644 "$server_cert_tmp"
  atomic_text "$SERVER_KEY" 0600 "$server_key_tmp"
  atomic_text "$SERVER_CERT" 0644 "$server_cert_tmp"
  rm -f -- "$server_key_tmp" "$server_csr_tmp" "$server_cert_tmp" "$leaf_extensions_tmp"
fi

ensure_regular "$SERVER_KEY" 0600
ensure_regular "$SERVER_CERT" 0644
openssl verify -CAfile "$CA_CERT" "$SERVER_CERT" >/dev/null 2>&1 \
  || fail LAN_PREVIEW_LEAF_INVALID
openssl x509 -in "$SERVER_CERT" -noout -ext subjectAltName \
  | grep -Fq "IP Address:$LAN_IP" || fail LAN_PREVIEW_LEAF_SAN_INVALID
server_key_fingerprint="$(
  openssl pkey -in "$SERVER_KEY" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}'
)"
server_cert_fingerprint="$(
  openssl x509 -in "$SERVER_CERT" -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | sha256sum | awk '{print $1}'
)"
[[ "$server_key_fingerprint" == "$server_cert_fingerprint" ]] \
  || fail LAN_PREVIEW_LEAF_KEY_MISMATCH

ca_not_after="$(openssl x509 -in "$CA_CERT" -noout -enddate | cut -d= -f2-)"
leaf_not_after="$(openssl x509 -in "$SERVER_CERT" -noout -enddate | cut -d= -f2-)"
node --input-type=module - "$LIBRARY" "$LAN_IP" "$ca_not_after" "$leaf_not_after" <<'NODE'
const [library, ip, caNotAfter, leafNotAfter] = process.argv.slice(2);
const { validateTlsMetadata } = await import(new URL(`file://${library}`));
const san = ip;
validateTlsMetadata({ now: Date.now(), ip, caNotAfter, leafNotAfter, leafSanIp: san });
NODE

config_tmp="$NGINX_PREFIX/.nginx.conf.$$"
node "$LIBRARY" --render-nginx "$LAN_IP" "$RUNTIME_DIR" >"$config_tmp" \
  || fail LAN_PREVIEW_NGINX_CONFIG_INVALID
chmod 0600 "$config_tmp"
atomic_text "$NGINX_CONFIG" 0600 "$config_tmp"
rm -f -- "$config_tmp"
ensure_regular "$NGINX_CONFIG" 0600

CONFIG_SHA="$(sha256sum "$NGINX_CONFIG" | awk '{print $1}')"
CA_FINGERPRINT="$(openssl x509 -in "$CA_CERT" -noout -fingerprint -sha256 | cut -d= -f2)"
LEAF_FINGERPRINT="$(openssl x509 -in "$SERVER_CERT" -noout -fingerprint -sha256 | cut -d= -f2)"
LAUNCH_COMMIT="$(git rev-parse HEAD)"

manifest_status="$(
  node --input-type=module - "$NGINX_MANIFEST" "$ROOT_DIR" "$NGINX_BIN" \
    "$NGINX_PREFIX" "$NGINX_CONFIG" "$CONFIG_SHA" "$LAN_IP" \
    "$CA_FINGERPRINT" "$LEAF_FINGERPRINT" "$LAUNCH_COMMIT" <<'NODE'
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
const [
  manifest, root, nginxBin, prefix, configPath, configSha256, lanIp,
  caFingerprint, leafFingerprint, launchCommit
] = process.argv.slice(2);
function result(value) { process.stdout.write(value); }
try {
  const info = lstatSync(manifest);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 16384) {
    result("invalid");
  } else {
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    const expectedKeys = [
      "caFingerprint", "configPath", "configSha256", "cwd", "executable",
      "httpPort", "httpsPort", "kind", "lanIp", "launchCommit", "leafFingerprint",
      "pid", "prefix", "starttime", "version"
    ].sort();
    if (
      Object.keys(value).sort().join("\0") !== expectedKeys.join("\0") ||
      value.version !== 1 ||
      value.kind !== "lan_nginx" ||
      value.cwd !== root ||
      value.executable !== nginxBin ||
      value.prefix !== prefix ||
      value.configPath !== configPath ||
      value.configSha256 !== configSha256 ||
      value.lanIp !== lanIp ||
      value.httpPort !== 9080 ||
      value.httpsPort !== 9443 ||
      value.caFingerprint !== caFingerprint ||
      value.leafFingerprint !== leafFingerprint ||
      value.launchCommit !== launchCommit ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      !/^\d+$/u.test(value.starttime)
    ) {
      result("invalid");
    } else {
      let stat;
      try {
        stat = readFileSync(`/proc/${value.pid}/stat`, "utf8");
      } catch (error) {
        result(error?.code === "ENOENT" ? "dead" : "invalid");
        process.exit(0);
      }
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/u);
      const cwd = readlinkSync(`/proc/${value.pid}/cwd`);
      const executable = readlinkSync(`/proc/${value.pid}/exe`);
      const command = readFileSync(`/proc/${value.pid}/cmdline`, "utf8").replace(/\0/g, " ");
      const rows = [9080, 9443].map(port =>
        execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], { encoding: "utf8" })
          .trim()
      );
      result(
        fields[19] === value.starttime &&
        cwd === root &&
        executable === nginxBin &&
        command.includes(prefix) &&
        command.includes(configPath) &&
        rows.every((row, index) =>
          row.split("\n").filter(Boolean).length === 1 &&
          row.includes(`0.0.0.0:${index === 0 ? 9080 : 9443}`) &&
          row.includes(`pid=${value.pid},`)
        )
          ? "live"
          : "invalid"
      );
    }
  }
} catch (error) {
  result(error?.code === "ENOENT" ? "missing" : "invalid");
}
NODE
)"

if [[ "$manifest_status" == "live" ]]; then
  LAN_PID=""
elif [[ "$manifest_status" == "dead" || "$manifest_status" == "missing" ]]; then
  [[ -z "$(ss -H -ltnp 'sport = :9080')" ]] || fail LAN_PREVIEW_PORT_9080_BUSY
  [[ -z "$(ss -H -ltnp 'sport = :9443')" ]] || fail LAN_PREVIEW_PORT_9443_BUSY
  [[ "$manifest_status" == "missing" ]] || rm -f -- "$NGINX_MANIFEST" "$NGINX_PID_FILE"
  "$NGINX_BIN" -p "$NGINX_PREFIX/" -c "$NGINX_CONFIG" -t >/dev/null 2>&1 \
    || fail LAN_PREVIEW_NGINX_CONFIG_INVALID
  : >"$NGINX_LOG"
  chmod 0600 "$NGINX_LOG"
  # isolated launch contract: nginx -p <runtime-prefix> -g 'daemon off;'
  "$NGINX_BIN" -p "$NGINX_PREFIX/" -c "$NGINX_CONFIG" -g 'daemon off;' \
    >>"$NGINX_LOG" 2>&1 &
  LAN_PID="$!"
  LAN_STARTTIME="$(awk '{print $22}' "/proc/$LAN_PID/stat" 2>/dev/null || true)"
  [[ "$LAN_PID" =~ ^[0-9]+$ && "$LAN_STARTTIME" =~ ^[0-9]+$ ]] \
    || fail LAN_PREVIEW_NGINX_START_FAILED
  ready=0
  for _ in $(seq 1 100); do
    if [[ "$(ss -H -ltnp 'sport = :9080')" == *"pid=$LAN_PID,"* ]] &&
       [[ "$(ss -H -ltnp 'sport = :9443')" == *"pid=$LAN_PID,"* ]]; then
      ready=1
      break
    fi
    if ! kill -0 "$LAN_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  [[ "$ready" -eq 1 ]] || fail LAN_PREVIEW_NGINX_START_FAILED
  manifest_tmp="${NGINX_MANIFEST}.tmp.$$"
  node --input-type=module - "$manifest_tmp" "$LAN_PID" "$LAN_STARTTIME" \
    "$ROOT_DIR" "$NGINX_BIN" "$NGINX_PREFIX" "$NGINX_CONFIG" "$CONFIG_SHA" \
    "$LAN_IP" "$CA_FINGERPRINT" "$LEAF_FINGERPRINT" "$LAUNCH_COMMIT" <<'NODE'
import { writeFileSync } from "node:fs";
const [
  path, pid, starttime, cwd, executable, prefix, configPath, configSha256,
  lanIp, caFingerprint, leafFingerprint, launchCommit
] = process.argv.slice(2);
writeFileSync(path, `${JSON.stringify({
  version: 1,
  kind: "lan_nginx",
  pid: Number(pid),
  starttime,
  cwd,
  executable,
  prefix,
  configPath,
  configSha256,
  lanIp,
  httpPort: 9080,
  httpsPort: 9443,
  caFingerprint,
  leafFingerprint,
  launchCommit
})}\n`, { mode: 0o600, flag: "wx" });
NODE
  chmod 0600 "$manifest_tmp"
  sync -f "$manifest_tmp"
  mv -fT "$manifest_tmp" "$NGINX_MANIFEST"
  printf '%s\n' "$LAN_PID" >"$NGINX_PID_FILE"
  chmod 0600 "$NGINX_PID_FILE"
  sync -f "$RUN_DIR"
else
  fail LAN_PREVIEW_NGINX_OWNERSHIP_INVALID
fi

downloaded_ca="$RUNTIME_DIR/ca-probe.$$"
curl --fail --silent --show-error --max-time 5 \
  "http://$LAN_IP:9080/family-ai-preview-ca.crt" >"$downloaded_ca" \
  || fail LAN_PREVIEW_CA_PROBE_FAILED
[[ "$(sha256sum "$downloaded_ca" | awk '{print $1}')" == "$(sha256sum "$CA_CERT" | awk '{print $1}')" ]] \
  || fail LAN_PREVIEW_CA_PROBE_FAILED
rm -f -- "$downloaded_ca"
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "http://$LAN_IP:9080/")" == "404" ]] \
  || fail LAN_PREVIEW_HTTP_SURFACE_INVALID

HTTPS_ORIGIN="https://$LAN_IP:9443"
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --cacert "$CA_CERT" --max-time 5 "$HTTPS_ORIGIN/")" == "302" ]] \
  || fail LAN_PREVIEW_TLS_ROOT_INVALID
for path in /health /admin/ /member/; do
  curl --fail --silent --show-error --cacert "$CA_CERT" --max-time 5 \
    "$HTTPS_ORIGIN$path" >/dev/null || fail LAN_PREVIEW_TLS_ROUTE_INVALID
done
node "$ROOT_DIR/scripts/member-preview-admin.mjs" --origin "$HTTPS_ORIGIN" >/dev/null \
  || fail LAN_PREVIEW_ADMIN_HANDOFF_FAILED
compare_8790 || fail LAN_PREVIEW_8790_CHANGED

urls_json="$(node "$LIBRARY" --urls "$LAN_IP")"
node --input-type=module - "$urls_json" "$CA_FINGERPRINT" <<'NODE'
const [urlsJson, fingerprint] = process.argv.slice(2);
const urls = JSON.parse(urlsJson);
process.stdout.write(
  `LAN Preview: PASS\n` +
  `CA download: ${urls.ca}\n` +
  `Family AI: ${urls.root}\n` +
  `Admin Web: ${urls.admin}\n` +
  `Member Web: ${urls.member}\n` +
  `CA SHA256: ${fingerprint}\n`
);
NODE
