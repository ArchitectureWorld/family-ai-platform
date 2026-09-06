import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { GatewayRecoveryRename } from "./databaseRecovery.js";

const helper = fileURLToPath(new URL("../runtime/rename_noreplace.py", import.meta.url));

function invoke(frame: unknown): string {
  const result = spawnSync("python3", [helper], {
    input: JSON.stringify(frame), encoding: "utf8", env: { PATH: "/usr/bin:/bin" },
    maxBuffer: 1024, timeout: 10_000
  });
  if (result.error || result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error("NOREPLACE_UNSUPPORTED");
  }
  return result.stdout;
}

export function renameGatewayRecoveryNoReplace(runtimeDirectory: string, input: GatewayRecoveryRename): void {
  const output = invoke({ protocolVersion: 1, runtimeDirectory,
    source: input.sourcePath, destination: input.destinationPath });
  if (output === '{"status":"renamed"}\n') return;
  if (output === '{"status":"destination_exists"}\n') throw new Error("DESTINATION_EXISTS");
  if (output === '{"status":"unsupported"}\n') throw new Error("NOREPLACE_UNSUPPORTED");
  throw new Error("NOREPLACE_FAILED");
}

export function checkGatewayRecoveryRuntime(): void {
  if (invoke({}) !== '{"status":"invalid"}\n') throw new Error("NOREPLACE_UNSUPPORTED");
  const result = spawnSync("python3", ["-c", "import ctypes;ctypes.CDLL(None).renameat2"], {
    env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10_000, maxBuffer: 1024
  });
  if (result.error || result.status !== 0 || result.stdout !== "" || result.stderr !== "") {
    throw new Error("NOREPLACE_UNSUPPORTED");
  }
}
