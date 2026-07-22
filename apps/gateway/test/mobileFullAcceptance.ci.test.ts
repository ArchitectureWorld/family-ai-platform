import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const shouldRun =
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_HEAD_REF === "feature/mobile-pairing-gateway";

function runRedacted(command: string, args: string[], expectedMarker: string): void {
  const result = spawnSync(command, args, {
    cwd: new URL("../../../", import.meta.url),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 12 * 60 * 1000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    const label = args[0] ?? command;
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
  expect(result.stdout).toContain(expectedMarker);
}

describe.runIf(shouldRun)("Mobile Entry full CI acceptance", () => {
  it(
    "runs Foundation and Mobile Entry Docker acceptance without publishing captured output",
    () => {
      runRedacted("bash", ["./scripts/verify-foundation.sh"], "automated verification: PASS");
      runRedacted(
        "bash",
        ["scripts/acceptance-mobile-pairing.sh"],
        "All Mobile Entry Gateway acceptance steps passed."
      );
    },
    14 * 60 * 1000
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
