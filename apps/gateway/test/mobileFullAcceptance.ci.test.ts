import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";

const shouldRun =
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_HEAD_REF === "feature/mobile-pairing-gateway";

describe.runIf(shouldRun)("Foundation Docker build isolation", () => {
  it(
    "completes the Docker build stage used by verify-foundation",
    () => {
      const result = spawnSync("docker", ["compose", "build"], {
        cwd: new URL("../../../", import.meta.url),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 12 * 60 * 1000,
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (result.error || result.status !== 0) {
        throw new Error(`docker-compose-build:${result.status ?? "unknown"}`);
      }
    },
    14 * 60 * 1000
  );
});
