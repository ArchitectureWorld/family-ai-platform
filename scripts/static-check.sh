#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for script in scripts/*.sh; do
  bash -n "$script"
done

grep -Fq '127.0.0.1:8790:8790' compose.yaml || {
  printf 'compose.yaml must publish Gateway on loopback only.\n' >&2
  exit 1
}

if grep -Fq '0.0.0.0:8790:8790' compose.yaml; then
  printf 'compose.yaml exposes Gateway outside loopback.\n' >&2
  exit 1
fi

grep -Fq 'FROM node:22.16.0-bookworm-slim AS build' Dockerfile || {
  printf 'Dockerfile must use the verified Node 22.16.0 build image.\n' >&2
  exit 1
}

grep -Fq 'RUN npm run check' Dockerfile || {
  printf 'Docker image build must run the full npm quality gate.\n' >&2
  exit 1
}

bash scripts/test-verify-foundation-preflight.sh

if grep -Eq 'command -v (node|npm)' scripts/verify-foundation.sh; then
  printf 'One-command verification must not require Node or npm on the host.\n' >&2
  exit 1
fi

for required in \
  '.runtime/' \
  'docs/acceptance/runtime/' \
  '.env' \
  '.npmrc' \
  '*.key' \
  '*.mobileprovision' \
  'clients/ios/Config/Local.xcconfig'; do
  grep -Fxq "$required" .gitignore || {
    printf '.gitignore is missing required entry: %s\n' "$required" >&2
    exit 1
  }
done

for required in \
  '.runtime' \
  '.env' \
  '.npmrc' \
  '*.key' \
  '*.mobileprovision' \
  'clients/ios'; do
  grep -Fxq "$required" .dockerignore || {
    printf '.dockerignore is missing required entry: %s\n' "$required" >&2
    exit 1
  }
done

while IFS= read -r tracked; do
  case "$tracked" in
    .env|.env.*|.npmrc|.npmrc.*|*.pem|*.key|*.p12|*.pfx|*.mobileprovision|*.sqlite|*.sqlite-*|*.credentials.json|*.secrets.json|*/Local.xcconfig|*/xcuserdata/*|*/DerivedData/*|.runtime/*|docs/acceptance/runtime/*)
      case "$tracked" in
        .env.example|.npmrc.example) ;;
        *)
          printf 'Sensitive or runtime file must not be tracked: %s\n' "$tracked" >&2
          exit 1
          ;;
      esac
      ;;
  esac
done < <(git ls-files)

for forbidden in 'agent-control-center.sqlite' '/home/youran/' 'family-ai-platform-legacy/data'; do
  if grep -R \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude-dir=.runtime \
    --exclude-dir=coverage \
    --exclude='*.md' \
    --exclude='static-check.sh' \
    -Fq "$forbidden" \
    apps packages scripts Dockerfile compose.yaml package.json tsconfig.base.json 2>/dev/null; then
    printf 'Forbidden production reference found: %s\n' "$forbidden" >&2
    exit 1
  fi
done

secret_pattern='-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}'
if git grep -n -E "$secret_pattern" -- '*.md' '*.mdx' '*.txt' ':!scripts/static-check.sh'; then
  printf 'High-confidence secret-like content found in documentation.\n' >&2
  exit 1
fi

while IFS= read -r use_token; do
  action_ref="${use_token##*@}"
  if [[ ! "$action_ref" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'GitHub Action must be pinned to a full commit SHA: %s\n' "$use_token" >&2
    exit 1
  fi
done < <(
  grep -RhoE 'uses:[[:space:]]+[^[:space:]#]+' .github/workflows 2>/dev/null \
    | awk '{print $2}' \
    | grep -v '^\./' \
    || true
)

printf 'Static deployment and public repository checks passed.\n'
