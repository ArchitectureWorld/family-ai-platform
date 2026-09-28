import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  now = () => new Date(),
  randomBytesImpl = randomBytes
} = {}) {
  validateEntry(await readProtectedJson(adminEntryPath));
  const createdAt = now();
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
  if (argv.length !== 4 || argv[0] !== "--entry" || argv[2] !== "--output") {
    fail("ADMIN_PRODUCTION_ACTIVATION_ARGUMENTS_INVALID");
  }
  return { adminEntryPath: argv[1], activationPath: argv[3] };
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
