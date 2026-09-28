import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { EntrySessionAuthenticator } from "../src/entrySessionAuth.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";
import { recoverAdminOperatorEntry } from "../src/adminOperatorRecovery.js";

const directories: string[] = [];
const databases: GatewayDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "family-admin-operator-recovery-"));
  directories.push(directory);
  const databasePath = join(directory, "gateway.sqlite");
  const entryPath = join(directory, "admin-entry.json");
  const db = openGatewayDatabase(databasePath, {
    intent: "test-create-or-existing", simulate: "migrate-create-or-existing"
  });
  databases.push(db);
  const repository = new FamilyDomainRepository(db);
  const onboarding = repository.initializeFamily({
    familyName: "恢复家庭", ownerName: "恢复管理员",
    deviceName: "本机管理设备", deviceCredential: "device-credential-for-operator-recovery"
  });
  const root = onboarding.entries.admin;
  writeFileSync(entryPath, JSON.stringify({
    version: 1, origin: "https://admin.example:8793",
    familyRef: onboarding.family.familyRef,
    personRef: onboarding.owner.personRef,
    deviceRef: onboarding.device.deviceRef,
    entryBindingRef: root.entryBindingRef,
    entrySessionRef: root.entrySessionRef,
    token: root.token
  }) + "\n", { mode: 0o600 });
  return { db, repository, root, onboarding, entryPath, directory, databasePath };
}

