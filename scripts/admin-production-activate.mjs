import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const MAX_BYTES = 64 * 1024;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_PATTERN = /^entry-session:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const FAMILY_PATTERN = /^family:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const PERSON_PATTERN = /^person:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const DEVICE_PATTERN = /^device:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;
const BINDING_PATTERN = /^entry-binding:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === "/") {
    fail("PROTECTED_ADMIN_FILE_INVALID");
  }
  return value;
}

async function readProtectedJson(path) {
  exactPath(path);
  let parent;
  try {
    parent = await lstat(dirname(path));
  } catch {
    fail("PROTECTED_ADMIN_FILE_INVALID");
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) > 0o700) {
    fail("PROTECTED_ADMIN_FILE_INVALID");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("PROTECTED_ADMIN_FILE_INVALID");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size <= 0 || info.size > MAX_BYTES) {
      fail("PROTECTED_ADMIN_FILE_INVALID");
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()));
    } catch {
      fail("PROTECTED_ADMIN_FILE_INVALID");
    }
  } finally {
    await handle.close();
  }
}

function validateEntry(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("PROTECTED_ADMIN_ENTRY_INVALID");
  const keys = Object.keys(value).sort().join("\0");
  if (
    keys !== "deviceRef\0entryBindingRef\0entrySessionRef\0familyRef\0origin\0personRef\0token\0version" ||
    value.version !== 1 ||
    typeof value.origin !== "string" ||
    !/^https:\/\/[^/]+(?::\d+)?$/u.test(value.origin) ||
    !FAMILY_PATTERN.test(String(value.familyRef)) ||
    !PERSON_PATTERN.test(String(value.personRef)) ||
    !DEVICE_PATTERN.test(String(value.deviceRef)) ||
    !BINDING_PATTERN.test(String(value.entryBindingRef)) ||
    !SESSION_PATTERN.test(String(value.entrySessionRef)) ||
    !TOKEN_PATTERN.test(String(value.token))
  ) fail("PROTECTED_ADMIN_ENTRY_INVALID");
  return value;
}

function code(randomBytesImpl) {
  const bytes = randomBytesImpl(10);
  if (!Buffer.isBuffer(bytes) || bytes.length < 10) fail("PROTECTED_ADMIN_FILE_INVALID");
  let raw = "";
  for (const value of bytes.subarray(0, 10)) raw += CODE_ALPHABET[value % CODE_ALPHABET.length];
  const result = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  if (!CODE_PATTERN.test(result)) fail("PROTECTED_ADMIN_FILE_INVALID");
  return result;
}

function hash(salt, value) {
  return createHash("sha256").update(salt).update(value, "utf8").digest("hex");
}

async function atomicWrite(path, content) {
  exactPath(path);
  const temporary = `${path}.tmp.${randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    const handle = await open(temporary, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function validateCurrentEntry(databasePath, entry, checkedAt) {
  exactPath(databasePath);
  let database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    database.pragma("query_only = ON");
    const schema = database.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations"
    ).get();
    if (schema?.version !== 15) fail("PROTECTED_ADMIN_ENTRY_INVALID");
    const row = database.prepare([
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
    ].join(" ")).get(entry.entrySessionRef);
    const expected = Buffer.from(createHash("sha256").update(entry.token).digest("hex"), "hex");
    const stored = Buffer.from(row?.token_hash ?? "", "hex");
    if (
      !row || row.status !== "active" ||
      Date.parse(row.expires_at) <= checkedAt.getTime() ||
      row.entry_binding_ref !== entry.entryBindingRef ||
      row.family_ref !== entry.familyRef ||
      row.person_ref !== entry.personRef ||
      row.device_ref !== entry.deviceRef ||
      stored.length !== 32 ||
      !timingSafeEqual(expected, stored)
    ) fail("PROTECTED_ADMIN_ENTRY_INVALID");
  } catch {
    fail("PROTECTED_ADMIN_ENTRY_INVALID");
  } finally {
    database?.close();
  }
}

async function acquireActivationLock(path) {
  exactPath(path);
  const lockPath = `${path}.lock`;
  const handle = await open(
    lockPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  await handle.close();
  return lockPath;
}

export async function createProductionAdminActivation({
  adminEntryPath,
  activationPath,
  databasePath,
  now = () => new Date(),
  randomBytesImpl = randomBytes
} = {}) {
  const entry = validateEntry(await readProtectedJson(adminEntryPath));
  const createdAt = now();
  validateCurrentEntry(databasePath, entry, createdAt);
  const salt = randomBytesImpl(16);
  if (!Buffer.isBuffer(salt) || salt.length !== 16) fail("PROTECTED_ADMIN_FILE_INVALID");
  const activationCode = code(randomBytesImpl);
  const lockPath = await acquireActivationLock(activationPath);
  let written = false;
  try {
    await atomicWrite(
      activationPath,
      `${JSON.stringify({
        version: 2,
        createdAt: createdAt.toISOString(),
        salt: salt.toString("base64url"),
        codeHash: hash(salt, activationCode),
        failedAttempts: 0
      })}\n`
    );
    written = true;
    return { code: activationCode, outputPath: activationPath };
  } finally {
    if (written) await rm(lockPath);
  }
}

function parseArgs(argv) {
  if (
    argv.length !== 6 ||
    argv[0] !== "--database" ||
    argv[2] !== "--entry" ||
    argv[4] !== "--output"
  ) {
    fail("ADMIN_PRODUCTION_ACTIVATION_ARGUMENTS_INVALID");
  }
  return { databasePath: argv[1], adminEntryPath: argv[3], activationPath: argv[5] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await createProductionAdminActivation(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${result.code}\n`);
  } catch {
    process.stderr.write("ADMIN_PRODUCTION_ACTIVATION_FAILED\n");
    process.exitCode = 1;
  }
}

export const productionActivationInternals = Object.freeze({
  CODE_PATTERN,
  parseArgs,
  validateEntry,
  hash
});
