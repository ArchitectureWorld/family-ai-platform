import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";

const shouldRun =
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_HEAD_REF === "feature/mobile-pairing-gateway" &&
  existsSync(new URL("../../../.git", import.meta.url));

const adjustedBuildDockerfile = `
FROM node:22.16.0-bookworm-slim AS build
RUN apt-get update \\
  && apt-get install -y --no-install-recommends python3 make g++ git \\
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/provider-adapter-sdk/package.json packages/provider-adapter-sdk/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN npm ci
COPY .gitignore Dockerfile compose.yaml ./
RUN printf '%s\\n' '.git' '.github' '.runtime' 'node_modules' '**/node_modules' '**/dist' 'coverage' 'clients/ios' '.env' '.env.*' '.npmrc' '.npmrc.*' '.yarnrc.yml' '.pnpmfile.cjs' '*.sqlite' '*.sqlite-*' '*.log' '*.pem' '*.key' '*.p12' '*.pfx' '*.mobileprovision' '*.credentials.json' '*.secrets.json' 'credentials' 'secrets' 'docs/acceptance/runtime' 'xcuserdata' 'DerivedData' > .dockerignore
COPY scripts scripts
COPY packages packages
COPY apps apps
RUN npm run check && npm prune --omit=dev
`;

describe.runIf(shouldRun)("Adjusted Docker build hypothesis", () => {
  it(
    "completes the full build when security-check inputs are available",
    () => {
      const result = spawnSync(
        "docker",
        ["build", "--progress=plain", "--file", "-", "."],
        {
          cwd: new URL("../../../", import.meta.url),
          input: adjustedBuildDockerfile,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          timeout: 12 * 60 * 1000,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      if (result.error || result.status !== 0) {
        throw new Error(`adjusted-docker-build:${result.status ?? "unknown"}`);
      }
    },
    14 * 60 * 1000
  );
});
