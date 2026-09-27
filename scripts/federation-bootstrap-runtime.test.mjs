import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const lockLauncher = join(root, "apps/gateway/runtime/gateway_lock_exec.py");

test("production package commands route built database entrypoints through the lock launcher", () => {
  assert.equal(
    packageJson.scripts["provision:federation-service"],
    "python3 apps/gateway/runtime/gateway_lock_exec.py --database-from-env GATEWAY_DATABASE_PATH -- node apps/gateway/dist/provisionFederationService.js"
  );
  assert.equal(
    packageJson.scripts["provision:federation-service:dev"],
    "npm run build:gateway && python3 apps/gateway/runtime/gateway_lock_exec.py --database-from-env GATEWAY_DATABASE_PATH -- node apps/gateway/dist/provisionFederationService.js"
  );
});

test("built production lock launcher passes its no-database self-check", () => {
  const result = spawnSync("python3", [lockLauncher, "--self-check"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" }
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "GATEWAY_DATABASE_LOCK_SELF_CHECK_OK\n");
  assert.equal(result.stderr, "");
});

test("final Docker runtime runs the built self-check after prune, copy and non-root switch", () => {
  const prune = dockerfile.indexOf("npm prune --omit=dev");
  const runtimeStage = dockerfile.indexOf(" AS runtime", prune);
  const copiedCli = dockerfile.indexOf(
    "COPY --from=build --chown=node:node /app/apps/gateway/dist /app/apps/gateway/dist",
    runtimeStage
  );
  const nonRoot = dockerfile.indexOf("USER 65532:65532", copiedCli);
  const selfCheck = dockerfile.indexOf(
    "python3 apps/gateway/runtime/gateway_lock_exec.py --self-check",
    nonRoot
  );

  assert.ok(prune >= 0);
  assert.ok(runtimeStage > prune);
  assert.ok(copiedCli > runtimeStage);
  assert.ok(nonRoot > copiedCli);
  assert.ok(selfCheck > nonRoot);
});
