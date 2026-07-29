#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

member_handoff_scan() {
  local scan_root="$1"
  node --input-type=module - "$scan_root" <<'NODE'
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const scanRoot = process.argv[2];
const fail = message => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const read = path => readFileSync(path, "utf8");
const exists = path => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};
const walk = (directory, predicate, excluded = new Set()) => {
  if (!exists(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name)) files.push(...walk(path, predicate, excluded));
    } else if (predicate(path)) {
      files.push(path);
    }
  }
  return files;
};
const scriptFiles = walk(
  join(scanRoot, "scripts"),
  path => /\.(?:sh|mjs|cjs|js)$/.test(path) && basename(path) !== "static-check.sh"
);
const describe = path => relative(scanRoot, path);
const handoffMarker =
  /(?:\b(?:MEMBER|ADMIN)_WEB_URL(?:_FILE)?\b|(?:member|admin)-web-url)/;

for (const path of scriptFiles) {
  const source = read(path);
  const logicalSource = source
    .replace(/\\\r?\n/g, " ")
    .replace(/\|\s*\r?\n\s*/g, "| ")
    .replace(/\r?\n\s*\|/g, " |");
  const logicalCommands = logicalSource.split(/\r?\n/);

  if (/\/member\/\?pairingRef=/.test(source)) {
    fail(`Formal Member Web handoffs must use a fragment: ${describe(path)}`);
  }
  if (/\bACCEPTANCE_URL\s*=/.test(source)) {
    fail(`Executable scripts must not construct acceptance URLs: ${describe(path)}`);
  }
  if (/#token=/.test(source)) {
    fail(`Executable scripts must not contain legacy Token handoffs: ${describe(path)}`);
  }
  if (
    /\b(?:xdg-open|gio\s+open|open)\b[^\n]{0,400}(?:#token=|pairingRef=|\b(?:MEMBER|ADMIN)_WEB_URL(?:_FILE)?\b|(?:member|admin)-web-url)/.test(
      logicalSource
    )
  ) {
      fail(`Executable scripts must not open secret-bearing handoffs: ${describe(path)}`);
  }
  if (
    /\$\(\s*<\s*[^)]*(?:(?:MEMBER|ADMIN)_WEB_URL(?:_FILE)?|(?:member|admin)-web-url)/.test(
      logicalSource
    )
  ) {
    fail(`Executable scripts must not load handoff bytes through command substitution: ${describe(path)}`);
  }

  for (const command of logicalCommands) {
    if (!handoffMarker.test(command)) continue;
    if (/\btee\b/.test(command)) {
      fail(`Formal scripts must not tee handoff bytes: ${describe(path)}`);
    }
    if (
      /\b(?:read|readarray|mapfile)\b/.test(command) &&
      /(?:<|--file|-f)[^;\n]*(?:(?:MEMBER|ADMIN)_WEB_URL(?:_FILE)?|(?:member|admin)-web-url)/.test(command)
    ) {
      fail(`Formal scripts must not load handoff bytes into shell variables: ${describe(path)}`);
    }
    if (
      /\b(?:cp|install)\b/.test(command) &&
      /(?:\/dev\/(?:stdout|stderr|fd\/[12])|\/proc\/self\/fd\/[12])/.test(command)
    ) {
      fail(`Formal scripts must not copy handoff bytes to output devices: ${describe(path)}`);
    }
    if (
      /\b(?:cat|head|tail|sed|awk|grep|dd)\b/.test(command) &&
      !/(?:^|[\s;])(?:1?>|&>)\s*\/dev\/null(?:[\s;]|$)/.test(command) &&
      !/\bdd\b[^;\n]*\bof=\/dev\/null(?:[\s;]|$)/.test(command)
    ) {
      fail(`Formal scripts must not print handoff bytes: ${describe(path)}`);
    }
  }

  const javascriptSource = source.replace(/\s+/g, " ");
  const readsHandoff = expression =>
    /\b(?:readFileSync|readFile|createReadStream)\s*\(/.test(expression) &&
    handoffMarker.test(expression);
  const containsIdentifier = (expression, identifier) => {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const withoutQuotedLiterals = expression
      .replace(/"(?:\\.|[^"\\])*"/g, "")
      .replace(/'(?:\\.|[^'\\])*'/g, "");
    return new RegExp(`(^|[^\\w$])${escaped}(?![\\w$])`).test(
      withoutQuotedLiterals
    );
  };
  const taintedIdentifiers = new Set();
  const handoffTextPattern =
    "(?:(?:MEMBER|ADMIN)_WEB_URL(?:_FILE)?|(?:member|admin)-web-url)";
  const identifierPattern = "([A-Za-z_$][\\w$]*)";
  const callbackReadPattern = new RegExp(
    `\\breadFile\\s*\\([^;]{0,1000}${handoffTextPattern}[^;]{0,1000}?` +
      `\\(\\s*${identifierPattern}\\s*,\\s*${identifierPattern}\\s*\\)\\s*=>`,
    "g"
  );
  for (const callbackRead of javascriptSource.matchAll(callbackReadPattern)) {
    taintedIdentifiers.add(callbackRead[2]);
  }
  const promiseReadPattern = new RegExp(
    `\\breadFile\\s*\\([^;]{0,1000}${handoffTextPattern}[^;]{0,1000}?\\)` +
      `\\s*\\.then\\s*\\(\\s*(?:async\\s*)?\\(?\\s*${identifierPattern}\\s*\\)?\\s*=>`,
    "g"
  );
  for (const promiseRead of javascriptSource.matchAll(promiseReadPattern)) {
    taintedIdentifiers.add(promiseRead[1]);
  }
  const assignments = [
    ...javascriptSource.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+)/g
    ),
    ...javascriptSource.matchAll(
      /(?:^|;)\s*([A-Za-z_$][\w$]*)\s*=\s*([^;]+)/g
    )
  ];
  for (let pass = 0; pass <= assignments.length; pass += 1) {
    let changed = false;
    for (const assignment of assignments) {
      const identifier = assignment[1];
      const expression = assignment[2];
      if (
        readsHandoff(expression) ||
        [...taintedIdentifiers].some(tainted =>
          containsIdentifier(expression, tainted)
        )
      ) {
        if (!taintedIdentifiers.has(identifier)) {
          taintedIdentifiers.add(identifier);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const leaksTaintedBytes = expression =>
    readsHandoff(expression) ||
    [...taintedIdentifiers].some(tainted =>
      containsIdentifier(expression, tainted)
    );
  const sinkPattern =
    /(?:process\.(?:stdout|stderr)\.write|console\.(?:log|info|error|warn|debug))\s*\((.*?)\)\s*\)*\s*(?:;|$)/g;
  for (const sink of javascriptSource.matchAll(sinkPattern)) {
    if (leaksTaintedBytes(sink[1])) {
      fail(`Executable JavaScript must not write handoff file bytes: ${describe(path)}`);
    }
  }
  for (const statement of javascriptSource.split(";")) {
    if (
      /\.pipe\s*\(\s*process\.(?:stdout|stderr)\s*\)/.test(statement) &&
      leaksTaintedBytes(statement)
    ) {
      fail(`Executable JavaScript must not pipe handoff file bytes: ${describe(path)}`);
    }
  }

  for (const command of logicalCommands) {
    if (
      /acceptance-onboarding\.sh/.test(command) &&
      (/\|\s*(?:[^|]*\s)?tee\b/.test(command) ||
        /\btee\b[^|]*\|\s*[^|]*acceptance-onboarding\.sh/.test(command))
    ) {
      fail(`Formal onboarding output must not be piped through tee: ${describe(path)}`);
    }
  }
}

const proxyPattern = /(?:member-preview-claim-loss-proxy|response-loss-proxy)/;
for (const rootName of ["apps", "packages"]) {
  const sourceFiles = walk(
    join(scanRoot, rootName),
    path =>
      /\.(?:js|mjs|cjs|ts|tsx)$/.test(path) &&
      !/\.(?:test|spec)\.[^.]+$/.test(path),
    new Set(["test", "tests"])
  );
  for (const path of sourceFiles) {
    if (proxyPattern.test(read(path))) {
      fail(`Response-loss proxy code reached a production module: ${describe(path)}`);
    }
  }
}

const productionFiles = [];
for (const name of ["Dockerfile", "compose.yaml", "package.json"]) {
  const path = join(scanRoot, name);
  if (exists(path)) productionFiles.push(path);
}
productionFiles.push(
  ...walk(
    scanRoot,
    path => basename(path) === "package.json" && !path.includes(`${join(scanRoot, "node_modules")}`)
  ),
  ...scriptFiles.filter(path => {
    const name = basename(path);
    return !name.startsWith("test-") && !name.startsWith("member-preview-");
  })
);
for (const path of new Set(productionFiles)) {
  if (proxyPattern.test(read(path))) {
    fail(`Response-loss proxy code reached a production build input: ${describe(path)}`);
  }
}
NODE
}

if [[ "${1:-}" == "--member-handoff-scan" ]]; then
  [[ "$#" -eq 2 ]] || {
    printf 'usage: static-check.sh --member-handoff-scan ROOT\n' >&2
    exit 2
  }
  member_handoff_scan "$2"
  exit 0
fi
[[ "$#" -eq 0 ]] || {
  printf 'static-check.sh does not accept these arguments.\n' >&2
  exit 2
}

member_handoff_scan "$ROOT_DIR"

preview_scripts=(
  scripts/member-preview-up.sh
  scripts/member-preview-admin.mjs
  scripts/member-preview-pair.mjs
  scripts/member-preview-revoke.mjs
  scripts/member-preview-secret-audit.mjs
  scripts/member-preview-down.sh
  scripts/member-preview-claim-loss-proxy.mjs
)
[[ ! -e scripts/member-preview-admin-activate.mjs ]] || {
  printf 'Retired Admin activation entrypoint is still present.\n' >&2
  exit 1
}
lan_preview_scripts=(
  scripts/member-preview-lan-lib.mjs
  scripts/member-preview-lan-up.sh
  scripts/member-preview-lan-down.sh
)
for preview_script in "${preview_scripts[@]}"; do
  [[ -f "$preview_script" && ! -L "$preview_script" ]] || {
    printf 'Missing protected Preview entrypoint: %s\n' "$preview_script" >&2
    exit 1
  }
done
for lan_preview_script in "${lan_preview_scripts[@]}"; do
  [[ -f "$lan_preview_script" && ! -L "$lan_preview_script" ]] || {
    printf 'Missing protected LAN Preview entrypoint: %s\n' "$lan_preview_script" >&2
    exit 1
  }
done

for ignore_file in .gitignore .dockerignore; do
  [[ "$(grep -Fxc '.runtime-preview/' "$ignore_file")" -eq 1 ]] || {
    printf '%s must contain exactly one .runtime-preview/ entry.\n' "$ignore_file" >&2
    exit 1
  }
done

preview_static_home="$(printf '/%s/%s/' home youran)"
if grep -Fq "$preview_static_home" "${preview_scripts[@]}" "${lan_preview_scripts[@]}"; then
  printf 'Preview scripts must derive the approved home dynamically.\n' >&2
  exit 1
fi
if grep -Fq '0.0.0.0' "${preview_scripts[@]}"; then
  printf 'Preview listeners must remain loopback-only.\n' >&2
  exit 1
fi
if grep -Fq 'GATEWAY_PORT=8790' scripts/member-preview-up.sh; then
  printf 'Preview Gateway must never claim the existing service port.\n' >&2
  exit 1
fi
if grep -Eq 'docker[[:space:]]+compose|dev-(up|reset)|verify-foundation' \
  scripts/member-preview-up.sh scripts/member-preview-down.sh; then
  printf 'Preview lifecycle must remain compose-free and isolated.\n' >&2
  exit 1
fi
if grep -Eq '8790|docker|pkill|killall|fuser' scripts/member-preview-down.sh; then
  printf 'Preview down must be PID-scoped and must not inspect production controls.\n' >&2
  exit 1
fi
if grep -Eq '(^|[^[:alnum:]_])kill[[:space:]]+-TERM([^[:alnum:]_]|$)' \
  scripts/member-preview-up.sh scripts/member-preview-down.sh; then
  printf 'Preview lifecycle TERM must use a validated pidfd.\n' >&2
  exit 1
fi
if grep -Eq '/etc/nginx|systemctl|service[[:space:]]+nginx|ufw|docker[[:space:]]+compose' \
  "${lan_preview_scripts[@]}"; then
  printf 'LAN Preview must remain isolated from system services and Compose.\n' >&2
  exit 1
fi
if grep -Eq 'pkill|killall|fuser|member-preview-down\.sh' \
  scripts/member-preview-lan-down.sh; then
  printf 'LAN Preview down must remain exact-process scoped.\n' >&2
  exit 1
fi
for required in \
  'hostname -s' \
  'id -un' \
  'getent passwd' \
  'fix/member-web-entry-hardening' \
  'umask 077' \
  '127.0.0.1:8791' \
  'memberPublicSha256' \
  'configSha256' \
  'start.lock' \
  'gateway.pid.json'; do
  grep -Fq "$required" scripts/member-preview-up.sh || {
    printf 'Preview up is missing required lifecycle contract: %s\n' "$required" >&2
    exit 1
  }
done
for required in \
  '/proc/' \
  'starttime' \
  'ss -H -ltnp' \
  'os.pidfd_open' \
  'signal.pidfd_send_signal' \
  'select.poll' \
  'gateway.pid.json' \
  'claim-loss-proxy.pid.json'; do
  grep -Fq "$required" scripts/member-preview-down.sh || {
    printf 'Preview down is missing required ownership contract: %s\n' "$required" >&2
    exit 1
  }
done
for required in \
  'hostname -s' \
  'id -un' \
  'getent passwd' \
  'fix/member-web-entry-hardening' \
  'umask 077' \
  'member-preview-up.sh' \
  '9080' \
  '9443' \
  'lan-tls' \
  'prime256v1' \
  'nginx -p' \
  'daemon off' \
  'baseline-8790' \
  'member-preview-admin.mjs'; do
  grep -Fq "$required" scripts/member-preview-lan-up.sh || {
    printf 'LAN Preview up is missing required lifecycle contract: %s\n' "$required" >&2
    exit 1
  }
done
for required in \
  '/proc/' \
  'starttime' \
  'os.pidfd_open' \
  'signal.pidfd_send_signal' \
  'select.poll' \
  'lan-nginx.pid.json' \
  '9080' \
  '9443' \
  'baseline-8790'; do
  grep -Fq "$required" scripts/member-preview-lan-down.sh || {
    printf 'LAN Preview down is missing required ownership contract: %s\n' "$required" >&2
    exit 1
  }
done
if grep -Eq 'set[[:space:]]+-x|#token=|/member/\?pairingRef=' "${preview_scripts[@]}"; then
  printf 'Preview scripts contain a secret-bearing output pattern.\n' >&2
  exit 1
fi
if grep -Eq '(cat|head|tail)[[:space:]][^[:cntrl:]]*(device-token|admin-entry|member-web-url|admin-web-url)' \
  "${preview_scripts[@]}"; then
  printf 'Preview scripts must not print protected handoff or credential files.\n' >&2
  exit 1
fi
if [[ -n "$(git ls-files -- '.runtime-preview' '.runtime-preview/**')" ]]; then
  printf 'Runtime preview artifacts must never be tracked.\n' >&2
  exit 1
fi

for script in scripts/*.sh; do
  bash -n "$script"
done

executable_scripts=()
for script in scripts/*.sh; do
  [[ "$script" == scripts/static-check.sh ]] || executable_scripts+=("$script")
done
formal_handoff_files=(
  "${executable_scripts[@]}"
  docs/development/2026-07-25-member-web-product-workbench.md
)

if grep -Fq '/member/?pairingRef=' "${formal_handoff_files[@]}"; then
  printf 'Formal Member Web handoffs must use a fragment, never pairing query parameters.\n' >&2
  exit 1
fi

if grep -Eq 'ACCEPTANCE_URL[[:space:]]*=' "${executable_scripts[@]}"; then
  printf 'Executable scripts must not construct a secret-bearing acceptance URL.\n' >&2
  exit 1
fi

if grep -Fq '#token=' "${executable_scripts[@]}"; then
  printf 'Executable scripts must not contain legacy Token fragment handoffs.\n' >&2
  exit 1
fi

if grep -Eq '(xdg-open|gio[[:space:]]+open|(^|[[:space:]])open[[:space:]])[^[:cntrl:]]*(#token=|pairingRef=|(MEMBER|ADMIN)_WEB_URL|(member|admin)-web-url)' "${executable_scripts[@]}"; then
  printf 'Executable scripts must not open secret-bearing handoff URLs.\n' >&2
  exit 1
fi

if grep -R -Eq \
  --include='*.sh' \
  --exclude='static-check.sh' \
  'acceptance-onboarding\.sh[^[:cntrl:]]*\|[^[:cntrl:]]*tee|tee[^[:cntrl:]]*\|?[^[:cntrl:]]*acceptance-onboarding\.sh' \
  scripts; then
  printf 'Formal onboarding output must not be piped through tee.\n' >&2
  exit 1
fi

if [[ -n "$(git ls-files -- '.runtime-preview/**' '.runtime-preview')" ]]; then
  printf 'Runtime preview artifacts must never be tracked.\n' >&2
  exit 1
fi

response_loss_proxy_pattern='((import|export)[[:space:]].*from[[:space:]]*|import[[:space:]]*\(|require[[:space:]]*\()[^[:cntrl:]]*(member-preview-claim-loss-proxy|response-loss-proxy)'
if grep -R -Eq \
  --include='*.js' \
  --include='*.mjs' \
  --include='*.cjs' \
  --include='*.ts' \
  --include='*.tsx' \
  --exclude-dir=test \
  --exclude-dir=tests \
  "$response_loss_proxy_pattern" \
  apps packages; then
  printf 'Response-loss proxy code must not be imported by application or package modules.\n' >&2
  exit 1
fi

production_build_files=(Dockerfile compose.yaml package.json)
for script in scripts/*; do
  case "$script" in
    scripts/static-check.sh|scripts/test-*|scripts/member-preview-*) ;;
    *) production_build_files+=("$script") ;;
  esac
done
if grep -Eq '(member-preview-claim-loss-proxy|response-loss-proxy)' "${production_build_files[@]}"; then
  printf 'Response-loss proxy code must not be imported by production build scripts.\n' >&2
  exit 1
fi

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

for forbidden in 'agent-control-center.sqlite' "$preview_static_home" 'family-ai-platform-legacy/data'; do
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
if git grep -n -E -e "$secret_pattern" -- '*.md' '*.mdx' '*.txt' ':!scripts/static-check.sh'; then
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
