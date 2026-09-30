import { isAbsolute, resolve } from "node:path";
import { recoverAdminOperatorEntry } from "./adminOperatorRecovery.js";
import { openGatewayDatabase } from "./database.js";
import { requireInheritedGatewayDatabaseLock } from "./databaseLock.js";

process.umask(0o077);
const args = process.argv.slice(2);

function exactPath(value: string | undefined): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value || value === "/") {
    throw new Error("ADMIN_OPERATOR_ARGUMENTS_INVALID");
  }
  return value;
}

async function main(): Promise<void> {
  if (args.length !== 4 || args[0] !== "--database" || args[2] !== "--entry") {
    throw new Error("ADMIN_OPERATOR_ARGUMENTS_INVALID");
  }
  const databasePath = exactPath(args[1]);
  const entryPath = exactPath(args[3]);
  const lock = requireInheritedGatewayDatabaseLock({
    role: "provision", databasePath
  });
  try {
    const database = openGatewayDatabase(databasePath, { intent: "provision-existing" });
    try {
      const result = await recoverAdminOperatorEntry({ database, entryPath });
      database.assertBound();
      process.stdout.write(
        result.status === "reissued"
          ? "ADMIN_OPERATOR_REISSUED\n"
          : "ADMIN_OPERATOR_ALREADY_ACTIVE\n"
      );
    } finally {
      database.close();
    }
  } finally {
    lock.close();
  }
}

main().catch(() => {
  process.stderr.write("ADMIN_OPERATOR_RECOVERY_FAILED\n");
  process.exitCode = 1;
});
