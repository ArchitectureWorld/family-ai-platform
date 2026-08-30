import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  openGatewayDatabase,
  type GatewayDatabase,
  type GatewayDatabaseOpenRequest
} from "../src/database.js";

type PlannedLease = GatewayDatabase & {
  database: GatewayDatabase;
  intent: GatewayDatabaseOpenRequest["intent"];
};

const openWithIntent = openGatewayDatabase as unknown as (
  path: string,
  request: GatewayDatabaseOpenRequest,
) => PlannedLease;

describe("secure Gateway database intents", () => {
  let directory = "";

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const prepareDirectory = (): string => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-secure-database-"));
    chmodSync(directory, 0o700);
    return join(directory, "gateway.sqlite");
  };

  const createFixture = (path: string, version: 14 | 15): void => {
    const opened = openWithIntent(path, {
      intent: "test-create-or-existing",
      simulate: "migrate-create-or-existing",
      migrationLimit: version
    });
    opened.close();
    chmodSync(path, 0o600);
  };

  it("requires an explicit intent before creating any database path", () => {
    const path = prepareDirectory();
    expect(() => (openGatewayDatabase as unknown as (path: string) => GatewayDatabase)(path))
      .toThrow("GATEWAY_DATABASE_INTENT_REQUIRED");
    expect(existsSync(path)).toBe(false);
  });

  it("allows only migrate intent to create exact V15 with protected modes and no sidecars", () => {
    const path = prepareDirectory();
    const lease = openWithIntent(path, { intent: "migrate-create-or-existing" });
    expect(lease.intent).toBe("migrate-create-or-existing");
    expect(lease.database).toBe(lease);
    expect(lease.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 15 });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    lease.close();
    expect(readdirSync(directory).filter((name) => name.startsWith("gateway.sqlite-")))
      .toEqual([]);

    const missing = join(directory, "missing.sqlite");
    expect(() => openWithIntent(missing, { intent: "gateway-existing" }))
      .toThrow("GATEWAY_DATABASE_INVALID");
    expect(() => openWithIntent(missing, { intent: "provision-existing" }))
      .toThrow("GATEWAY_DATABASE_INVALID");
    expect(existsSync(missing)).toBe(false);
  });

  it("rejects V14 Gateway open before WAL or database mutation", () => {
    const path = prepareDirectory();
    createFixture(path, 14);
    const beforeLedger = (() => {
      const legacy = new Database(path, { readonly: true, fileMustExist: true });
      try {
        return legacy.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      } finally {
        legacy.close();
      }
    })();
    const beforeBytes = readFileSync(path);
    const before = statSync(path);

    expect(() => openWithIntent(path, { intent: "gateway-existing" }))
      .toThrow("GATEWAY_DATABASE_SCHEMA_INVALID");
    expect(readFileSync(path)).toEqual(beforeBytes);
    const after = statSync(path);
    expect({ size: after.size, mode: after.mode & 0o777, mtimeMs: after.mtimeMs })
      .toEqual({ size: before.size, mode: before.mode & 0o777, mtimeMs: before.mtimeMs });
    expect(readdirSync(directory).filter((name) => name.startsWith("gateway.sqlite-")))
      .toEqual([]);
    const verification = new Database(path, { readonly: true, fileMustExist: true });
    expect(verification.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual(beforeLedger);
    verification.close();
  }, 20_000);

  it("rejects a V13 production migration without changing the legacy database", () => {
    const path = prepareDirectory();
    createFixture(path, 13);
    const before = readFileSync(path);
    const beforeState = statSync(path);

    expect(() => openWithIntent(path, { intent: "migrate-create-or-existing" }))
      .toThrow("GATEWAY_DATABASE_SCHEMA_INVALID");
    expect(readFileSync(path)).toEqual(before);
    const afterState = statSync(path);
    expect({ size: afterState.size, mtimeMs: afterState.mtimeMs })
      .toEqual({ size: beforeState.size, mtimeMs: beforeState.mtimeMs });
    expect(readdirSync(directory).filter((name) => name.startsWith("gateway.sqlite-")))
      .toEqual([]);
  }, 30_000);

  it("rolls back the complete V14-to-V15 migration when the exclusive commit faults", () => {
    const path = prepareDirectory();
    createFixture(path, 14);

    expect(() => openGatewayDatabase(
      path,
      { intent: "migrate-create-or-existing" },
      {
        checkpoint: (stage) => {
          if (stage === "beforeMigrationCommit") throw new Error("MIGRATION_FAULT");
        }
      }
    )).toThrow("MIGRATION_FAULT");

    const verification = new Database(path, { readonly: true, fileMustExist: true });
    expect(verification.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 14 });
    expect(verification.prepare("PRAGMA table_info(federation_actor_contexts)").all())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "service_ref" })]));
    verification.close();
    expect(existsSync(`${path}-journal`)).toBe(false);
  }, 30_000);

  it.each([14, 15] as const)(
    "rejects a non-exact V%d production migration schema before mutation",
    (version) => {
      const path = prepareDirectory();
      createFixture(path, version);
      const hostile = new Database(path, { fileMustExist: true });
      hostile.exec("CREATE VIEW permissive_migration_view AS SELECT version FROM schema_migrations");
      hostile.close();
      const before = readFileSync(path);
      const beforeState = statSync(path);

      expect(() => openWithIntent(path, { intent: "migrate-create-or-existing" }))
        .toThrow("GATEWAY_DATABASE_SCHEMA_INVALID");
      expect(readFileSync(path)).toEqual(before);
      const afterState = statSync(path);
      expect({ size: afterState.size, mtimeMs: afterState.mtimeMs })
        .toEqual({ size: beforeState.size, mtimeMs: beforeState.mtimeMs });
      expect(readdirSync(directory).filter((name) => name.startsWith("gateway.sqlite-")))
        .toEqual([]);
    },
    30_000
  );

  it.each(["wal", "shm", "journal"] as const)(
    "rejects a pre-existing %s sidecar without changing database bytes",
    (kind) => {
      const path = prepareDirectory();
      createFixture(path, 15);
      const before = readFileSync(path);
      writeFileSync(`${path}-${kind}`, "hostile-sidecar", { mode: 0o600 });
      expect(() => openWithIntent(path, { intent: "gateway-existing" }))
        .toThrow("GATEWAY_DATABASE_INVALID");
      expect(readFileSync(path)).toEqual(before);
    },
    30_000
  );

  it("rejects a recovery marker and invalid test-intent combinations", () => {
    const path = prepareDirectory();
    createFixture(path, 15);
    mkdirSync(join(directory, ".gateway.sqlite.wal-recovery"), { mode: 0o700 });
    expect(() => openWithIntent(path, { intent: "gateway-existing" }))
      .toThrow("GATEWAY_DATABASE_INVALID");
    expect(() => openWithIntent(path, {
      intent: "test-create-or-existing",
      simulate: "gateway-existing",
      migrationLimit: 14
    } as unknown as GatewayDatabaseOpenRequest)).toThrow("GATEWAY_DATABASE_INTENT_INVALID");
  });
});
