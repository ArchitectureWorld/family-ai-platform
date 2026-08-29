import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { FederationRepository, type FederationServiceProduct } from "./federationRepository.js";

type BootstrapErrorCode =
  | "FEDERATION_BOOTSTRAP_ARGUMENTS_INVALID"
  | "FEDERATION_BOOTSTRAP_CREDENTIAL_INVALID"
  | "FEDERATION_BOOTSTRAP_DATABASE_INVALID"
  | "FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID"
  | "FEDERATION_BOOTSTRAP_SERVICE_CONFLICT"
  | "FEDERATION_BOOTSTRAP_SERVICE_REVOKED"
  | "FEDERATION_BOOTSTRAP_FAILED";

class BootstrapError extends Error {
  constructor(readonly code: BootstrapErrorCode) {
    super(code);
  }
}

interface BootstrapArguments {
  serviceRef: string;
  product: FederationServiceProduct;
  credentialFile: string;
  databasePath: string;
}

export type FederationProvisionCheckpoint =
  | "afterReadonlyOpen"
  | "afterReadonlyValidation"
  | "afterWritableOpen"
  | "beforeProvision"
  | "afterProvision"
  | "beforeReturn";

export interface FederationProvisionTestHooks {
  checkpoint?: (stage: FederationProvisionCheckpoint) => void;
  expectedParentUid?: number;
  expectedDatabaseUid?: number;
}

const EXPECTED_MIGRATIONS = Array.from({ length: 14 }, (_, index) => index + 1);
const EXPECTED_V14_SCHEMA_OBJECT_COUNT = 144;
const EXPECTED_V14_SCHEMA_SHA256 =
  "ded4e2c1800dac6e799fa2e42bb8876996ac40852161a0041b6ae41a048b6845";

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
    // node:sqlite is experimental on Node 22. Suppress only its synchronous load warning;
    // operational CLI warnings and errors remain untouched after this require returns.
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

function failure(code: BootstrapErrorCode): never {
  throw new BootstrapError(code);
}

function parseArguments(argv: readonly string[]): BootstrapArguments {
  if (argv.length !== 8) failure("FEDERATION_BOOTSTRAP_ARGUMENTS_INVALID");
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined
      || value === undefined
      || values.has(flag)
      || ![
        "--service-ref",
        "--product",
        "--credential-file",
        "--database"
      ].includes(flag)
    ) {
      failure("FEDERATION_BOOTSTRAP_ARGUMENTS_INVALID");
    }
    values.set(flag, value);
  }
  const serviceRef = values.get("--service-ref");
  const product = values.get("--product");
  const credentialFile = values.get("--credential-file");
  const databasePath = values.get("--database");
  if (
    serviceRef === undefined
    || !/^service:[a-z0-9][a-z0-9._:-]{1,126}$/.test(serviceRef)
    || (product !== "canvas" && product !== "me")
    || credentialFile === undefined
    || databasePath === undefined
  ) {
    failure("FEDERATION_BOOTSTRAP_ARGUMENTS_INVALID");
  }
  return { serviceRef, product, credentialFile, databasePath };
}

