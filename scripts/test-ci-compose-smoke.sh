#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI_FILE="$ROOT_DIR/.github/workflows/ci.yml"

fail() {
  printf 'CI COMPOSE CONTRACT TEST FAILED: %s\n' "$1" >&2
  exit 1
}

for job in quality production-audit docker-build container-smoke; do
  grep -Eq "^  ${job}:$" "$CI_FILE" || fail "missing CI job: $job"
done

grep -Fq 'npm audit --omit=dev --audit-level=high' "$CI_FILE" \
  || fail 'production-audit command is missing'
grep -Fq 'docker compose config --quiet' "$CI_FILE" \
  || fail 'Compose configuration gate is missing'
grep -Fq 'FAMILY_AI_GATEWAY_ENV_FILE="$RUNNER_TEMP/gateway-config-check.env"' "$CI_FILE" \
  || fail 'Compose configuration gate may not depend on the formal runtime env file'
grep -Fq 'scripts/build-gateway-image.sh' "$CI_FILE" \
  || fail 'docker-build does not use the immutable wrapper'
grep -Fq 'scripts/ci-compose-smoke.sh' "$CI_FILE" \
  || fail 'container-smoke entrypoint is missing'
grep -Fq 'scripts/acceptance-container-attachments.sh' "$ROOT_DIR/scripts/ci-compose-smoke.sh" \
  || fail 'container smoke does not reuse A2 attachment restart acceptance'

if grep -Eq 'dev-reset\.sh|127\.0\.0\.1:8790|\.runtime(/|[[:space:]])' "$ROOT_DIR/scripts/ci-compose-smoke.sh"; then
  fail 'container smoke may not reset or read the formal runtime or publish 8790'
fi

grep -Eq '^    timeout-minutes: 15$' "$CI_FILE" \
  || fail 'quality timeout must remain 15 minutes'
grep -Fq 'needs: docker-build' "$CI_FILE" \
  || fail 'container-smoke must depend on docker-build'

printf 'CI compose contract tests passed.\n'
