import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const builtCli = join(root, "apps/gateway/dist/provisionFederationService.js");

test("production package command uses the built CLI and keeps tsx explicit to development", () => {
  assert.equal(
    packageJson.scripts["provision:federation-service"],
    "node apps/gateway/dist/provisionFederationService.js"
  );
  assert.equal(
    packageJson.scripts["provision:federation-service:dev"],
    "tsx apps/gateway/src/provisionFederationService.ts"
  );
});

test("built production CLI imports native runtime dependencies without secrets or files", () => {
  const result = spawnSync(process.execPath, [builtCli, "--self-check"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" }
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("built production CLI provisions one disposable V14 service without secret output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-built-bootstrap-"));
  const databasePath = join(directory, "gateway.sqlite");
  const credentialPath = join(directory, "canvas.credential");
  const credential = "Built-Canvas-Credential-0001";
  try {
    const { openGatewayDatabase } = await import(
      "../apps/gateway/dist/database.js"
    );
    const database = openGatewayDatabase(databasePath);
    database.close();
    writeFileSync(credentialPath, credential, { mode: 0o600 });
    chmodSync(credentialPath, 0o600);

    const result = spawnSync(process.execPath, [
      builtCli,
      "--service-ref", "service:canvas-built",
      "--product", "canvas",
      "--credential-file", credentialPath,
      "--database", databasePath
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production" }
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      '{"status":"ready","serviceRef":"service:canvas-built","product":"canvas"}\n'
    );
    assert.equal(`${result.stdout}${result.stderr}`.includes(credential), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(credentialPath), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(databasePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    "node apps/gateway/dist/provisionFederationService.js --self-check",
    nonRoot
  );

  assert.ok(prune >= 0);
  assert.ok(runtimeStage > prune);
  assert.ok(copiedCli > runtimeStage);
  assert.ok(nonRoot > copiedCli);
  assert.ok(selfCheck > nonRoot);
});
