import { resolve } from "node:path";
import { requireInheritedGatewayDatabaseLock } from "./databaseLock.js";

process.umask(0o077);
const launchDatabasePath = resolve(
  process.env.GATEWAY_DATABASE_PATH ?? ".runtime/data/gateway.sqlite"
);

let launchLock;
try {
  launchLock = requireInheritedGatewayDatabaseLock({
    role: "gateway",
    databasePath: launchDatabasePath
  });
} catch {
  process.stderr.write("GATEWAY_DATABASE_LOCK_INVALID\n");
  process.exit(1);
}

try {
  const [{ buildGatewayApp }, { buildProviderRuntime, loadGatewayConfig }] =
    await Promise.all([import("./app.js"), import("./config.js")]);
  const config = loadGatewayConfig();
  if (config.databasePath !== launchDatabasePath) {
    throw new Error("GATEWAY_DATABASE_LOCK_INVALID");
  }
  const runtime = buildProviderRuntime(config.providerRuntime);
  const app = await buildGatewayApp({
    databaseOpenRequest: { intent: "gateway-existing" },
    databasePath: config.databasePath,
    attachmentRoot: config.attachmentRoot,
    attachmentQuotaBytes: config.attachmentQuotaBytes,
    deviceToken: config.deviceToken,
    mode: config.mode,
    providerRouter: runtime.router,
    configuredAgentRuntimes: runtime.agents,
    authoritativeAgentRuntimeCatalog: runtime.authoritative,
    ...(config.canvasBaseUrl === undefined
      ? {}
      : {
          canvasBaseUrl: config.canvasBaseUrl,
          canvasAllowContainerService: config.canvasAllowContainerService
        }),
    ...(config.previewAdminEntryPath === undefined
      ? {}
      : {
          previewAdminEntryPath: config.previewAdminEntryPath,
          previewAdminOrigin: config.previewAdminOrigin!
        })
  });
  app.addHook("onClose", async () => launchLock.close());

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down Family AI Gateway");
    await app.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  launchLock.close();
  if (error instanceof Error && error.message === "GATEWAY_DATABASE_LOCK_INVALID") {
    process.stderr.write("GATEWAY_DATABASE_LOCK_INVALID\n");
  }
  throw error;
}
