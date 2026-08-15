#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT
chmod 700 "$TMP_DIR"

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/scripts"
cp "$ROOT_DIR/scripts/verify-foundation.sh" "$TMP_DIR/scripts/verify-foundation.sh"
touch "$TMP_DIR/package-lock.json"

printf '#!/usr/bin/env bash\nexit 0\n' >"$TMP_DIR/bin/docker"
printf '#!/usr/bin/env bash\n[[ "$1" != "ls-files" ]]\n' >"$TMP_DIR/bin/git"
printf '#!/usr/bin/env bash\nexit 0\n' >"$TMP_DIR/bin/curl"
chmod +x "$TMP_DIR/bin/docker" "$TMP_DIR/bin/git" "$TMP_DIR/bin/curl"

set +e
OUTPUT="$(PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/scripts/verify-foundation.sh" 2>&1)"
STATUS=$?
set -e
if [[ $STATUS -eq 0 ]] || ! grep -Fq 'package-lock.json 未受 Git 跟踪' <<<"$OUTPUT"; then
  printf 'verify-foundation did not reject an untracked lock file\n' >&2
  exit 1
fi

mkdir -m 700 "$TMP_DIR/runtime"
printf retained > "$TMP_DIR/runtime/do-not-delete"
if FAMILY_AI_RUNTIME_ROOT="$TMP_DIR/runtime" bash "$ROOT_DIR/scripts/verify-foundation.sh" --preflight-only >"$TMP_DIR/out" 2>&1; then
  printf 'verify-foundation accepted a non-empty retained runtime\n' >&2
  exit 1
fi
grep -F 'disposable' "$TMP_DIR/out" >/dev/null
[[ -f "$TMP_DIR/runtime/do-not-delete" ]]

printf 'verify-foundation disposable preflight tests: PASS\n'
