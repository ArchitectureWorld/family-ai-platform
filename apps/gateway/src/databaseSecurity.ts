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
  expectedDatabaseUid?: number;
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
  parentIdentity: Stats;
  databaseIdentity: Stats;
  expectedParentUid: number;
  expectedDatabaseUid: number;
}

function protectedParent(state: Stats, uid: number): boolean {
  return state.isDirectory()
    && state.uid === uid
    && (state.mode & 0o777) === 0o700;
}

function protectedDatabase(state: Stats, uid: number): boolean {
  return state.isFile()
    && !state.isSymbolicLink()
    && state.uid === uid
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
  if (readdirSync(parent).some((name) => forbidden.has(name))) {
    fail("GATEWAY_DATABASE_INVALID");
  }
}

function assertProtectedPath(protectedPath: ProtectedPath): void {
  try {
    const parentFd = fstatSync(protectedPath.parentDescriptor);
    const parentPath = lstatSync(protectedPath.parentPath);
    const databasePath = lstatSync(protectedPath.path);
    if (
      realpathSync(protectedPath.parentPath) !== protectedPath.parentPath
      || !sameIdentity(parentFd, protectedPath.parentIdentity)
      || !sameIdentity(parentPath, protectedPath.parentIdentity)
      || !protectedParent(parentFd, protectedPath.expectedParentUid)
      || !protectedParent(parentPath, protectedPath.expectedParentUid)
      || !sameIdentity(databasePath, protectedPath.databaseIdentity)
      || !protectedDatabase(databasePath, protectedPath.expectedDatabaseUid)
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
  hooks: DatabaseSecurityHooks
): ProtectedPath {
  const processUid = process.getuid?.();
  if (
    processUid === undefined
    || !isAbsolute(path)
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
  try {
    const parentIdentity = fstatSync(parentDescriptor);
    const expectedParentUid = hooks.expectedParentUid ?? processUid;
    if (
      realpathSync(parentPath) !== parentPath
      || !protectedParent(parentIdentity, expectedParentUid)
    ) {
      fail("GATEWAY_DATABASE_INVALID");
    }
    let databaseIdentity: Stats;
    try {
      databaseIdentity = lstatSync(path);
    } catch (error) {
      if (!allowCreate || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      createDatabase(path, parentDescriptor);
      databaseIdentity = lstatSync(path);
    }
    const protectedPath = {
      path,
      parentPath,
      parentDescriptor,
      parentIdentity,
      databaseIdentity,
      expectedParentUid,
      expectedDatabaseUid: hooks.expectedDatabaseUid ?? processUid
    };
    assertProtectedPath(protectedPath);
    assertNoSidecarsOrMarker(path);
    return protectedPath;
  } catch (error) {
    closeSync(parentDescriptor);
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_INVALID") throw error;
    fail("GATEWAY_DATABASE_INVALID");
  }
}

function openDescriptors(identity: Stats): Set<number> {
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

function newConnectionDescriptor(before: ReadonlySet<number>, identity: Stats): number {
  const descriptor = [...openDescriptors(identity)].find((candidate) => !before.has(candidate));
  if (descriptor === undefined) return fail("GATEWAY_DATABASE_INVALID");
  const state = fstatSync(descriptor);
  if (!state.isFile() || !sameIdentity(state, identity)) {
    return fail("GATEWAY_DATABASE_INVALID");
  }
  return descriptor;
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
  const protectedPath = capturePath(path, allowCreate, hooks);
  if (existedBefore) {
    const before = openDescriptors(protectedPath.databaseIdentity);
    let inspection: ImmutableDatabase;
    try {
      const Immutable = loadImmutableDatabaseConstructor();
      inspection = new Immutable(`${pathToFileURL(path).href}?immutable=1`, {
        readOnly: true
      });
    } catch {
      closeSync(protectedPath.parentDescriptor);
      return fail("GATEWAY_DATABASE_SCHEMA_INVALID");
    }
    try {
      const descriptor = newConnectionDescriptor(before, protectedPath.databaseIdentity);
      assertProtectedPath(protectedPath);
      assertNoSidecarsOrMarker(path);
      fstatSync(descriptor);
      hooks.checkpoint?.("afterReadonlyOpen");
      inspectSchema(
        inspection,
        resolved.publicIntent,
        resolved.effectiveIntent,
        resolved.migrationLimit
      );
      assertProtectedPath(protectedPath);
      assertNoSidecarsOrMarker(path);
      hooks.checkpoint?.("afterReadonlyValidation");
    } catch (error) {
      closeSync(protectedPath.parentDescriptor);
      throw error;
    } finally {
      inspection.close();
    }
  }
  assertProtectedPath(protectedPath);
  assertNoSidecarsOrMarker(path);
  const writableBefore = openDescriptors(protectedPath.databaseIdentity);
  let database: Database.Database;
  try {
    database = new Database(path, { fileMustExist: true });
  } catch {
    closeSync(protectedPath.parentDescriptor);
    return fail("GATEWAY_DATABASE_INVALID");
  }
  try {
    const descriptor = newConnectionDescriptor(writableBefore, protectedPath.databaseIdentity);
    const closeDatabase = database.close.bind(database);
    const assertBound = () => {
      assertProtectedPath(protectedPath);
      const connection = fstatSync(descriptor);
      if (!connection.isFile() || !sameIdentity(connection, protectedPath.databaseIdentity)) {
        fail("GATEWAY_DATABASE_INVALID");
      }
    };
    assertBound();
    hooks.checkpoint?.("afterWritableOpen");
    return {
      database,
      intent: resolved.publicIntent,
      effectiveIntent: resolved.effectiveIntent,
      migrationLimit: resolved.migrationLimit,
      assertBound,
      close: () => {
        try {
          closeDatabase();
        } finally {
          closeSync(protectedPath.parentDescriptor);
        }
      }
    };
  } catch (error) {
    database.close();
    closeSync(protectedPath.parentDescriptor);
    throw error;
  }
}
