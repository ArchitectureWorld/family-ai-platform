import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  type Stats
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

export type GatewayDatabaseIntent =
  | "gateway-existing"
  | "migrate-create-or-existing"
  | "provision-existing"
  | "test-create-or-existing";

export type GatewayDatabaseOpenRequest =
  | { intent: "gateway-existing" }
  | { intent: "migrate-create-or-existing" }
  | { intent: "provision-existing" }
  | { intent: "test-create-or-existing"; simulate: "gateway-existing" }
  | { intent: "test-create-or-existing"; simulate: "provision-existing" }
  | {
      intent: "test-create-or-existing";
      simulate: "migrate-create-or-existing";
      migrationLimit?: 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
    };

export type DatabaseSecurityCheckpoint =
  | "afterReadonlyOpen"
  | "afterReadonlyValidation"
  | "afterWritableOpen"
  | "beforeMigrationCommit"
  | "beforeReturn";

export interface DatabaseSecurityHooks {
  checkpoint?: (stage: DatabaseSecurityCheckpoint) => void;
  expectedParentUid?: number;
  expectedParentGid?: number;
  expectedDatabaseUid?: number;
  expectedDatabaseGid?: number;
}

export interface SecureDatabaseFile {
  database: Database.Database;
  intent: GatewayDatabaseIntent;
  effectiveIntent: Exclude<GatewayDatabaseIntent, "test-create-or-existing">;
  migrationLimit: 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
  assertBound: () => void;
  close: () => void;
}

interface SchemaStatement {
  all: () => unknown[];
}

interface SchemaInspectionDatabase {
  prepare: (sql: string) => SchemaStatement;
}

interface ImmutableDatabase extends SchemaInspectionDatabase {
  close: () => void;
}

type ImmutableDatabaseConstructor = new (
  path: string,
  options: { readOnly: true }
) => ImmutableDatabase;

let immutableDatabaseConstructor: ImmutableDatabaseConstructor | undefined;
const GATEWAY_APPLICATION_UID = 1000;
const GATEWAY_APPLICATION_GID = 1000;

function loadImmutableDatabaseConstructor(): ImmutableDatabaseConstructor {
  if (immutableDatabaseConstructor) return immutableDatabaseConstructor;
  const originalEmitWarning = process.emitWarning;
  try {
    process.emitWarning = (() => undefined) as typeof process.emitWarning;
    const sqlite = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: ImmutableDatabaseConstructor;
    };
    immutableDatabaseConstructor = sqlite.DatabaseSync;
    return immutableDatabaseConstructor;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function fail(code: string): never {
  throw new Error(code);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).toSorted()) ===
    JSON.stringify([...expected].toSorted());
}

function resolveRequest(request: GatewayDatabaseOpenRequest): {
  publicIntent: GatewayDatabaseIntent;
  effectiveIntent: Exclude<GatewayDatabaseIntent, "test-create-or-existing">;
  migrationLimit: 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
} {
  if (request.intent === "gateway-existing") {
    if (!exactKeys(request, ["intent"])) fail("GATEWAY_DATABASE_INTENT_INVALID");
    return { publicIntent: request.intent, effectiveIntent: request.intent, migrationLimit: 15 };
  }
  if (request.intent === "migrate-create-or-existing") {
    if (!exactKeys(request, ["intent"])) fail("GATEWAY_DATABASE_INTENT_INVALID");
    return { publicIntent: request.intent, effectiveIntent: request.intent, migrationLimit: 15 };
  }
  if (request.intent === "provision-existing") {
    if (!exactKeys(request, ["intent"])) fail("GATEWAY_DATABASE_INTENT_INVALID");
    return { publicIntent: request.intent, effectiveIntent: request.intent, migrationLimit: 15 };
  }
  if (request.intent !== "test-create-or-existing") {
    return fail("GATEWAY_DATABASE_INTENT_INVALID");
  }
  if (request.simulate === "migrate-create-or-existing") {
    if (!exactKeys(request, ["intent", "simulate", ...(request.migrationLimit === undefined
      ? []
      : ["migrationLimit"])])) {
      fail("GATEWAY_DATABASE_INTENT_INVALID");
    }
    return {
      publicIntent: request.intent,
      effectiveIntent: request.simulate,
      migrationLimit: request.migrationLimit ?? 15
    };
  }
  if (
    (request.simulate === "gateway-existing" || request.simulate === "provision-existing")
    && exactKeys(request, ["intent", "simulate"])
  ) {
    return {
      publicIntent: request.intent,
      effectiveIntent: request.simulate,
      migrationLimit: 15
    };
  }
  return fail("GATEWAY_DATABASE_INTENT_INVALID");
}

interface ProtectedPath {
  path: string;
  parentPath: string;
  parentDescriptor: number;
  databaseDescriptor: number;
  expectedParentUid: number;
  expectedParentGid: number;
  expectedDatabaseUid: number;
  expectedDatabaseGid: number;
}

