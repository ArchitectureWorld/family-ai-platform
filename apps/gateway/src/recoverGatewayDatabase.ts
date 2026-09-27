import { isAbsolute, resolve } from "node:path";
import type { GatewayRecoveryCommand, GatewayRecoveryResult } from "./databaseRecovery.js";

function invalid(): never { throw new Error("GATEWAY_RECOVERY_INVALID"); }

function parse(args: string[]): GatewayRecoveryCommand {
  if (args.length % 2 !== 0) return invalid();
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    if (!["--database", "--action", "--operation-id"].includes(key) || values.has(key)) return invalid();
    values.set(key, args[i + 1]!);
  }
  const databasePath = values.get("--database");
  const action = values.get("--action");
  const operationId = values.get("--operation-id");
  if (!databasePath || databasePath.includes("\0") || !isAbsolute(databasePath)
    || databasePath === "/" || resolve(databasePath) !== databasePath) return invalid();
  if (operationId !== undefined && !/^[0-9a-f]{32}$/u.test(operationId)) return invalid();
  if (action === "recover" && operationId === undefined) return { databasePath, action };
  if (action === "status") return { databasePath, action, ...(operationId === undefined ? {} : { operationId }) };
  if ((action === "resume" || action === "retry") && operationId !== undefined) return { databasePath, action, operationId };
  return invalid();
}

function output(result: GatewayRecoveryResult): unknown {
  if (result.kind === "status") {
    return { operationId: result.operationId, state: result.state,
      ...(result.state === "initializing" ? {} : { stage: result.stage }) };
  }
  if (result.status === "aborted") throw new Error("GATEWAY_RECOVERY_FAILED");
  if (result.status === "blocked") throw new Error("GATEWAY_RECOVERY_FORWARD_RESUME_REQUIRED");
  return { status: result.status, operationId: result.operationId };
}

process.umask(0o077);
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-check") {
    const { checkGatewayRecoveryRuntime } = await import("./databaseRecoveryRuntime.js");
    checkGatewayRecoveryRuntime();
    // Load the actual built dependency graph, including native SQLite, after production prune.
    await import("./databaseRecovery.js");
    process.stdout.write("RECOVERY_SELF_CHECK_OK\n");
  } else {
    const input = parse(args);
    const { runGatewayRecovery } = await import("./databaseRecovery.js");
    process.stdout.write(`${JSON.stringify(output(runGatewayRecovery(input)))}\n`);
  }
} catch (error) {
  const code = error instanceof Error ? error.message : "";
  const publicCode = code === "GATEWAY_RECOVERY_RESUME_REQUIRED" ? "RECOVERY_RESUME_REQUIRED"
    : code === "GATEWAY_RECOVERY_FORWARD_RESUME_REQUIRED" ? "RECOVERY_FORWARD_RESUME_REQUIRED"
      : ["GATEWAY_RECOVERY_INVALID", "GATEWAY_RECOVERY_LOCK_INVALID", "GATEWAY_DATABASE_LOCK_INVALID", "METADATA_INVALID"].includes(code)
        ? "RECOVERY_INVALID" : "RECOVERY_FAILED";
  process.stderr.write(`${publicCode}\n`);
  process.exitCode = 1;
}
