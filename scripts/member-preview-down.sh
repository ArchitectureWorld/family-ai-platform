#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 0 ]] || { printf 'usage: member-preview-down.sh\n' >&2; exit 2; }
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REMOTE_USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
APPROVED_ROOT="$(cd "$REMOTE_USER_HOME/Development/family-ai-platform" && pwd -P)"
[[ "$(hostname -s)" == "Admin-YR" ]] || { printf 'PREVIEW_HOST_INVALID\n' >&2; exit 1; }
[[ "$(id -un)" == "youran" ]] || { printf 'PREVIEW_USER_INVALID\n' >&2; exit 1; }
[[ "$ROOT_DIR" == "$APPROVED_ROOT" ]] || { printf 'PREVIEW_ROOT_INVALID\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" rev-parse --show-toplevel)" == "$ROOT_DIR" ]] || { printf 'PREVIEW_REPOSITORY_INVALID\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" branch --show-current)" == "main" ]] || { printf 'PREVIEW_BRANCH_INVALID\n' >&2; exit 1; }
cd "$ROOT_DIR"
umask 077
RUNTIME_DIR="$ROOT_DIR/.runtime-preview"
CONFIG_DIR="$RUNTIME_DIR/config"
DATA_DIR="$RUNTIME_DIR/data"
LOG_DIR="$RUNTIME_DIR/logs"
RUN_DIR="$RUNTIME_DIR/run"
START_LOCK_DIR="$RUN_DIR/start.lock"
GATEWAY_MANIFEST="$RUN_DIR/gateway.pid.json"
PROXY_MANIFEST="$RUN_DIR/claim-loss-proxy.pid.json"

# Validate /proc/<pid>/stat starttime, /proc/<pid>/cwd, NUL /proc/<pid>/cmdline
# and the exact ss -H -ltnp listener after opening the target's pidfd.
pidfd_terminate() {
  python3 - "$1" "$2" "$3" "$4" "$5" "$ROOT_DIR" "$6" <<'PYTHON'
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
terminate_owned_pid() {
  local pid="$1" manifest="$2" kind="$3" entrypoint="$4" port="$5" starttime
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$(manifest_state "$manifest" "$kind" "$entrypoint" "$port" "$pid")" == owned ]] || return 1
  starttime="$(manifest_starttime_for_pid "$manifest" "$pid")" || return 1
  pidfd_terminate "$pid" "$starttime" "$kind" "$entrypoint" "$port" "$manifest"
}

fail() { printf '%s\n' "$1" >&2; exit 1; }

ensure_directory() {
  local path="$1"
  [[ ! -L "$path" && ( ! -e "$path" || -d "$path" ) ]] || fail PREVIEW_RUNTIME_INVALID
  [[ -d "$path" ]] || mkdir --mode=0700 "$path"
  chmod 0700 "$path"
}

write_lock_owner() {
  local path="$START_LOCK_DIR/owner.json" lock_id="$1" starttime
  starttime="$(awk '{print $22}' "/proc/$$/stat")"
  node --input-type=module - "$path" "$$" "$starttime" "$ROOT_DIR" "$lock_id" <<'NODE'
import { writeFileSync, openSync, closeSync, fsyncSync, renameSync, chmodSync } from "node:fs";
const [path,pid,starttime,cwd,lockId]=process.argv.slice(2); const temporary=`${path}.tmp.${process.pid}`;
writeFileSync(temporary,`${JSON.stringify({version:1,pid:Number(pid),starttime,cwd,lockId})}\n`,{mode:0o600,flag:"wx"}); const fd=openSync(temporary,"r");fsyncSync(fd);closeSync(fd);chmodSync(temporary,0o600);renameSync(temporary,path);
NODE
  chmod 0600 "$path"
}

lock_state() {
  node --input-type=module - "$1" "$ROOT_DIR" <<'NODE'
import { lstatSync,readFileSync,readlinkSync } from "node:fs"; const [path,root]=process.argv.slice(2); const out=v=>process.stdout.write(v);
function main() {
try { const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o777)!==0o600||info.size>4096)return out("invalid");const a=readFileSync(path,"utf8"),b=readFileSync(path,"utf8");if(a!==b)return out("invalid");const v=JSON.parse(a);if(Object.keys(v).sort().join("\0")!=="cwd\0lockId\0pid\0starttime\0version"||v.version!==1||!Number.isInteger(v.pid)||v.pid<=0||v.cwd!==root||!/^\d+$/.test(v.starttime)||! /^[0-9a-f-]{36}$/.test(v.lockId))return out("invalid");let stat;try{stat=readFileSync(`/proc/${v.pid}/stat`,"utf8");}catch(error){return out(error?.code==="ENOENT"?"dead":"invalid");}const fields=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/);let cwd;try{cwd=readlinkSync(`/proc/${v.pid}/cwd`);}catch{return out("invalid");}out(fields[19]===v.starttime&&cwd===root?"live":"invalid");}catch{out("invalid");}
}
main();
NODE
}

