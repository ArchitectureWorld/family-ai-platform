import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openGatewayDatabase } from "../src/database.js";
import {
  validateImmutableGatewayV15Database,
  validateImmutableGatewayV15DatabaseForTest
} from "../src/databaseSecurity.js";
import {
  RECOVERY_STAGE_DEFINITIONS,
  createClaimedRecoveryLockLeaseForTest,
  runGatewayRecoveryWithLease,
  type GatewayRecoveryDependencies
} from "../src/databaseRecovery.js";

const EXPECTED_STAGE_NAMES = [
  "snapshot-intent", "snapshot-complete", "candidate-validated",
  "quarantine-wal-intent", "wal-quarantined", "quarantine-shm-intent",
  "shm-quarantined", "quarantine-main-intent", "originals-quarantined",
  "publish-intent", "candidate-published", "public-verified",
  "cleanup-quarantine-wal-intent", "cleanup-quarantine-wal-done",
  "cleanup-quarantine-shm-intent", "cleanup-quarantine-shm-done",
  "cleanup-quarantine-main-intent", "cleanup-quarantine-main-done",
  "cleanup-snapshot-wal-intent", "cleanup-snapshot-wal-done",
  "cleanup-snapshot-shm-intent", "cleanup-snapshot-shm-done",
  "cleanup-snapshot-main-intent", "cleanup-snapshot-main-done",
  "complete-intent", "completed", "archive-intent", "archive-renamed",
  "archive-done", "marker-remove-intent", "marker-removed", "rollback-intent",
  "candidate-quarantine-intent", "candidate-quarantined", "restore-wal-intent",
  "wal-restored", "restore-shm-intent", "shm-restored", "restore-main-intent",
  "original-restored", "failed", "retry-intent",
  "retry-cleanup-candidate-quarantine-wal-intent",
  "retry-cleanup-candidate-quarantine-wal-done",
  "retry-cleanup-candidate-quarantine-shm-intent",
  "retry-cleanup-candidate-quarantine-shm-done",
  "retry-cleanup-candidate-quarantine-main-intent",
  "retry-cleanup-candidate-quarantine-main-done", "retry-snapshot-intent",
  "retry-reset-done",
  "snapshot-abort-candidate-temp-wal-intent",
  "snapshot-abort-candidate-temp-wal-done",
  "snapshot-abort-candidate-temp-shm-intent",
  "snapshot-abort-candidate-temp-shm-done",
  "snapshot-abort-candidate-temp-main-intent",
  "snapshot-abort-candidate-temp-main-done",
  "snapshot-abort-candidate-wal-intent", "snapshot-abort-candidate-wal-done",
  "snapshot-abort-candidate-shm-intent", "snapshot-abort-candidate-shm-done",
  "snapshot-abort-candidate-main-intent", "snapshot-abort-candidate-main-done",
  "snapshot-abort-snapshot-temp-wal-intent",
  "snapshot-abort-snapshot-temp-wal-done",
  "snapshot-abort-snapshot-temp-shm-intent",
  "snapshot-abort-snapshot-temp-shm-done",
  "snapshot-abort-snapshot-temp-main-intent",
  "snapshot-abort-snapshot-temp-main-done",
  "snapshot-abort-snapshot-wal-intent", "snapshot-abort-snapshot-wal-done",
  "snapshot-abort-snapshot-shm-intent", "snapshot-abort-snapshot-shm-done",
  "snapshot-abort-snapshot-main-intent", "snapshot-abort-snapshot-main-done",
  "aborted", "snapshot-retry-intent", "snapshot-retry-done"
] as const;

