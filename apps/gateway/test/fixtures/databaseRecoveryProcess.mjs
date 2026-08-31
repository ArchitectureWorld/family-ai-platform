import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 3) throw new Error("DATABASE_PATH_REQUIRED");
const writer = fileURLToPath(new URL("./databaseRecoveryCrashWriter.mjs", import.meta.url));
const child = spawn(process.execPath, [writer, process.argv[2]], {
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