function protectedParent(state: Stats, uid: number, gid: number): boolean {
  return state.isDirectory()
    && state.uid === uid
    && state.gid === gid
    && (state.mode & 0o777) === 0o700;
}

function protectedDatabase(state: Stats, uid: number, gid: number): boolean {
  return state.isFile()
    && !state.isSymbolicLink()
    && state.uid === uid
    && state.gid === gid
    && state.nlink === 1
    && (state.mode & 0o777) === 0o600;
}

function assertNoSidecarsOrMarker(path: string): void {
  const parent = dirname(path);
  const file = basename(path);
  const forbidden = new Set([
    `${file}-wal`,
    `${file}-shm`,
    `${file}-journal`,
    `.${file}.wal-recovery`
  ]);
  try {
    if (readdirSync(parent).some((name) => forbidden.has(name))) {
      fail("GATEWAY_DATABASE_INVALID");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_INVALID") throw error;
    fail("GATEWAY_DATABASE_INVALID");
  }
}

function assertProtectedPath(protectedPath: ProtectedPath): void {
  try {
    const parentFd = fstatSync(protectedPath.parentDescriptor);
    const parentPath = lstatSync(protectedPath.parentPath);
    const databaseFd = fstatSync(protectedPath.databaseDescriptor);
    const databasePath = lstatSync(protectedPath.path);
    if (
      realpathSync(protectedPath.parentPath) !== protectedPath.parentPath
      || !sameIdentity(parentPath, parentFd)
      || !protectedParent(
        parentFd,
        protectedPath.expectedParentUid,
        protectedPath.expectedParentGid
      )
      || !protectedParent(
        parentPath,
        protectedPath.expectedParentUid,
        protectedPath.expectedParentGid
      )
      || !sameIdentity(databasePath, databaseFd)
      || !protectedDatabase(
        databaseFd,
        protectedPath.expectedDatabaseUid,
        protectedPath.expectedDatabaseGid
      )
      || !protectedDatabase(
        databasePath,
        protectedPath.expectedDatabaseUid,
        protectedPath.expectedDatabaseGid
      )
    ) {
      fail("GATEWAY_DATABASE_INVALID");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_INVALID") throw error;
    fail("GATEWAY_DATABASE_INVALID");
  }
}

function createDatabase(path: string, parentDescriptor: number): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
  } catch {
    return fail("GATEWAY_DATABASE_INVALID");
  }
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncSync(parentDescriptor);
}

