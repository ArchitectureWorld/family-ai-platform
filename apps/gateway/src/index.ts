import { buildGatewayApp } from "./app.js";
import { loadGatewayConfig } from "./config.js";

const config = loadGatewayConfig();
const app = await buildGatewayApp({
  databasePath: config.databasePath,
  deviceToken: config.deviceToken,
  mode: config.mode
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down Family AI Gateway");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
