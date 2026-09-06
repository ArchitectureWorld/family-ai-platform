// Test-only fault process. Mounted separately for image gates; never copied to runtime.
import { dirname } from "node:path";
import { requireInheritedGatewayDatabaseLock } from "../../dist/databaseLock.js";
import { createClaimedRecoveryLockLeaseForTest, runGatewayRecoveryWithLease } from "../../dist/databaseRecovery.js";
import { renameGatewayRecoveryNoReplace } from "../../dist/databaseRecoveryRuntime.js";
import { validateImmutableGatewayV15Database } from "../../dist/databaseSecurity.js";

const [databasePath, action, operationId, target, faultKind] = process.argv.slice(2);
const inherited = requireInheritedGatewayDatabaseLock({ role: "recovery", databasePath });
try {
  const lease = createClaimedRecoveryLockLeaseForTest(Object.assign(inherited, { databasePath }));
  const result = runGatewayRecoveryWithLease(lease, {
    databasePath, action, ...(action === "recover" ? {} : { operationId })
  }, {
    randomBytes16: () => Uint8Array.from({ length: 16 }, (_, i) => i),
    now: () => new Date(),
    renameNoReplace: paths => renameGatewayRecoveryNoReplace(dirname(databasePath), paths),
    validateImmutableV15: validateImmutableGatewayV15Database,
    fault: boundary => {
      if (boundary === target) process.kill(process.pid, "SIGKILL");
      if (faultKind === "candidate" && boundary === "candidate-before-open") throw new Error("CANDIDATE_INVALID");
      if (faultKind === "snapshot" && boundary === "snapshot-copy:original:wal") throw new Error("SNAPSHOT_IO_FAILED");
    }
  });
  process.stdout.write(JSON.stringify(result));
} finally {
  inherited.close();
}
