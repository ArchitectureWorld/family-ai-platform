import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
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

const EXPECTED_MIGRATIONS = Array.from({ length: 14 }, (_, index) => index + 1);
const EXPECTED_SERVICE_COLUMNS = [
  "service_ref",
  "product",
  "token_hash",
  "status",
  "created_at",
  "revoked_at"
];
const EXPECTED_V14_AUDIT_COLUMNS = [
  "invocation_ref",
  "correlation_ref",
  "product",
  "person_ref",
  "agent_ref",
  "local_session_ref",
  "request_sha256",
  "service_ref",
  "family_ref",
  "actor_context_ref",
  "requested_external_session_ref",
  "timeout_ms",
  "status",
  "error_code",
  "started_at",
  "completed_at"
];

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
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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

function databasePathState(path: string): Stats {
  if (!isAbsolute(path) || path === "/") {
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
  try {
    const state = lstatSync(path);
    if (!state.isFile() || state.isSymbolicLink()) {
      failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
    }
    return state;
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
}

function columnNames(database: Database.Database, table: string): string[] {
  return database.prepare(`PRAGMA table_info(${table})`).all()
    .map(row => String((row as { name: unknown }).name));
}

function validateV14(database: Database.Database): void {
  try {
    const migrations = database.prepare(
      "SELECT version FROM schema_migrations ORDER BY version"
    ).all().map(row => Number((row as { version: unknown }).version));
    const quickCheck = database.pragma("quick_check", { simple: true });
    const foreignKeyViolations = database.pragma("foreign_key_check") as unknown[];
    if (
      JSON.stringify(migrations) !== JSON.stringify(EXPECTED_MIGRATIONS)
      || quickCheck !== "ok"
      || foreignKeyViolations.length !== 0
      || JSON.stringify(columnNames(database, "federation_services"))
        !== JSON.stringify(EXPECTED_SERVICE_COLUMNS)
      || JSON.stringify(columnNames(database, "agent_invocation_audit"))
        !== JSON.stringify(EXPECTED_V14_AUDIT_COLUMNS)
    ) {
      failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
    }
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
  }
}

function openExistingV14Database(path: string): Database.Database {
  const before = databasePathState(path);
  let inspection: Database.Database;
  try {
    inspection = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
  }
  try {
    validateV14(inspection);
  } finally {
    inspection.close();
  }
  const inspected = databasePathState(path);
  if (!sameFileState(before, inspected)) {
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
  let database: Database.Database;
  try {
    database = new Database(path, { fileMustExist: true });
  } catch {
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
  }
  try {
    const opened = databasePathState(path);
    if (!sameFileState(inspected, opened)) {
      failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
    }
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    validateV14(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function provisionFederationService(argv: readonly string[]): {
  status: "ready";
  serviceRef: string;
  product: FederationServiceProduct;
} {
  const input = parseArguments(argv);
  const token = readProtectedFederationCredential(input.credentialFile);
  const database = openExistingV14Database(input.databasePath);
  try {
    const repository = new FederationRepository(database);
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
    const active = repository.authenticateService(token);
    if (
      active?.serviceRef !== input.serviceRef
      || active.product !== input.product
    ) {
      failure("FEDERATION_BOOTSTRAP_SERVICE_REVOKED");
    }
    return {
      status: "ready",
      serviceRef: input.serviceRef,
      product: input.product
    };
  } finally {
    database.close();
  }
}

function runCli(): void {
  try {
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
