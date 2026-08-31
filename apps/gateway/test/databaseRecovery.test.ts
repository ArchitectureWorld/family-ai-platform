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
import { spawnLockedSource } from "./helpers/launchLockedNode.js";

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

  const runLockedRecoveryChild = (input: {
    databasePath: string;
    action: "recover" | "resume" | "retry" | "status";
    operationId?: string;
    killBoundary?: string;
    diskBoundary?: string;
    candidateInvalid?: boolean;
    snapshotFailure?: boolean;
  }) => spawnLockedSource({
    root: join(import.meta.dirname, "../../.."),
    role: "gateway",
    databasePath: input.databasePath,
    target: join(import.meta.dirname, "fixtures/databaseRecoveryProcess.mjs"),
    args: [
      "--engine",
      `--action=${input.action}`,
      ...(input.operationId === undefined ? [] : [`--operation-id=${input.operationId}`]),
      ...(input.killBoundary === undefined ? [] : [`--kill-boundary=${input.killBoundary}`]),
      ...(input.diskBoundary === undefined ? [] : [`--disk-boundary=${input.diskBoundary}`]),
      ...(input.candidateInvalid === true ? ["--candidate-invalid=1"] : []),
      ...(input.snapshotFailure === true ? ["--snapshot-failure=1"] : [])
    ],
    timeout: 30_000
  });

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

  it("seals the single stage authority and makes every layout resolver reject a mismatched stage", () => {
    expect(Object.isFrozen(RECOVERY_STAGE_DEFINITIONS)).toBe(true);
    for (const definition of RECOVERY_STAGE_DEFINITIONS) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.predecessors)).toBe(true);
      const another = RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name !== definition.name)!;
      expect(() => definition.resolveLayout({ stage: another.name } as never))
        .toThrow("GATEWAY_RECOVERY_INVALID");
      const invalidPredecessor = RECOVERY_STAGE_DEFINITIONS.find(({ name }) =>
        !definition.predecessors.includes(name)
      )!;
      expect(() => definition.resolveLayout({
        stage: definition.name,
        predecessor: invalidPredecessor.name
      } as never)).toThrow("GATEWAY_RECOVERY_INVALID");
    }
  });

  it("keeps both bounded snapshot stages self-resumable only after their exact branch entry", () => {
    expect(RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === "snapshot-intent")
      ?.predecessors).toEqual(["marker-only", "snapshot-intent"]);
    expect(RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === "retry-snapshot-intent")
      ?.predecessors).toEqual([
        "retry-cleanup-candidate-quarantine-main-done",
        "retry-snapshot-intent"
      ]);
    expect(RECOVERY_STAGE_DEFINITIONS.find(({ name }) => name === "snapshot-retry-intent")
      ?.predecessors).toEqual(["aborted", "snapshot-retry-intent"]);
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
    expect(existsSync(join(activeRoot, "work"))).toBe(false);
    expect(statSync(join(directory, ".family-ai-gateway.lock")).isFile()).toBe(true);
  });

  it("rejects a marker whose audit timestamp is not exact UTC RFC3339 milliseconds", () => {
    const databasePath = prepareV15();
    const activeRoot = join(directory, `.${basename(databasePath)}.wal-recovery`);
    mkdirSync(activeRoot, { mode: 0o700 });
    writeFileSync(join(activeRoot, "marker.json"), JSON.stringify({
      version: 1,
      operationId: "000102030405060708090a0b0c0d0e0f",
      databaseBasename: "gateway.sqlite",
      workspaceBasename: "work",
      createdAt: "2026-08-31"
    }), { mode: 0o600, flag: "wx" });
    const lease = claimedLease(databasePath);

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "status", databasePath },
      dependencies
    )).toThrow("GATEWAY_RECOVERY_INVALID");
  });

  it("cleans one unowned markerless empty active root before a new recovery", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const activeRoot = join(directory, `.${basename(databasePath)}.wal-recovery`);
    mkdirSync(activeRoot, { mode: 0o700 });
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";

    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
  }, 30_000);

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

  it("writes a bounded snapshot-intent receipt for initialization and every copied file chunk", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
    const receiptsPath = join(
      directory,
      ".gateway.sqlite.wal-recovery-completed",
      operationId,
      "receipts"
    );
    expect(readdirSync(receiptsPath)
      .filter((name) => name.endsWith("-snapshot-intent.json")).length)
      .toBeGreaterThanOrEqual(7);
  }, 30_000);

  it("truncates one exact crash-ahead chunk back to the last durable receipt before resuming", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary.startsWith("snapshot-chunk:snapshotTemp:wal:")) {
            throw new Error("SIMULATED_SIGKILL");
          }
        }
      }
    )).toThrow("SIMULATED_SIGKILL");

    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
  }, 30_000);

  it("maps the imported disk fault fixture to snapshot abort and requires explicit retry", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const failed = runLockedRecoveryChild({
      databasePath,
      action: "recover",
      diskBoundary: "snapshot-copy:original:wal"
    });
    expect(failed.status).toBe(0);
    expect(failed.signal).toBeNull();
    expect(failed.stderr).toBe("");
    expect(JSON.parse(failed.stdout)).toEqual({
      kind: "execution",
      status: "aborted",
      operationId
    });

    const retried = runLockedRecoveryChild({ databasePath, action: "retry", operationId });
    expect(retried.status).toBe(0);
    expect(retried.signal).toBeNull();
    expect(retried.stderr).toBe("");
    expect(JSON.parse(retried.stdout)).toEqual({
      kind: "execution",
      status: "recovered",
      operationId
    });
  }, 60_000);

  it("validates the entire completed chain instead of trusting only its terminal receipt", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
    const receiptsPath = join(
      directory,
      ".gateway.sqlite.wal-recovery-completed",
      operationId,
      "receipts"
    );
    const firstPath = join(receiptsPath, readdirSync(receiptsPath).toSorted()[0]!);
    const first = JSON.parse(readFileSync(firstPath, "utf8")) as Record<string, unknown>;
    first.extra = true;
    writeFileSync(firstPath, JSON.stringify(first), "utf8");

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "status", databasePath, operationId },
      dependencies
    )).toThrow("GATEWAY_RECOVERY_INVALID");
  }, 30_000);

  it.each(["unknown", "00000000000000000099-completed.json.tmp"])(
    "rejects a sealed completed receipt directory containing %s",
    async (extraName) => {
      const databasePath = prepareV15();
      await crashWalWriter(databasePath);
      const lease = claimedLease(databasePath);
      const operationId = "000102030405060708090a0b0c0d0e0f";
      expect(runGatewayRecoveryWithLease(
        lease,
        { action: "recover", databasePath },
        dependencies
      )).toEqual({ kind: "execution", status: "recovered", operationId });
      const receiptsPath = join(
        directory,
        ".gateway.sqlite.wal-recovery-completed",
        operationId,
        "receipts"
      );
      writeFileSync(join(receiptsPath, extraName), "", { flag: "wx", mode: 0o600 });

      expect(() => runGatewayRecoveryWithLease(
        lease,
        { action: "status", databasePath, operationId },
        dependencies
      )).toThrow("GATEWAY_RECOVERY_INVALID");
    },
    30_000
  );

  it("supports a second completed recovery with a fresh operation id", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const firstOperationId = "000102030405060708090a0b0c0d0e0f";
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId: firstOperationId });
    const cleanup = new Database(databasePath);
    cleanup.prepare("DELETE FROM families WHERE family_ref = ?")
      .run("family:recovery-committed");
    cleanup.close();
    await crashWalWriter(databasePath);
    const secondDependencies: GatewayRecoveryDependencies = {
      ...dependencies,
      randomBytes16: () => Uint8Array.from({ length: 16 }, (_, index) => index + 16)
    };
    const secondOperationId = "101112131415161718191a1b1c1d1e1f";

    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      secondDependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId: secondOperationId });
    expect(readdirSync(join(directory, ".gateway.sqlite.wal-recovery-completed")).toSorted())
      .toEqual([firstOperationId, secondOperationId]);
  }, 60_000);

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

  it("uses a real claimed fd3 lease and two fresh recovery children after SIGKILL", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";

    const killed = runLockedRecoveryChild({
      databasePath,
      action: "recover",
      killBoundary: "receipt:snapshot-intent"
    });
    expect(killed.status).toBeNull();
    expect(killed.signal).toBe("SIGKILL");
    expect(killed.stdout).toBe("");
    expect(killed.stderr).toBe("");

    const first = runLockedRecoveryChild({ databasePath, action: "resume", operationId });
    expect(first.status).toBe(0);
    expect(first.signal).toBeNull();
    expect(first.stderr).toBe("");
    expect(JSON.parse(first.stdout)).toEqual({
      kind: "execution",
      status: "recovered",
      operationId
    });

    const second = runLockedRecoveryChild({ databasePath, action: "resume", operationId });
    expect(second.status).toBe(0);
    expect(second.signal).toBeNull();
    expect(second.stderr).toBe("");
    expect(JSON.parse(second.stdout)).toEqual({
      kind: "execution",
      status: "recovered",
      operationId
    });
  }, 60_000);

  it.each([
    ["extra top-level key", (receipt: Record<string, unknown>) => {
      receipt.extra = true;
    }],
    ["non-canonical BigInt metadata", (receipt: Record<string, unknown>) => {
      const owned = receipt.owned as {
        public: { main: { dev: string } };
      };
      owned.public.main.dev = "01";
    }],
    ["negative BigInt metadata", (receipt: Record<string, unknown>) => {
      const owned = receipt.owned as { public: { main: { dev: string } } };
      owned.public.main.dev = "-1";
    }],
    ["BigInt metadata above uint64", (receipt: Record<string, unknown>) => {
      const owned = receipt.owned as { public: { main: { dev: string } } };
      owned.public.main.dev = "18446744073709551616";
    }],
    ["unknown safe error", (receipt: Record<string, unknown>) => {
      receipt.safeErrorCode = "FORWARD_RESUME_REQUIRED";
    }]
  ] as const)("rejects a receipt with %s before reporting status", async (_label, corrupt) => {
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
    const receiptsPath = join(directory, ".gateway.sqlite.wal-recovery", "work", "receipts");
    const receiptPath = join(
      receiptsPath,
      readdirSync(receiptsPath).find((name) => name.endsWith(".json"))!
    );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    corrupt(receipt);
    writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "status", databasePath, operationId },
      dependencies
    )).toThrow("GATEWAY_RECOVERY_INVALID");
  }, 30_000);

  it.each(["forged inode", "replaced inode", "unknown private child"] as const)(
    "rejects an owned layout with a %s without mutating that layout",
    async (kind) => {
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
      const work = join(directory, ".gateway.sqlite.wal-recovery", "work");
      const receiptsPath = join(work, "receipts");
      const receiptPath = join(
        receiptsPath,
        readdirSync(receiptsPath).find((name) => name.endsWith(".json"))!
      );
      if (kind === "forged inode") {
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
          owned: { candidateTemp: { wal: { ino: string } } };
        };
        receipt.owned.candidateTemp.wal.ino = "999999999";
        writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");
      } else if (kind === "replaced inode") {
        const candidate = join(work, "candidate");
        const path = join(candidate, `.${basename(databasePath)}.${operationId}.wal.tmp`);
        const bytes = readFileSync(path);
        const displaced = join(candidate, "displaced-owned-wal");
        renameSync(path, displaced);
        writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      } else {
        writeFileSync(join(work, "candidate", "unknown"), "unknown", {
          flag: "wx",
          mode: 0o600
        });
      }
      const before = readdirSync(join(work, "candidate")).toSorted();

      expect(() => runGatewayRecoveryWithLease(
        lease,
        { action: "status", databasePath, operationId },
        dependencies
      )).toThrow("GATEWAY_RECOVERY_INVALID");
      expect(readdirSync(join(work, "candidate")).toSorted()).toEqual(before);
    },
    30_000
  );

  it("rejects a physically self-consistent owned mask that is invalid for its stage", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "receipt:snapshot-intent") throw new Error("SIMULATED_SIGKILL");
        }
      }
    )).toThrow("SIMULATED_SIGKILL");
    const work = join(directory, ".gateway.sqlite.wal-recovery", "work");
    const candidate = join(work, "candidate");
    const temporary = join(candidate, `.${basename(databasePath)}.${operationId}.wal.tmp`);
    const final = join(candidate, `${basename(databasePath)}-wal`);
    renameSync(temporary, final);
    const receiptsPath = join(work, "receipts");
    const receiptPath = join(
      receiptsPath,
      readdirSync(receiptsPath).find((name) => name.endsWith(".json"))!
    );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      owned: {
        candidate: { wal: Record<string, unknown> | null };
        candidateTemp: { wal: Record<string, unknown> | null };
      };
    };
    const metadata = receipt.owned.candidateTemp.wal!;
    metadata.logicalBasename = `${basename(databasePath)}-wal`;
    receipt.owned.candidate.wal = metadata;
    receipt.owned.candidateTemp.wal = null;
    writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "status", databasePath, operationId },
      dependencies
    )).toThrow("GATEWAY_RECOVERY_INVALID");
  }, 30_000);

  it.each([
    {
      stage: "candidate-validated",
      sourceDirectory: "candidate",
      destinationDirectory: "candidate-quarantine",
      sourceSlot: "candidate",
      destinationSlot: "candidateQuarantine",
      piece: "main"
    },
    {
      stage: "cleanup-quarantine-wal-done",
      sourceDirectory: "original",
      destinationDirectory: "quarantine",
      sourceSlot: "snapshot",
      destinationSlot: "quarantine",
      piece: "wal"
    }
  ] as const)(
    "rejects the physically consistent but semantically wrong $stage layout",
    async (mutation) => {
      const databasePath = prepareV15();
      await crashWalWriter(databasePath);
      const lease = claimedLease(databasePath);
      const operationId = "000102030405060708090a0b0c0d0e0f";
      expect(() => runGatewayRecoveryWithLease(
        lease,
        { action: "recover", databasePath },
        {
          ...dependencies,
          fault: (boundary) => {
            if (boundary === `receipt:${mutation.stage}`) {
              throw new Error("SIMULATED_SIGKILL");
            }
          }
        }
      )).toThrow("SIMULATED_SIGKILL");
      const work = join(directory, ".gateway.sqlite.wal-recovery", "work");
      const source = join(
        work,
        mutation.sourceDirectory,
        mutation.piece === "main" ? basename(databasePath) : `${basename(databasePath)}-${mutation.piece}`
      );
      const destination = join(
        work,
        mutation.destinationDirectory,
        mutation.piece === "main" ? basename(databasePath) : `${basename(databasePath)}-${mutation.piece}`
      );
      renameSync(source, destination);
      const receiptsPath = join(work, "receipts");
      const receiptPath = join(
        receiptsPath,
        readdirSync(receiptsPath).filter((name) => name.endsWith(".json")).toSorted().at(-1)!
      );
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        owned: Record<string, Record<string, Record<string, unknown> | null>>;
      };
      receipt.owned[mutation.destinationSlot]![mutation.piece] =
        receipt.owned[mutation.sourceSlot]![mutation.piece];
      receipt.owned[mutation.sourceSlot]![mutation.piece] = null;
      writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");

      expect(() => runGatewayRecoveryWithLease(
        lease,
        { action: "status", databasePath, operationId },
        dependencies
      )).toThrow("GATEWAY_RECOVERY_INVALID");
    },
    30_000
  );

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

  it("detects a NOREPLACE source substitution by comparing the destination with its held inode", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "receipt:quarantine-wal-intent") {
            throw new Error("SIMULATED_SIGKILL");
          }
        }
      }
    )).toThrow("SIMULATED_SIGKILL");
    const quarantineWal = join(
      directory,
      ".gateway.sqlite.wal-recovery",
      "work",
      "quarantine",
      `${basename(databasePath)}-wal`
    );
    const displaced = `${databasePath}-wal.displaced`;
    const unknown = Buffer.from("unknown-quarantine-source");

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      {
        ...dependencies,
        renameNoReplace: ({ sourcePath, destinationPath }) => {
          if (sourcePath === `${databasePath}-wal`) {
            renameSync(sourcePath, displaced);
            writeFileSync(sourcePath, unknown, { flag: "wx", mode: 0o600 });
          }
          renameSync(sourcePath, destinationPath);
        }
      }
    )).toThrow("GATEWAY_RECOVERY_INVALID");
    expect(readFileSync(quarantineWal)).toEqual(unknown);
    expect(existsSync(displaced)).toBe(true);
  }, 30_000);

  it("preserves a quarantine replacement injected after cleanup intent and before unlink", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "receipt:cleanup-quarantine-wal-intent") {
            throw new Error("SIMULATED_SIGKILL");
          }
        }
      }
    )).toThrow("SIMULATED_SIGKILL");
    const quarantineWal = join(
      directory,
      ".gateway.sqlite.wal-recovery",
      "work",
      "quarantine",
      `${basename(databasePath)}-wal`
    );
    const displaced = `${quarantineWal}.displaced`;
    const unknown = Buffer.from("unknown-cleanup-target");
    let fired = false;

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "cleanup-before-unlink:cleanup-quarantine-wal-intent") {
            fired = true;
            renameSync(quarantineWal, displaced);
            writeFileSync(quarantineWal, unknown, { flag: "wx", mode: 0o600 });
          }
        }
      }
    )).toThrow("GATEWAY_RECOVERY_INVALID");
    expect(fired).toBe(true);
    expect(readFileSync(quarantineWal)).toEqual(unknown);
    expect(existsSync(displaced)).toBe(true);
  }, 30_000);

  it("returns blocked after a post-cut synchronous fault and resumes forward only", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const blocked = runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "cleanup-before-unlink:cleanup-quarantine-wal-intent") {
            const error = new Error("ENOSPC") as NodeJS.ErrnoException;
            error.code = "ENOSPC";
            throw error;
          }
        }
      }
    );

    expect(blocked).toEqual({ kind: "execution", status: "blocked", operationId });
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

  it("preserves a marker replacement injected after marker-remove-intent", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "receipt:marker-remove-intent") {
            throw new Error("SIMULATED_SIGKILL");
          }
        }
      }
    )).toThrow("SIMULATED_SIGKILL");
    const marker = join(directory, ".gateway.sqlite.wal-recovery", "marker.json");
    const displaced = `${marker}.displaced`;
    const unknown = Buffer.from("unknown-marker");
    let fired = false;

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "marker-before-unlink") {
            fired = true;
            renameSync(marker, displaced);
            writeFileSync(marker, unknown, { flag: "wx", mode: 0o600 });
          }
        }
      }
    )).toThrow("GATEWAY_RECOVERY_INVALID");
    expect(fired).toBe(true);
    expect(readFileSync(marker)).toEqual(unknown);
    expect(existsSync(displaced)).toBe(true);
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

  it.each(["wrong basename", "wrong bytes"] as const)(
    "read-only status rejects one active deterministic receipt temp with %s",
    async (kind) => {
      const databasePath = prepareV15();
      await crashWalWriter(databasePath);
      const lease = claimedLease(databasePath);
      const operationId = "000102030405060708090a0b0c0d0e0f";
      expect(() => runGatewayRecoveryWithLease(
        lease,
        { action: "recover", databasePath },
        {
          ...dependencies,
          fault: (boundary) => {
            if (boundary === "receipt-temp:snapshot-intent") {
              throw new Error("SIMULATED_SIGKILL");
            }
          }
        }
      )).toThrow("SIMULATED_SIGKILL");
      const receipts = join(directory, ".gateway.sqlite.wal-recovery", "work", "receipts");
      const [temporary] = readdirSync(receipts);
      if (kind === "wrong basename") {
        renameSync(join(receipts, temporary!), join(receipts, "wrong.json.tmp"));
      } else {
        writeFileSync(join(receipts, temporary!), "x", "utf8");
      }
      const before = readdirSync(receipts).map((name) => [name, readFileSync(join(receipts, name))]);

      expect(() => runGatewayRecoveryWithLease(
        lease,
        { action: "status", databasePath, operationId },
        dependencies
      )).toThrow("GATEWAY_RECOVERY_INVALID");
      expect(readdirSync(receipts).map((name) => [name, readFileSync(join(receipts, name))]))
        .toEqual(before);
    },
    30_000
  );

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

  it("holds candidate main before SQLite open and preserves a replacement inode", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const candidatePath = join(
      directory,
      ".gateway.sqlite.wal-recovery",
      "work",
      "candidate",
      basename(databasePath)
    );
    const displaced = `${candidatePath}.displaced`;
    const unknown = Buffer.from("unknown-candidate-inode");
    const publicBefore = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .map((path) => readFileSync(path));
    let fired = false;

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "candidate-before-open") {
            fired = true;
            renameSync(candidatePath, displaced);
            writeFileSync(candidatePath, unknown, { flag: "wx", mode: 0o600 });
          }
        }
      }
    )).toThrow("GATEWAY_RECOVERY_INVALID");
    expect(fired).toBe(true);
    expect(readFileSync(candidatePath)).toEqual(unknown);
    expect(existsSync(displaced)).toBe(true);
    expect([databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .map((path) => readFileSync(path))).toEqual(publicBefore);
  }, 30_000);

  it("preserves a candidate WAL replacement created after checkpoint and before unlink", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const candidateWal = join(
      directory,
      ".gateway.sqlite.wal-recovery",
      "work",
      "candidate",
      `${basename(databasePath)}-wal`
    );
    const displaced = `${candidateWal}.displaced`;
    const unknown = Buffer.from("unknown-candidate-wal");
    let fired = false;

    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "candidate-before-sidecar-unlink:wal") {
            fired = true;
            if (existsSync(candidateWal)) renameSync(candidateWal, displaced);
            writeFileSync(candidateWal, unknown, { flag: "wx", mode: 0o600 });
          }
        }
      }
    )).toThrow("GATEWAY_RECOVERY_INVALID");
    expect(fired).toBe(true);
    expect(readFileSync(candidateWal)).toEqual(unknown);
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

  it("resumes a failed retry only after retry-intent is durable", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
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
    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "retry", databasePath, operationId },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "receipt:retry-intent") throw new Error("SIMULATED_SIGKILL");
        }
      }
    )).toThrow("SIMULATED_SIGKILL");

    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
  }, 30_000);

  it("records bounded retry-snapshot self loops for a failed recovery", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    const invalidCandidate: GatewayRecoveryDependencies = {
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
      invalidCandidate
    )).toEqual({ kind: "execution", status: "restored", operationId });
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "retry", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
    const receiptsPath = join(
      directory,
      ".gateway.sqlite.wal-recovery-completed",
      operationId,
      "receipts"
    );
    expect(readdirSync(receiptsPath)
      .filter((name) => name.endsWith("-retry-snapshot-intent.json")).length)
      .toBeGreaterThanOrEqual(4);
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

  it("resumes an aborted retry only after snapshot-retry-intent is durable", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "snapshot-copy:original:wal") {
            throw new Error("SNAPSHOT_IO_FAILED");
          }
        }
      }
    )).toEqual({ kind: "execution", status: "aborted", operationId });
    expect(() => runGatewayRecoveryWithLease(
      lease,
      { action: "retry", databasePath, operationId },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "receipt:snapshot-retry-intent") {
            throw new Error("SIMULATED_SIGKILL");
          }
        }
      }
    )).toThrow("SIMULATED_SIGKILL");

    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "resume", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
  }, 30_000);

  it("records bounded snapshot-retry self loops after an aborted recovery", async () => {
    const databasePath = prepareV15();
    await crashWalWriter(databasePath);
    const lease = claimedLease(databasePath);
    const operationId = "000102030405060708090a0b0c0d0e0f";
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "recover", databasePath },
      {
        ...dependencies,
        fault: (boundary) => {
          if (boundary === "snapshot-copy:original:wal") {
            throw new Error("SNAPSHOT_IO_FAILED");
          }
        }
      }
    )).toEqual({ kind: "execution", status: "aborted", operationId });
    expect(runGatewayRecoveryWithLease(
      lease,
      { action: "retry", databasePath, operationId },
      dependencies
    )).toEqual({ kind: "execution", status: "recovered", operationId });
    const receiptsPath = join(
      directory,
      ".gateway.sqlite.wal-recovery-completed",
      operationId,
      "receipts"
    );
    expect(readdirSync(receiptsPath)
      .filter((name) => name.endsWith("-snapshot-retry-intent.json")).length)
      .toBeGreaterThanOrEqual(7);
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

  it.each(RECOVERY_STAGE_DEFINITIONS)(
    "resumes the authoritative $name state twice without a default branch",
    async (definition) => {
      const databasePath = prepareV15();
      await crashWalWriter(databasePath);
      const lease = claimedLease(databasePath);
      const operationId = "000102030405060708090a0b0c0d0e0f";
      const receiptBoundary = `receipt:${definition.name}`;
      const killAtDefinition = (boundary: string) => {
        if (boundary === receiptBoundary) throw new Error("SIMULATED_SIGKILL");
      };
      const invalidCandidate = (input: Parameters<
        typeof validateImmutableGatewayV15Database
      >[0]) => {
        if (input.databasePath.includes("/.gateway.sqlite.wal-recovery/work/candidate/")) {
          throw new Error("CANDIDATE_INVALID");
        }
        validateImmutableGatewayV15Database(input);
      };

      if (definition.phase === "rollback-precut") {
        expect(() => runGatewayRecoveryWithLease(
          lease,
          { action: "recover", databasePath },
          {
            ...dependencies,
            validateImmutableV15: invalidCandidate,
            fault: killAtDefinition
          }
        )).toThrow("SIMULATED_SIGKILL");
      } else if (definition.phase === "retry-failed" || definition.phase === "retry-reset") {
        expect(runGatewayRecoveryWithLease(
          lease,
          { action: "recover", databasePath },
          { ...dependencies, validateImmutableV15: invalidCandidate }
        )).toEqual({ kind: "execution", status: "restored", operationId });
        expect(() => runGatewayRecoveryWithLease(
          lease,
          { action: "retry", databasePath, operationId },
          { ...dependencies, fault: killAtDefinition }
        )).toThrow("SIMULATED_SIGKILL");
      } else if (definition.phase === "snapshot-abort") {
        expect(() => runGatewayRecoveryWithLease(
          lease,
          { action: "recover", databasePath },
          {
            ...dependencies,
            fault: (boundary) => {
              if (boundary === "snapshot-copy:original:wal") {
                throw new Error("SNAPSHOT_IO_FAILED");
              }
              killAtDefinition(boundary);
            }
          }
        )).toThrow("SIMULATED_SIGKILL");
      } else if (definition.phase === "retry-aborted") {
        expect(runGatewayRecoveryWithLease(
          lease,
          { action: "recover", databasePath },
          {
            ...dependencies,
            fault: (boundary) => {
              if (boundary === "snapshot-copy:original:wal") {
                throw new Error("SNAPSHOT_IO_FAILED");
              }
            }
          }
        )).toEqual({ kind: "execution", status: "aborted", operationId });
        expect(() => runGatewayRecoveryWithLease(
          lease,
          { action: "retry", databasePath, operationId },
          { ...dependencies, fault: killAtDefinition }
        )).toThrow("SIMULATED_SIGKILL");
      } else {
        expect(() => runGatewayRecoveryWithLease(
          lease,
          { action: "recover", databasePath },
          { ...dependencies, fault: killAtDefinition }
        )).toThrow("SIMULATED_SIGKILL");
      }

      const expectedStatus = definition.phase === "snapshot-abort"
        ? "aborted"
        : definition.phase === "rollback-precut"
          ? "restored"
          : "recovered";
      const first = runGatewayRecoveryWithLease(
        lease,
        { action: "resume", databasePath, operationId },
        dependencies
      );
      expect(first).toEqual({ kind: "execution", status: expectedStatus, operationId });
      const second = runGatewayRecoveryWithLease(
        lease,
        { action: "resume", databasePath, operationId },
        dependencies
      );
      expect(second).toEqual({ kind: "execution", status: expectedStatus, operationId });
    },
    60_000
  );

  it.each(RECOVERY_STAGE_DEFINITIONS)(
    "survives real child SIGKILL at authoritative $name and two fresh locked resumes",
    async (definition) => {
      const databasePath = prepareV15();
      await crashWalWriter(databasePath);
      const operationId = "000102030405060708090a0b0c0d0e0f";
      const killBoundary = `receipt:${definition.name}`;
      let killed;
      if (definition.phase === "rollback-precut") {
        killed = runLockedRecoveryChild({
          databasePath,
          action: "recover",
          killBoundary,
          candidateInvalid: true
        });
      } else if (definition.phase === "retry-failed" || definition.phase === "retry-reset") {
        const prepared = runLockedRecoveryChild({
          databasePath,
          action: "recover",
          candidateInvalid: true
        });
        expect(prepared.status).toBe(0);
        expect(prepared.stderr).toBe("");
        expect(JSON.parse(prepared.stdout)).toEqual({
          kind: "execution",
          status: "restored",
          operationId
        });
        killed = runLockedRecoveryChild({
          databasePath,
          action: "retry",
          operationId,
          killBoundary
        });
      } else if (definition.phase === "snapshot-abort") {
        killed = runLockedRecoveryChild({
          databasePath,
          action: "recover",
          killBoundary,
          snapshotFailure: true
        });
      } else if (definition.phase === "retry-aborted") {
        const prepared = runLockedRecoveryChild({
          databasePath,
          action: "recover",
          snapshotFailure: true
        });
        expect(prepared.status).toBe(0);
        expect(prepared.stderr).toBe("");
        expect(JSON.parse(prepared.stdout)).toEqual({
          kind: "execution",
          status: "aborted",
          operationId
        });
        killed = runLockedRecoveryChild({
          databasePath,
          action: "retry",
          operationId,
          killBoundary
        });
      } else {
        killed = runLockedRecoveryChild({
          databasePath,
          action: "recover",
          killBoundary
        });
      }
      expect(killed.status).toBeNull();
      expect(killed.signal).toBe("SIGKILL");
      expect(killed.stdout).toBe("");
      expect(killed.stderr).toBe("");

      const expectedStatus = definition.phase === "snapshot-abort"
        ? "aborted"
        : definition.phase === "rollback-precut"
          ? "restored"
          : "recovered";
      for (let index = 0; index < 2; index += 1) {
        const resumed = runLockedRecoveryChild({
          databasePath,
          action: "resume",
          operationId
        });
        expect({
          status: resumed.status,
          signal: resumed.signal,
          stdout: resumed.stdout,
          stderr: resumed.stderr
        }).toMatchObject({ status: 0, signal: null, stderr: "" });
        expect(resumed.signal).toBeNull();
        expect(resumed.stderr).toBe("");
        expect(JSON.parse(resumed.stdout)).toEqual({
          kind: "execution",
          status: expectedStatus,
          operationId
        });
      }
    },
    120_000
  );
});
