import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const shouldRun =
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_HEAD_REF === "feature/mobile-pairing-gateway" &&
  existsSync(new URL("../../../.git", import.meta.url));

function runCaptured(command: string, args: string[], marker: string): void {
  const result = spawnSync(command, args, {
    cwd: new URL("../../../", import.meta.url),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 14 * 60 * 1000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${args[0] ?? command}:${result.status ?? "unknown"}`);
  }
  expect(result.stdout).toContain(marker);
}

describe.runIf(shouldRun)("Foundation exact acceptance", () => {
  it(
    "executes the required Foundation command",
    () => {
      runCaptured("bash", ["./scripts/verify-foundation.sh"], "automated verification: PASS");
    },
    16 * 60 * 1000
  );

  afterAll(() => {
    spawnSync("bash", ["./scripts/dev-reset.sh", "--yes"], {
      cwd: new URL("../../../", import.meta.url),
      stdio: "ignore",
      timeout: 60_000
    });
    rmSync(new URL("../../../docs/acceptance/runtime/", import.meta.url), {
      recursive: true,
      force: true
    });
  });
});
