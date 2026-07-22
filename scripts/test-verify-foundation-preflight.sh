#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/scripts"
cp "$ROOT_DIR/scripts/verify-foundation.sh" "$TMP_DIR/scripts/verify-foundation.sh"
touch "$TMP_DIR/package-lock.json"

cat >"$TMP_DIR/bin/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat >"$TMP_DIR/bin/git" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "ls-files" ]]; then
  exit 1
fi
exit 0
EOF

cat >"$TMP_DIR/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

chmod +x "$TMP_DIR/bin/docker" "$TMP_DIR/bin/git" "$TMP_DIR/bin/curl"

set +e
OUTPUT="$(PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/scripts/verify-foundation.sh" 2>&1)"
STATUS=$?
set -e

if [[ $STATUS -eq 0 ]]; then
  printf 'verify-foundation.sh unexpectedly accepted an untracked package-lock.json.\n' >&2
  exit 1
fi

grep -Fq 'package-lock.json 未受 Git 跟踪' <<<"$OUTPUT" || {
  printf 'verify-foundation.sh did not reject an untracked package-lock.json with the expected error.\n' >&2
  printf '%s\n' "$OUTPUT" >&2
  exit 1
}

printf 'Foundation lock preflight regression test passed.\n'
