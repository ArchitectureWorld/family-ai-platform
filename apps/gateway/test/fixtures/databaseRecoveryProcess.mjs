import { spawn } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

async function runWriterController(databasePath) {
  const writer = fileURLToPath(new URL("./databaseRecoveryCrashWriter.mjs", import.meta.url));
  const child = spawn(process.execPath, [writer, databasePath], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout === "RECOVERY_WRITER_READY\n") child.kill("SIGKILL");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    throw error;
  });
  child.once("exit", (code, signal) => {
    if (code !== null || signal !== "SIGKILL" || stderr !== "") {
      throw new Error("RECOVERY_WRITER_PROCESS_INVALID");
    }
    process.stdout.write("RECOVERY_WRITER_KILLED\n");
  });
}

function exactOptions(args) {
  const options = new Map();
  for (const argument of args) {
    const match = argument.match(/^--([a-z-]+)=(.*)$/u);
    if (!match || options.has(match[1])) throw new Error("RECOVERY_PROCESS_ARGUMENTS_INVALID");
    options.set(match[1], match[2]);
  }
  return options;
}

async function runEngine(args) {
  const options = exactOptions(args);
  const allowed = new Set([
    "action", "operation-id", "kill-boundary", "disk-boundary", "candidate-invalid",
    "candidate-failure-before-open", "public-invalid", "snapshot-failure"
  ]);
  if ([...options.keys()].some((key) => !allowed.has(key))) {
    throw new Error("RECOVERY_PROCESS_ARGUMENTS_INVALID");
  }
  const action = options.get("action");
  const databasePath = process.env.FAMILY_AI_GATEWAY_LOCK_DATABASE;
  if (!databasePath || !["recover", "resume", "retry", "status"].includes(action)) {
    throw new Error("RECOVERY_PROCESS_ARGUMENTS_INVALID");
  }
  const operationId = options.get("operation-id");
  if ((action === "resume" || action === "retry") !== (operationId !== undefined)) {
    throw new Error("RECOVERY_PROCESS_ARGUMENTS_INVALID");
  }
  for (const flag of [
    "candidate-invalid", "candidate-failure-before-open", "public-invalid", "snapshot-failure"
  ]) {
    if (options.has(flag) && options.get(flag) !== "1") {
      throw new Error("RECOVERY_PROCESS_ARGUMENTS_INVALID");
    }
  }
  const [lockModule, recoveryModule, securityModule, stageFaultModule, diskFaultModule] =
    await Promise.all([
      import("../../src/databaseLock.ts"),
      import("../../src/databaseRecovery.ts"),
      import("../../src/databaseSecurity.ts"),
      import("./databaseRecoveryStageFault.mjs"),
      import("./databaseRecoveryDiskFault.mjs")
    ]);
  const inherited = lockModule.requireInheritedGatewayDatabaseLockForTest({
    role: "gateway",
    databasePath
  }, {
    uid: process.getuid(),
    gid: process.getgid()
  });
  const lease = recoveryModule.createClaimedRecoveryLockLeaseForTest(
    Object.assign(inherited, { databasePath })
  );
  const killFault = options.has("kill-boundary")
    ? stageFaultModule.createRecoveryStageKill(options.get("kill-boundary"))
    : null;
  const diskFault = options.has("disk-boundary")
    ? diskFaultModule.createRecoveryDiskFault(options.get("disk-boundary"))
    : null;
  try {
    const command = action === "recover"
      ? { action, databasePath }
      : action === "status"
        ? { action, databasePath, ...(operationId === undefined ? {} : { operationId }) }
        : { action, databasePath, operationId };
    const result = recoveryModule.runGatewayRecoveryWithLease(lease, command, {
      randomBytes16: () => Uint8Array.from({ length: 16 }, (_, index) => index),
      now: () => new Date("2026-08-31T00:00:00.000Z"),
      renameNoReplace: ({ sourcePath, destinationPath }) => {
        if (existsSync(destinationPath)) throw new Error("DESTINATION_EXISTS");
        renameSync(sourcePath, destinationPath);
      },
      validateImmutableV15: options.has("candidate-invalid")
        ? (input) => {
            if (input.databasePath.includes("/.gateway.sqlite.wal-recovery/work/candidate/")) {
              throw new Error("CANDIDATE_INVALID");
            }
            securityModule.validateImmutableGatewayV15Database(input);
          }
        : options.has("public-invalid")
          ? (input) => {
              if (input.databasePath === databasePath) throw new Error("CANDIDATE_INVALID");
              securityModule.validateImmutableGatewayV15Database(input);
            }
          : securityModule.validateImmutableGatewayV15Database,
          fault: killFault === null && diskFault === null && !options.has("snapshot-failure")
            && !options.has("candidate-failure-before-open")
            && !options.has("public-invalid")
        ? null
        : (boundary) => {
            if (
              options.has("snapshot-failure")
              && boundary === "snapshot-copy:original:wal"
            ) {
              throw new Error("SNAPSHOT_IO_FAILED");
            }
            if (
              options.has("candidate-failure-before-open")
              && boundary === "candidate-before-open"
            ) {
              throw new Error("CANDIDATE_INVALID");
            }
            killFault?.(boundary);
            diskFault?.(boundary);
          }
    });
    process.stdout.write(JSON.stringify(result));
  } finally {
    lease.close();
  }
}

if (process.argv[2] === "--engine") {
  await runEngine(process.argv.slice(3));
} else {
  if (process.argv.length !== 3) throw new Error("DATABASE_PATH_REQUIRED");
  await runWriterController(process.argv[2]);
}