describe("offline Gateway database recovery engine", () => {
  let directory = "";
  const descriptors: number[] = [];

  afterEach(() => {
    for (const descriptor of descriptors.splice(0)) {
      try {
        closeSync(descriptor);
      } catch {
        // A test may deliberately prove that SQLite closed its own descriptor.
      }
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = "";
  });

  const prepareV15 = (): string => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-recovery-"));
    chmodSync(directory, 0o700);
    const databasePath = join(directory, "gateway.sqlite");
    const database = openGatewayDatabase(databasePath, {
      intent: "test-create-or-existing",
      simulate: "migrate-create-or-existing"
    });
    database.close();
    chmodSync(databasePath, 0o600);
    return databasePath;
  };

  const proof = (databasePath: string) => {
    const parentProofFd = openSync(
      dirname(databasePath),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const databaseProofFd = openSync(
      databasePath,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    descriptors.push(parentProofFd, databaseProofFd);
    const parent = fstatSync(parentProofFd, { bigint: true });
    const database = fstatSync(databaseProofFd, { bigint: true });
    return {
      databasePath,
      parentProofFd,
      databaseProofFd,
      expectedParentIdentity: { dev: parent.dev, ino: parent.ino },
      expectedDatabaseIdentity: { dev: database.dev, ino: database.ino }
    };
  };

  const claimedLease = (databasePath: string) => {
    const lockPath = join(dirname(databasePath), ".family-ai-gateway.lock");
    const lockFd = openSync(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    );
    descriptors.push(lockFd);
    const identity = fstatSync(lockFd, { bigint: true });
    return createClaimedRecoveryLockLeaseForTest({
      databasePath,
      lockDev: identity.dev,
      lockIno: identity.ino,
      close: () => closeSync(lockFd)
    });
  };

  const dependencies: GatewayRecoveryDependencies = {
    randomBytes16: () => Uint8Array.from({ length: 16 }, (_, index) => index),
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    renameNoReplace: ({ sourcePath, destinationPath }) => {
      expect(statSync(destinationPath, { throwIfNoEntry: false })).toBeUndefined();
      renameSync(sourcePath, destinationPath);
    },
    validateImmutableV15: validateImmutableGatewayV15Database,
    fault: null
  };

  const crashWalWriter = async (databasePath: string): Promise<void> => {
    const child = spawn(process.execPath, [
      join(import.meta.dirname, "fixtures/databaseRecoveryProcess.mjs"),
      databasePath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      }
    );
    expect(result).toEqual({ code: 0, signal: null });
    expect(stdout).toBe("RECOVERY_WRITER_KILLED\n");
    expect(stderr).toBe("");
    expect(existsSync(`${databasePath}-wal`)).toBe(true);
    expect(existsSync(`${databasePath}-shm`)).toBe(true);
  };

  it("exports one complete stage authority with the retry predecessor split", () => {
    expect(RECOVERY_STAGE_DEFINITIONS.map(({ name }) => name)).toEqual(EXPECTED_STAGE_NAMES);
    expect(new Set(RECOVERY_STAGE_DEFINITIONS.map(({ name }) => name)).size).toBe(77);
    expect(RECOVERY_STAGE_DEFINITIONS.every((definition) =>
      Object.keys(definition).toSorted().join(",") ===
        "name,phase,predecessors,resolveLayout,safeError"
    )).toBe(true);
    expect(RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === "candidate-validated")
      ?.predecessors).toEqual(["snapshot-complete", "retry-reset-done"]);
  });

  it("keeps caller proof descriptors open while the immutable validator closes its connection", () => {
    const input = proof(prepareV15());
    let connectionDescriptor = -1;

    validateImmutableGatewayV15DatabaseForTest(input, {
      connectionDescriptor: (descriptor) => {
        connectionDescriptor = descriptor;
      }
    });

    expect(connectionDescriptor).toBeGreaterThan(2);
    expect(() => fstatSync(connectionDescriptor)).toThrow();
    expect(fstatSync(input.parentProofFd, { bigint: true }).ino)
      .toBe(input.expectedParentIdentity.ino);
    expect(fstatSync(input.databaseProofFd, { bigint: true }).ino)
      .toBe(input.expectedDatabaseIdentity.ino);
  });

  it("rejects an unclaimed plain lease before reading the recovery root", () => {
    const databasePath = prepareV15();
    expect(() => runGatewayRecoveryWithLease({
      databasePath,
      lockDev: 1n,
      lockIno: 2n,
      close: () => undefined
    } as never, { action: "status", databasePath }, dependencies))
      .toThrow("GATEWAY_RECOVERY_LOCK_INVALID");
  });

  it("reports a canonical marker-only root as initializing without closing the lease", () => {
    const databasePath = prepareV15();
    const activeRoot = join(directory, `.${basename(databasePath)}.wal-recovery`);
    mkdirSync(activeRoot, { mode: 0o700 });
    writeFileSync(join(activeRoot, "marker.json"), JSON.stringify({
      version: 1,
      operationId: "000102030405060708090a0b0c0d0e0f",
      databaseBasename: "gateway.sqlite",
      workspaceBasename: "work",
      createdAt: "2026-08-31T00:00:00.000Z"
    }), { mode: 0o600, flag: "wx" });
    const lease = claimedLease(databasePath);

    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "status", databasePath },
      dependencies
    )).toEqual({
      kind: "status",
      state: "initializing",
      operationId: "000102030405060708090a0b0c0d0e0f"
    });
    expect(statSync(join(directory, ".family-ai-gateway.lock")).isFile()).toBe(true);
  });

  it("recovers committed WAL data, excludes the killed transaction and seals completion", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);

    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      dependencies
    )).toEqual({
      kind: "execution",
      status: "recovered",
      operationId: "000102030405060708090a0b0c0d0e0f"
    });

    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
    expect(existsSync(join(directory, ".gateway.sqlite.wal-recovery"))).toBe(false);
    const recovered = new Database(databasePath, { readonly: true, fileMustExist: true });
    expect(recovered.prepare(
      "SELECT family_ref FROM families WHERE family_ref LIKE 'family:recovery-%' ORDER BY family_ref"
    ).all()).toEqual([{ family_ref: "family:recovery-committed" }]);
    recovered.close();

    const operationId = "000102030405060708090a0b0c0d0e0f";
    const completed = join(directory, ".gateway.sqlite.wal-recovery-completed", operationId);
    const receipts = readdirSync(join(completed, "receipts")).toSorted();
    expect(receipts.at(-1)).toMatch(/-marker-removed\.json$/u);
    const terminal = JSON.parse(readFileSync(
      join(completed, "receipts", receipts.at(-1)!),
      "utf8"
    )) as Record<string, unknown>;
    expect(Object.keys(terminal)).toEqual([
      "version", "sequence", "prevHash", "operationId", "stage", "databaseBasename",
      "workspace", "original", "owned", "candidateSha256", "safeErrorCode",
      "rollbackFromStage"
    ]);
    expect(terminal.stage).toBe("marker-removed");
    expect(terminal.workspace).not.toHaveProperty("nlink");

    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "status", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "status", state: "completed", operationId, stage: "marker-removed" });
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
  }, 30_000);

  it("resumes from the durable marker when the first process dies before work creation", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const crashing: GatewayRecoveryDependencies = {
      ...dependencies,
      fault: (boundary) => {
        if (boundary === "marker-created") throw new Error("SIMULATED_SIGKILL");
      }
    };

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      crashing
    )).toThrow("SIMULATED_SIGKILL");
    expect(existsSync(join(directory, ".gateway.sqlite.wal-recovery", "work"))).toBe(false);
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "status", databasePath },
      dependencies
    )).toEqual({
      kind: "status",
      state: "initializing",
      operationId: "000102030405060708090a0b0c0d0e0f"
    });
    expect(runGatewayRecoveryWithLease(
      lease,
      {
        action: "resume",
        databasePath,
        operationId: "000102030405060708090a0b0c0d0e0f"
      },
      dependencies
    )).toEqual({
      kind: "execution",
      status: "recovered",
      operationId: "000102030405060708090a0b0c0d0e0f"
    });
  }, 30_000);

  it("resumes idempotently from a published snapshot intent and owned temp prefix", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const crashing: GatewayRecoveryDependencies = {
      ...dependencies,
      fault: (boundary) => {
        if (boundary === "receipt:snapshot-intent") throw new Error("SIMULATED_SIGKILL");
      }
    };

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      crashing
    )).toThrow("SIMULATED_SIGKILL");
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "status", databasePath },
      dependencies
    )).toEqual({ kind: "status", state: "active", operationId, stage: "snapshot-intent" });
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
  }, 30_000);

  it("resumes an original-main quarantine intent without replaying earlier renames", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const crashing: GatewayRecoveryDependencies = {
      ...dependencies,
      fault: (boundary) => {
        if (boundary === "receipt:quarantine-main-intent") {
          throw new Error("SIMULATED_SIGKILL");
        }
      }
    };

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      crashing
    )).toThrow("SIMULATED_SIGKILL");
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "status", databasePath },
      dependencies
    )).toEqual({
      kind: "status",
      state: "active",
      operationId,
      stage: "quarantine-main-intent"
    });
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
  }, 30_000);

  it.each([
    "receipt:cleanup-snapshot-main-intent",
    "archive:work",
    "receipt:marker-remove-intent",
    "active-root-removed"
  ] as const)("resumes the forward-only %s boundary", async (faultBoundary) => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const crashing: GatewayRecoveryDependencies = {
      ...dependencies,
      fault: (boundary) => {
        if (boundary === faultBoundary) throw new Error("SIMULATED_SIGKILL");
      }
    };

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      crashing
    )).toThrow("SIMULATED_SIGKILL");
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
    const completedReceipts = readdirSync(join(
      directory,
      ".gateway.sqlite.wal-recovery-completed",
      operationId,
      "receipts"
    )).toSorted();
    expect(completedReceipts.at(-1)).toMatch(/-marker-removed\.json$/u);
  }, 30_000);

  it("rewrites one strict-prefix unpublished receipt temp before publishing it", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const crashing: GatewayRecoveryDependencies = {
      ...dependencies,
      fault: (boundary) => {
        if (boundary === "receipt-temp:snapshot-intent") {
          throw new Error("SIMULATED_SIGKILL");
        }
      }
    };

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      crashing
    )).toThrow("SIMULATED_SIGKILL");
    const receipts = join(directory, ".gateway.sqlite.wal-recovery", "work", "receipts");
    const [unpublished] = readdirSync(receipts);
    expect(unpublished).toMatch(/snapshot-intent\.json\.tmp$/u);
    truncateSync(join(receipts, unpublished!), 17);
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
  }, 30_000);

  it("blocks public source drift without appending a receipt or overwriting the unknown inode", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const crashing: GatewayRecoveryDependencies = {
      ...dependencies,
      fault: (boundary) => {
        if (boundary === "receipt:snapshot-intent") throw new Error("SIMULATED_SIGKILL");
      }
    };
    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      crashing
    )).toThrow("SIMULATED_SIGKILL");
    const receipts = join(directory, ".gateway.sqlite.wal-recovery", "work", "receipts");
    const receiptCount = readdirSync(receipts).length;
    const unknown = Buffer.concat([readFileSync(databasePath), Buffer.from("unknown-source")]);
    writeFileSync(databasePath, unknown);

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toThrow("GATEWAY_RECOVERY_INVALID");
    expect(readFileSync(databasePath)).toEqual(unknown);
    expect(readdirSync(receipts).length).toBe(receiptCount);
  }, 30_000);

  it.each(["wrong", "multiple"] as const)(
    "rejects a %s unpublished receipt temp without touching public WAL bytes",
    async (kind) => {
      const databasePath = prepareV15();
      await crashWalWriter(databasePath);
      const lease = claimedLease(databasePath);
      const operationId = "000102030405060708090a0b0c0d0e0f";
      const crashing: GatewayRecoveryDependencies = {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "receipt-temp:snapshot-intent") throw new Error("SIMULATED_SIGKILL");
        }
      };
      expect(() => runGatewayRecoveryWithLease(
        lease,
        { action: "recover", databasePath },
        crashing
      )).toThrow("SIMULATED_SIGKILL");
      const receipts = join(directory, ".gateway.sqlite.wal-recovery", "work", "receipts");
      const [unpublished] = readdirSync(receipts);
      if (kind === "wrong") {
        writeFileSync(join(receipts, unpublished!), "x", { mode: 0o600 });
      } else {
        writeFileSync(join(receipts, "extra.json.tmp"), "", { mode: 0o600, flag: "wx" });
      }
      const before = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
        .map((path) => readFileSync(path));

      expect(() => runGatewayRecoveryWithLease(
        lease,
        { action: "resume", databasePath, operationId },
        dependencies
      )).toThrow("GATEWAY_RECOVERY_INVALID");
      expect([databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
        .map((path) => readFileSync(path))).toEqual(before);
    },
    30_000
  );

  it("restores a pre-cut candidate validation failure and retries through all CQ no-op stages", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const before = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .map((path) => readFileSync(path));
    const candidateFailure: GatewayRecoveryDependencies = {
      ...dependencies,
      validateImmutableV15: (input) => {
        if (input.databasePath.includes("/.gateway.sqlite.wal-recovery/work/candidate/")) {
          throw new Error("CANDIDATE_INVALID");
        }
        validateImmutableGatewayV15Database(input);
      }
    };

    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      candidateFailure
    )).toEqual({ kind: "execution", status: "restored", operationId });
    expect([databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .map((path) => readFileSync(path))).toEqual(before);
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "restored", operationId });
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "retry", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });

    const receiptNames = readdirSync(join(
      directory,
      ".gateway.sqlite.wal-recovery-completed",
      operationId,
      "receipts"
    ));
    for (const piece of ["wal", "shm", "main"] as const) {
      expect(receiptNames.some((name) =>
        name.endsWith(`-retry-cleanup-candidate-quarantine-${piece}-intent.json`)
      )).toBe(true);
      expect(receiptNames.some((name) =>
        name.endsWith(`-retry-cleanup-candidate-quarantine-${piece}-done.json`)
      )).toBe(true);
    }
  }, 30_000);

  it("aborts a workspace copy failure through all 24 cleanup receipts and retries from zero", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const before = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .map((path) => readFileSync(path));
    const copyFailure: GatewayRecoveryDependencies = {
      ...dependencies,
      fault: (boundary) => {
        if (boundary === "snapshot-copy:original:wal") {
          throw new Error("SNAPSHOT_IO_FAILED");
        }
      }
    };

    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      copyFailure
    )).toEqual({ kind: "execution", status: "aborted", operationId });
    expect([databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .map((path) => readFileSync(path))).toEqual(before);
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "aborted", operationId });
    const activeReceipts = readdirSync(join(
      directory,
      ".gateway.sqlite.wal-recovery",
      "work",
      "receipts"
    ));
    expect(activeReceipts.filter((name) => name.includes("snapshot-abort-")).length).toBe(24);
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "retry", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
  }, 30_000);

  it("resumes an interrupted rollback intent to the restored terminal", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const rollbackCrash: GatewayRecoveryDependencies = {
      ...dependencies,
      validateImmutableV15: (input) => {
        if (input.databasePath.includes("/.gateway.sqlite.wal-recovery/work/candidate/")) {
          throw new Error("CANDIDATE_INVALID");
        }
        validateImmutableGatewayV15Database(input);
      },
      fault: (boundary) => {
        if (boundary === "receipt:restore-shm-intent") throw new Error("SIMULATED_SIGKILL");
      }
    };

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      rollbackCrash
    )).toThrow("SIMULATED_SIGKILL");
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "restored", operationId });
  }, 30_000);

  it("resumes an interrupted snapshot-abort cleanup to aborted", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const abortCrash: GatewayRecoveryDependencies = {
      ...dependencies,
      fault: (boundary) => {
        if (boundary === "snapshot-copy:original:wal") throw new Error("SNAPSHOT_IO_FAILED");
        if (boundary === "receipt:snapshot-abort-snapshot-temp-wal-intent") {
          throw new Error("SIMULATED_SIGKILL");
        }
      }
    };

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      abortCrash
    )).toThrow("SIMULATED_SIGKILL");
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "aborted", operationId });
  }, 30_000);
});
