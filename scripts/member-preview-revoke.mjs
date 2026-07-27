import Database from "better-sqlite3";
import { chmod, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadOrInitializePreviewAdmin,
  previewInternals,
  previewJsonRequest
} from "./member-preview-pair.mjs";

const { REF, adminHeaders, prepareRuntime, readProtectedJson, requireExact, requireIso, requireString } =
  previewInternals;

class RevokeError extends Error {
  constructor(code) {
    super(code);
    this.name = "RevokeError";
    this.code = code;
  }
}

function fail(code) {
  throw new RevokeError(code);
}

function validatePairingTarget(value) {
  requireExact(
    value,
    ["protocolVersion", "pairingRef", "expiresAt"],
    "PREVIEW_REVOKE_TARGET_INVALID"
  );
  if (value.protocolVersion !== 2) fail("PREVIEW_REVOKE_TARGET_INVALID");
  requireString(value.pairingRef, REF.pairing, "PREVIEW_REVOKE_TARGET_INVALID");
  requireIso(value.expiresAt, "PREVIEW_REVOKE_TARGET_INVALID");
  return value;
}

async function validateDatabasePath(databasePath) {
  let info;
  try {
    info = await lstat(databasePath);
  } catch {
    fail("PREVIEW_DATABASE_INVALID");
  }
  if (!info.isFile() || info.isSymbolicLink()) fail("PREVIEW_DATABASE_INVALID");
  await chmod(databasePath, 0o600);
}

function requireDeviceRow(rows, admin) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail("PREVIEW_REVOKE_DEVICE_INVALID");
  }
  const row = rows[0];
  requireExact(row, [
    "pairing_status",
    "device_ref",
    "device_status",
    "terminal_type",
    "platform",
    "binding_family_ref",
    "binding_person_ref",
    "owner_scope",
    "binding_status"
  ], "PREVIEW_REVOKE_DEVICE_INVALID");
  requireString(row.device_ref, REF.device, "PREVIEW_REVOKE_DEVICE_INVALID");
  if (
    row.pairing_status !== "consumed" ||
    row.device_status !== "active" ||
    row.terminal_type !== "web" ||
    row.platform !== "browser" ||
    row.binding_family_ref !== admin.familyRef ||
    row.binding_person_ref !== admin.personRef ||
    row.owner_scope !== "person" ||
    row.binding_status !== "active"
  ) fail("PREVIEW_REVOKE_DEVICE_INVALID");
  return row.device_ref;
}

function findConsumedWebDevice(databasePath, pairingRef, admin) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = database.prepare(
      `SELECT p.status AS pairing_status,
              p.consumed_device_ref AS device_ref,
              d.status AS device_status,
              d.terminal_type,
              d.platform,
              b.family_ref AS binding_family_ref,
              b.person_ref AS binding_person_ref,
              b.owner_scope,
              b.status AS binding_status
       FROM mobile_pairing_codes AS p
       LEFT JOIN managed_devices AS d
         ON d.device_ref = p.consumed_device_ref
       LEFT JOIN device_bindings AS b
         ON b.device_ref = d.device_ref
        AND b.status = 'active'
       WHERE p.pairing_ref = ?
         AND p.family_ref = ?
         AND p.person_ref = ?`
    ).all(pairingRef, admin.familyRef, admin.personRef);
    return requireDeviceRow(rows, admin);
  } catch (error) {
    if (error instanceof RevokeError) throw error;
    fail("PREVIEW_REVOKE_DATABASE_READ_FAILED");
  } finally {
    database.close();
  }
}

function validateRevokeResponse(value) {
  requireExact(value, ["protocolVersion", "status"], "PREVIEW_REVOKE_RESPONSE_INVALID");
  if (value.protocolVersion !== 1 || value.status !== "revoked") {
    fail("PREVIEW_REVOKE_RESPONSE_INVALID");
  }
}

export async function revokeMemberPreviewDevice(options = {}) {
  if (options.port !== 8791) fail("PREVIEW_REVOKE_ARGUMENTS_INVALID");
  const origin = options.origin ?? "http://127.0.0.1:8791";
  const admin = await loadOrInitializePreviewAdmin({
    origin,
    runtimeDir: options.runtimeDir,
    fetchImpl: options.fetchImpl
  });
  const paths = await prepareRuntime(admin.runtimeDir);
  const target = await readProtectedJson(
    join(paths.configDir, "pairing-target-8791.json"),
    validatePairingTarget
  );
  const databasePath = join(paths.dataDir, "gateway.sqlite");
  await validateDatabasePath(databasePath);
  const deviceRef = findConsumedWebDevice(
    databasePath,
    target.pairingRef,
    admin
  );
  const response = await previewJsonRequest(
    origin,
    `/api/v1/admin/devices/${encodeURIComponent(deviceRef)}`,
    {
      fetchImpl: options.fetchImpl,
      method: "DELETE",
      headers: adminHeaders(admin)
    }
  );
  if (response.status !== 200) fail("PREVIEW_REVOKE_RESPONSE_INVALID");
  validateRevokeResponse(response.body);
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--port" || argv[1] !== "8791") {
    fail("PREVIEW_REVOKE_ARGUMENTS_INVALID");
  }
}

async function main() {
  parseCli(process.argv.slice(2));
  await revokeMemberPreviewDevice({ port: 8791 });
  process.stdout.write("Preview Web Device revoke: PASS\n");
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch {
    process.stderr.write("PREVIEW_REVOKE_FAILED\n");
    process.exitCode = 1;
  }
}
