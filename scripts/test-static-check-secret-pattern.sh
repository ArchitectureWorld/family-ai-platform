#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_FILE="SECURITY.md"
TMP_DIR="$(mktemp -d)"
cp "$TARGET_FILE" "$TMP_DIR/SECURITY.md"

cleanup() {
  cp "$TMP_DIR/SECURITY.md" "$TARGET_FILE"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

clean_output="$TMP_DIR/clean-output.txt"
if ! bash scripts/static-check.sh >"$clean_output" 2>&1; then
  cat "$clean_output" >&2
  printf 'Static check must pass for the clean repository.\n' >&2
  exit 1
fi

if grep -Fq 'unknown option' "$clean_output"; then
  cat "$clean_output" >&2
  printf 'Documentation secret scan must pass its regex as a git grep pattern.\n' >&2
  exit 1
fi

cat >>"$TARGET_FILE" <<'EOF'

-----BEGIN PRIVATE KEY-----
synthetic-regression-fixture
-----END PRIVATE KEY-----
EOF

secret_output="$TMP_DIR/secret-output.txt"
set +e
bash scripts/static-check.sh >"$secret_output" 2>&1
secret_status=$?
set -e

if [[ "$secret_status" -eq 0 ]]; then
  cat "$secret_output" >&2
  printf 'Static check must reject a tracked documentation file containing a private-key marker.\n' >&2
  exit 1
fi

if ! grep -Fq 'High-confidence secret-like content found in documentation.' "$secret_output"; then
  cat "$secret_output" >&2
  printf 'Static check did not report the documentation secret guard.\n' >&2
  exit 1
fi

printf 'Static documentation secret-pattern regression test passed.\n'
