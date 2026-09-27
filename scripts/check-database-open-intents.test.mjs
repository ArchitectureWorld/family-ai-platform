import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("reports exact Gateway caller and forbidden production/script counts", () => {
  const result = spawnSync(process.execPath, [
    "scripts/check-database-open-intents.mjs"
  ], {
    cwd: root,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    "DATABASE_OPEN_INTENTS_OK callerFiles=47 callSites=120 "
      + "productionTestIntentCalls=0 scriptDirectCalls=0\n"
  );
});
