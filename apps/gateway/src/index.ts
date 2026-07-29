import { buildGatewayApp } from "./app.js";
import {
  buildProviderRuntime,
  loadGatewayConfig
} from "./config.js";

const config = loadGatewayConfig();
const runtime = buildProviderRuntime(config.providerRuntime);
const app = await buildGatewayApp({
  databasePath: config.databasePath,
  attachmentRoot: config.attachmentRoot,
  attachmentQuotaBytes: config.attachmentQuotaBytes,
  deviceToken: config.deviceToken,
  mode: config.mode,
  providerRouter: runtime.router,
  configuredAgentRuntimes: runtime.agents,
  authoritativeAgentRuntimeCatalog: runtime.authoritative,
  ...(config.previewAdminEntryPath === undefined
    ? {}
    : {
        previewAdminEntryPath: config.previewAdminEntryPath,
        previewAdminOrigin: config.previewAdminOrigin!
      })
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down Family AI Gateway");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