LOCK_ID=""
LOCK_HELD=0
acquire_lock() {
  LOCK_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  if ! mkdir --mode=0700 "$START_LOCK_DIR" 2>/dev/null; then
    local status stale before after
    status="$(lock_state "$START_LOCK_DIR/owner.json")"
    [[ "$status" == dead ]] || { [[ "$status" == live ]] && fail PREVIEW_START_BUSY; fail PREVIEW_START_LOCK_AMBIGUOUS; }
    before="$(sha256sum "$START_LOCK_DIR/owner.json" | awk '{print $1}')"
    stale="$RUN_DIR/start.lock.stale.$LOCK_ID"
    mv -T "$START_LOCK_DIR" "$stale" || fail PREVIEW_START_LOCK_AMBIGUOUS
    after="$(sha256sum "$stale/owner.json" | awk '{print $1}')"
    [[ "$before" == "$after" && "$(lock_state "$stale/owner.json")" == dead ]] || fail PREVIEW_START_LOCK_AMBIGUOUS
    mkdir --mode=0700 "$START_LOCK_DIR" || fail PREVIEW_START_BUSY
  fi
  chmod 0700 "$START_LOCK_DIR"
  write_lock_owner "$LOCK_ID"
  LOCK_HELD=1
}

release_lock() {
  [[ "$LOCK_HELD" -eq 1 ]] || return 0
  node --input-type=module - "$START_LOCK_DIR/owner.json" "$LOCK_ID" <<'NODE'
import { readFileSync,rmSync } from "node:fs";const [path,id]=process.argv.slice(2);try{const v=JSON.parse(readFileSync(path,"utf8"));if(v.lockId!==id)process.exit(1);rmSync(path);}catch{process.exit(1);}
NODE
  rmdir "$START_LOCK_DIR" 2>/dev/null || true
  LOCK_HELD=0
}

