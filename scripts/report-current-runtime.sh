#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
reporter="$script_dir/report-current-runtime.mjs"

if [[ -n "${FAMILY_AI_RUNTIME_TRUTH_FIXTURE:-}" ]]; then
  fixture="$FAMILY_AI_RUNTIME_TRUTH_FIXTURE"
  [[ -f "$fixture" && ! -L "$fixture" ]] || {
    printf 'RUNTIME_TRUTH_FIXTURE_INVALID\n' >&2
    exit 2
  }
  exec node "$reporter" --fixture "$fixture"
fi

host="${FAMILY_AI_RUNTIME_TRUTH_HOST:-127.0.0.1}"
port="${FAMILY_AI_RUNTIME_TRUTH_PORT:-8790}"
[[ "$host" == "127.0.0.1" ]] || {
  printf 'RUNTIME_TRUTH_HOST_MUST_BE_LOOPBACK\n' >&2
  exit 2
}
[[ "$port" =~ ^[1-9][0-9]{0,4}$ && "$port" -le 65535 ]] || {
  printf 'RUNTIME_TRUTH_PORT_INVALID\n' >&2
  exit 2
}

exec node "$reporter" --live "$host" "$port"
