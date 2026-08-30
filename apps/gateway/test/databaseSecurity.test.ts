import {
  chmodSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
import type { DatabaseSecurityHooks } from "../src/databaseSecurity.js";

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

  const createFixture = (path: string, version: 13 | 14 | 15): void => {
    const opened = openWithIntent(path, {
      intent: "test-create-or-existing",
      simulate: "migrate-create-or-existing",
      migrationLimit: version
    });
    opened.close();
    chmodSync(path, 0o600);
  };

  const openFileCount = (): number => readdirSync("/proc/self/fd").length;

  const databaseDescriptorCount = (path: string): number => {
    const identity = statSync(path);
    let count = 0;
    for (const name of readdirSync("/proc/self/fd")) {
      if (!/^\d+$/u.test(name)) continue;
      try {
        const state = fstatSync(Number(name));
        if (state.isFile() && state.dev === identity.dev && state.ino === identity.ino) {
          count += 1;
        }
      } catch {
        // The proc enumeration descriptor may disappear before inspection.
      }
    }
    return count;
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

  it("holds an independent database proof descriptor through inspection, writable open and lease", () => {
    const path = prepareDirectory();
    createFixture(path, 15);
    const observed = new Map<string, number>();

    const lease = openGatewayDatabase(
      path,
      { intent: "gateway-existing" },
      {
        checkpoint: (stage) => {
          if (stage !== "beforeMigrationCommit") {
            observed.set(stage, databaseDescriptorCount(path));
          }
        }
      }
    );

    expect(observed.get("afterReadonlyOpen")).toBeGreaterThanOrEqual(2);
    expect(observed.get("afterReadonlyValidation")).toBeGreaterThanOrEqual(2);
    expect(observed.get("afterWritableOpen")).toBeGreaterThanOrEqual(2);
    expect(observed.get("beforeReturn")).toBeGreaterThanOrEqual(2);
    expect(databaseDescriptorCount(path)).toBeGreaterThanOrEqual(2);
    lease.close();
    expect(databaseDescriptorCount(path)).toBe(0);
  });

  it.each(["path", "sidecar", "marker"] as const)(
    "closes every held descriptor across 50 readonly-to-writable %s transition failures",
    (failureKind) => {
      const path = prepareDirectory();
      createFixture(path, 15);
      const replacementPath = join(directory, "replacement.sqlite");
      const originalPath = join(directory, "original.sqlite");
      if (failureKind === "path") createFixture(replacementPath, 15);
      const initialBytes = readFileSync(path);
      const baseline = openFileCount();

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const stages: string[] = [];
        try {
          expect(() => openGatewayDatabase(
            path,
            { intent: "gateway-existing" },
            {
              checkpoint: (stage) => {
                stages.push(stage);
                if (stage !== "afterReadonlyValidation") return;
                if (failureKind === "path") {
                  renameSync(path, originalPath);
                  renameSync(replacementPath, path);
                } else if (failureKind === "sidecar") {
                  writeFileSync(`${path}-wal`, "transition-sidecar", { mode: 0o600 });
                } else {
                  mkdirSync(join(directory, ".gateway.sqlite.wal-recovery"), { mode: 0o700 });
                }
              }
            }
          )).toThrow("GATEWAY_DATABASE_INVALID");
        } finally {
          if (failureKind === "path" && existsSync(originalPath)) {
            renameSync(path, replacementPath);
            renameSync(originalPath, path);
          }
          rmSync(`${path}-wal`, { force: true });
          rmSync(join(directory, ".gateway.sqlite.wal-recovery"), {
            recursive: true,
            force: true
          });
        }
        expect(stages).not.toContain("afterWritableOpen");
        expect(stages).not.toContain("beforeReturn");
        expect(openFileCount()).toBe(baseline);
      }

      expect(readFileSync(path)).toEqual(initialBytes);
      expect(databaseDescriptorCount(path)).toBe(0);
    },
    60_000
  );

  it("uses fixed production 1000:1000 ownership and test-only injected uid/gid expectations", () => {
    const path = prepareDirectory();
    createFixture(path, 15);
    const uid = process.getuid();
    const gid = process.getgid();
    const currentIds: DatabaseSecurityHooks = {
      expectedParentUid: uid,
      expectedParentGid: gid,
      expectedDatabaseUid: uid,
      expectedDatabaseGid: gid
    };

    const testLease = openGatewayDatabase(
      path,
      { intent: "test-create-or-existing", simulate: "gateway-existing" },
      currentIds
    );
    testLease.close();
    const beforeHostileAttempts = readFileSync(path);

    for (const hostile of [
      { ...currentIds, expectedParentUid: uid + 1 },
      { ...currentIds, expectedParentGid: gid + 1 },
      { ...currentIds, expectedDatabaseUid: uid + 1 },
      { ...currentIds, expectedDatabaseGid: gid + 1 },
      {
        expectedParentUid: 0,
        expectedParentGid: 0,
        expectedDatabaseUid: 0,
        expectedDatabaseGid: 0
      }
    ]) {
      expect(() => openGatewayDatabase(
        path,
        { intent: "test-create-or-existing", simulate: "gateway-existing" },
        hostile
      )).toThrow("GATEWAY_DATABASE_INVALID");
      expect(readFileSync(path)).toEqual(beforeHostileAttempts);
    }

    const production = openGatewayDatabase(
      path,
      { intent: "gateway-existing" },
      {
        expectedParentUid: uid + 1,
        expectedParentGid: gid + 1,
        expectedDatabaseUid: uid + 1,
        expectedDatabaseGid: gid + 1
      }
    );
    production.close();
    expect(readdirSync(directory).filter((name) => name.startsWith("gateway.sqlite-")))
      .toEqual([]);
  }, 60_000);

  it.each([
    ["V13", 13, false],
    ["altered V15", 15, true]
  ] as const)(
    "rejects a fresh-create proof-window replacement with %s without changing either inode",
    (_label, version, altered) => {
      const path = prepareDirectory();
      const replacementPath = join(directory, "replacement.sqlite");
      const createdPath = join(directory, "created.sqlite");
      createFixture(replacementPath, version);
      if (altered) {
        const replacement = new Database(replacementPath, { fileMustExist: true });
        replacement.exec("CREATE TABLE hostile_replacement(value TEXT)");
        replacement.close();
      }
      const replacementBytes = readFileSync(replacementPath);
      const replacementLedger = new Database(replacementPath, {
        readonly: true,
        fileMustExist: true
      });
      const ledgerBefore = replacementLedger.prepare(
        "SELECT version FROM schema_migrations ORDER BY version"
      ).all();
      replacementLedger.close();
      let createdBytes: Buffer | undefined;
      const stages: string[] = [];
      const baseline = openFileCount();

      expect(() => openGatewayDatabase(
        path,
        { intent: "migrate-create-or-existing" },
        {
          checkpoint: (stage) => {
            stages.push(stage);
            if (String(stage) !== "afterDatabaseCreate") return;
            renameSync(path, createdPath);
            renameSync(replacementPath, path);
            createdBytes = readFileSync(createdPath);
          }
        }
      )).toThrow("GATEWAY_DATABASE_INVALID");

      expect(createdBytes).toBeDefined();
      expect(readFileSync(createdPath)).toEqual(createdBytes);
      expect(readFileSync(path)).toEqual(replacementBytes);
      const replacementAfter = new Database(path, { readonly: true, fileMustExist: true });
      expect(replacementAfter.prepare(
        "SELECT version FROM schema_migrations ORDER BY version"
      ).all()).toEqual(ledgerBefore);
      replacementAfter.close();
      expect(stages).not.toContain("afterWritableOpen");
      expect(stages).not.toContain("beforeMigrationCommit");
      expect(stages).not.toContain("beforeReturn");
      expect(openFileCount()).toBe(baseline);
    },
    60_000
  );

  it("treats a create-time EEXIST race as existing and runs immutable validation", () => {
    const path = prepareDirectory();
    const replacementPath = join(directory, "replacement.sqlite");
    createFixture(replacementPath, 13);
    const before = readFileSync(replacementPath);
    const baseline = openFileCount();
    const stages: string[] = [];

    expect(() => openGatewayDatabase(
      path,
      { intent: "migrate-create-or-existing" },
      {
        checkpoint: (stage) => {
          stages.push(stage);
          if (String(stage) === "beforeDatabaseCreate") {
            renameSync(replacementPath, path);
          }
        }
      }
    )).toThrow("GATEWAY_DATABASE_SCHEMA_INVALID");

    expect(readFileSync(path)).toEqual(before);
    const verification = new Database(path, { readonly: true, fileMustExist: true });
    expect(verification.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 13 });
    verification.close();
    expect(stages).not.toContain("afterWritableOpen");
    expect(stages).not.toContain("beforeMigrationCommit");
    expect(stages).not.toContain("beforeReturn");
    expect(openFileCount()).toBe(baseline);
  }, 60_000);
});
