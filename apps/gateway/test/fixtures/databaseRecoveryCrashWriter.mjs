import Database from "better-sqlite3";

if (process.argv.length !== 3) throw new Error("DATABASE_PATH_REQUIRED");
process.umask(0o077);
const database = new Database(process.argv[2], { fileMustExist: true });
database.pragma("journal_mode = WAL");
database.pragma("wal_autocheckpoint = 0");
const insert = database.prepare(`
  INSERT INTO families(family_ref, display_name, status, created_at, updated_at)
  VALUES (?, ?, 'active', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
`);
insert.run("family:recovery-committed", "Recovery committed");
database.exec("BEGIN IMMEDIATE");
insert.run("family:recovery-uncommitted", "Recovery uncommitted");
process.stdout.write("RECOVERY_WRITER_READY\n");
// Keep the native connection and uncommitted transaction alive until SIGKILL.
// A timer that does not capture the database lets GC close it and remove WAL.
setInterval(() => {
  if (!database.open || !database.inTransaction) {
    throw new Error("RECOVERY_WRITER_TRANSACTION_LOST");
  }
}, 60_000);
