import { existsSync, writeFileSync } from "node:fs";
import { setInterval as delayInterval } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { tsImport } from "tsx/esm/api";

const { requireInheritedGatewayDatabaseLock } = await tsImport(
  "../../src/databaseLock.ts",
  import.meta.url
);
const { createGatewayProcessLifecycle } = await tsImport(
  "../../src/gatewayProcessLifecycle.ts",
  import.meta.url
);

const [databasePath, mode, readyPath, closingPath, releasePath, dbClosedPath, closeErrorPath, portRaw] =
  process.argv.slice(2);

const lock = requireInheritedGatewayDatabaseLock({ role: "gateway", databasePath });
const database = new Database(databasePath);
const app = Fastify({ logger: false });
app.addHook("onClose", async () => {
  database.close();
  writeFileSync(dbClosedPath, "closed\n", { mode: 0o600, flag: "wx" });
});
app.addHook("onClose", async () => {
  writeFileSync(closingPath, "closing\n", { mode: 0o600, flag: "wx" });
  while (!existsSync(releasePath)) await delay(10);
  if (mode === "throw") throw new Error("fixture close failure");
});
const lifecycle = createGatewayProcessLifecycle({ app, lock });

let shutdown;
const requestShutdown = () => {
  shutdown ??= lifecycle.close().then(
    () => process.exit(0),
    () => {
      writeFileSync(closeErrorPath, "error\n", { mode: 0o600, flag: "wx" });
    }
  );
};
process.on("SIGINT", requestShutdown);
process.on("SIGTERM", requestShutdown);
delayInterval(() => undefined, 60_000);

writeFileSync(readyPath, "ready\n", { mode: 0o600, flag: "wx" });
if (mode === "listen-failure") {
  try {
    await app.listen({ host: "127.0.0.1", port: Number(portRaw) });
    process.exit(70);
  } catch {
    try {
      await lifecycle.close();
    } catch {
      process.exit(71);
    }
    process.exit(1);
  }
} else {
  await new Promise(() => undefined);
}
