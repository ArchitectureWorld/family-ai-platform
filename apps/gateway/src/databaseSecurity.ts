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
  type BigIntStats,
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
  | "beforeDatabaseCreate"
  | "afterDatabaseCreate"
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

function assertNoSidecars(path: string): void {
  const parent = dirname(path);
  const file = basename(path);
  const forbidden = new Set([
    `${file}-wal`,
    `${file}-shm`,
    `${file}-journal`
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

function assertNoSidecarsOrMarker(path: string): void {
  assertNoSidecars(path);
  try {
    if (readdirSync(dirname(path)).includes(`.${basename(path)}.wal-recovery`)) {
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

function openDatabaseProof(
  path: string,
  parentDescriptor: number,
  allowCreate: boolean,
  hooks: DatabaseSecurityHooks
): { databaseDescriptor: number; created: boolean } {
  if (!allowCreate) {
    try {
      return {
        databaseDescriptor: openSync(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        ),
        created: false
      };
    } catch {
      return fail("GATEWAY_DATABASE_INVALID");
    }
  }
  hooks.checkpoint?.("beforeDatabaseCreate");
  let databaseDescriptor: number;
  try {
    databaseDescriptor = openSync(
      path,
      constants.O_RDWR
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
      0o600
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return fail("GATEWAY_DATABASE_INVALID");
    }
    try {
      return {
        databaseDescriptor: openSync(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        ),
        created: false
      };
    } catch {
      return fail("GATEWAY_DATABASE_INVALID");
    }
  }
  try {
    fsyncSync(databaseDescriptor);
    fsyncSync(parentDescriptor);
    hooks.checkpoint?.("afterDatabaseCreate");
    return { databaseDescriptor, created: true };
  } catch (error) {
    closeSync(databaseDescriptor);
    throw error;
  }
}

function capturePath(
  path: string,
  allowCreate: boolean,
  publicIntent: GatewayDatabaseIntent,
  hooks: DatabaseSecurityHooks
): { protectedPath: ProtectedPath; created: boolean } {
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
    const opened = openDatabaseProof(path, parentDescriptor, allowCreate, hooks);
    databaseDescriptor = opened.databaseDescriptor;
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
    return { protectedPath, created: opened.created };
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

const EXPECTED_V10_SCHEMA_SHAPES = new Set([
  "119:cc8e64042ee601899651f85c42fbb54d1a5278ff585ac54b4c370e98be09dd9b",
  // Existing candidate Family data includes the separately-installed domain-event tables.
  "141:9406e95806a4d73703014fe9308cc402c86b7d84464f05de96ce8fe306acc928"
]);
const EXPECTED_V14_SCHEMA_OBJECT_COUNT = 144;
const EXPECTED_V14_SCHEMA_SHA256 =
  "ded4e2c1800dac6e799fa2e42bb8876996ac40852161a0041b6ae41a048b6845";
const EXPECTED_V15_SCHEMA_OBJECT_COUNT = 148;
const EXPECTED_V15_SCHEMA_SHA256 =
  "b69b648fef9e0790a6d3a588be2f2b8f603cb153af57cb253365425eb61b7c37";
const EXPECTED_V15_SCHEMA_SHAPES = new Set([
  `${EXPECTED_V15_SCHEMA_OBJECT_COUNT}:${EXPECTED_V15_SCHEMA_SHA256}`,
  // Existing candidate data retains the separately-installed domain-event tables.
  "170:68e191f479a563398c5139347697940900d6b675cb0dcf26e6e66815ab5114ab"
]);

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
        && !(
          latest === 10
          || latest === 14
          || latest === 15
        )
      )
    ) {
      fail("GATEWAY_DATABASE_SCHEMA_INVALID");
    }
    if (publicIntent === "migrate-create-or-existing") {
      const objects = canonicalGatewaySchema(database);
      const fingerprint = gatewaySchemaFingerprint(database);
      const validLegacyV10 = latest === 10 && EXPECTED_V10_SCHEMA_SHAPES.has(`${objects.length}:${fingerprint}`);
      const expectedCount = latest === 14 ? EXPECTED_V14_SCHEMA_OBJECT_COUNT : EXPECTED_V15_SCHEMA_OBJECT_COUNT;
      const expectedHash = latest === 14 ? EXPECTED_V14_SCHEMA_SHA256 : EXPECTED_V15_SCHEMA_SHA256;
      const validV15 = latest === 15 && EXPECTED_V15_SCHEMA_SHAPES.has(`${objects.length}:${fingerprint}`);
      if (
        (latest === 10 && !validLegacyV10)
        || (latest === 15 && !validV15)
        || (latest !== 10 && latest !== 15 && (objects.length !== expectedCount || fingerprint !== expectedHash))
      ) {
        fail("GATEWAY_DATABASE_SCHEMA_INVALID");
      }
    }
    if (effectiveIntent === "provision-existing") {
      const objects = canonicalGatewaySchema(database);
      if (!EXPECTED_V15_SCHEMA_SHAPES.has(`${objects.length}:${gatewaySchemaFingerprint(database)}`)) {
        fail("GATEWAY_DATABASE_SCHEMA_INVALID");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_SCHEMA_INVALID") throw error;
    fail("GATEWAY_DATABASE_SCHEMA_INVALID");
  }
}

export interface ImmutableGatewayV15ValidationInput {
  databasePath: string;
  parentProofFd: number;
  databaseProofFd: number;
  expectedParentIdentity: { dev: bigint; ino: bigint };
  expectedDatabaseIdentity: { dev: bigint; ino: bigint };
}

export interface ImmutableGatewayV15ValidatorTestHooks {
  connectionDescriptor?: (descriptor: number) => void;
  afterConnectionClose?: (descriptor: number) => void;
}

interface ImmutableValidatorProtectedPath {
  path: string;
  parentPath: string;
  parentDescriptor: number;
  databaseDescriptor: number;
  expectedParentIdentity: ImmutableGatewayV15ValidationInput["expectedParentIdentity"];
  expectedDatabaseIdentity: ImmutableGatewayV15ValidationInput["expectedDatabaseIdentity"];
}

function sameBigIntIdentity(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: { dev: bigint; ino: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function protectedImmutableValidatorParent(state: BigIntStats): boolean {
  return state.isDirectory()
    && state.uid === BigInt(GATEWAY_APPLICATION_UID)
    && state.gid === BigInt(GATEWAY_APPLICATION_GID)
    && (state.mode & 0o777n) === 0o700n;
}

function protectedImmutableValidatorDatabase(state: BigIntStats): boolean {
  return state.isFile()
    && !state.isSymbolicLink()
    && state.uid === BigInt(GATEWAY_APPLICATION_UID)
    && state.gid === BigInt(GATEWAY_APPLICATION_GID)
    && state.nlink === 1n
    && (state.mode & 0o777n) === 0o600n;
}

function assertImmutableValidatorPathAndProof(
  protectedPath: ImmutableValidatorProtectedPath
): void {
  try {
    const parentProof = fstatSync(protectedPath.parentDescriptor, { bigint: true });
    const parentPath = lstatSync(protectedPath.parentPath, { bigint: true });
    const databaseProof = fstatSync(protectedPath.databaseDescriptor, { bigint: true });
    const databasePath = lstatSync(protectedPath.path, { bigint: true });
    if (
      realpathSync(protectedPath.parentPath) !== protectedPath.parentPath
      || !sameBigIntIdentity(parentProof, protectedPath.expectedParentIdentity)
      || !sameBigIntIdentity(parentPath, protectedPath.expectedParentIdentity)
      || !protectedImmutableValidatorParent(parentProof)
      || !protectedImmutableValidatorParent(parentPath)
      || !sameBigIntIdentity(databaseProof, protectedPath.expectedDatabaseIdentity)
      || !sameBigIntIdentity(databasePath, protectedPath.expectedDatabaseIdentity)
      || !protectedImmutableValidatorDatabase(databaseProof)
      || !protectedImmutableValidatorDatabase(databasePath)
    ) {
      fail("GATEWAY_DATABASE_SCHEMA_INVALID");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_SCHEMA_INVALID") {
      throw error;
    }
    fail("GATEWAY_DATABASE_SCHEMA_INVALID");
  }
}

function immutableValidatorOpenDescriptors(proofDescriptor: number): Set<number> {
  const proof = fstatSync(proofDescriptor, { bigint: true });
  const descriptors = new Set<number>();
  for (const name of readdirSync("/proc/self/fd")) {
    if (!/^\d+$/u.test(name)) continue;
    const descriptor = Number(name);
    try {
      const state = fstatSync(descriptor, { bigint: true });
      if (state.isFile() && sameBigIntIdentity(state, proof)) {
        descriptors.add(descriptor);
      }
    } catch {
      // The proc enumeration descriptor may disappear before inspection.
    }
  }
  return descriptors;
}

function newImmutableValidatorConnectionDescriptor(
  before: ReadonlySet<number>,
  protectedPath: ImmutableValidatorProtectedPath
): number {
  const candidates = [...immutableValidatorOpenDescriptors(protectedPath.databaseDescriptor)]
    .filter((candidate) => !before.has(candidate));
  if (candidates.length !== 1) return fail("GATEWAY_DATABASE_SCHEMA_INVALID");
  const descriptor = candidates[0]!;
  const connection = fstatSync(descriptor, { bigint: true });
  const proof = fstatSync(protectedPath.databaseDescriptor, { bigint: true });
  if (
    !connection.isFile()
    || !sameBigIntIdentity(connection, proof)
    || !sameBigIntIdentity(connection, protectedPath.expectedDatabaseIdentity)
  ) {
    return fail("GATEWAY_DATABASE_SCHEMA_INVALID");
  }
  return descriptor;
}

function assertImmutableValidatorConnectionBound(
  descriptor: number,
  protectedPath: ImmutableValidatorProtectedPath
): void {
  try {
    assertImmutableValidatorPathAndProof(protectedPath);
    const connection = fstatSync(descriptor, { bigint: true });
    const proof = fstatSync(protectedPath.databaseDescriptor, { bigint: true });
    if (
      !connection.isFile()
      || !sameBigIntIdentity(connection, proof)
      || !sameBigIntIdentity(connection, protectedPath.expectedDatabaseIdentity)
    ) {
      fail("GATEWAY_DATABASE_SCHEMA_INVALID");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_SCHEMA_INVALID") {
      throw error;
    }
    fail("GATEWAY_DATABASE_SCHEMA_INVALID");
  }
}

function assertImmutableValidatorConnectionClosed(
  descriptor: number,
  before: ReadonlySet<number>,
  protectedPath: ImmutableValidatorProtectedPath
): void {
  try {
    fstatSync(descriptor, { bigint: true });
    fail("GATEWAY_DATABASE_SCHEMA_INVALID");
  } catch (error) {
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_SCHEMA_INVALID") {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "EBADF") {
      fail("GATEWAY_DATABASE_SCHEMA_INVALID");
    }
  }
  assertImmutableValidatorPathAndProof(protectedPath);
  const after = immutableValidatorOpenDescriptors(protectedPath.databaseDescriptor);
  if (
    after.size !== before.size
    || [...before].some((candidate) => !after.has(candidate))
  ) {
    fail("GATEWAY_DATABASE_SCHEMA_INVALID");
  }
}

function validateImmutableGatewayV15DatabaseWithHooks(
  input: ImmutableGatewayV15ValidationInput,
  hooks: ImmutableGatewayV15ValidatorTestHooks
): void {
  if (
    !isAbsolute(input.databasePath)
    || input.databasePath === "/"
    || resolve(input.databasePath) !== input.databasePath
    || dirname(input.databasePath) === input.databasePath
  ) {
    return fail("GATEWAY_DATABASE_SCHEMA_INVALID");
  }
  const protectedPath: ImmutableValidatorProtectedPath = {
    path: input.databasePath,
    parentPath: dirname(input.databasePath),
    parentDescriptor: input.parentProofFd,
    databaseDescriptor: input.databaseProofFd,
    expectedParentIdentity: input.expectedParentIdentity,
    expectedDatabaseIdentity: input.expectedDatabaseIdentity
  };
  try {
    assertImmutableValidatorPathAndProof(protectedPath);
    assertNoSidecars(input.databasePath);
    const before = immutableValidatorOpenDescriptors(input.databaseProofFd);
    const Immutable = loadImmutableDatabaseConstructor();
    const inspection = new Immutable(
      `${pathToFileURL(input.databasePath).href}?immutable=1`,
      { readOnly: true }
    );
    let connectionDescriptor: number | undefined;
    try {
      connectionDescriptor = newImmutableValidatorConnectionDescriptor(before, protectedPath);
      assertImmutableValidatorConnectionBound(connectionDescriptor, protectedPath);
      hooks.connectionDescriptor?.(connectionDescriptor);
      inspectSchema(inspection, "provision-existing", "provision-existing", 15);
      assertImmutableValidatorConnectionBound(connectionDescriptor, protectedPath);
      assertNoSidecars(input.databasePath);
    } finally {
      inspection.close();
    }
    if (connectionDescriptor === undefined) fail("GATEWAY_DATABASE_SCHEMA_INVALID");
    hooks.afterConnectionClose?.(connectionDescriptor);
    assertImmutableValidatorConnectionClosed(connectionDescriptor, before, protectedPath);
    assertNoSidecars(input.databasePath);
  } catch (error) {
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_SCHEMA_INVALID") throw error;
    fail("GATEWAY_DATABASE_SCHEMA_INVALID");
  }
}

export function validateImmutableGatewayV15Database(
  input: ImmutableGatewayV15ValidationInput
): void {
  validateImmutableGatewayV15DatabaseWithHooks(input, {});
}

export function validateImmutableGatewayV15DatabaseForTest(
  input: ImmutableGatewayV15ValidationInput,
  hooks: ImmutableGatewayV15ValidatorTestHooks
): void {
  if (process.env.NODE_ENV !== "test") fail("GATEWAY_DATABASE_SCHEMA_INVALID");
  validateImmutableGatewayV15DatabaseWithHooks(input, hooks);
}

export function openSecureDatabaseFile(
  path: string,
  request: GatewayDatabaseOpenRequest,
  hooks: DatabaseSecurityHooks = {}
): SecureDatabaseFile {
  const resolved = resolveRequest(request);
  const allowCreate = resolved.effectiveIntent === "migrate-create-or-existing";
  const captured = capturePath(path, allowCreate, resolved.publicIntent, hooks);
  const { protectedPath } = captured;
  let database: Database.Database | undefined;
  try {
    if (!captured.created) {
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
