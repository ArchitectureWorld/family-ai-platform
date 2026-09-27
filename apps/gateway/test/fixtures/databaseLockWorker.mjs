import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tsImport } from "tsx/esm/api";

const {
  requireInheritedGatewayDatabaseLock,
  requireInheritedGatewayDatabaseLockForTest
} = await tsImport(
  "../../src/databaseLock.ts",
  import.meta.url
);

const [role, databasePath, readyPath, releasePath, uidRaw, gidRaw] = process.argv.slice(2);
try {
  const lease = uidRaw === undefined
    ? requireInheritedGatewayDatabaseLock({ role, databasePath })
    : requireInheritedGatewayDatabaseLockForTest(
      { role, databasePath },
      { uid: Number(uidRaw), gid: Number(gidRaw) }
    );
  try {
    if (readyPath) writeFileSync(readyPath, "ready\n", { mode: 0o600, flag: "wx" });
    process.stdout.write("GATEWAY_DATABASE_LOCK_READY\n");
    while (releasePath && !existsSync(releasePath)) await delay(10);
  } finally {
    lease.close();
  }
} catch {
  process.stderr.write("GATEWAY_DATABASE_LOCK_INVALID\n");
  process.exitCode = 1;
}
