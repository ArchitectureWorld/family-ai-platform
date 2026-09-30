import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readProtectedAdminEntry } from "./adminProductionActivation.js";
import { sha256, type GatewayDatabase } from "./database.js";
import { ADMIN_ENTRY_EXPIRES_AT } from "./familyDomain.js";

type RecoveryStage = "beforeReplace" | "afterRenameBeforeSync" | "afterReplace";

interface RecoveryRow {
  token_hash: string;
  status: "active" | "expired" | "revoked";
  expires_at: string;
  entry_binding_ref: string;
  family_ref: string;
  person_ref: string;
  device_ref: string;
}

function invalid(): never {
  throw new Error("ADMIN_OPERATOR_RECOVERY_INVALID");
}

function hashMatches(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicProtectedWrite(
  path: string,
  bytes: Buffer,
  afterRename?: () => void
): Promise<void> {
  const temporary = path + ".tmp." + randomUUID();
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await syncFile(temporary);
    await rename(temporary, path);
    afterRename?.();
    await syncDirectory(path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function recoveryRow(db: GatewayDatabase, entrySessionRef: string): RecoveryRow | undefined {
  return db.prepare([
    "SELECT es.token_hash, es.status, es.expires_at,",
    "eb.entry_binding_ref, eb.family_ref, eb.person_ref, eb.device_ref",
    "FROM entry_sessions es",
    "JOIN entry_bindings eb ON eb.entry_binding_ref = es.entry_binding_ref",
    "AND eb.status = 'active' AND eb.audience = 'family_admin'",
    "JOIN managed_devices d ON d.device_ref = eb.device_ref AND d.status = 'active'",
    "JOIN device_bindings db ON db.device_ref = d.device_ref",
    "AND db.family_ref = eb.family_ref AND db.person_ref = eb.person_ref",
    "AND db.owner_scope = 'person' AND db.status = 'active'",
    "JOIN families f ON f.family_ref = eb.family_ref AND f.status = 'active'",
    "JOIN persons p ON p.person_ref = eb.person_ref AND p.status = 'active'",
    "JOIN family_memberships fm ON fm.family_ref = eb.family_ref",
    "AND fm.person_ref = eb.person_ref AND fm.status = 'active'",
    "WHERE es.entry_session_ref = ?"
  ].join(" ")).get(entrySessionRef) as RecoveryRow | undefined;
}

export async function recoverAdminOperatorEntry(input: {
  database: GatewayDatabase;
  entryPath: string;
  now?: () => Date;
  checkpoint?: (stage: RecoveryStage) => void;
}): Promise<{ status: "reissued" | "already-active" }> {
  const { entry, bytes: previousBytes } = await readProtectedAdminEntry(input.entryPath);
  const checkedAt = (input.now ?? (() => new Date()))();
  const nowIso = checkedAt.toISOString();
  const row = recoveryRow(input.database, entry.entrySessionRef);
  if (
    !row ||
    row.entry_binding_ref !== entry.entryBindingRef ||
    row.family_ref !== entry.familyRef ||
    row.person_ref !== entry.personRef ||
    row.device_ref !== entry.deviceRef ||
    !hashMatches(row.token_hash, sha256(entry.token)) ||
    !["active", "expired"].includes(row.status)
  ) invalid();
  if (row.status === "active" && row.expires_at === ADMIN_ENTRY_EXPIRES_AT) {
    return { status: "already-active" };
  }
  if (
    row.status !== "expired" &&
    !(row.status === "active" && Date.parse(row.expires_at) <= checkedAt.getTime())
  ) invalid();

  const newSessionRef = "entry-session:" + randomUUID();
  const newToken = randomBytes(32).toString("base64url");
  const nextBytes = Buffer.from(JSON.stringify({
    ...entry, entrySessionRef: newSessionRef, token: newToken
  }) + "\n");
  const backupPath = input.entryPath + ".backup." + randomUUID();
  await writeFile(backupPath, previousBytes, { mode: 0o600, flag: "wx" });
  await syncFile(backupPath);
  await syncDirectory(backupPath);

  let replaced = false;
  try {
    input.database.exec("BEGIN IMMEDIATE");
    const current = recoveryRow(input.database, entry.entrySessionRef);
    if (
      !current ||
      !(
        current.status === "expired" ||
        (current.status === "active" && Date.parse(current.expires_at) <= checkedAt.getTime())
      ) ||
      current.entry_binding_ref !== entry.entryBindingRef ||
      current.family_ref !== entry.familyRef ||
      current.person_ref !== entry.personRef ||
      current.device_ref !== entry.deviceRef ||
      !hashMatches(current.token_hash, sha256(entry.token))
    ) invalid();
    if (current.status === "active") {
      input.database.prepare(
        "UPDATE entry_sessions SET status = 'expired' WHERE entry_session_ref = ? AND status = 'active'"
      ).run(entry.entrySessionRef);
    }
    input.database.prepare([
      "INSERT INTO entry_sessions",
      "(entry_session_ref, entry_binding_ref, token_hash, status,",
      "created_at, expires_at, revoked_at)",
      "VALUES(?, ?, ?, 'active', ?, ?, NULL)"
    ].join(" ")).run(
      newSessionRef, entry.entryBindingRef, sha256(newToken),
      nowIso, ADMIN_ENTRY_EXPIRES_AT
    );
    input.checkpoint?.("beforeReplace");
    await atomicProtectedWrite(input.entryPath, nextBytes, () => {
      replaced = true;
      input.checkpoint?.("afterRenameBeforeSync");
    });
    input.checkpoint?.("afterReplace");
    input.database.exec("COMMIT");
    return { status: "reissued" };
  } catch (error) {
    if (input.database.inTransaction) input.database.exec("ROLLBACK");
    if (replaced) {
      try {
        await atomicProtectedWrite(input.entryPath, previousBytes);
      } catch {
        throw new Error("ADMIN_OPERATOR_RECOVERY_ROLLBACK_FAILED");
      }
    }
    throw error;
  }
}
