import { resolve } from "node:path";
import { openGatewayDatabase } from "./database.js";
import { requireInheritedGatewayDatabaseLock } from "./databaseLock.js";

process.umask(0o077);
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--database") {
  throw new Error("MIGRATION_ONLY_INVALID_ARGUMENTS");
}
const databasePath = resolve(args[1]!);
if (databasePath !== args[1] || databasePath === "/") {
  throw new Error("MIGRATION_ONLY_DATABASE_PATH_INVALID");
}
let launchLock;
try {
  launchLock = requireInheritedGatewayDatabaseLock({ role: "migrate", databasePath });
} catch {
  process.stderr.write("GATEWAY_DATABASE_LOCK_INVALID\n");
  process.exit(1);
}
try {
  const database = openGatewayDatabase(databasePath, {
    intent: "migrate-create-or-existing"
  });
  try {
    const quick = database.pragma("quick_check", { simple: true });
    const foreign = database.pragma("foreign_key_check") as unknown[];
    const schema = database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    if (quick !== "ok" || foreign.length !== 0 || schema.version !== 15) {
      throw new Error("MIGRATION_ONLY_VALIDATION_FAILED");
    }
    process.stdout.write(`${JSON.stringify({ schemaVersion: schema.version, quickCheck: quick, foreignKeyViolations: 0 })}\n`);
  } finally {
    database.close();
  }
} finally {
  launchLock.close();
}