manifest_state() {
  node --input-type=module - "$1" "$2" "$3" "$4" "${5:-}" "$ROOT_DIR" <<'NODE'
import { execFileSync } from "node:child_process";import { lstatSync,readFileSync,readlinkSync } from "node:fs";import { basename,resolve } from "node:path";
const [file,kind,entrypoint,portRaw,expectedPidRaw,root]=process.argv.slice(2),port=Number(portRaw),out=v=>process.stdout.write(v);
const listeners=()=>{try{return execFileSync("ss",["-H","-ltnp",`sport = :${port}`],{encoding:"utf8"}).trim().split("\n").filter(Boolean);}catch{return null;}};
function main() {
let v;try{const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o777)!==0o600||info.size>16384)return out("invalid");const a=readFileSync(file,"utf8"),b=readFileSync(file,"utf8");if(a!==b)return out("invalid");v=JSON.parse(a);}catch(error){if(error?.code==="ENOENT"){const rows=listeners();return out(rows?.length===0?"absent":"unowned");}return out("invalid");}
const gateway=["version","kind","pid","starttime","cwd","entrypoint","host","port","launchCommit","distSha256","memberPublicSha256","configSha256"].sort();const proxy=["version","kind","pid","starttime","cwd","entrypoint","host","port","upstreamOrigin","launchCommit","proxySourceSha256","proxyConfigSha256"].sort();
if(Object.keys(v).sort().join("\0")!==(kind==="gateway"?gateway:proxy).join("\0")||v.version!==1||v.kind!==kind||!Number.isInteger(v.pid)||v.pid<=0||!/^\d+$/.test(v.starttime)||v.cwd!==root||v.entrypoint!==entrypoint||v.host!=="127.0.0.1"||v.port!==port||! /^[0-9a-f]{40}$/.test(v.launchCommit))return out("invalid");
if(expectedPidRaw!==""&&v.pid!==Number(expectedPidRaw))return out("unowned");
if(kind==="gateway"){if(![v.distSha256,v.memberPublicSha256,v.configSha256].every(x=>/^[0-9a-f]{64}$/.test(x)))return out("invalid");}else if(v.upstreamOrigin!=="http://127.0.0.1:8791"||![v.proxySourceSha256,v.proxyConfigSha256].every(x=>/^[0-9a-f]{64}$/.test(x)))return out("invalid");
let stat;try{stat=readFileSync(`/proc/${v.pid}/stat`,"utf8");}catch(error){const rows=listeners();return out(error?.code==="ENOENT"&&rows?.length===0?"stale":"unowned");}const fields=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/);if(fields[19]!==v.starttime)return out("unowned");let cwd;try{cwd=readlinkSync(`/proc/${v.pid}/cwd`);}catch{return out("unowned");}if(cwd!==root)return out("unowned");const argv=readFileSync(`/proc/${v.pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);if(argv.length!==2||basename(argv[0])!=="node"||resolve(cwd,argv[1])!==resolve(root,entrypoint))return out("unowned");const rows=listeners();if(!rows||rows.length!==1||!rows[0].includes(`127.0.0.1:${port}`)||!rows[0].includes(`pid=${v.pid},`))return out("unowned");out("owned");
}
main();
NODE
}

manifest_pid() {
  node -e 'const v=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(!Number.isInteger(v.pid)||v.pid<=0)process.exit(1);process.stdout.write(String(v.pid))' "$1"
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

[[ -e "$RUNTIME_DIR" ]] || exit 0
[[ ! -L "$RUNTIME_DIR" && -d "$RUNTIME_DIR" ]] || { printf 'PREVIEW_RUNTIME_INVALID\n' >&2; exit 1; }
chmod 0700 "$RUNTIME_DIR"
for directory in "$CONFIG_DIR" "$DATA_DIR" "$RUN_DIR" "$LOG_DIR"; do
  [[ ! -e "$directory" ]] || ensure_directory "$directory"
done
for protected in \
  "$CONFIG_DIR/device-token" "$CONFIG_DIR/gateway.env" "$CONFIG_DIR/admin-entry.json" \
  "$CONFIG_DIR/pairing-target-8791.json" "$CONFIG_DIR/pairing-target-8792.json" \
  "$CONFIG_DIR/member-web-url-8791" "$CONFIG_DIR/member-web-url-8792" \
  "$LOG_DIR/gateway.log" "$LOG_DIR/claim-loss-proxy.log" \
  "$GATEWAY_MANIFEST" "$PROXY_MANIFEST" "$RUN_DIR/claim-loss-state.json"; do
  if [[ -e "$protected" || -L "$protected" ]]; then
    [[ -f "$protected" && ! -L "$protected" ]] || fail PREVIEW_RUNTIME_INVALID
    chmod 0600 "$protected"
  fi
done
if [[ -d "$DATA_DIR" ]]; then
  while IFS= read -r -d '' protected; do
    [[ -f "$protected" && ! -L "$protected" ]] || fail PREVIEW_RUNTIME_INVALID
    chmod 0600 "$protected"
  done < <(find "$DATA_DIR" -maxdepth 1 -mindepth 1 -name 'gateway.sqlite*' -print0)
fi
ensure_directory "$RUN_DIR"
acquire_lock
trap release_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

proxy_state="$(manifest_state "$PROXY_MANIFEST" claim_loss_proxy scripts/member-preview-claim-loss-proxy.mjs 8792)"
gateway_state="$(manifest_state "$GATEWAY_MANIFEST" gateway apps/gateway/dist/index.js 8791)"
for state in "$proxy_state" "$gateway_state"; do
  case "$state" in absent|owned) ;; *) fail PREVIEW_PROCESS_OWNERSHIP_FAILED ;; esac
done

if [[ "$proxy_state" == owned ]]; then
  proxy_pid="$(manifest_pid "$PROXY_MANIFEST")" || fail PREVIEW_PROCESS_OWNERSHIP_FAILED
  terminate_owned_pid "$proxy_pid" "$PROXY_MANIFEST" claim_loss_proxy scripts/member-preview-claim-loss-proxy.mjs 8792 || fail PREVIEW_PROCESS_STOP_FAILED
fi
if [[ "$gateway_state" == owned ]]; then
  gateway_pid="$(manifest_pid "$GATEWAY_MANIFEST")" || fail PREVIEW_PROCESS_OWNERSHIP_FAILED
  terminate_owned_pid "$gateway_pid" "$GATEWAY_MANIFEST" gateway apps/gateway/dist/index.js 8791 || fail PREVIEW_PROCESS_STOP_FAILED
fi

release_lock
printf 'Member Preview down: PASS\n'
