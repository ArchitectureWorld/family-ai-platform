import { parentPort, workerData } from "node:worker_threads";
import { AgentManagementRepository } from "../../src/agentManagement.js";
import { openGatewayDatabase } from "../../src/database.js";

type WorkerInput = {
  databasePath: string;
  familyRef: string;
  personRef: string;
  agentRef: string;
  now: string;
};

const port = parentPort;
if (!port) throw new Error("Agent mount worker requires a parent port");

const input = workerData as WorkerInput;
const db = openGatewayDatabase(input.databasePath);
const repository = new AgentManagementRepository(db, () => new Date(input.now));

port.postMessage({ type: "ready" });
port.once("message", (message: unknown) => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "mount"
  ) {
    throw new Error("Agent mount worker received an invalid command");
  }

  port.postMessage({ type: "mounting" });
  try {
    const mount = repository.mountMemberAgent({
      familyRef: input.familyRef,
      personRef: input.personRef,
      agentRef: input.agentRef
    });
    port.postMessage({ type: "result", mount });
  } catch (error) {
    const sqliteError = error as Error & { code?: string };
    port.postMessage({
      type: "error",
      code: sqliteError.code ?? "UNKNOWN",
      message: sqliteError.message
    });
  } finally {
    db.close();
  }
});
