import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";

const shouldRun =
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_HEAD_REF === "feature/mobile-pairing-gateway" &&
  existsSync(new URL("../../../.git", import.meta.url));

const testDockerfile = `
FROM node:22.16.0-bookworm-slim
RUN apt-get update \\
  && apt-get install -y --no-install-recommends python3 make g++ \\
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/provider-adapter-sdk/package.json packages/provider-adapter-sdk/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN npm ci
COPY .gitignore Dockerfile compose.yaml ./
COPY scripts scripts
COPY packages packages
COPY apps apps
RUN npm run test
`;

describe.runIf(shouldRun)("Foundation Docker test isolation", () => {
  it(
    "runs all repository tests inside the Docker build environment",
    () => {
      const result = spawnSync(
        "docker",
        ["build", "--progress=plain", "--file", "-", "."],
        {
          cwd: new URL("../../../", import.meta.url),
          input: testDockerfile,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          timeout: 12 * 60 * 1000,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      if (result.error || result.status !== 0) {
        throw new Error(`docker-tests:${result.status ?? "unknown"}`);
      }
    },
    14 * 60 * 1000
  );
});
