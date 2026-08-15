import { resolve } from "node:path";
import { openGatewayDatabase } from "./database.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--database") {
  throw new Error("MIGRATION_ONLY_INVALID_ARGUMENTS");
}
const databasePath = resolve(args[1]!);
if (databasePath !== args[1] || databasePath === "/") {
  throw new Error("MIGRATION_ONLY_DATABASE_PATH_INVALID");
}
const database = openGatewayDatabase(databasePath);
try {
  const quick = database.pragma("quick_check", { simple: true });
  const foreign = database.pragma("foreign_key_check") as unknown[];
  const schema = database
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number };
  if (quick !== "ok" || foreign.length !== 0 || schema.version !== 9) {
    throw new Error("MIGRATION_ONLY_VALIDATION_FAILED");
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: schema.version, quickCheck: quick, foreignKeyViolations: 0 })}\n`);
} finally {
  database.close();
}
