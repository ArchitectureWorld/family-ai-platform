import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const lockLauncher = join(root, "apps/gateway/runtime/gateway_lock_exec.py");

function migrateDatabase(databasePath) {
  const result = spawnSync("python3", [
    lockLauncher,
    "--database-from-env", "GATEWAY_DATABASE_PATH",
    "--",
    "node", "apps/gateway/dist/migrate.js",
    "--database", databasePath
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", GATEWAY_DATABASE_PATH: databasePath }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
}

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

test("built production CLI provisions one disposable V15 service without secret output", () => {
  const directory = mkdtempSync(join(tmpdir(), "family-built-bootstrap-"));
  const databasePath = join(directory, "gateway.sqlite");
  const credentialPath = join(directory, "canvas.credential");
  const credential = "Built-Canvas-Credential-0001";
  try {
    migrateDatabase(databasePath);
    writeFileSync(credentialPath, credential, { mode: 0o600 });
    chmodSync(credentialPath, 0o600);

    const result = spawnSync("python3", [
      lockLauncher,
      "--database-from-env", "GATEWAY_DATABASE_PATH",
      "--",
      "node", "apps/gateway/dist/provisionFederationService.js",
      "--service-ref", "service:canvas-built",
      "--product", "canvas",
      "--credential-file", credentialPath,
      "--database", databasePath
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production", GATEWAY_DATABASE_PATH: databasePath }
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

test("built production CLI rejects extra and altered persistent service views", () => {
  for (const [label, viewSql] of [
    [
      "extra",
      "CREATE VIEW permissive_service_view AS SELECT service_ref, token_hash FROM federation_services"
    ],
    [
      "altered",
      `CREATE VIEW permissive_service_view AS
       SELECT service_ref, product, token_hash FROM federation_services WHERE 1=1`
    ]
  ]) {
    const directory = mkdtempSync(join(tmpdir(), `family-built-view-${label}-`));
    const databasePath = join(directory, "gateway.sqlite");
    const credentialPath = join(directory, "canvas.credential");
    const credential = `Built-View-Credential-${label}-0001`;
    try {
      migrateDatabase(databasePath);
      const database = new Database(databasePath, { fileMustExist: true });
      database.exec(viewSql);
      database.close();
      writeFileSync(credentialPath, credential, { mode: 0o600 });
      chmodSync(credentialPath, 0o600);

      const result = spawnSync("python3", [
        lockLauncher,
        "--database-from-env", "GATEWAY_DATABASE_PATH",
        "--",
        "node", "apps/gateway/dist/provisionFederationService.js",
        "--service-ref", `service:canvas-view-${label}`,
        "--product", "canvas",
        "--credential-file", credentialPath,
        "--database", databasePath
      ], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production", GATEWAY_DATABASE_PATH: databasePath }
      });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID\n");
      assert.equal(`${result.stdout}${result.stderr}`.includes(credential), false);
      assert.equal(`${result.stdout}${result.stderr}`.includes(databasePath), false);
      const verification = new Database(databasePath, {
        readonly: true,
        fileMustExist: true
      });
      assert.deepEqual(
        verification.prepare("SELECT COUNT(*) AS count FROM federation_services").get(),
        { count: 0 }
      );
      verification.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("built production CLI ignores SQLite-owned ANALYZE objects", () => {
  const directory = mkdtempSync(join(tmpdir(), "family-built-internal-schema-"));
  const databasePath = join(directory, "gateway.sqlite");
  const credentialPath = join(directory, "canvas.credential");
  try {
    migrateDatabase(databasePath);
    const database = new Database(databasePath, { fileMustExist: true });
    database.exec("ANALYZE");
    database.close();
    writeFileSync(credentialPath, "Built-Internal-Credential-0001", { mode: 0o600 });
    chmodSync(credentialPath, 0o600);

    const result = spawnSync("python3", [
      lockLauncher,
      "--database-from-env", "GATEWAY_DATABASE_PATH",
      "--",
      "node", "apps/gateway/dist/provisionFederationService.js",
      "--service-ref", "service:canvas-internal",
      "--product", "canvas",
      "--credential-file", credentialPath,
      "--database", databasePath
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production", GATEWAY_DATABASE_PATH: databasePath }
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
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
    "python3 apps/gateway/runtime/gateway_lock_exec.py --self-check",
    nonRoot
  );

  assert.ok(prune >= 0);
  assert.ok(runtimeStage > prune);
  assert.ok(copiedCli > runtimeStage);
  assert.ok(nonRoot > copiedCli);
  assert.ok(selfCheck > nonRoot);
});
