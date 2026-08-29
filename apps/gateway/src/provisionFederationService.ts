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
interface ExpectedColumn {
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: number;
}

const EXPECTED_COLUMNS: Record<string, ExpectedColumn[]> = {
  federation_services: [
    { name: "service_ref", type: "TEXT", notnull: 0, pk: 1 },
    { name: "product", type: "TEXT", notnull: 1, pk: 0 },
    { name: "token_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "revoked_at", type: "TEXT", notnull: 0, pk: 0 }
  ],
  agent_invocation_audit: [
    { name: "invocation_ref", type: "TEXT", notnull: 0, pk: 1 },
    { name: "correlation_ref", type: "TEXT", notnull: 1, pk: 0 },
    { name: "product", type: "TEXT", notnull: 1, pk: 0 },
    { name: "person_ref", type: "TEXT", notnull: 1, pk: 0 },
    { name: "agent_ref", type: "TEXT", notnull: 1, pk: 0 },
    { name: "local_session_ref", type: "TEXT", notnull: 1, pk: 0 },
    { name: "request_sha256", type: "TEXT", notnull: 0, pk: 0 },
    { name: "service_ref", type: "TEXT", notnull: 0, pk: 0 },
    { name: "family_ref", type: "TEXT", notnull: 0, pk: 0 },
    { name: "actor_context_ref", type: "TEXT", notnull: 0, pk: 0 },
    { name: "requested_external_session_ref", type: "TEXT", notnull: 0, pk: 0 },
    { name: "timeout_ms", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, pk: 0 },
    { name: "error_code", type: "TEXT", notnull: 0, pk: 0 },
    { name: "started_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "completed_at", type: "TEXT", notnull: 0, pk: 0 }
  ],
  federation_session_invocation_claims: [
    { name: "product", type: "TEXT", notnull: 1, pk: 1 },
    { name: "family_ref", type: "TEXT", notnull: 1, pk: 2 },
    { name: "person_ref", type: "TEXT", notnull: 1, pk: 3 },
    { name: "agent_ref", type: "TEXT", notnull: 1, pk: 4 },
    { name: "local_session_ref", type: "TEXT", notnull: 1, pk: 5 },
    { name: "invocation_ref", type: "TEXT", notnull: 1, pk: 0 },
    { name: "service_ref", type: "TEXT", notnull: 1, pk: 0 },
    { name: "claimed_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "lease_expires_at", type: "TEXT", notnull: 1, pk: 0 }
  ],
  federation_session_bindings: [
    { name: "product", type: "TEXT", notnull: 1, pk: 1 },
    { name: "family_ref", type: "TEXT", notnull: 1, pk: 2 },
    { name: "person_ref", type: "TEXT", notnull: 1, pk: 3 },
    { name: "agent_ref", type: "TEXT", notnull: 1, pk: 4 },
    { name: "local_session_ref", type: "TEXT", notnull: 1, pk: 5 },
    { name: "external_session_ref", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 }
  ]
};

interface ExpectedIndex {
  name: string;
  unique: 0 | 1;
  origin: "c" | "pk" | "u";
  partial: 0 | 1;
  columns: string[];
}

const EXPECTED_INDEXES: Record<string, ExpectedIndex[]> = {
  federation_services: [
    {
      name: "sqlite_autoindex_federation_services_2",
      unique: 1,
      origin: "u",
      partial: 0,
      columns: ["token_hash"]
    },
    {
      name: "sqlite_autoindex_federation_services_1",
      unique: 1,
      origin: "pk",
      partial: 0,
      columns: ["service_ref"]
    }
  ],
  agent_invocation_audit: [
    {
      name: "agent_invocation_audit_scope_idx",
      unique: 0,
      origin: "c",
      partial: 0,
      columns: [
        "service_ref", "product", "family_ref", "person_ref", "agent_ref",
        "local_session_ref", "invocation_ref"
      ]
    },
    {
      name: "sqlite_autoindex_agent_invocation_audit_1",
      unique: 1,
      origin: "pk",
      partial: 0,
      columns: ["invocation_ref"]
    }
  ],
  federation_session_invocation_claims: [
    {
      name: "federation_session_claim_expiry_idx",
      unique: 0,
      origin: "c",
      partial: 0,
      columns: ["lease_expires_at"]
    },
    {
      name: "sqlite_autoindex_federation_session_invocation_claims_2",
      unique: 1,
      origin: "pk",
      partial: 0,
      columns: ["product", "family_ref", "person_ref", "agent_ref", "local_session_ref"]
    },
    {
      name: "sqlite_autoindex_federation_session_invocation_claims_1",
      unique: 1,
      origin: "u",
      partial: 0,
      columns: ["invocation_ref"]
    }
  ],
  federation_session_bindings: [
    {
      name: "sqlite_autoindex_federation_session_bindings_2",
      unique: 1,
      origin: "pk",
      partial: 0,
      columns: ["product", "family_ref", "person_ref", "agent_ref", "local_session_ref"]
    },
    {
      name: "sqlite_autoindex_federation_session_bindings_1",
      unique: 1,
      origin: "u",
      partial: 0,
      columns: ["external_session_ref"]
    }
  ]
};

interface ExpectedForeignKey {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

const EXPECTED_FOREIGN_KEYS: Record<string, ExpectedForeignKey[]> = {
  federation_services: [],
  agent_invocation_audit: [],
  federation_session_invocation_claims: [
    { table: "federation_services", from: "service_ref", to: "service_ref", on_delete: "NO ACTION" },
    { table: "agent_invocation_audit", from: "invocation_ref", to: "invocation_ref", on_delete: "CASCADE" },
    { table: "agents", from: "agent_ref", to: "agent_ref", on_delete: "NO ACTION" },
    { table: "persons", from: "person_ref", to: "person_ref", on_delete: "NO ACTION" },
    { table: "families", from: "family_ref", to: "family_ref", on_delete: "NO ACTION" }
  ],
  federation_session_bindings: [
    { table: "agents", from: "agent_ref", to: "agent_ref", on_delete: "NO ACTION" },
    { table: "persons", from: "person_ref", to: "person_ref", on_delete: "NO ACTION" },
    { table: "families", from: "family_ref", to: "family_ref", on_delete: "NO ACTION" }
  ]
};

const EXPECTED_CRITICAL_SQL: Record<string, string[]> = {
  federation_services: [
    "product TEXT NOT NULL CHECK(product IN ('canvas', 'me'))",
    "token_hash TEXT NOT NULL UNIQUE",
    "status TEXT NOT NULL CHECK(status IN ('active', 'revoked'))"
  ],
  agent_invocation_audit: [
    "status TEXT NOT NULL CHECK(status IN ('accepted', 'succeeded', 'failed'))",
    "request_sha256 IS NULL AND service_ref IS NULL AND family_ref IS NULL AND actor_context_ref IS NULL AND requested_external_session_ref IS NULL AND timeout_ms IS NULL",
    "request_sha256 IS NOT NULL AND length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*' AND service_ref IS NOT NULL AND family_ref IS NOT NULL AND actor_context_ref IS NOT NULL AND timeout_ms BETWEEN 1000 AND 300000",
    "(status = 'accepted' AND error_code IS NULL AND completed_at IS NULL) OR (status = 'succeeded' AND error_code IS NULL AND completed_at IS NOT NULL) OR (status = 'failed' AND error_code IS NOT NULL AND completed_at IS NOT NULL)"
  ],
  federation_session_invocation_claims: [
    "product TEXT NOT NULL CHECK(product IN ('canvas', 'me'))",
    "invocation_ref TEXT NOT NULL UNIQUE REFERENCES agent_invocation_audit(invocation_ref) ON DELETE CASCADE",
    "service_ref TEXT NOT NULL REFERENCES federation_services(service_ref)",
    "PRIMARY KEY(product, family_ref, person_ref, agent_ref, local_session_ref)"
  ],
  federation_session_bindings: [
    "product TEXT NOT NULL CHECK(product IN ('canvas', 'me'))",
    "external_session_ref TEXT NOT NULL UNIQUE",
    "PRIMARY KEY(product, family_ref, person_ref, agent_ref, local_session_ref)"
  ]
};

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

function tableColumns(database: Database.Database, table: string): ExpectedColumn[] {
  return database.prepare(`PRAGMA table_info(${table})`).all().map(row => {
    const column = row as Record<string, unknown>;
    return {
      name: String(column.name),
      type: String(column.type),
      notnull: Number(column.notnull) as 0 | 1,
      pk: Number(column.pk)
    };
  });
}

function tableIndexes(database: Database.Database, table: string): ExpectedIndex[] {
  return database.prepare(`PRAGMA index_list(${table})`).all().map(row => {
    const index = row as Record<string, unknown>;
    const name = String(index.name);
    return {
      name,
      unique: Number(index.unique) as 0 | 1,
      origin: String(index.origin) as ExpectedIndex["origin"],
      partial: Number(index.partial) as 0 | 1,
      columns: database.prepare(`PRAGMA index_info(${name})`).all()
        .map(column => String((column as { name: unknown }).name))
    };
  }).toSorted((left, right) => left.name.localeCompare(right.name));
}

function tableForeignKeys(
  database: Database.Database,
  table: string
): ExpectedForeignKey[] {
  return database.prepare(`PRAGMA foreign_key_list(${table})`).all().map(row => {
    const key = row as Record<string, unknown>;
    return {
      table: String(key.table),
      from: String(key.from),
      to: String(key.to),
      on_delete: String(key.on_delete)
    };
  }).toSorted((left, right) => left.from.localeCompare(right.from));
}

function canonicalTableSql(database: Database.Database, table: string): string {
  const row = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table) as { sql: unknown } | undefined;
  return typeof row?.sql === "string"
    ? row.sql.replace(/\s+/g, " ").trim()
    : "";
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateV14(database: Database.Database): void {
  try {
    const migrations = database.prepare(
      "SELECT version FROM schema_migrations ORDER BY version"
    ).all().map(row => Number((row as { version: unknown }).version));
    const quickCheck = database.pragma("quick_check", { simple: true });
    const foreignKeyViolations = database.pragma("foreign_key_check") as unknown[];
    if (!exactJson(migrations, EXPECTED_MIGRATIONS)
      || quickCheck !== "ok"
      || foreignKeyViolations.length !== 0) {
      failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
    }
    for (const [table, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
      const expectedIndexes = EXPECTED_INDEXES[table];
      const expectedForeignKeys = EXPECTED_FOREIGN_KEYS[table];
      const criticalSql = EXPECTED_CRITICAL_SQL[table];
      if (
        expectedIndexes === undefined
        || expectedForeignKeys === undefined
        || criticalSql === undefined
        || !exactJson(tableColumns(database, table), expectedColumns)
        || !exactJson(
          tableIndexes(database, table),
          expectedIndexes.toSorted((left, right) => left.name.localeCompare(right.name))
        )
        || !exactJson(
          tableForeignKeys(database, table),
          expectedForeignKeys.toSorted((left, right) => left.from.localeCompare(right.from))
        )
      ) {
        failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
      }
      const sql = canonicalTableSql(database, table);
      if (criticalSql.some(fragment => !sql.includes(fragment))) {
        failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
      }
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
  const readonlyBaseline = openFileDescriptorsForIdentity(
    protectedPath.databaseIdentity
  );
  let inspection: Database.Database;
  try {
    inspection = new Database(path, { readonly: true, fileMustExist: true });
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
    assertSqliteConnectionFd(inspectionDescriptor, protectedPath.databaseIdentity);
    hooks.checkpoint?.("afterReadonlyOpen");
    assertProtectedDatabasePath(protectedPath);
    assertSqliteConnectionFd(inspectionDescriptor, protectedPath.databaseIdentity);
    validateV14(inspection);
    hooks.checkpoint?.("afterReadonlyValidation");
    assertProtectedDatabasePath(protectedPath);
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
