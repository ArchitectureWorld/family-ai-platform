#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 0 ]] || { printf 'usage: member-preview-lan-down.sh\n' >&2; exit 2; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REMOTE_USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
APPROVED_ROOT="$(cd "$REMOTE_USER_HOME/Development/family-ai-platform" && pwd -P)"
[[ "$(hostname -s)" == "Admin-YR" ]] || { printf 'LAN_PREVIEW_HOST_INVALID\n' >&2; exit 1; }
[[ "$(id -un)" == "youran" ]] || { printf 'LAN_PREVIEW_USER_INVALID\n' >&2; exit 1; }
[[ "$ROOT_DIR" == "$APPROVED_ROOT" ]] || { printf 'LAN_PREVIEW_ROOT_INVALID\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" rev-parse --show-toplevel)" == "$ROOT_DIR" ]] || { printf 'LAN_PREVIEW_REPOSITORY_INVALID\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" branch --show-current)" == "main" ]] || { printf 'LAN_PREVIEW_BRANCH_INVALID\n' >&2; exit 1; }

cd "$ROOT_DIR"
umask 077
RUNTIME_DIR="$ROOT_DIR/.runtime-preview"
RUN_DIR="$RUNTIME_DIR/run"
MANIFEST="$RUN_DIR/lan-nginx.pid.json"
PID_FILE="$RUN_DIR/lan-nginx.pid"
BASELINE_FILE="$RUN_DIR/baseline-8790-lan.snapshot"

fail() { printf '%s\n' "$1" >&2; exit 1; }

capture_8790_json() {
  local health docker_row listener_row
  health="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8790/health | sha256sum | awk '{print $1}')" \
    || return 1
  docker_row="$(docker ps --filter publish=8790 --format '{{.ID}}\t{{.Ports}}')" || return 1
  listener_row="$(ss -H -ltnp 'sport = :8790')" || return 1
  node --input-type=module - "$health" "$docker_row" "$listener_row" <<'NODE'
const [healthSha256, dockerRow, listenerRow] = process.argv.slice(2);
process.stdout.write(JSON.stringify({ version: 1, healthSha256, dockerRow, listenerRow }));
NODE
}

[[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" ]] || fail LAN_PREVIEW_RUNTIME_INVALID
[[ -d "$RUN_DIR" && ! -L "$RUN_DIR" ]] || fail LAN_PREVIEW_RUNTIME_INVALID
[[ -f "$BASELINE_FILE" && ! -L "$BASELINE_FILE" ]] || fail LAN_PREVIEW_8790_BASELINE_INVALID
chmod 0600 "$BASELINE_FILE"
baseline="$(tr -d '\n' <"$BASELINE_FILE")"
current="$(capture_8790_json)" || fail LAN_PREVIEW_8790_INVALID
[[ "$current" == "$baseline" ]] || fail LAN_PREVIEW_8790_CHANGED

if [[ ! -e "$MANIFEST" ]]; then
  [[ -z "$(ss -H -ltnp 'sport = :9080')" ]] || fail LAN_PREVIEW_PORT_9080_BUSY
  [[ -z "$(ss -H -ltnp 'sport = :9443')" ]] || fail LAN_PREVIEW_PORT_9443_BUSY
  printf 'LAN Preview down: PASS\n'
  exit 0
fi

# Validate /proc/<pid>/stat starttime, cwd, executable, command and both exact
# listeners after opening the recorded process with os.pidfd_open.
python3 - "$MANIFEST" "$ROOT_DIR" <<'PYTHON'
import hashlib
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys

manifest_path, expected_root = sys.argv[1:3]

def fail():
    raise RuntimeError("lan nginx ownership validation failed")

def listeners(port):
    result = subprocess.run(
        ["ss", "-H", "-ltnp", f"sport = :{port}"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=True,
        text=True,
        timeout=2,
    )
    return [line for line in result.stdout.splitlines() if line]

descriptor = os.open(manifest_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
pidfd = None
try:
    info = os.fstat(descriptor)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size < 2
        or info.st_size > 16384
    ):
        fail()
    first = os.read(descriptor, 16385)
    os.lseek(descriptor, 0, os.SEEK_SET)
    second = os.read(descriptor, 16385)
    if first != second or len(first) > 16384:
        fail()
    value = json.loads(first.decode("utf-8"))
    expected_keys = {
        "version", "kind", "pid", "starttime", "cwd", "executable", "prefix",
        "configPath", "configSha256", "lanIp", "httpPort", "httpsPort",
        "caFingerprint", "leafFingerprint", "launchCommit",
    }
    if (
        type(value) is not dict
        or set(value) != expected_keys
        or value["version"] != 1
        or value["kind"] != "lan_nginx"
        or type(value["pid"]) is not int
        or value["pid"] <= 0
        or re.fullmatch(r"\d+", value["starttime"]) is None
        or value["cwd"] != expected_root
        or value["httpPort"] != 9080
        or value["httpsPort"] != 9443
        or re.fullmatch(r"[0-9a-f]{64}", value["configSha256"]) is None
        or re.fullmatch(r"[0-9a-f]{40}", value["launchCommit"]) is None
    ):
        fail()
    pid = value["pid"]
    pidfd = os.pidfd_open(pid, 0)
    with open(f"/proc/{pid}/stat", "rb", buffering=0) as handle:
        process_stat = handle.read(16384)
    close = process_stat.rfind(b") ")
    fields = process_stat[close + 2:].strip().split()
    if fields[19].decode("ascii") != value["starttime"]:
        fail()
    if os.path.realpath(os.readlink(f"/proc/{pid}/cwd")) != expected_root:
        fail()
    if os.path.realpath(os.readlink(f"/proc/{pid}/exe")) != value["executable"]:
        fail()
    with open(f"/proc/{pid}/cmdline", "rb", buffering=0) as handle:
        command = handle.read(16384).replace(b"\0", b" ").decode("utf-8")
    if value["prefix"] not in command or value["configPath"] not in command:
        fail()
    with open(value["configPath"], "rb", buffering=0) as handle:
        config_hash = hashlib.sha256(handle.read()).hexdigest()
    if config_hash != value["configSha256"]:
        fail()
    for port in (9080, 9443):
        rows = listeners(port)
        if (
            len(rows) != 1
            or f"0.0.0.0:{port}" not in rows[0]
            or f"pid={pid}," not in rows[0]
        ):
            fail()
    signal.pidfd_send_signal(pidfd, signal.SIGTERM, None, 0)
    waiter = select.poll()
    waiter.register(pidfd, select.POLLIN)
    if not any(fd == pidfd and mask & select.POLLIN for fd, mask in waiter.poll(10000)):
        fail()
    if listeners(9080) or listeners(9443):
        fail()
    confirmed = os.lstat(manifest_path)
    if (confirmed.st_dev, confirmed.st_ino) != (info.st_dev, info.st_ino):
        fail()
    os.unlink(manifest_path)
finally:
    if pidfd is not None:
        os.close(pidfd)
    os.close(descriptor)
PYTHON

rm -f -- "$PID_FILE"
current="$(capture_8790_json)" || fail LAN_PREVIEW_8790_INVALID
[[ "$current" == "$baseline" ]] || fail LAN_PREVIEW_8790_CHANGED
printf 'LAN Preview down: PASS\n'
