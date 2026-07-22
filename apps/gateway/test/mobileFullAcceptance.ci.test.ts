import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";

const shouldRun =
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_HEAD_REF === "feature/mobile-pairing-gateway" &&
  existsSync(new URL("../../../.git", import.meta.url));

const fileScanDockerfile = `
FROM node:22.16.0-bookworm-slim
RUN apt-get update \\
  && apt-get install -y --no-install-recommends git \\
  && rm -rf /var/lib/apt/lists/*
SHELL ["/bin/bash", "-c"]
WORKDIR /app
COPY package.json tsconfig.base.json Dockerfile compose.yaml ./
COPY scripts scripts
COPY packages packages
COPY apps apps
RUN rm apps/gateway/test/mobileFullAcceptance.ci.test.ts; \\
  set -euo pipefail; \\
  while IFS= read -r tracked; do \\
    case "$tracked" in \\
      .env|.env.*|.npmrc|.npmrc.*|*.pem|*.key|*.p12|*.pfx|*.mobileprovision|*.sqlite|*.sqlite-*|*.credentials.json|*.secrets.json|*/Local.xcconfig|*/xcuserdata/*|*/DerivedData/*|.runtime/*|docs/acceptance/runtime/*) exit 11 ;; \\
    esac; \\
  done < <(git ls-files 2>/dev/null || true); \\
  for forbidden in 'agent-control-center.sqlite' '/home/youran/' 'family-ai-platform-legacy/data'; do \\
    if grep -R --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.runtime --exclude-dir=coverage --exclude='*.md' --exclude='static-check.sh' -Fq "$forbidden" apps packages scripts Dockerfile compose.yaml package.json tsconfig.base.json 2>/dev/null; then exit 12; fi; \\
  done
`;

describe.runIf(shouldRun)("Docker sensitive-file scan isolation", () => {
  it(
    "runs tracked-file and forbidden-reference scans",
    () => {
      const result = spawnSync(
        "docker",
        ["build", "--progress=plain", "--file", "-", "."],
        {
          cwd: new URL("../../../", import.meta.url),
          input: fileScanDockerfile,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 6 * 60 * 1000,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      if (result.error || result.status !== 0) {
        throw new Error(`docker-file-scan:${result.status ?? "unknown"}`);
      }
    },
    8 * 60 * 1000
  );
});