describe("protected operator recovery", () => {
  it("reissues a new administrator root without changing the expired session", async () => {
    const { db, repository, root, entryPath } = fixture();
    db.prepare(
      "UPDATE entry_sessions SET status = 'expired', expires_at = ? WHERE entry_session_ref = ?"
    ).run("2000-01-01T00:00:00.000Z", root.entrySessionRef);

    const result = await recoverAdminOperatorEntry({
      database: db, entryPath, now: () => new Date("2026-09-28T00:00:00.000Z")
    });
    expect(result.status).toBe("reissued");
    const updated = JSON.parse(readFileSync(entryPath, "utf8"));
    expect(updated.entrySessionRef).not.toBe(root.entrySessionRef);
    expect(updated.token).not.toBe(root.token);
    expect(db.prepare(
      "SELECT status FROM entry_sessions WHERE entry_session_ref = ?"
    ).get(root.entrySessionRef)).toEqual({ status: "expired" });
    const authentication = new EntrySessionAuthenticator(db, repository)
      .authenticate(updated.entrySessionRef, updated.token);
    expect(authentication.status).toBe("authenticated");
    expect(db.prepare(
      "SELECT expires_at FROM entry_sessions WHERE entry_session_ref = ?"
    ).get(updated.entrySessionRef)).toEqual({
      expires_at: "9999-12-31T23:59:59.999Z"
    });

    const repeat = await recoverAdminOperatorEntry({ database: db, entryPath });
    expect(repeat.status).toBe("already-active");
    expect(JSON.parse(readFileSync(entryPath, "utf8")).entrySessionRef)
      .toBe(updated.entrySessionRef);
  });

  it("reissues an old active row whose deadline passed before any authentication request", async () => {
    const { db, root, entryPath } = fixture();
    db.prepare(
      "UPDATE entry_sessions SET expires_at = ? WHERE entry_session_ref = ?"
    ).run("2000-01-01T00:00:00.000Z", root.entrySessionRef);
    expect(db.prepare(
      "SELECT status FROM entry_sessions WHERE entry_session_ref = ?"
    ).get(root.entrySessionRef)).toEqual({ status: "active" });
    const result = await recoverAdminOperatorEntry({
      database: db, entryPath, now: () => new Date("2026-09-28T00:00:00.000Z")
    });
    expect(result.status).toBe("reissued");
    expect(db.prepare(
      "SELECT status FROM entry_sessions WHERE entry_session_ref = ?"
    ).get(root.entrySessionRef)).toEqual({ status: "expired" });
    const updated = JSON.parse(readFileSync(entryPath, "utf8"));
    expect(updated.entrySessionRef).not.toBe(root.entrySessionRef);
  });

  it("rejects revoked roots, revoked devices, and mismatched protected tokens", async () => {
    const revokedRoot = fixture();
    revokedRoot.db.prepare(
      "UPDATE entry_sessions SET status = 'revoked' WHERE entry_session_ref = ?"
    ).run(revokedRoot.root.entrySessionRef);
    await expect(recoverAdminOperatorEntry({
      database: revokedRoot.db, entryPath: revokedRoot.entryPath
    })).rejects.toThrow("ADMIN_OPERATOR_RECOVERY_INVALID");

    const revokedDevice = fixture();
    revokedDevice.db.prepare(
      "UPDATE entry_sessions SET status = 'expired' WHERE entry_session_ref = ?"
    ).run(revokedDevice.root.entrySessionRef);
    revokedDevice.db.prepare(
      "UPDATE managed_devices SET status = 'revoked' WHERE device_ref = ?"
    ).run(revokedDevice.onboarding.device.deviceRef);
    await expect(recoverAdminOperatorEntry({
      database: revokedDevice.db, entryPath: revokedDevice.entryPath
    })).rejects.toThrow("ADMIN_OPERATOR_RECOVERY_INVALID");

    const mismatchedIdentity = fixture();
    mismatchedIdentity.db.prepare(
      "UPDATE entry_sessions SET status = 'expired' WHERE entry_session_ref = ?"
    ).run(mismatchedIdentity.root.entrySessionRef);
    const wrongIdentity = JSON.parse(readFileSync(mismatchedIdentity.entryPath, "utf8"));
    wrongIdentity.personRef = "person:another";
    writeFileSync(
      mismatchedIdentity.entryPath, JSON.stringify(wrongIdentity) + "\n", { mode: 0o600 }
    );
    await expect(recoverAdminOperatorEntry({
      database: mismatchedIdentity.db, entryPath: mismatchedIdentity.entryPath
    })).rejects.toThrow("ADMIN_OPERATOR_RECOVERY_INVALID");

    const mismatched = fixture();
    mismatched.db.prepare(
      "UPDATE entry_sessions SET status = 'expired' WHERE entry_session_ref = ?"
    ).run(mismatched.root.entrySessionRef);
    const document = JSON.parse(readFileSync(mismatched.entryPath, "utf8"));
    document.token = "A".repeat(43);
    writeFileSync(mismatched.entryPath, JSON.stringify(document) + "\n", { mode: 0o600 });
    await expect(recoverAdminOperatorEntry({
      database: mismatched.db, entryPath: mismatched.entryPath
    })).rejects.toThrow("ADMIN_OPERATOR_RECOVERY_INVALID");
  });

  it("preflights the active operator session before generating a code", () => {
    const { db, root, entryPath, directory, databasePath } = fixture();
    const script = join(process.cwd(), "../../scripts/admin-production-activate.mjs");
    const output = join(directory, "activation.json");
    const args = [
      script, "--database", databasePath, "--entry", entryPath,
      "--output", output
    ];
    const active = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(active.status).toBe(0);
    expect(active.stdout.trim()).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/u);
    expect(existsSync(output)).toBe(true);

    db.prepare("UPDATE entry_sessions SET status = 'expired' WHERE entry_session_ref = ?")
      .run(root.entrySessionRef);
    const expiredOutput = join(directory, "expired-code.json");
    const expired = spawnSync(process.execPath, [
      script, "--database", databasePath, "--entry", entryPath,
      "--output", expiredOutput
    ], { encoding: "utf8" });
    expect(expired.status).toBe(1);
    expect(expired.stdout).toBe("");
    expect(existsSync(expiredOutput)).toBe(false);
    const missingDatabase = spawnSync(process.execPath, [
      script, "--entry", entryPath, "--output", expiredOutput
    ], { encoding: "utf8" });
    expect(missingDatabase.status).toBe(1);
    expect(existsSync(expiredOutput)).toBe(false);
  });

  it("refuses the operator CLI without the inherited exclusive database lock", () => {
    const { db, root, entryPath, databasePath } = fixture();
    db.prepare(
      "UPDATE entry_sessions SET status = 'expired' WHERE entry_session_ref = ?"
    ).run(root.entrySessionRef);
    const direct = spawnSync(process.execPath, [
      "--import", "tsx",
      join(process.cwd(), "src/adminOperatorCli.ts"),
      "--database", databasePath, "--entry", entryPath
    ], { encoding: "utf8" });
    expect(direct.status).toBe(1);
    expect(direct.stdout).toBe("");
    expect(direct.stderr).toContain("ADMIN_OPERATOR_RECOVERY_FAILED");
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM entry_sessions WHERE entry_binding_ref = ?"
    ).get(root.entryBindingRef)).toEqual({ count: 1 });
  });

  it("restores the old protected file when syncing its directory fails after rename", async () => {
    const { db, root, entryPath } = fixture();
    db.prepare(
      "UPDATE entry_sessions SET status = 'expired' WHERE entry_session_ref = ?"
    ).run(root.entrySessionRef);
    const before = readFileSync(entryPath);
    await expect(recoverAdminOperatorEntry({
      database: db, entryPath,
      checkpoint: stage => {
        if (stage === "afterRenameBeforeSync") {
          throw new Error("TEST_DIRECTORY_SYNC_FAILURE");
        }
      }
    })).rejects.toThrow("TEST_DIRECTORY_SYNC_FAILURE");
    expect(readFileSync(entryPath)).toEqual(before);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM entry_sessions WHERE entry_binding_ref = ?"
    ).get(root.entryBindingRef)).toEqual({ count: 1 });
  });

  it("restores the old protected file and rolls back when replacement fails", async () => {
    const { db, root, entryPath } = fixture();
    db.prepare(
      "UPDATE entry_sessions SET status = 'expired' WHERE entry_session_ref = ?"
    ).run(root.entrySessionRef);
    const before = readFileSync(entryPath);
    await expect(recoverAdminOperatorEntry({
      database: db, entryPath,
      checkpoint: stage => {
        if (stage === "afterReplace") throw new Error("TEST_REPLACE_FAILURE");
      }
    })).rejects.toThrow("TEST_REPLACE_FAILURE");
    expect(readFileSync(entryPath)).toEqual(before);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM entry_sessions WHERE entry_binding_ref = ?"
    ).get(root.entryBindingRef)).toEqual({ count: 1 });
  });
});
