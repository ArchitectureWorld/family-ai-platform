import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";

const shouldRun =
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_HEAD_REF === "feature/mobile-pairing-gateway" &&
  existsSync(new URL("../../../.git", import.meta.url));

const preflightDockerfile = `
FROM node:22.16.0-bookworm-slim
RUN apt-get update \\
  && apt-get install -y --no-install-recommends git \\
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package-lock.json ./
COPY scripts scripts
RUN bash scripts/test-verify-foundation-preflight.sh
`;

describe.runIf(shouldRun)("Docker Foundation preflight isolation", () => {
  it(
    "runs the committed-lock preflight inside Docker",
    () => {
      const result = spawnSync(
        "docker",
        ["build", "--progress=plain", "--file", "-", "."],
        {
          cwd: new URL("../../../", import.meta.url),
          input: preflightDockerfile,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 6 * 60 * 1000,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      if (result.error || result.status !== 0) {
        throw new Error(`docker-foundation-preflight:${result.status ?? "unknown"}`);
      }
    },
    8 * 60 * 1000
  );
});