function sameFileState(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readBounded(descriptor: number): Buffer {
  const bytes = Buffer.alloc(4097);
  let count = 0;
  while (count < bytes.length) {
    const read = readSync(descriptor, bytes, count, bytes.length - count, count);
    if (read === 0) break;
    count += read;
  }
  return bytes.subarray(0, count);
}

export function readProtectedFederationCredential(
  path: string
): string {
  const expectedUid = process.getuid?.();
  if (!isAbsolute(path) || path === "/" || expectedUid === undefined) {
    failure("FEDERATION_BOOTSTRAP_CREDENTIAL_INVALID");
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    failure("FEDERATION_BOOTSTRAP_CREDENTIAL_INVALID");
  }
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile()
      || before.uid !== expectedUid
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
      || before.size < 16
      || before.size > 4096
    ) {
      failure("FEDERATION_BOOTSTRAP_CREDENTIAL_INVALID");
    }
    const first = readBounded(descriptor);
    const middle = fstatSync(descriptor);
    const second = readBounded(descriptor);
    const after = fstatSync(descriptor);
    if (
      !sameFileState(before, middle)
      || !sameFileState(middle, after)
      || first.length !== before.size
      || !first.equals(second)
      || first.some(byte => byte < 0x21 || byte > 0x7e)
    ) {
      failure("FEDERATION_BOOTSTRAP_CREDENTIAL_INVALID");
    }
    return first.toString("ascii");
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    failure("FEDERATION_BOOTSTRAP_CREDENTIAL_INVALID");
  } finally {
    closeSync(descriptor);
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function protectedParentState(state: Stats, expectedUid: number): boolean {
  return state.isDirectory()
    && state.uid === expectedUid
    && (state.mode & 0o022) === 0;
}

function protectedDatabaseState(state: Stats, expectedUid: number): boolean {
  return state.isFile()
    && state.uid === expectedUid
    && state.nlink === 1
    && (state.mode & 0o022) === 0;
}

function assertNoDatabaseSidecars(path: string): void {
  for (const sidecar of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try {
      lstatSync(sidecar);
      failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
    } catch (error) {
      if (error instanceof BootstrapError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
      }
    }
  }
}

function openFileDescriptorsForIdentity(identity: Stats): Set<number> {
  const descriptors = new Set<number>();
  let entries: string[];
  try {
    entries = readdirSync("/proc/self/fd");
  } catch {
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const descriptor = Number(entry);
    try {
      const state = fstatSync(descriptor);
      if (state.isFile() && sameIdentity(state, identity)) {
        descriptors.add(descriptor);
      }
    } catch {
      // The descriptor used to enumerate /proc may disappear before fstat.
    }
  }
  return descriptors;
}

interface ProtectedDatabasePath {
  path: string;
  parentPath: string;
  parentDescriptor: number;
  parentIdentity: Stats;
  databaseIdentity: Stats;
  expectedParentUid: number;
  expectedDatabaseUid: number;
}

function assertProtectedDatabasePath(protectedPath: ProtectedDatabasePath): void {
  try {
    const descriptorParent = fstatSync(protectedPath.parentDescriptor);
    const pathParent = lstatSync(protectedPath.parentPath);
    const pathDatabase = lstatSync(protectedPath.path);
    if (
      realpathSync(protectedPath.parentPath) !== protectedPath.parentPath
      || !sameIdentity(descriptorParent, protectedPath.parentIdentity)
      || !sameIdentity(pathParent, protectedPath.parentIdentity)
      || !protectedParentState(descriptorParent, protectedPath.expectedParentUid)
      || !protectedParentState(pathParent, protectedPath.expectedParentUid)
      || !sameIdentity(pathDatabase, protectedPath.databaseIdentity)
      || pathDatabase.isSymbolicLink()
      || !protectedDatabaseState(pathDatabase, protectedPath.expectedDatabaseUid)
    ) {
      failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
    }
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
}

function captureProtectedDatabasePath(
  path: string,
  hooks: FederationProvisionTestHooks
): ProtectedDatabasePath {
  const processUid = process.getuid?.();
  if (
    processUid === undefined
    || !isAbsolute(path)
    || path === "/"
    || resolve(path) !== path
  ) {
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
  const parentPath = dirname(path);
  let parentDescriptor: number;
  try {
    parentDescriptor = openSync(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch {
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
  try {
    const parentIdentity = fstatSync(parentDescriptor);
    const databaseIdentity = lstatSync(path);
    const protectedPath = {
      path,
      parentPath,
      parentDescriptor,
      parentIdentity,
      databaseIdentity,
      expectedParentUid: hooks.expectedParentUid ?? processUid,
      expectedDatabaseUid: hooks.expectedDatabaseUid ?? processUid
    };
    assertProtectedDatabasePath(protectedPath);
    return protectedPath;
  } catch (error) {
    closeSync(parentDescriptor);
    if (error instanceof BootstrapError) throw error;
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
}

function assertSqliteConnectionFd(
  descriptor: number,
  identity: Stats
): void {
  try {
    const state = fstatSync(descriptor);
    if (!state.isFile() || !sameIdentity(state, identity)) {
      failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
    }
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
}

function newSqliteConnectionFd(
  beforeOpen: ReadonlySet<number>,
  identity: Stats
): number {
  const descriptor = [...openFileDescriptorsForIdentity(identity)]
    .find(candidate => !beforeOpen.has(candidate));
  if (descriptor === undefined) {
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
  assertSqliteConnectionFd(descriptor, identity);
  return descriptor;
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface CanonicalSchemaObject {
  type: "index" | "table" | "trigger" | "view";
  name: string;
  tableName: string;
  sql: string | null;
}

function compareSchemaObjects(
  left: CanonicalSchemaObject,
  right: CanonicalSchemaObject
): number {
  for (const key of ["type", "name", "tableName"] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

function canonicalV14Schema(
  database: SchemaInspectionDatabase
): CanonicalSchemaObject[] {
  const applicationTypes = new Set<CanonicalSchemaObject["type"]>([
    "index",
    "table",
    "trigger",
    "view"
  ]);
  const objects: CanonicalSchemaObject[] = [];
  for (const row of database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master"
  ).all()) {
    const object = row as Record<string, unknown>;
    if (
      !exactJson(Object.keys(object).toSorted(), ["name", "sql", "tbl_name", "type"])
      || typeof object.type !== "string"
      || typeof object.name !== "string"
      || typeof object.tbl_name !== "string"
      || (object.sql !== null && typeof object.sql !== "string")
    ) {
      failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
    }
    const type = object.type;
    const name = object.name;
    if (name.startsWith("sqlite_") && !name.startsWith("sqlite_autoindex_")) {
      continue;
    }
    if (!applicationTypes.has(type as CanonicalSchemaObject["type"])) {
      failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
    }
    objects.push({
      type: object.type as CanonicalSchemaObject["type"],
      name: object.name,
      tableName: object.tbl_name,
      sql: object.sql === null
        ? null
        : String(object.sql).replace(/\s+/g, " ").trim()
    });
  }
  return objects.toSorted(compareSchemaObjects);
}

function exactV14SchemaFingerprint(database: SchemaInspectionDatabase): boolean {
  const objects = canonicalV14Schema(database);
  if (objects.length !== EXPECTED_V14_SCHEMA_OBJECT_COUNT) return false;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(objects), "utf8")
    .digest("hex");
  return fingerprint === EXPECTED_V14_SCHEMA_SHA256;
}

function validateV14(database: SchemaInspectionDatabase): void {
  try {
    const migrations = database.prepare(
      "SELECT version FROM schema_migrations ORDER BY version"
    ).all().map(row => Number((row as { version: unknown }).version));
    const quickCheck = database.prepare("PRAGMA quick_check").all();
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    const quickCheckValue = quickCheck.length === 1
      ? Object.values(quickCheck[0] as Record<string, unknown>)[0]
      : undefined;
    if (!exactJson(migrations, EXPECTED_MIGRATIONS)
      || quickCheckValue !== "ok"
      || foreignKeyViolations.length !== 0) {
      failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
    }
    if (!exactV14SchemaFingerprint(database)) {
      failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
    }
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
  }
}

interface ProtectedGatewayDatabase {
  database: Database.Database;
  assertBound: () => void;
  checkpoint: (stage: FederationProvisionCheckpoint) => void;
  close: () => void;
}

function prepareOfflineDeleteJournal(database: Database.Database): void {
  try {
    const [checkpoint] = database.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const journalMode = database.pragma("journal_mode = DELETE", {
      simple: true
    });
    if (
      checkpoint === undefined
      || checkpoint.busy !== 0
      || checkpoint.log !== checkpoint.checkpointed
      || journalMode !== "delete"
    ) {
      failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
    }
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
}

function openExistingV14Database(
  path: string,
  hooks: FederationProvisionTestHooks
): ProtectedGatewayDatabase {
  const protectedPath = captureProtectedDatabasePath(path, hooks);
  let readonlyBaseline: Set<number>;
  try {
    assertNoDatabaseSidecars(path);
    readonlyBaseline = openFileDescriptorsForIdentity(
      protectedPath.databaseIdentity
    );
  } catch (error) {
    closeSync(protectedPath.parentDescriptor);
    throw error;
  }
  let inspection: ImmutableDatabase;
  try {
    const ImmutableDatabaseSync = loadImmutableDatabaseConstructor();
    inspection = new ImmutableDatabaseSync(
      `${pathToFileURL(path).href}?immutable=1`,
      { readOnly: true }
    );
  } catch {
    closeSync(protectedPath.parentDescriptor);
    failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
  }
  try {
    const inspectionDescriptor = newSqliteConnectionFd(
      readonlyBaseline,
      protectedPath.databaseIdentity
    );
    assertProtectedDatabasePath(protectedPath);
    assertNoDatabaseSidecars(path);
    assertSqliteConnectionFd(inspectionDescriptor, protectedPath.databaseIdentity);
    hooks.checkpoint?.("afterReadonlyOpen");
    assertProtectedDatabasePath(protectedPath);
    assertNoDatabaseSidecars(path);
    assertSqliteConnectionFd(inspectionDescriptor, protectedPath.databaseIdentity);
    validateV14(inspection);
    hooks.checkpoint?.("afterReadonlyValidation");
    assertProtectedDatabasePath(protectedPath);
    assertNoDatabaseSidecars(path);
    assertSqliteConnectionFd(inspectionDescriptor, protectedPath.databaseIdentity);
  } catch (error) {
    closeSync(protectedPath.parentDescriptor);
    throw error;
  } finally {
    inspection.close();
  }
  let writableBaseline: Set<number>;
  try {
    assertProtectedDatabasePath(protectedPath);
    assertNoDatabaseSidecars(path);
    writableBaseline = openFileDescriptorsForIdentity(
      protectedPath.databaseIdentity
    );
  } catch (error) {
    closeSync(protectedPath.parentDescriptor);
    throw error;
  }
  let database: Database.Database;
  try {
    database = new Database(path, { fileMustExist: true });
  } catch {
    closeSync(protectedPath.parentDescriptor);
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
  try {
    const connectionDescriptor = newSqliteConnectionFd(
      writableBaseline,
      protectedPath.databaseIdentity
    );
    const assertBound = () => {
      assertProtectedDatabasePath(protectedPath);
      assertSqliteConnectionFd(connectionDescriptor, protectedPath.databaseIdentity);
    };
    assertBound();
    hooks.checkpoint?.("afterWritableOpen");
    assertBound();
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 250");
    validateV14(database);
    assertBound();
    return {
      database,
      assertBound,
      checkpoint: stage => hooks.checkpoint?.(stage),
      close: () => {
        try {
          database.close();
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

export function provisionFederationService(
  argv: readonly string[],
  hooks: FederationProvisionTestHooks = {}
): {
  status: "ready";
  serviceRef: string;
  product: FederationServiceProduct;
} {
  const input = parseArguments(argv);
  const token = readProtectedFederationCredential(input.credentialFile);
  const protectedDatabase = openExistingV14Database(input.databasePath, hooks);
  const { database } = protectedDatabase;
  let committed = false;
  try {
    protectedDatabase.assertBound();
    prepareOfflineDeleteJournal(database);
    protectedDatabase.assertBound();
    try {
      database.exec("BEGIN EXCLUSIVE");
    } catch {
      failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
    }
    protectedDatabase.assertBound();
    const repository = new FederationRepository(database);
    protectedDatabase.checkpoint("beforeProvision");
    protectedDatabase.assertBound();
    try {
      repository.provisionService({
        serviceRef: input.serviceRef,
        product: input.product,
        token
      });
    } catch (error) {
      if (error instanceof Error && error.message === "FEDERATION_SERVICE_CONFLICT") {
        failure("FEDERATION_BOOTSTRAP_SERVICE_CONFLICT");
      }
      if (error instanceof Error && error.message === "FEDERATION_SERVICE_INVALID") {
        failure("FEDERATION_BOOTSTRAP_ARGUMENTS_INVALID");
      }
      failure("FEDERATION_BOOTSTRAP_FAILED");
    }
    protectedDatabase.checkpoint("afterProvision");
    protectedDatabase.assertBound();
    const active = repository.authenticateService(token);
    if (
      active?.serviceRef !== input.serviceRef
      || active.product !== input.product
    ) {
      failure("FEDERATION_BOOTSTRAP_SERVICE_REVOKED");
    }
    protectedDatabase.checkpoint("beforeReturn");
    protectedDatabase.assertBound();
    database.exec("COMMIT");
    committed = true;
    protectedDatabase.assertBound();
    return {
      status: "ready",
      serviceRef: input.serviceRef,
      product: input.product
    };
  } finally {
    try {
      if (!committed && database.inTransaction) {
        database.exec("ROLLBACK");
      }
    } finally {
      protectedDatabase.close();
    }
  }
}

function runCli(): void {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--self-check") {
      const database = new Database(":memory:");
      try {
        const result = database.prepare("SELECT 1 AS ready").get() as {
          ready: number;
        };
        if (result.ready !== 1) failure("FEDERATION_BOOTSTRAP_FAILED");
      } finally {
        database.close();
      }
      return;
    }
    const result = provisionFederationService(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof BootstrapError
      ? error.code
      : "FEDERATION_BOOTSTRAP_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  runCli();
}
