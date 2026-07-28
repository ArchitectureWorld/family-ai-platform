import { parentPort, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";
const { AgentManagementRepository } = await tsImport("../../src/agentManagement.ts", import.meta.url);
const { openGatewayDatabase } = await tsImport("../../src/database.ts", import.meta.url);

const port = parentPort;
if (!port) throw new Error("Agent mount worker requires a parent port");

const input = workerData;
const db = openGatewayDatabase(input.databasePath);
const repository = new AgentManagementRepository(db, () => new Date(input.now));

port.postMessage({ type: "ready" });
port.once("message", (message) => {
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
    port.postMessage({
      type: "error",
      code: error?.code ?? "UNKNOWN",
      message: error instanceof Error ? error.message : "unknown mount failure"
    });
  } finally {
    db.close();
  }
});
