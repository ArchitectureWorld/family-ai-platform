import { tsImport } from "tsx/esm/api";

const { requireInheritedGatewayDatabaseLock } = await tsImport(
  "../../src/databaseLock.ts",
  import.meta.url
);
const [flag, databasePath] = process.argv.slice(2);
if (flag !== "--database" || !databasePath) process.exit(2);
const lock = requireInheritedGatewayDatabaseLock({ role: "migrate", databasePath });
try {
  process.stdout.write("GATEWAY_DATABASE_LOCK_PROBE_OK\n");
} finally {
  lock.close();
}
