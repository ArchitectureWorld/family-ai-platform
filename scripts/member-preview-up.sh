#!/usr/bin/env bash
set -euo pipefail

usage() { printf 'usage: member-preview-up.sh [--with-claim-loss-proxy]\n' >&2; }
WITH_CLAIM_LOSS_PROXY=0
case "$#:${1:-}" in
  0:) ;;
  1:--with-claim-loss-proxy) WITH_CLAIM_LOSS_PROXY=1 ;;
  *) usage; exit 2 ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REMOTE_USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
APPROVED_ROOT="$(cd "$REMOTE_USER_HOME/Development/family-ai-platform-worktrees/member-web-entry-hardening" && pwd -P)"
[[ "$(hostname -s)" == "Admin-YR" ]] || { printf 'PREVIEW_HOST_INVALID\n' >&2; exit 1; }
[[ "$(id -un)" == "youran" ]] || { printf 'PREVIEW_USER_INVALID\n' >&2; exit 1; }
[[ "$ROOT_DIR" == "$APPROVED_ROOT" ]] || { printf 'PREVIEW_ROOT_INVALID\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" rev-parse --show-toplevel)" == "$ROOT_DIR" ]] || { printf 'PREVIEW_REPOSITORY_INVALID\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" branch --show-current)" == "fix/member-web-entry-hardening" ]] || { printf 'PREVIEW_BRANCH_INVALID\n' >&2; exit 1; }

cd "$ROOT_DIR"
umask 077
RUNTIME_DIR="$ROOT_DIR/.runtime-preview"
CONFIG_DIR="$RUNTIME_DIR/config"
DATA_DIR="$RUNTIME_DIR/data"
RUN_DIR="$RUNTIME_DIR/run"
LOG_DIR="$RUNTIME_DIR/logs"
START_LOCK_DIR="$RUN_DIR/start.lock"
GATEWAY_MANIFEST="$RUN_DIR/gateway.pid.json"
PROXY_MANIFEST="$RUN_DIR/claim-loss-proxy.pid.json"
GATEWAY_LOG="$LOG_DIR/gateway.log"
PROXY_LOG="$LOG_DIR/claim-loss-proxy.log"

# gateway: starttime/cwd/entrypoint/launchCommit/distSha256/memberPublicSha256/configSha256
# proxy: starttime/cwd/entrypoint/launchCommit/proxySourceSha256/proxyConfigSha256
# exact listeners are 127.0.0.1:8791 and optional 127.0.0.1:8792 via ss -H -ltnp.
ensure_directory() {
  local path="$1"
  [[ ! -L "$path" && ( ! -e "$path" || -d "$path" ) ]] || { printf 'PREVIEW_RUNTIME_INVALID\n' >&2; exit 1; }
  [[ -d "$path" ]] || mkdir --mode=0700 "$path"
  chmod 0700 "$path"
}
ensure_protected_file() {
  local path="$1"
  [[ ! -L "$path" && ( ! -e "$path" || -f "$path" ) ]] || { printf 'PREVIEW_RUNTIME_INVALID\n' >&2; exit 1; }
  if [[ ! -e "$path" ]]; then
    ( set -o noclobber; umask 077; : >"$path" ) 2>/dev/null || {
      printf 'PREVIEW_RUNTIME_INVALID\n' >&2
      exit 1
    }
  fi
  chmod 0600 "$path"
}
tighten_optional_file() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] || fail PREVIEW_RUNTIME_INVALID
    chmod 0600 "$path"
  fi
}

fail() { printf '%s\n' "$1" >&2; exit 1; }

capture_8790() {
  local health_hash docker_row listener_row
  health_hash="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8790/health | sha256sum | awk '{print $1}')" || return 1
  [[ "$health_hash" =~ ^[0-9a-f]{64}$ ]] || return 1
  docker_row="$(docker ps --filter publish=8790 --format '{{.ID}}\t{{.Ports}}')" || return 1
  [[ "$(printf '%s\n' "$docker_row" | sed '/^$/d' | wc -l)" -eq 1 ]] || return 1
  [[ "$docker_row" == *"127.0.0.1:8790->8790/tcp"* ]] || return 1
  listener_row="$(ss -H -ltnp 'sport = :8790')" || return 1
  [[ "$(printf '%s\n' "$listener_row" | sed '/^$/d' | wc -l)" -eq 1 ]] || return 1
  [[ "$listener_row" == *"127.0.0.1:8790"* ]] || return 1
  BASELINE_HEALTH_SHA="$health_hash"
  BASELINE_DOCKER_ROW="$docker_row"
  BASELINE_LISTENER_ROW="$listener_row"
}

compare_8790() {
  local before_health="$BASELINE_HEALTH_SHA" before_docker="$BASELINE_DOCKER_ROW" before_listener="$BASELINE_LISTENER_ROW"
  capture_8790 || return 1
  [[ "$BASELINE_HEALTH_SHA" == "$before_health" && "$BASELINE_DOCKER_ROW" == "$before_docker" && "$BASELINE_LISTENER_ROW" == "$before_listener" ]]
}

atomic_text_file() {
  local target="$1" temporary="${1}.tmp.$$.$RANDOM"
  [[ -d "$(dirname "$target")" && ! -L "$(dirname "$target")" ]] || fail PREVIEW_ATOMIC_WRITE_FAILED
  [[ ! -L "$target" && ( ! -e "$target" || -f "$target" ) ]] || fail PREVIEW_ATOMIC_WRITE_FAILED
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || fail PREVIEW_ATOMIC_WRITE_FAILED
  ( set -o noclobber; umask 077; builtin printf '%s' "$2" >"$temporary" ) \
    2>/dev/null || fail PREVIEW_ATOMIC_WRITE_FAILED
  [[ -f "$temporary" && ! -L "$temporary" ]] || fail PREVIEW_ATOMIC_WRITE_FAILED
  chmod 0600 "$temporary"
  sync -f "$temporary"
  mv -fT "$temporary" "$target"
  chmod 0600 "$target"
  sync -f "$(dirname "$target")"
}

