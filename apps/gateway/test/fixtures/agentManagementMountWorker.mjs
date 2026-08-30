import { tsImport } from "tsx/esm/api";
const { AgentManagementRepository } = await tsImport("../../src/agentManagement.ts", import.meta.url);
const { openGatewayDatabase } = await tsImport("../../src/database.ts", import.meta.url);

if (typeof process.send !== "function") {
  throw new Error("Agent mount worker requires an IPC channel");
}

const input = JSON.parse(process.env.AGENT_MANAGEMENT_MOUNT_INPUT ?? "null");
const db = openGatewayDatabase(input.databasePath, {
  intent: "test-create-or-existing",
  simulate: "migrate-create-or-existing"
});
const repository = new AgentManagementRepository(db, () => new Date(input.now));

process.send({ type: "ready", pid: process.pid });
process.once("message", (message) => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "mount"
  ) {
    throw new Error("Agent mount worker received an invalid command");
  }

  process.send({ type: "mounting" });
  try {
    const mount = repository.mountMemberAgent({
      familyRef: input.familyRef,
      personRef: input.personRef,
      agentRef: input.agentRef
    });
    process.send({ type: "result", mount });
  } catch (error) {
    process.send({
      type: "error",
      code: error?.code ?? "UNKNOWN",
      message: error instanceof Error ? error.message : "unknown mount failure"
    });
  } finally {
    db.close();
    process.disconnect();
  }
});
