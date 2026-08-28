import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentBroker } from "./server.js";

export * from "./catalog.js";
export * from "./server.js";

const HERMES_PYTHON = join(
  "/home",
  "youran",
  ".hermes",
  "hermes-agent",
  "venv",
  "bin",
  "python"
);

export async function startAgentBrokerFromEnvironment(): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const runtimeDirectory =
    process.env.RUNTIME_DIRECTORY ??
    `/run/user/${uid}/family-ai-agent-broker`;
  const broker = createAgentBroker({
    runtimeDirectory,
    socketPath: join(runtimeDirectory, "agent-broker.sock"),
    executable: HERMES_PYTHON,
    prefixArgs: ["-m", "hermes_cli.main"],
    logger: (entry) => {
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    }
  });
  await broker.start();

  const shutdown = async () => {
    await broker.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  await startAgentBrokerFromEnvironment();
}
