import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("container-only Gateway timeout remains bounded at twenty seconds", () => {
  const fixture = mkdtempSync(join(root, "apps/gateway/.container-timeout-contract-"));
  const fixtureName = fixture.slice(fixture.lastIndexOf("/") + 1);
  writeFileSync(
    join(fixture, "probe.test.ts"),
    'import { it } from "vitest";\nit("hangs", async () => new Promise<never>(() => undefined));\n',
    { mode: 0o600 }
  );
  const startedAt = Date.now();
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        `${fixtureName}/probe.test.ts`,
        "--config",
        "vitest.config.ts",
        "--maxWorkers=1",
        "--no-file-parallelism"
      ],
      {
        cwd: `${root}/apps/gateway`,
        encoding: "utf8",
        env: { ...process.env, FAMILY_AI_CONTAINER_BUILD: "1" },
        timeout: 30_000
      }
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  const elapsedMs = Date.now() - startedAt;
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 1, output);
  assert.match(output, /Test timed out in 20000ms\./u);
  assert.ok(elapsedMs >= 20_000, `elapsed ${elapsedMs}ms`);
  assert.ok(elapsedMs < 30_000, `elapsed ${elapsedMs}ms`);
});