write_lock_owner() {
  local owner="$START_LOCK_DIR/owner.json" pid="$$" starttime lock_id="$1"
  starttime="$(awk '{print $22}' "/proc/$$/stat")"
  node --input-type=module - "$owner" "$pid" "$starttime" "$ROOT_DIR" "$lock_id" <<'NODE'
import { openSync, closeSync, fsyncSync, renameSync, chmodSync, writeFileSync } from "node:fs";
const [path, pidRaw, starttime, cwd, lockId] = process.argv.slice(2);
const value = { version: 1, pid: Number(pidRaw), starttime, cwd, lockId };
const temporary = `${path}.tmp.${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
const descriptor = openSync(temporary, "r"); fsyncSync(descriptor); closeSync(descriptor);
chmodSync(temporary, 0o600); renameSync(temporary, path);
NODE
  chmod 0600 "$owner"
}

inspect_lock_owner() {
  node --input-type=module - "$1" "$ROOT_DIR" <<'NODE'
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
const [path, expectedCwd] = process.argv.slice(2);
const result = value => process.stdout.write(value);
function main() {
try {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 4096) return result("invalid");
  const first = readFileSync(path, "utf8");
  const second = readFileSync(path, "utf8");
  if (first !== second) return result("invalid");
  const owner = JSON.parse(first);
  const keys = Object.keys(owner).sort().join("\0");
  if (keys !== "cwd\0lockId\0pid\0starttime\0version" || owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.cwd !== expectedCwd || typeof owner.starttime !== "string" || !/^\d+$/.test(owner.starttime) || typeof owner.lockId !== "string" || !/^[0-9a-f-]{36}$/.test(owner.lockId)) return result("invalid");
  let stat;
  try { stat = readFileSync(`/proc/${owner.pid}/stat`, "utf8"); } catch (error) { return result(error?.code === "ENOENT" ? "dead" : "invalid"); }
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const starttime = fields[19];
  let cwd;
  try { cwd = readlinkSync(`/proc/${owner.pid}/cwd`); } catch { return result("invalid"); }
  result(starttime === owner.starttime && cwd === expectedCwd ? "live" : "invalid");
} catch { result("invalid"); }
}
main();
NODE
}

LOCK_ID=""
LOCK_HELD=0
acquire_start_lock() {
  LOCK_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  if ! mkdir --mode=0700 "$START_LOCK_DIR" 2>/dev/null; then
    local owner="$START_LOCK_DIR/owner.json" status stale before after
    status="$(inspect_lock_owner "$owner")"
    [[ "$status" == dead ]] || {
      [[ "$status" == live ]] && fail PREVIEW_START_BUSY
      fail PREVIEW_START_LOCK_AMBIGUOUS
    }
    before="$(sha256sum "$owner" | awk '{print $1}')"
    stale="$RUN_DIR/start.lock.stale.$LOCK_ID"
    mv -T "$START_LOCK_DIR" "$stale" || fail PREVIEW_START_LOCK_AMBIGUOUS
    after="$(sha256sum "$stale/owner.json" | awk '{print $1}')"
    [[ "$before" == "$after" && "$(inspect_lock_owner "$stale/owner.json")" == dead ]] || fail PREVIEW_START_LOCK_AMBIGUOUS
    mkdir --mode=0700 "$START_LOCK_DIR" || fail PREVIEW_START_BUSY
  fi
  chmod 0700 "$START_LOCK_DIR"
  write_lock_owner "$LOCK_ID"
  LOCK_HELD=1
}

release_start_lock() {
  [[ "$LOCK_HELD" -eq 1 ]] || return 0
  node --input-type=module - "$START_LOCK_DIR/owner.json" "$LOCK_ID" <<'NODE'
import { readFileSync, rmSync } from "node:fs";
const [path, lockId] = process.argv.slice(2);
try { const value = JSON.parse(readFileSync(path, "utf8")); if (value.lockId === lockId) rmSync(path); else process.exitCode = 1; } catch { process.exitCode = 1; }
NODE
  rmdir "$START_LOCK_DIR" 2>/dev/null || true
  LOCK_HELD=0
}

prepare_runtime() {
  local path
  ensure_directory "$RUNTIME_DIR"
  ensure_directory "$CONFIG_DIR"
  ensure_directory "$DATA_DIR"
  ensure_directory "$RUN_DIR"
  ensure_directory "$LOG_DIR"
  ensure_protected_file "$GATEWAY_LOG"
  ensure_protected_file "$PROXY_LOG"
  for path in \
    "$CONFIG_DIR/device-token" "$CONFIG_DIR/gateway.env" "$CONFIG_DIR/admin-entry.json" \
    "$CONFIG_DIR/pairing-target-8791.json" "$CONFIG_DIR/pairing-target-8792.json" \
    "$CONFIG_DIR/member-web-url-8791" "$CONFIG_DIR/member-web-url-8792" \
    "$GATEWAY_MANIFEST" "$PROXY_MANIFEST" "$RUN_DIR/claim-loss-state.json" \
    "$RUN_DIR/baseline-8790.snapshot"; do
    tighten_optional_file "$path"
  done
  while IFS= read -r -d '' path; do
    [[ -f "$path" && ! -L "$path" ]] || fail PREVIEW_RUNTIME_INVALID
    chmod 0600 "$path"
  done < <(find "$DATA_DIR" -maxdepth 1 -mindepth 1 -name 'gateway.sqlite*' -print0)
}

discover_provider_runtime() {
  local candidate profile_path profile_name
  HERMES_EXECUTABLE=""
  CODEX_EXECUTABLE=""
  for candidate in \
    "$REMOTE_USER_HOME/.local/bin/hermes" \
    "$REMOTE_USER_HOME/.hermes/hermes-agent/hermes"; do
    if [[ -f "$candidate" && ! -L "$candidate" && -x "$candidate" && -O "$candidate" ]]; then
      HERMES_EXECUTABLE="$candidate"
      break
    fi
  done
  for candidate in "$REMOTE_USER_HOME/.local/bin/codex"; do
    if [[ -f "$candidate" && ! -L "$candidate" && -x "$candidate" && -O "$candidate" ]]; then
      CODEX_EXECUTABLE="$candidate"
      break
    fi
  done
  HERMES_JARVIS_HOME="$REMOTE_USER_HOME/.hermes"
  HERMES_PERSONAL_HOME="$REMOTE_USER_HOME/hermes-personal-assistants"
  CODEX_WORKING_DIRECTORY="$ROOT_DIR"
  [[ -n "$HERMES_EXECUTABLE" && -n "$CODEX_EXECUTABLE" ]] ||
    fail PREVIEW_PROVIDER_DISCOVERY_FAILED
  [[ -d "$HERMES_JARVIS_HOME" && ! -L "$HERMES_JARVIS_HOME" &&
     -O "$HERMES_JARVIS_HOME" &&
     -f "$HERMES_JARVIS_HOME/config.yaml" &&
     ! -L "$HERMES_JARVIS_HOME/config.yaml" ]] ||
    fail PREVIEW_PROVIDER_DISCOVERY_FAILED
  [[ -d "$HERMES_PERSONAL_HOME" && ! -L "$HERMES_PERSONAL_HOME" &&
     -O "$HERMES_PERSONAL_HOME" &&
     -d "$HERMES_PERSONAL_HOME/profiles" &&
     ! -L "$HERMES_PERSONAL_HOME/profiles" ]] ||
    fail PREVIEW_PROVIDER_DISCOVERY_FAILED
  [[ -d "$CODEX_WORKING_DIRECTORY" && ! -L "$CODEX_WORKING_DIRECTORY" &&
     -O "$CODEX_WORKING_DIRECTORY" ]] ||
    fail PREVIEW_PROVIDER_DISCOVERY_FAILED

  HERMES_PROFILES=""
  while IFS= read -r -d '' profile_path; do
    [[ -d "$profile_path" && ! -L "$profile_path" && -O "$profile_path" ]] ||
      fail PREVIEW_PROVIDER_DISCOVERY_FAILED
    profile_name="${profile_path##*/}"
    [[ "$profile_name" =~ ^[a-z0-9_-]+$ ]] ||
      fail PREVIEW_PROVIDER_DISCOVERY_FAILED
    if [[ -z "$HERMES_PROFILES" ]]; then
      HERMES_PROFILES="$profile_name"
    else
      HERMES_PROFILES="$HERMES_PROFILES,$profile_name"
    fi
  done < <(
    find "$HERMES_PERSONAL_HOME/profiles" -mindepth 1 -maxdepth 1 -print0 |
      LC_ALL=C sort -z
  )
  [[ -n "$HERMES_PROFILES" ]] || fail PREVIEW_PROVIDER_DISCOVERY_FAILED
}

prepare_config() {
  local token_file="$CONFIG_DIR/device-token" env_file="$CONFIG_DIR/gateway.env" token
  discover_provider_runtime
  write_gateway_env() {
    local current_token="$1" env_text
    env_text="$(
      builtin printf 'GATEWAY_MODE=development\n'
      builtin printf 'GATEWAY_HOST=127.0.0.1\n'
      builtin printf 'GATEWAY_PORT=8791\n'
      builtin printf 'GATEWAY_DATABASE_PATH=%s\n' "$DATA_DIR/gateway.sqlite"
      builtin printf 'GATEWAY_DEVICE_TOKEN=%s\n' "$current_token"
      builtin printf 'GATEWAY_PREVIEW_ADMIN_ENTRY_PATH=%s\n' "$CONFIG_DIR/admin-entry.json"
      builtin printf 'GATEWAY_PREVIEW_ADMIN_ORIGIN=http://127.0.0.1:8791\n'
      builtin printf 'FAMILY_AI_PROVIDER_MODE=real\n'
      builtin printf 'FAMILY_AI_HERMES_EXECUTABLE=%s\n' "$HERMES_EXECUTABLE"
      builtin printf 'FAMILY_AI_HERMES_JARVIS_HOME=%s\n' "$HERMES_JARVIS_HOME"
      builtin printf 'FAMILY_AI_HERMES_PERSONAL_HOME=%s\n' "$HERMES_PERSONAL_HOME"
      builtin printf 'FAMILY_AI_HERMES_PROFILES=%s\n' "$HERMES_PROFILES"
      builtin printf 'FAMILY_AI_HERMES_MODEL=deepseek-v4-flash\n'
      builtin printf 'FAMILY_AI_HERMES_PROVIDER=sensenova\n'
      builtin printf 'FAMILY_AI_CODEX_EXECUTABLE=%s\n' "$CODEX_EXECUTABLE"
      builtin printf 'FAMILY_AI_CODEX_WORKING_DIRECTORY=%s\n' "$CODEX_WORKING_DIRECTORY"
    )"
    atomic_text_file "$env_file" "$env_text"$'\n'
  }
  if [[ ! -e "$token_file" && ! -e "$env_file" ]]; then
    token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
    [[ "$token" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail PREVIEW_CONFIG_INVALID
    atomic_text_file "$token_file" "$token"$'\n'
  fi
  [[ -e "$token_file" ]] || fail PREVIEW_CONFIG_INVALID
  [[ -f "$token_file" && ! -L "$token_file" && -O "$token_file" ]] ||
    fail PREVIEW_CONFIG_INVALID
  chmod 0600 "$token_file"
  if [[ -e "$env_file" || -L "$env_file" ]]; then
    [[ -f "$env_file" && ! -L "$env_file" && -O "$env_file" ]] ||
      fail PREVIEW_CONFIG_INVALID
  fi
  IFS= read -r token <"$token_file"
  [[ "$token" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail PREVIEW_CONFIG_INVALID
  write_gateway_env "$token"
  unset token
  [[ -f "$env_file" && ! -L "$env_file" && -O "$env_file" ]] ||
    fail PREVIEW_CONFIG_INVALID
  chmod 0600 "$env_file"
  node --input-type=module - "$token_file" "$env_file" "$DATA_DIR/gateway.sqlite" \
    "$CONFIG_DIR/admin-entry.json" <<'NODE'
import { readFileSync } from "node:fs";
const [tokenFile, envFile, databasePath, adminEntryPath] = process.argv.slice(2);
const tokenText = readFileSync(tokenFile, "utf8");
const token = tokenText.endsWith("\n") ? tokenText.slice(0, -1) : tokenText;
if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token) || tokenText !== `${token}\n`) process.exit(1);
const lines = readFileSync(envFile, "utf8").split("\n");
if (lines.at(-1) !== "") process.exit(1); lines.pop();
const expected = [
  "GATEWAY_MODE", "GATEWAY_HOST", "GATEWAY_PORT", "GATEWAY_DATABASE_PATH",
  "GATEWAY_DEVICE_TOKEN", "GATEWAY_PREVIEW_ADMIN_ENTRY_PATH",
  "GATEWAY_PREVIEW_ADMIN_ORIGIN", "FAMILY_AI_PROVIDER_MODE",
  "FAMILY_AI_HERMES_EXECUTABLE", "FAMILY_AI_HERMES_JARVIS_HOME",
  "FAMILY_AI_HERMES_PERSONAL_HOME", "FAMILY_AI_HERMES_PROFILES",
  "FAMILY_AI_HERMES_MODEL", "FAMILY_AI_HERMES_PROVIDER",
  "FAMILY_AI_CODEX_EXECUTABLE", "FAMILY_AI_CODEX_WORKING_DIRECTORY"
];
if (lines.length !== expected.length) process.exit(1);
const values = new Map(lines.map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
if (
  values.size !== expected.length ||
  expected.some(key => !values.has(key)) ||
  values.get("GATEWAY_MODE") !== "development" ||
  values.get("GATEWAY_HOST") !== "127.0.0.1" ||
  values.get("GATEWAY_PORT") !== "8791" ||
  values.get("GATEWAY_DATABASE_PATH") !== databasePath ||
  values.get("GATEWAY_DEVICE_TOKEN") !== token ||
  values.get("GATEWAY_PREVIEW_ADMIN_ENTRY_PATH") !== adminEntryPath ||
  values.get("GATEWAY_PREVIEW_ADMIN_ORIGIN") !== "http://127.0.0.1:8791" ||
  values.get("FAMILY_AI_PROVIDER_MODE") !== "real" ||
  values.get("FAMILY_AI_HERMES_MODEL") !== "deepseek-v4-flash" ||
  values.get("FAMILY_AI_HERMES_PROVIDER") !== "sensenova" ||
  !/^(?:[a-z0-9_-]+)(?:,[a-z0-9_-]+)*$/.test(
    values.get("FAMILY_AI_HERMES_PROFILES") ?? ""
  ) ||
  [
    "FAMILY_AI_HERMES_EXECUTABLE",
    "FAMILY_AI_HERMES_JARVIS_HOME",
    "FAMILY_AI_HERMES_PERSONAL_HOME",
    "FAMILY_AI_CODEX_EXECUTABLE",
    "FAMILY_AI_CODEX_WORKING_DIRECTORY"
  ].some(key => !(values.get(key) ?? "").startsWith("/"))
) process.exit(1);
NODE
}

tree_fingerprint() {
  node --input-type=module - "$1" <<'NODE'
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
const root = process.argv[2]; const files = [];
const walk = directory => { for (const name of readdirSync(directory).sort()) { const path = join(directory, name); const info = lstatSync(path); if (info.isSymbolicLink()) process.exit(1); if (info.isDirectory()) walk(path); else if (info.isFile()) files.push(path); else process.exit(1); } };
walk(root); if (files.length === 0) process.exit(1);
const outer = createHash("sha256");
for (const path of files.sort()) { outer.update(relative(root, path)); outer.update("\0"); outer.update(createHash("sha256").update(readFileSync(path)).digest("hex")); }
process.stdout.write(outer.digest("hex"));
NODE
}

config_fingerprint() {
  node --input-type=module - "$CONFIG_DIR" <<'NODE'
import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; import { join } from "node:path";
const root = process.argv[2]; const outer = createHash("sha256");
for (const name of ["device-token", "gateway.env"]) { outer.update(name); outer.update("\0"); outer.update(createHash("sha256").update(readFileSync(join(root, name))).digest("hex")); }
process.stdout.write(outer.digest("hex"));
NODE
}

manifest_status() {
  node --input-type=module - "$1" "$2" "$3" "$4" "$ROOT_DIR" "${5:-}" "${6:-}" "${7:-}" "${8:-}" <<'NODE'
import { execFileSync } from "node:child_process"; import { lstatSync, readFileSync, readlinkSync } from "node:fs"; import { basename, resolve } from "node:path";
const [file, kind, entrypoint, portRaw, root, one, two, three, expectedPidRaw] = process.argv.slice(2); const port = Number(portRaw); const out = value => process.stdout.write(value);
const listeners = () => { try { return execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return null; } };
function main() {
if (!file) return out("invalid");
let value;
try { const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 16384) return out("invalid"); const a = readFileSync(file, "utf8"), b = readFileSync(file, "utf8"); if (a !== b) return out("invalid"); value = JSON.parse(a); } catch (error) { if (error?.code === "ENOENT") { const rows = listeners(); return out(rows?.length === 0 ? "absent" : "unowned"); } return out("invalid"); }
const gatewayKeys = ["version","kind","pid","starttime","cwd","entrypoint","host","port","launchCommit","distSha256","memberPublicSha256","configSha256"].sort();
const proxyKeys = ["version","kind","pid","starttime","cwd","entrypoint","host","port","upstreamOrigin","launchCommit","proxySourceSha256","proxyConfigSha256"].sort();
const keys = Object.keys(value).sort(), wanted = kind === "gateway" ? gatewayKeys : proxyKeys;
if (keys.join("\0") !== wanted.join("\0") || value.version !== 1 || value.kind !== kind || !Number.isInteger(value.pid) || value.pid <= 0 || !/^\d+$/.test(value.starttime) || value.cwd !== root || value.entrypoint !== entrypoint || value.host !== "127.0.0.1" || value.port !== port || !/^[0-9a-f]{40}$/.test(value.launchCommit)) return out("invalid");
if (expectedPidRaw !== "" && value.pid !== Number(expectedPidRaw)) return out("unowned");
if (kind === "gateway") { if (![value.distSha256,value.memberPublicSha256,value.configSha256].every(v => /^[0-9a-f]{64}$/.test(v))) return out("invalid"); }
else if (value.upstreamOrigin !== "http://127.0.0.1:8791" || ![value.proxySourceSha256,value.proxyConfigSha256].every(v => /^[0-9a-f]{64}$/.test(v))) return out("invalid");
let statText; try { statText = readFileSync(`/proc/${value.pid}/stat`, "utf8"); } catch (error) { const rows = listeners(); return out(error?.code === "ENOENT" && rows?.length === 0 ? "stale" : "unowned"); }
const fields = statText.slice(statText.lastIndexOf(")") + 2).trim().split(/\s+/); if (fields[19] !== value.starttime) return out("unowned");
let cwd; try { cwd = readlinkSync(`/proc/${value.pid}/cwd`); } catch { return out("unowned"); } if (cwd !== root) return out("unowned");
const argv = readFileSync(`/proc/${value.pid}/cmdline`).toString("utf8").split("\0").filter(Boolean); if (argv.length !== 2 || basename(argv[0]) !== "node" || resolve(cwd, argv[1]) !== resolve(root, entrypoint)) return out("unowned");
const rows = listeners(); if (!rows || rows.length !== 1 || !rows[0].includes(`127.0.0.1:${port}`) || !rows[0].includes(`pid=${value.pid},`)) return out("unowned");
const match = kind === "gateway" ? value.launchCommit === one && value.distSha256 === two && value.memberPublicSha256 === three && value.configSha256 === process.env.EXPECTED_CONFIG_SHA : value.launchCommit === one && value.proxySourceSha256 === two && value.proxyConfigSha256 === three;
out(match ? "owned-match" : "owned-mismatch");
}
main();
NODE
}

manifest_pid() {
  node -e 'const v=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); if(!Number.isInteger(v.pid)||v.pid<=0)process.exit(1); process.stdout.write(String(v.pid))' "$1"
}

manifest_starttime_for_pid() {
  node --input-type=module - "$1" "$2" <<'NODE'
import { lstatSync, readFileSync } from "node:fs";
const [file, expectedPidRaw] = process.argv.slice(2), expectedPid = Number(expectedPidRaw);
try {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 16384) process.exit(1);
  const first = readFileSync(file, "utf8"), second = readFileSync(file, "utf8");
  if (first !== second) process.exit(1);
  const value = JSON.parse(first);
  if (!Number.isInteger(expectedPid) || expectedPid <= 0 || value.pid !== expectedPid || typeof value.starttime !== "string" || !/^\d+$/.test(value.starttime)) process.exit(1);
  process.stdout.write(value.starttime);
} catch { process.exit(1); }
NODE
}

raw_pid_owned() {
  node --input-type=module - "$1" "$2" "$3" "$4" "$ROOT_DIR" <<'NODE'
import { execFileSync } from "node:child_process"; import { readFileSync, readlinkSync } from "node:fs"; import { basename, resolve } from "node:path";
const [pidRaw, entrypoint, portRaw, expectedStarttime, root] = process.argv.slice(2); const pid=Number(pidRaw), port=Number(portRaw);
try { const stat=readFileSync(`/proc/${pid}/stat`,"utf8"),fields=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/); if(!/^\d+$/.test(expectedStarttime)||fields[19]!==expectedStarttime)process.exit(1); if (readlinkSync(`/proc/${pid}/cwd`) !== root) process.exit(1); const argv=readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean); if(argv.length!==2||basename(argv[0])!=="node"||resolve(root,argv[1])!==resolve(root,entrypoint))process.exit(1); const rows=execFileSync("ss",["-H","-ltnp",`sport = :${port}`],{encoding:"utf8"}).trim().split("\n").filter(Boolean); if(rows.length!==1||!rows[0].includes(`127.0.0.1:${port}`)||!rows[0].includes(`pid=${pid},`))process.exit(1); } catch { process.exit(1); }
NODE
}

pidfd_terminate() {
  python3 - "$1" "$2" "$3" "$4" "$5" "$ROOT_DIR" "${6:-}" <<'PYTHON'
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys

def fail():
    raise RuntimeError("pidfd validation failed")

def open_manifest(path, maximum):
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    info = os.fstat(descriptor)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size < 2
        or info.st_size > maximum
    ):
        os.close(descriptor)
        fail()
    return descriptor, info

def read_from_start(descriptor, maximum):
    os.lseek(descriptor, 0, os.SEEK_SET)
    chunks = []
    remaining = maximum + 1
    while remaining:
        chunk = os.read(descriptor, min(65536, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    data = b"".join(chunks)
    if len(data) > maximum:
        fail()
    return data, os.fstat(descriptor)

def read_stable_manifest(descriptor):
    first, first_info = read_from_start(descriptor, 16384)
    second, second_info = read_from_start(descriptor, 16384)
    if first != second or (first_info.st_dev, first_info.st_ino) != (second_info.st_dev, second_info.st_ino):
        fail()
    if (
        not stat.S_ISREG(second_info.st_mode)
        or stat.S_IMODE(second_info.st_mode) != 0o600
        or second_info.st_size != len(second)
    ):
        fail()
    return first, second_info

def path_still_names(path, expected_info):
    current = os.lstat(path)
    return (
        stat.S_ISREG(current.st_mode)
        and (current.st_dev, current.st_ino) == (expected_info.st_dev, expected_info.st_ino)
    )

def validate_manifest(data, kind, pid, starttime, root, entrypoint, port):
    value = json.loads(data.decode("utf-8"))
    gateway_keys = {
        "version", "kind", "pid", "starttime", "cwd", "entrypoint", "host", "port",
        "launchCommit", "distSha256", "memberPublicSha256", "configSha256",
    }
    proxy_keys = {
        "version", "kind", "pid", "starttime", "cwd", "entrypoint", "host", "port",
        "upstreamOrigin", "launchCommit", "proxySourceSha256", "proxyConfigSha256",
    }
    expected_keys = gateway_keys if kind == "gateway" else proxy_keys
    if (
        type(value) is not dict
        or set(value) != expected_keys
        or type(value["version"]) is not int
        or value["version"] != 1
        or value["kind"] != kind
        or type(value["pid"]) is not int
        or value["pid"] != pid
        or value["starttime"] != starttime
        or value["cwd"] != root
        or value["entrypoint"] != entrypoint
        or value["host"] != "127.0.0.1"
        or type(value["port"]) is not int
        or value["port"] != port
        or re.fullmatch(r"[0-9a-f]{40}", value["launchCommit"]) is None
    ):
        fail()
    if kind == "gateway":
        hashes = (value["distSha256"], value["memberPublicSha256"], value["configSha256"])
    else:
        if value["upstreamOrigin"] != "http://127.0.0.1:8791":
            fail()
        hashes = (value["proxySourceSha256"], value["proxyConfigSha256"])
    if any(type(item) is not str or re.fullmatch(r"[0-9a-f]{64}", item) is None for item in hashes):
        fail()

def process_starttime(pid):
    with open(f"/proc/{pid}/stat", "rb", buffering=0) as handle:
        value = handle.read(16384)
    close = value.rfind(b") ")
    if close < 0:
        fail()
    fields = value[close + 2:].strip().split()
    if len(fields) <= 19:
        fail()
    return fields[19].decode("ascii")

def listeners(port):
    result = subprocess.run(
        ["ss", "-H", "-ltnp", f"sport = :{port}"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=2,
        check=True,
        text=True,
    )
    return [line for line in result.stdout.splitlines() if line]

def main():
    pid = int(sys.argv[1])
    starttime, kind, entrypoint, port_text, root, manifest = sys.argv[2:8]
    port = int(port_text)
    expected_entrypoint = (
        "apps/gateway/dist/index.js"
        if kind == "gateway"
        else "scripts/member-preview-claim-loss-proxy.mjs"
    )
    expected_port = 8791 if kind == "gateway" else 8792
    if (
        pid <= 0
        or not starttime.isdecimal()
        or kind not in ("gateway", "claim_loss_proxy")
        or entrypoint != expected_entrypoint
        or port != expected_port
    ):
        fail()
    pidfd = os.pidfd_open(pid, 0)
    manifest_descriptor = None
    try:
        manifest_bytes = None
        manifest_info = None
        if manifest:
            manifest_descriptor, manifest_info = open_manifest(manifest, 16384)
            manifest_bytes, manifest_info = read_stable_manifest(manifest_descriptor)
            validate_manifest(manifest_bytes, kind, pid, starttime, root, entrypoint, port)
            if not path_still_names(manifest, manifest_info):
                fail()
        if process_starttime(pid) != starttime:
            fail()
        cwd = os.path.realpath(os.readlink(f"/proc/{pid}/cwd"))
        if cwd != root:
            fail()
        with open(f"/proc/{pid}/cmdline", "rb", buffering=0) as handle:
            command = handle.read(16384)
        arguments = command.split(b"\0")
        if not arguments or arguments[-1] != b"":
            fail()
        arguments.pop()
        if (
            len(arguments) != 2
            or os.path.basename(os.fsdecode(arguments[0])) != "node"
            or os.path.realpath(os.path.join(cwd, os.fsdecode(arguments[1])))
            != os.path.realpath(os.path.join(root, entrypoint))
        ):
            fail()
        rows = listeners(port)
        if (
            len(rows) != 1
            or f"127.0.0.1:{port}" not in rows[0]
            or f"pid={pid}," not in rows[0]
        ):
            fail()
        if manifest:
            confirmed_bytes, confirmed_info = read_stable_manifest(manifest_descriptor)
            if (
                confirmed_bytes != manifest_bytes
                or (confirmed_info.st_dev, confirmed_info.st_ino)
                != (manifest_info.st_dev, manifest_info.st_ino)
                or not path_still_names(manifest, manifest_info)
            ):
                fail()
            validate_manifest(confirmed_bytes, kind, pid, starttime, root, entrypoint, port)
        signal.pidfd_send_signal(pidfd, signal.SIGTERM, None, 0)
        waiter = select.poll()
        waiter.register(pidfd, select.POLLIN)
        events = waiter.poll(10000)
        if not any(descriptor == pidfd and mask & select.POLLIN for descriptor, mask in events):
            fail()
        if listeners(port):
            fail()
        if manifest:
            final_bytes, final_info = read_stable_manifest(manifest_descriptor)
            if (
                final_bytes != manifest_bytes
                or (final_info.st_dev, final_info.st_ino)
                != (manifest_info.st_dev, manifest_info.st_ino)
                or not path_still_names(manifest, manifest_info)
            ):
                fail()
            validate_manifest(final_bytes, kind, pid, starttime, root, entrypoint, port)
            os.unlink(manifest)
            directory = os.open(os.path.dirname(manifest), os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if manifest_descriptor is not None:
            os.close(manifest_descriptor)
        os.close(pidfd)

try:
    main()
except BaseException:
    sys.exit(1)
PYTHON
}
stop_exact_pid() { pidfd_terminate "$1" "$5" "$2" "$3" "$4"; }
stop_manifest_pid() { local starttime; starttime="$(manifest_starttime_for_pid "$1" "$2")" || return 1; pidfd_terminate "$2" "$starttime" "$3" "$4" "$5" "$1"; }

write_manifest() {
  atomic_text_file "$1" "$2"$'\n'
}

wait_health() { local origin="$1"; for _ in $(seq 1 100); do curl --fail --silent --max-time 1 "$origin/health" >/dev/null 2>&1 && return 0; sleep 0.1; done; return 1; }

SUCCESS=0
NEW_GATEWAY_PID=""
NEW_PROXY_PID=""
NEW_GATEWAY_STARTTIME=""
NEW_PROXY_STARTTIME=""
cleanup() {
  local status="$?"
  if [[ "$SUCCESS" -ne 1 ]]; then
    [[ -z "$NEW_PROXY_PID" || -z "$NEW_PROXY_STARTTIME" ]] || stop_exact_pid "$NEW_PROXY_PID" claim_loss_proxy scripts/member-preview-claim-loss-proxy.mjs 8792 "$NEW_PROXY_STARTTIME" >/dev/null 2>&1 || true
    [[ -z "$NEW_GATEWAY_PID" || -z "$NEW_GATEWAY_STARTTIME" ]] || stop_exact_pid "$NEW_GATEWAY_PID" gateway apps/gateway/dist/index.js 8791 "$NEW_GATEWAY_STARTTIME" >/dev/null 2>&1 || true
  fi
  release_start_lock
  return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

capture_8790 || fail PREVIEW_8790_BASELINE_INVALID
prepare_runtime
atomic_text_file "$RUN_DIR/baseline-8790.snapshot" "healthSha256=$BASELINE_HEALTH_SHA\ndocker=$BASELINE_DOCKER_ROW\nlistener=$BASELINE_LISTENER_ROW\n"
acquire_start_lock
prepare_config || fail PREVIEW_CONFIG_INVALID

npm run build:gateway >>"$GATEWAY_LOG" 2>&1 || fail PREVIEW_BUILD_FAILED
DIST_SHA="$(tree_fingerprint "$ROOT_DIR/apps/gateway/dist")" || fail PREVIEW_FINGERPRINT_FAILED
MEMBER_PUBLIC_SHA="$(tree_fingerprint "$ROOT_DIR/apps/gateway/member-public")" || fail PREVIEW_FINGERPRINT_FAILED
CONFIG_SHA="$(config_fingerprint)" || fail PREVIEW_FINGERPRINT_FAILED
LAUNCH_COMMIT="$(git rev-parse HEAD)"

export EXPECTED_CONFIG_SHA="$CONFIG_SHA"
gateway_state="$(manifest_status "$GATEWAY_MANIFEST" gateway apps/gateway/dist/index.js 8791 "$LAUNCH_COMMIT" "$DIST_SHA" "$MEMBER_PUBLIC_SHA")"
unset EXPECTED_CONFIG_SHA
case "$gateway_state" in
  owned-match)
    gateway_pid="$(manifest_pid "$GATEWAY_MANIFEST")" || fail PREVIEW_GATEWAY_OWNERSHIP_FAILED
    gateway_starttime="$(manifest_starttime_for_pid "$GATEWAY_MANIFEST" "$gateway_pid")" || fail PREVIEW_GATEWAY_OWNERSHIP_FAILED
    wait_health http://127.0.0.1:8791 || fail PREVIEW_GATEWAY_HEALTH_FAILED
    export EXPECTED_CONFIG_SHA="$CONFIG_SHA"
    [[ "$(manifest_status "$GATEWAY_MANIFEST" gateway apps/gateway/dist/index.js 8791 "$LAUNCH_COMMIT" "$DIST_SHA" "$MEMBER_PUBLIC_SHA" "$gateway_pid")" == owned-match ]] || fail PREVIEW_GATEWAY_OWNERSHIP_FAILED
    unset EXPECTED_CONFIG_SHA
    raw_pid_owned "$gateway_pid" apps/gateway/dist/index.js 8791 "$gateway_starttime" || fail PREVIEW_GATEWAY_OWNERSHIP_FAILED
    ;;
  owned-mismatch)
    gateway_pid="$(manifest_pid "$GATEWAY_MANIFEST")" || fail PREVIEW_GATEWAY_OWNERSHIP_FAILED
    export EXPECTED_CONFIG_SHA="$CONFIG_SHA"
    [[ "$(manifest_status "$GATEWAY_MANIFEST" gateway apps/gateway/dist/index.js 8791 "$LAUNCH_COMMIT" "$DIST_SHA" "$MEMBER_PUBLIC_SHA" "$gateway_pid")" == owned-mismatch ]] || fail PREVIEW_GATEWAY_OWNERSHIP_FAILED
    unset EXPECTED_CONFIG_SHA
    stop_manifest_pid "$GATEWAY_MANIFEST" "$gateway_pid" gateway apps/gateway/dist/index.js 8791 || fail PREVIEW_GATEWAY_STOP_FAILED
    gateway_state=absent
    ;;
  stale) mv -T "$GATEWAY_MANIFEST" "$GATEWAY_MANIFEST.stale.$LOCK_ID"; gateway_state=absent ;;
  absent) ;;
  *) fail PREVIEW_GATEWAY_OWNERSHIP_FAILED ;;
esac

if [[ "$gateway_state" == absent ]]; then
  nohup /bin/bash -c 'set -a; . "$1"; set +a; exec node "$2"' preview-runtime "$CONFIG_DIR/gateway.env" "$ROOT_DIR/apps/gateway/dist/index.js" >>"$GATEWAY_LOG" 2>&1 </dev/null &
  NEW_GATEWAY_PID="$!"
  NEW_GATEWAY_STARTTIME="$(awk '{print $22}' "/proc/$NEW_GATEWAY_PID/stat")" || fail PREVIEW_GATEWAY_OWNERSHIP_FAILED
  wait_health http://127.0.0.1:8791 || fail PREVIEW_GATEWAY_START_FAILED
  raw_pid_owned "$NEW_GATEWAY_PID" apps/gateway/dist/index.js 8791 "$NEW_GATEWAY_STARTTIME" || fail PREVIEW_GATEWAY_OWNERSHIP_FAILED
  gateway_starttime="$NEW_GATEWAY_STARTTIME"
  gateway_json="$(node -e 'const [pid,starttime,cwd,commit,dist,pub,config]=process.argv.slice(1);process.stdout.write(JSON.stringify({version:1,kind:"gateway",pid:Number(pid),starttime,cwd,entrypoint:"apps/gateway/dist/index.js",host:"127.0.0.1",port:8791,launchCommit:commit,distSha256:dist,memberPublicSha256:pub,configSha256:config}))' "$NEW_GATEWAY_PID" "$gateway_starttime" "$ROOT_DIR" "$LAUNCH_COMMIT" "$DIST_SHA" "$MEMBER_PUBLIC_SHA" "$CONFIG_SHA")"
  write_manifest "$GATEWAY_MANIFEST" "$gateway_json"
  export EXPECTED_CONFIG_SHA="$CONFIG_SHA"
  [[ "$(manifest_status "$GATEWAY_MANIFEST" gateway apps/gateway/dist/index.js 8791 "$LAUNCH_COMMIT" "$DIST_SHA" "$MEMBER_PUBLIC_SHA")" == owned-match ]] || fail PREVIEW_GATEWAY_OWNERSHIP_FAILED
  unset EXPECTED_CONFIG_SHA
fi

find "$DATA_DIR" -maxdepth 1 -type l -print -quit | grep -q . && fail PREVIEW_DATA_INVALID
find "$DATA_DIR" -maxdepth 1 -type f -name 'gateway.sqlite*' -exec chmod 0600 {} +

if [[ "$WITH_CLAIM_LOSS_PROXY" -eq 1 ]]; then
  PROXY_SOURCE_SHA="$(sha256sum "$ROOT_DIR/scripts/member-preview-claim-loss-proxy.mjs" | awk '{print $1}')"
  PROXY_CONFIG_SHA="$(builtin printf '%s\0%s\0%s\0%s' '127.0.0.1' '8792' 'http://127.0.0.1:8791' "$RUN_DIR/claim-loss-state.json" | sha256sum | awk '{print $1}')"
  proxy_state="$(manifest_status "$PROXY_MANIFEST" claim_loss_proxy scripts/member-preview-claim-loss-proxy.mjs 8792 "$LAUNCH_COMMIT" "$PROXY_SOURCE_SHA" "$PROXY_CONFIG_SHA")"
  case "$proxy_state" in
    owned-match)
      proxy_pid="$(manifest_pid "$PROXY_MANIFEST")" || fail PREVIEW_PROXY_OWNERSHIP_FAILED
      proxy_starttime="$(manifest_starttime_for_pid "$PROXY_MANIFEST" "$proxy_pid")" || fail PREVIEW_PROXY_OWNERSHIP_FAILED
      wait_health http://127.0.0.1:8792 || fail PREVIEW_PROXY_HEALTH_FAILED
      [[ "$(manifest_status "$PROXY_MANIFEST" claim_loss_proxy scripts/member-preview-claim-loss-proxy.mjs 8792 "$LAUNCH_COMMIT" "$PROXY_SOURCE_SHA" "$PROXY_CONFIG_SHA" "$proxy_pid")" == owned-match ]] || fail PREVIEW_PROXY_OWNERSHIP_FAILED
      raw_pid_owned "$proxy_pid" scripts/member-preview-claim-loss-proxy.mjs 8792 "$proxy_starttime" || fail PREVIEW_PROXY_OWNERSHIP_FAILED
      ;;
    owned-mismatch)
      proxy_pid="$(manifest_pid "$PROXY_MANIFEST")" || fail PREVIEW_PROXY_OWNERSHIP_FAILED
      [[ "$(manifest_status "$PROXY_MANIFEST" claim_loss_proxy scripts/member-preview-claim-loss-proxy.mjs 8792 "$LAUNCH_COMMIT" "$PROXY_SOURCE_SHA" "$PROXY_CONFIG_SHA" "$proxy_pid")" == owned-mismatch ]] || fail PREVIEW_PROXY_OWNERSHIP_FAILED
      stop_manifest_pid "$PROXY_MANIFEST" "$proxy_pid" claim_loss_proxy scripts/member-preview-claim-loss-proxy.mjs 8792 || fail PREVIEW_PROXY_STOP_FAILED
      proxy_state=absent
      ;;
    stale) proxy_state=stale ;;
    absent) ;;
    *) fail PREVIEW_PROXY_OWNERSHIP_FAILED ;;
  esac
  if [[ "$proxy_state" == absent || "$proxy_state" == stale ]]; then
    nohup node scripts/member-preview-claim-loss-proxy.mjs >>"$PROXY_LOG" 2>&1 </dev/null &
    NEW_PROXY_PID="$!"
    NEW_PROXY_STARTTIME="$(awk '{print $22}' "/proc/$NEW_PROXY_PID/stat")" || fail PREVIEW_PROXY_OWNERSHIP_FAILED
    wait_health http://127.0.0.1:8792 || fail PREVIEW_PROXY_START_FAILED
    raw_pid_owned "$NEW_PROXY_PID" scripts/member-preview-claim-loss-proxy.mjs 8792 "$NEW_PROXY_STARTTIME" || fail PREVIEW_PROXY_OWNERSHIP_FAILED
    [[ "$proxy_state" != stale ]] || mv -T "$PROXY_MANIFEST" "$PROXY_MANIFEST.stale.$LOCK_ID"
    proxy_starttime="$NEW_PROXY_STARTTIME"
    proxy_json="$(node -e 'const [pid,starttime,cwd,commit,source,config]=process.argv.slice(1);process.stdout.write(JSON.stringify({version:1,kind:"claim_loss_proxy",pid:Number(pid),starttime,cwd,entrypoint:"scripts/member-preview-claim-loss-proxy.mjs",host:"127.0.0.1",port:8792,upstreamOrigin:"http://127.0.0.1:8791",launchCommit:commit,proxySourceSha256:source,proxyConfigSha256:config}))' "$NEW_PROXY_PID" "$proxy_starttime" "$ROOT_DIR" "$LAUNCH_COMMIT" "$PROXY_SOURCE_SHA" "$PROXY_CONFIG_SHA")"
    write_manifest "$PROXY_MANIFEST" "$proxy_json"
    [[ "$(manifest_status "$PROXY_MANIFEST" claim_loss_proxy scripts/member-preview-claim-loss-proxy.mjs 8792 "$LAUNCH_COMMIT" "$PROXY_SOURCE_SHA" "$PROXY_CONFIG_SHA")" == owned-match ]] || fail PREVIEW_PROXY_OWNERSHIP_FAILED
  fi
fi

compare_8790 || fail PREVIEW_8790_CHANGED
SUCCESS=1
release_start_lock
printf 'Member Preview Gateway READY: http://127.0.0.1:8791/member/\n'
if [[ "$WITH_CLAIM_LOSS_PROXY" -eq 1 ]]; then printf 'Member Preview Claim-loss Proxy READY: http://127.0.0.1:8792/member/\n'; fi