function capturePath(
  path: string,
  allowCreate: boolean,
  publicIntent: GatewayDatabaseIntent,
  hooks: DatabaseSecurityHooks
): ProtectedPath {
  if (
    !isAbsolute(path)
    || path === "/"
    || resolve(path) !== path
  ) {
    return fail("GATEWAY_DATABASE_INVALID");
  }
  const parentPath = dirname(path);
  let parentDescriptor: number;
  try {
    parentDescriptor = openSync(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch {
    return fail("GATEWAY_DATABASE_INVALID");
  }
  let databaseDescriptor: number | undefined;
  try {
    const injected = publicIntent === "test-create-or-existing";
    const expectedParentUid = injected
      ? hooks.expectedParentUid ?? GATEWAY_APPLICATION_UID
      : GATEWAY_APPLICATION_UID;
    const expectedParentGid = injected
      ? hooks.expectedParentGid ?? GATEWAY_APPLICATION_GID
      : GATEWAY_APPLICATION_GID;
    const expectedDatabaseUid = injected
      ? hooks.expectedDatabaseUid ?? GATEWAY_APPLICATION_UID
      : GATEWAY_APPLICATION_UID;
    const expectedDatabaseGid = injected
      ? hooks.expectedDatabaseGid ?? GATEWAY_APPLICATION_GID
      : GATEWAY_APPLICATION_GID;
    const parentIdentity = fstatSync(parentDescriptor);
    if (
      realpathSync(parentPath) !== parentPath
      || !protectedParent(parentIdentity, expectedParentUid, expectedParentGid)
    ) {
      fail("GATEWAY_DATABASE_INVALID");
    }
    try {
      lstatSync(path);
    } catch (error) {
      if (!allowCreate || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      createDatabase(path, parentDescriptor);
    }
    databaseDescriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const protectedPath = {
      path,
      parentPath,
      parentDescriptor,
      databaseDescriptor,
      expectedParentUid,
      expectedParentGid,
      expectedDatabaseUid,
      expectedDatabaseGid
    };
    assertProtectedPath(protectedPath);
    assertNoSidecarsOrMarker(path);
    return protectedPath;
  } catch (error) {
    try {
      if (databaseDescriptor !== undefined) closeSync(databaseDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_INVALID") throw error;
    fail("GATEWAY_DATABASE_INVALID");
  }
}

function openDescriptors(proofDescriptor: number): Set<number> {
  const identity = fstatSync(proofDescriptor);
  const descriptors = new Set<number>();
  for (const name of readdirSync("/proc/self/fd")) {
    if (!/^\d+$/u.test(name)) continue;
    const descriptor = Number(name);
    try {
      const state = fstatSync(descriptor);
      if (state.isFile() && sameIdentity(state, identity)) descriptors.add(descriptor);
    } catch {
      // The proc enumeration descriptor may disappear before inspection.
    }
  }
  return descriptors;
}

function newConnectionDescriptor(
  before: ReadonlySet<number>,
  proofDescriptor: number
): number {
  const descriptor = [...openDescriptors(proofDescriptor)]
    .find((candidate) => !before.has(candidate));
  if (descriptor === undefined) return fail("GATEWAY_DATABASE_INVALID");
  const state = fstatSync(descriptor);
  const proof = fstatSync(proofDescriptor);
  if (!state.isFile() || !sameIdentity(state, proof)) {
    return fail("GATEWAY_DATABASE_INVALID");
  }
  return descriptor;
}

function assertConnectionBound(descriptor: number, protectedPath: ProtectedPath): void {
  try {
    assertProtectedPath(protectedPath);
    const connection = fstatSync(descriptor);
    const proof = fstatSync(protectedPath.databaseDescriptor);
    if (!connection.isFile() || !sameIdentity(connection, proof)) {
      fail("GATEWAY_DATABASE_INVALID");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_INVALID") throw error;
    fail("GATEWAY_DATABASE_INVALID");
  }
}

export interface CanonicalSchemaObject {
  type: "index" | "table" | "trigger" | "view";
  name: string;
  tableName: string;
  sql: string | null;
}

export function canonicalGatewaySchema(
  database: SchemaInspectionDatabase
): CanonicalSchemaObject[] {
  const applicationTypes = new Set<CanonicalSchemaObject["type"]>([
    "index", "table", "trigger", "view"
  ]);
  const objects: CanonicalSchemaObject[] = [];
  for (const row of database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master"
  ).all()) {
    const object = row as Record<string, unknown>;
    if (
      JSON.stringify(Object.keys(object).toSorted()) !==
        JSON.stringify(["name", "sql", "tbl_name", "type"])
      || typeof object.type !== "string"
      || typeof object.name !== "string"
      || typeof object.tbl_name !== "string"
      || (object.sql !== null && typeof object.sql !== "string")
    ) {
      return fail("GATEWAY_DATABASE_SCHEMA_INVALID");
    }
    if (object.name.startsWith("sqlite_") && !object.name.startsWith("sqlite_autoindex_")) {
      continue;
    }
    if (!applicationTypes.has(object.type as CanonicalSchemaObject["type"])) {
      return fail("GATEWAY_DATABASE_SCHEMA_INVALID");
    }
    objects.push({
      type: object.type as CanonicalSchemaObject["type"],
      name: object.name,
      tableName: object.tbl_name,
      sql: object.sql === null ? null : object.sql.replace(/\s+/gu, " ").trim()
    });
  }
  return objects.toSorted((left, right) =>
    left.type.localeCompare(right.type)
    || left.name.localeCompare(right.name)
    || left.tableName.localeCompare(right.tableName)
  );
}

const EXPECTED_V14_SCHEMA_OBJECT_COUNT = 144;
const EXPECTED_V14_SCHEMA_SHA256 =
  "ded4e2c1800dac6e799fa2e42bb8876996ac40852161a0041b6ae41a048b6845";
const EXPECTED_V15_SCHEMA_OBJECT_COUNT = 148;
const EXPECTED_V15_SCHEMA_SHA256 =
  "b69b648fef9e0790a6d3a588be2f2b8f603cb153af57cb253365425eb61b7c37";

export function gatewaySchemaFingerprint(database: SchemaInspectionDatabase): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalGatewaySchema(database)), "utf8")
    .digest("hex");
}

function inspectSchema(
  database: SchemaInspectionDatabase,
  publicIntent: SecureDatabaseFile["intent"],
  effectiveIntent: SecureDatabaseFile["effectiveIntent"],
  migrationLimit: SecureDatabaseFile["migrationLimit"]
): void {
  try {
    const quick = database.prepare("PRAGMA quick_check").all();
    const foreign = database.prepare("PRAGMA foreign_key_check").all();
    const versions = database.prepare(
      "SELECT version FROM schema_migrations ORDER BY version"
    ).all().map((row) => Number((row as { version: unknown }).version));
    const quickValue = quick.length === 1
      ? Object.values(quick[0] as Record<string, unknown>)[0]
      : undefined;
    const latest = versions.at(-1);
    const exactLedger = versions.every((version, index) => version === index + 1);
    if (
      quickValue !== "ok"
      || foreign.length !== 0
      || !Number.isInteger(latest)
      || latest! < 1
      || latest! > migrationLimit
      || !exactLedger
      || (effectiveIntent !== "migrate-create-or-existing" && latest !== 15)
      || (
        publicIntent === "migrate-create-or-existing"
        && latest !== 14
        && latest !== 15
      )
    ) {
      fail("GATEWAY_DATABASE_SCHEMA_INVALID");
    }
    if (publicIntent === "migrate-create-or-existing") {
      const objects = canonicalGatewaySchema(database);
      const expectedCount = latest === 14
        ? EXPECTED_V14_SCHEMA_OBJECT_COUNT
        : EXPECTED_V15_SCHEMA_OBJECT_COUNT;
      const expectedHash = latest === 14
        ? EXPECTED_V14_SCHEMA_SHA256
        : EXPECTED_V15_SCHEMA_SHA256;
      if (
        objects.length !== expectedCount
        || gatewaySchemaFingerprint(database) !== expectedHash
      ) {
        fail("GATEWAY_DATABASE_SCHEMA_INVALID");
      }
    }
    if (effectiveIntent === "provision-existing") {
      const objects = canonicalGatewaySchema(database);
      if (
        objects.length !== EXPECTED_V15_SCHEMA_OBJECT_COUNT
        || gatewaySchemaFingerprint(database) !== EXPECTED_V15_SCHEMA_SHA256
      ) {
        fail("GATEWAY_DATABASE_SCHEMA_INVALID");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_SCHEMA_INVALID") throw error;
    fail("GATEWAY_DATABASE_SCHEMA_INVALID");
  }
}

export function openSecureDatabaseFile(
  path: string,
  request: GatewayDatabaseOpenRequest,
  hooks: DatabaseSecurityHooks = {}
): SecureDatabaseFile {
  const resolved = resolveRequest(request);
  const allowCreate = resolved.effectiveIntent === "migrate-create-or-existing";
  const existedBefore = (() => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  })();
  const protectedPath = capturePath(path, allowCreate, resolved.publicIntent, hooks);
  let database: Database.Database | undefined;
  try {
    if (existedBefore) {
      const before = openDescriptors(protectedPath.databaseDescriptor);
      let inspection: ImmutableDatabase;
      try {
        const Immutable = loadImmutableDatabaseConstructor();
        inspection = new Immutable(`${pathToFileURL(path).href}?immutable=1`, {
          readOnly: true
        });
      } catch {
        return fail("GATEWAY_DATABASE_SCHEMA_INVALID");
      }
      try {
        const descriptor = newConnectionDescriptor(
          before,
          protectedPath.databaseDescriptor
        );
        assertConnectionBound(descriptor, protectedPath);
        assertNoSidecarsOrMarker(path);
        hooks.checkpoint?.("afterReadonlyOpen");
        assertConnectionBound(descriptor, protectedPath);
        assertNoSidecarsOrMarker(path);
        inspectSchema(
          inspection,
          resolved.publicIntent,
          resolved.effectiveIntent,
          resolved.migrationLimit
        );
        assertConnectionBound(descriptor, protectedPath);
        assertNoSidecarsOrMarker(path);
        hooks.checkpoint?.("afterReadonlyValidation");
        assertConnectionBound(descriptor, protectedPath);
        assertNoSidecarsOrMarker(path);
      } finally {
        inspection.close();
      }
    }
    assertProtectedPath(protectedPath);
    assertNoSidecarsOrMarker(path);
    const writableBefore = openDescriptors(protectedPath.databaseDescriptor);
    try {
      database = new Database(path, { fileMustExist: true });
    } catch {
      return fail("GATEWAY_DATABASE_INVALID");
    }
    const descriptor = newConnectionDescriptor(
      writableBefore,
      protectedPath.databaseDescriptor
    );
    const closeDatabase = database.close.bind(database);
    const assertBound = () => {
      assertConnectionBound(descriptor, protectedPath);
    };
    assertBound();
    hooks.checkpoint?.("afterWritableOpen");
    assertBound();
    const leasedDatabase = database;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        closeDatabase();
      } finally {
        try {
          closeSync(protectedPath.databaseDescriptor);
        } finally {
          closeSync(protectedPath.parentDescriptor);
        }
      }
    };
    database = undefined;
    return {
      database: leasedDatabase,
      intent: resolved.publicIntent,
      effectiveIntent: resolved.effectiveIntent,
      migrationLimit: resolved.migrationLimit,
      assertBound,
      close
    };
  } catch (error) {
    try {
      if (database !== undefined) database.close();
    } finally {
      try {
        closeSync(protectedPath.databaseDescriptor);
      } finally {
        closeSync(protectedPath.parentDescriptor);
      }
    }
    throw error;
  }
}
