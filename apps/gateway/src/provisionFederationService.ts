import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  type Stats
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { openGatewayDatabase } from "./database.js";
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

function openExistingV15Database(
  path: string,
  hooks: FederationProvisionTestHooks
): ProtectedGatewayDatabase {
  try {
    const lease = openGatewayDatabase(
      path,
      { intent: "provision-existing" },
      {
        ...(hooks.expectedParentUid === undefined
          ? {}
          : { expectedParentUid: hooks.expectedParentUid }),
        ...(hooks.expectedDatabaseUid === undefined
          ? {}
          : { expectedDatabaseUid: hooks.expectedDatabaseUid }),
        checkpoint: stage => {
          if (stage !== "beforeMigrationCommit") hooks.checkpoint?.(stage);
        }
      }
    );
    return {
      database: lease.database,
      assertBound: () => {
        try {
          lease.assertBound();
        } catch {
          failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
        }
      },
      checkpoint: stage => hooks.checkpoint?.(stage),
      close: lease.close
    };
  } catch (error) {
    if (error instanceof Error && error.message === "GATEWAY_DATABASE_SCHEMA_INVALID") {
      failure("FEDERATION_BOOTSTRAP_DATABASE_SCHEMA_INVALID");
    }
    failure("FEDERATION_BOOTSTRAP_DATABASE_INVALID");
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
  const protectedDatabase = openExistingV15Database(input.databasePath, hooks);
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
