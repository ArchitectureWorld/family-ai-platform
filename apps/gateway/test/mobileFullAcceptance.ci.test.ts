import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";

const shouldRun =
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_HEAD_REF === "feature/mobile-pairing-gateway" &&
  existsSync(new URL("../../../.git", import.meta.url));

const metadataDockerfile = `
FROM node:22.16.0-bookworm-slim
SHELL ["/bin/bash", "-c"]
WORKDIR /app
COPY .gitignore Dockerfile compose.yaml ./
RUN printf '%s\\n' '.git' '.github' '.runtime' 'node_modules' '**/node_modules' '**/dist' 'coverage' 'clients/ios' '.env' '.env.*' '.npmrc' '.npmrc.*' '.yarnrc.yml' '.pnpmfile.cjs' '*.sqlite' '*.sqlite-*' '*.log' '*.pem' '*.key' '*.p12' '*.pfx' '*.mobileprovision' '*.credentials.json' '*.secrets.json' 'credentials' 'secrets' 'docs/acceptance/runtime' 'xcuserdata' 'DerivedData' > .dockerignore
COPY scripts scripts
RUN set -euo pipefail; \\
  for script in scripts/*.sh; do bash -n "$script"; done; \\
  grep -Fq '127.0.0.1:8790:8790' compose.yaml; \\
  ! grep -Fq '0.0.0.0:8790:8790' compose.yaml; \\
  grep -Fq 'FROM node:22.16.0-bookworm-slim AS build' Dockerfile; \\
  grep -Fq 'RUN npm run check' Dockerfile; \\
  ! grep -Eq 'command -v (node|npm)' scripts/verify-foundation.sh; \\
  for required in '.runtime/' 'docs/acceptance/runtime/' '.env' '.npmrc' '*.key' '*.mobileprovision' 'clients/ios/Config/Local.xcconfig'; do grep -Fxq "$required" .gitignore; done; \\
  for required in '.runtime' '.env' '.npmrc' '*.key' '*.mobileprovision' 'clients/ios'; do grep -Fxq "$required" .dockerignore; done
`;

describe.runIf(shouldRun)("Docker deployment metadata isolation", () => {
  it(
    "validates deployment and ignore-file metadata inside Docker",
    () => {
      const result = spawnSync(
        "docker",
        ["build", "--progress=plain", "--file", "-", "."],
        {
          cwd: new URL("../../../", import.meta.url),
          input: metadataDockerfile,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 6 * 60 * 1000,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      if (result.error || result.status !== 0) {
        throw new Error(`docker-deployment-metadata:${result.status ?? "unknown"}`);
      }
    },
    8 * 60 * 1000
  );
});
