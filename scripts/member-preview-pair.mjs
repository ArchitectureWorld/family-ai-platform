import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  unlink
} from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeMemberHandoff } from "./write-member-handoff.mjs";

const MAX_JSON_BYTES = 64 * 1024;
const LOCK_RETRIES = 400;
const EXPECTED_USER = "youran";
const EXPECTED_HOST = "Admin-YR";
const EXPECTED_BRANCH = "fix/member-web-entry-hardening";
const WORKTREE_RELATIVE = join(
  "Development",
  "family-ai-platform-worktrees",
  "member-web-entry-hardening"
);
const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REF = Object.freeze({
  family: /^family:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u,
  person: /^person:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u,
  device: /^device:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u,
  binding: /^entry-binding:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u,
  session: /^entry-session:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u,
  pairing: /^pairing:[a-z0-9][a-z0-9._:-]{1,126}$/u,
  token: /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u,
  pairingCode: /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u
});

class PreviewError extends Error {
  constructor(code) {
    super(code);
    this.name = "PreviewError";
    this.code = code;
  }
}

function fail(code) {
  throw new PreviewError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function requireExact(value, keys, code) {
  if (!hasExactKeys(value, keys)) fail(code);
  return value;
}

function requireString(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function requireDisplayString(value, code) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    fail(code);
  }
  return value;
}

function requireIso(value, code) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(code);
  return value;
}

function normalizeOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("PREVIEW_ORIGIN_INVALID");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port === ""
  ) fail("PREVIEW_ORIGIN_INVALID");
  return parsed.origin;
}

function gitOutput(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    fail("PREVIEW_BOUNDARY_INVALID");
  }
}

async function resolveDefaultRuntime() {
  const account = userInfo();
  const shortHost = hostname().split(".", 1)[0];
  if (account.username !== EXPECTED_USER || shortHost !== EXPECTED_HOST) {
    fail("PREVIEW_BOUNDARY_INVALID");
  }
  const approved = await realpath(join(account.homedir, WORKTREE_RELATIVE)).catch(() => null);
  const root = await realpath(SCRIPT_ROOT).catch(() => null);
  if (!approved || !root || root !== approved) fail("PREVIEW_BOUNDARY_INVALID");
  if (
    gitOutput(root, ["rev-parse", "--show-toplevel"]) !== root ||
    gitOutput(root, ["branch", "--show-current"]) !== EXPECTED_BRANCH
  ) fail("PREVIEW_BOUNDARY_INVALID");
  return { root, runtimeDir: join(root, ".runtime-preview") };
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("PREVIEW_RUNTIME_INVALID");
  await chmod(path, 0o700);
  return realpath(path);
}

async function prepareRuntime(runtimeDirOption) {
  let root;
  let runtimeDir;
  if (runtimeDirOption === undefined) {
    ({ root, runtimeDir } = await resolveDefaultRuntime());
    process.chdir(root);
  } else {
    if (typeof runtimeDirOption !== "string" || runtimeDirOption === "") {
      fail("PREVIEW_RUNTIME_INVALID");
    }
    runtimeDir = resolve(runtimeDirOption);
    root = resolve(runtimeDir, "..");
  }
  await ensureDirectory(runtimeDir);
  const configDir = await ensureDirectory(join(runtimeDir, "config"));
  const dataDir = await ensureDirectory(join(runtimeDir, "data"));
  const runDir = await ensureDirectory(join(runtimeDir, "run"));
  const logsDir = await ensureDirectory(join(runtimeDir, "logs"));
  return { root, runtimeDir: await realpath(runtimeDir), configDir, dataDir, runDir, logsDir };
}

async function protectedFile(
  path,
  { required = true, maxBytes = MAX_JSON_BYTES, preserveMissing = false } = {}
) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    if (preserveMissing && error?.code === "ENOENT") throw error;
    fail("PREVIEW_PROTECTED_FILE_INVALID");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    fail("PREVIEW_PROTECTED_FILE_INVALID");
  }
  await chmod(path, 0o600);
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) fail("PREVIEW_PROTECTED_FILE_INVALID");
  return bytes;
}

async function readProtectedJson(path, validator, { required = true } = {}) {
  const bytes = await protectedFile(path, { required });
  if (bytes === null) return null;
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("PREVIEW_JSON_INVALID");
  }
  return validator(value);
}

async function removeIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function atomicProtectedText(path, value) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES
  ) {
    fail("PREVIEW_PROTECTED_TEXT_INVALID");
  }
  const parent = await ensureDirectory(dirname(path));
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(value, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await removeIfPresent(temporary);
  }
}

async function atomicProtectedJson(path, value) {
  return atomicProtectedText(path, `${JSON.stringify(value)}\n`);
}

function processStarttimeFromStat(bytes) {
  const close = bytes.lastIndexOf(") ");
  if (close < 0) fail("PREVIEW_LOCK_AMBIGUOUS");
  const fields = bytes.slice(close + 2).trim().split(/\s+/u);
  const starttime = fields[19];
  if (!/^\d+$/u.test(starttime ?? "")) fail("PREVIEW_LOCK_AMBIGUOUS");
  return starttime;
}

async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail("PREVIEW_LOCK_AMBIGUOUS");
  let statBytes;
  try {
    statBytes = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("PREVIEW_LOCK_AMBIGUOUS");
  }
  const starttime = processStarttimeFromStat(statBytes);
  const cwd = await realpath(`/proc/${pid}/cwd`).catch(() => fail("PREVIEW_LOCK_AMBIGUOUS"));
  return { starttime, cwd };
}

function validateLockOwner(value) {
  requireExact(value, ["version", "pid", "starttime", "cwd", "lockId"], "PREVIEW_LOCK_AMBIGUOUS");
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !/^\d+$/u.test(value.starttime) ||
    typeof value.cwd !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(value.lockId)
  ) fail("PREVIEW_LOCK_AMBIGUOUS");
  return value;
}

async function acquireAdminLock(paths, hooks = {}) {
async function retryMissingLockOwner(lockPath, ownerPath) {
  let lockInfo;
  try {
    lockInfo = await lstat(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") fail("PREVIEW_LOCK_AMBIGUOUS");
    await new Promise(resolve => setTimeout(resolve, 25));
    return true;
  }
  if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()) {
    fail("PREVIEW_LOCK_AMBIGUOUS");
  }
  try {
    await lstat(ownerPath);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT") fail("PREVIEW_LOCK_AMBIGUOUS");
  }
  if (Date.now() - lockInfo.mtimeMs < 1000) {
    await new Promise(resolve => setTimeout(resolve, 25));
    return true;
  }
  return false;
}

  const lockPath = join(paths.runDir, "admin-init.lock");
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await chmod(lockPath, 0o700);
      const identity = await processIdentity(process.pid);
      if (!identity) fail("PREVIEW_LOCK_AMBIGUOUS");
      const owner = {
        version: 1,
        pid: process.pid,
        starttime: identity.starttime,
        cwd: identity.cwd,
        lockId: randomUUID()
      };
      await atomicProtectedJson(join(lockPath, "owner.json"), owner);
      return { lockPath, owner };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const ownerPath = join(lockPath, "owner.json");
      let ownerInfo;
      try {
        ownerInfo = await lstat(ownerPath);
      } catch (ownerError) {
        if (ownerError?.code === "ENOENT") {
          let lockInfo;
          try {
            lockInfo = await lstat(lockPath);
          } catch (lockError) {
            if (lockError?.code === "ENOENT") continue;
            fail("PREVIEW_LOCK_AMBIGUOUS");
          }
          if (Date.now() - lockInfo.mtimeMs < 1000) {
            await new Promise(resolve => setTimeout(resolve, 25));
            continue;
          }
        }
        fail("PREVIEW_LOCK_AMBIGUOUS");
      }
      if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink()) {
        fail("PREVIEW_LOCK_AMBIGUOUS");
      }
      let before;
      try {
        before = await protectedFile(ownerPath, { preserveMissing: true });
      } catch (error) {
        if (
          error?.code === "ENOENT" &&
          await retryMissingLockOwner(lockPath, ownerPath)
        ) continue;
        fail("PREVIEW_LOCK_AMBIGUOUS");
      }
      let owner;
      try {
        owner = validateLockOwner(JSON.parse(before.toString("utf8")));
      } catch {
        fail("PREVIEW_LOCK_AMBIGUOUS");
      }
      let after;
      try {
        after = await protectedFile(ownerPath, { preserveMissing: true });
      } catch (error) {
        if (
          error?.code === "ENOENT" &&
          await retryMissingLockOwner(lockPath, ownerPath)
        ) continue;
        fail("PREVIEW_LOCK_AMBIGUOUS");
      }
      if (!before.equals(after)) fail("PREVIEW_LOCK_AMBIGUOUS");
      const identity = await processIdentity(owner.pid);
      if (identity) {
        if (identity.starttime === owner.starttime && identity.cwd === owner.cwd) {
          await new Promise(resolve => setTimeout(resolve, 25));
          continue;
        }
        fail("PREVIEW_LOCK_AMBIGUOUS");
      }
      const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
      await rename(lockPath, stalePath).catch(() => fail("PREVIEW_LOCK_AMBIGUOUS"));
      try {
        await hooks.afterStaleRename?.({
          stalePath,
          owner: structuredClone(owner),
          ownerBytes: Buffer.from(before)
        });
      } catch {
        fail("PREVIEW_LOCK_AMBIGUOUS");
      }
      const staleOwnerPath = join(stalePath, "owner.json");
      const renamedBefore = await protectedFile(staleOwnerPath)
        .catch(() => fail("PREVIEW_LOCK_AMBIGUOUS"));
      let renamedOwner;
      try {
        renamedOwner = validateLockOwner(JSON.parse(renamedBefore.toString("utf8")));
      } catch {
        fail("PREVIEW_LOCK_AMBIGUOUS");
      }
      if (
        !before.equals(renamedBefore) ||
        renamedOwner.lockId !== owner.lockId
      ) fail("PREVIEW_LOCK_AMBIGUOUS");
      const renamedAfter = await protectedFile(staleOwnerPath)
        .catch(() => fail("PREVIEW_LOCK_AMBIGUOUS"));
      if (!renamedBefore.equals(renamedAfter)) fail("PREVIEW_LOCK_AMBIGUOUS");
      const renamedIdentity = await processIdentity(renamedOwner.pid);
      if (renamedIdentity !== null) fail("PREVIEW_LOCK_AMBIGUOUS");
      await rm(stalePath, { recursive: true, force: false });
    }
  }
  fail("PREVIEW_ADMIN_INIT_BUSY");
}

async function releaseAdminLock(lock) {
  const ownerPath = join(lock.lockPath, "owner.json");
  let current;
  try {
    current = await readProtectedJson(ownerPath, validateLockOwner);
  } catch {
    return;
  }
  if (current.lockId !== lock.owner.lockId) return;
  await unlink(ownerPath).catch(() => undefined);
  await rmdir(lock.lockPath).catch(() => undefined);
}

async function responseBytes(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_BYTES) {
      fail("PREVIEW_HTTP_RESPONSE_INVALID");
    }
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_JSON_BYTES) fail("PREVIEW_HTTP_RESPONSE_INVALID");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        fail("PREVIEW_HTTP_RESPONSE_INVALID");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function previewJsonRequest(origin, path, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") fail("PREVIEW_FETCH_UNAVAILABLE");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  let response;
  try {
    response = await fetchImpl(new URL(path, normalizeOrigin(origin)), {
      method: options.method ?? "GET",
      headers: options.headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal
    });
  } catch {
    fail("PREVIEW_HTTP_FAILED");
  } finally {
    clearTimeout(timeout);
  }
  const bytes = await responseBytes(response);
  let body = null;
  if (bytes.byteLength > 0) {
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      fail("PREVIEW_HTTP_RESPONSE_INVALID");
    }
  }
  return { status: response.status, body, headers: response.headers };
}

function validateAdminFile(value, origin) {
  requireExact(value, [
    "version", "origin", "familyRef", "personRef", "deviceRef",
    "entryBindingRef", "entrySessionRef", "token"
  ], "PREVIEW_ADMIN_ENTRY_INVALID");
  if (value.version !== 1 || value.origin !== origin) fail("PREVIEW_ADMIN_ENTRY_INVALID");
  requireString(value.familyRef, REF.family, "PREVIEW_ADMIN_ENTRY_INVALID");
  requireString(value.personRef, REF.person, "PREVIEW_ADMIN_ENTRY_INVALID");
  requireString(value.deviceRef, REF.device, "PREVIEW_ADMIN_ENTRY_INVALID");
  requireString(value.entryBindingRef, REF.binding, "PREVIEW_ADMIN_ENTRY_INVALID");
  requireString(value.entrySessionRef, REF.session, "PREVIEW_ADMIN_ENTRY_INVALID");
  requireString(value.token, REF.token, "PREVIEW_ADMIN_ENTRY_INVALID");
  return value;
}

function validateEntryMaterial(value, code) {
  requireExact(value, ["entryBindingRef", "entrySessionRef", "token", "audience", "agentRef"], code);
  requireString(value.entryBindingRef, REF.binding, code);
  requireString(value.entrySessionRef, REF.session, code);
  requireString(value.token, REF.token, code);
  if (!["family_admin", "personal"].includes(value.audience)) fail(code);
  requireString(value.agentRef, /^agent:[a-zA-Z0-9][a-zA-Z0-9._:-]{1,126}$/u, code);
  return value;
}

function validateOnboarding(value) {
  const code = "PREVIEW_ONBOARDING_INVALID";
  requireExact(value, ["family", "owner", "device", "entries"], code);
  requireExact(value.family, ["familyRef", "displayName", "status"], code);
  requireString(value.family.familyRef, REF.family, code);
  requireDisplayString(value.family.displayName, code);
  if (value.family.status !== "active") fail(code);
  requireExact(value.owner, ["personRef", "displayName", "status"], code);
  requireString(value.owner.personRef, REF.person, code);
  requireDisplayString(value.owner.displayName, code);
  if (value.owner.status !== "active") fail(code);
  requireExact(value.device, ["deviceRef", "displayName", "status"], code);
  requireString(value.device.deviceRef, REF.device, code);
  requireDisplayString(value.device.displayName, code);
  if (value.device.status !== "active") fail(code);
  requireExact(value.entries, ["admin", "personal"], code);
  const admin = validateEntryMaterial(value.entries.admin, code);
  const personal = validateEntryMaterial(value.entries.personal, code);
  if (admin.audience !== "family_admin" || admin.agentRef !== "agent:family-manager") fail(code);
  if (personal.audience !== "personal" || personal.agentRef !== "agent:personal-assistant") fail(code);
  if (
    admin.entryBindingRef === personal.entryBindingRef ||
    admin.entrySessionRef === personal.entrySessionRef ||
    admin.token === personal.token
  ) fail(code);
  return value;
}

function validateContext(value, admin) {
  const code = "PREVIEW_ADMIN_CONTEXT_INVALID";
  requireExact(value, [
    "protocolVersion", "audience", "entrySessionRef", "entryBindingRef",
    "family", "person", "membership", "device", "agent"
  ], code);
  if (
    value.protocolVersion !== 1 || value.audience !== "family_admin" ||
    value.entrySessionRef !== admin.entrySessionRef ||
    value.entryBindingRef !== admin.entryBindingRef
  ) fail(code);
  requireExact(value.family, ["familyRef", "displayName"], code);
  requireExact(value.person, ["personRef", "displayName"], code);
  requireExact(value.membership, ["familyRole"], code);
  requireExact(value.device, ["deviceRef", "displayName", "terminalType", "platform"], code);
  requireExact(value.agent, [
    "assignmentRef", "assignmentType", "agentRef", "displayName", "providerProfileRef"
  ], code);
  if (
    value.family.familyRef !== admin.familyRef ||
    value.person.personRef !== admin.personRef ||
    value.device.deviceRef !== admin.deviceRef ||
    value.agent.agentRef !== "agent:family-manager"
  ) fail(code);
  return value;
}

async function deviceToken(paths) {
  const bytes = await protectedFile(join(paths.configDir, "device-token"), { maxBytes: 128 });
  const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\n$/u, "");
  if (!REF.token.test(token)) fail("PREVIEW_DEVICE_TOKEN_INVALID");
  return token;
}

function adminHeaders(admin) {
  return {
    Authorization: `Bearer ${admin.token}`,
    "X-Entry-Session-Ref": admin.entrySessionRef
  };
}

async function verifyAdmin(origin, admin, fetchImpl) {
  const response = await previewJsonRequest(origin, "/api/v1/portal/context", {
    fetchImpl,
    headers: adminHeaders(admin)
  });
  if (response.status !== 200) fail("PREVIEW_ADMIN_CONTEXT_INVALID");
  validateContext(response.body, admin);
}

export async function loadPreviewAdminHandoff(options = {}) {
  const paths = await prepareRuntime(options.runtimeDir);
  const origin = normalizeOrigin(options.origin ?? "http://127.0.0.1:8791");
  const adminPath = join(paths.configDir, "admin-entry.json");
  const lock = await acquireAdminLock(paths);
  try {
    const statusResponse = await previewJsonRequest(origin, "/api/v1/onboarding/status", {
      fetchImpl: options.fetchImpl
    });
    if (statusResponse.status !== 200) fail("PREVIEW_ONBOARDING_STATUS_INVALID");
    requireExact(statusResponse.body, ["initialized"], "PREVIEW_ONBOARDING_STATUS_INVALID");
    if (typeof statusResponse.body.initialized !== "boolean") {
      fail("PREVIEW_ONBOARDING_STATUS_INVALID");
    }

    if (statusResponse.body.initialized === false) {
      if (await protectedFile(adminPath, { required: false }) !== null) {
        fail("PREVIEW_ADMIN_ENTRY_CONFLICT");
      }
      return {
        kind: "bootstrap",
        deviceRef: "device:test",
        token: await deviceToken(paths),
        runtimeDir: paths.runtimeDir
      };
    }

    const admin = await readProtectedJson(
      adminPath,
      value => validateAdminFile(value, origin)
    );
    await verifyAdmin(origin, admin, options.fetchImpl);
    return {
      kind: "entry",
      entrySessionRef: admin.entrySessionRef,
      token: admin.token,
      runtimeDir: paths.runtimeDir
    };
  } finally {
    await releaseAdminLock(lock);
  }
}

export async function loadOrInitializePreviewAdmin(options = {}) {
  const paths = await prepareRuntime(options.runtimeDir);
  const origin = normalizeOrigin(options.origin ?? "http://127.0.0.1:8791");
  const adminPath = join(paths.configDir, "admin-entry.json");
  const lock = await acquireAdminLock(paths);
  try {
    const statusResponse = await previewJsonRequest(origin, "/api/v1/onboarding/status", {
      fetchImpl: options.fetchImpl
    });
    if (statusResponse.status !== 200) fail("PREVIEW_ONBOARDING_STATUS_INVALID");
    requireExact(statusResponse.body, ["initialized"], "PREVIEW_ONBOARDING_STATUS_INVALID");
    if (typeof statusResponse.body.initialized !== "boolean") {
      fail("PREVIEW_ONBOARDING_STATUS_INVALID");
    }

    let admin;
    if (statusResponse.body.initialized === false) {
      if (await protectedFile(adminPath, { required: false }) !== null) {
        fail("PREVIEW_ADMIN_ENTRY_CONFLICT");
      }
      const bootstrapToken = await deviceToken(paths);
      const initialized = await previewJsonRequest(origin, "/api/v1/onboarding/family", {
        fetchImpl: options.fetchImpl,
        method: "POST",
        headers: {
          Authorization: `Bearer ${bootstrapToken}`,
          "X-Device-Ref": "device:test",
          "Content-Type": "application/json"
        },
        body: {
          familyName: "Member Web Preview 家庭",
          ownerName: "Member Web Preview 成员",
          deviceName: "Member Web Preview 管理设备"
        }
      });
      if (initialized.status !== 201) fail("PREVIEW_ONBOARDING_INVALID");
      const result = validateOnboarding(initialized.body);
      admin = {
        version: 1,
        origin,
        familyRef: result.family.familyRef,
        personRef: result.owner.personRef,
        deviceRef: result.device.deviceRef,
        entryBindingRef: result.entries.admin.entryBindingRef,
        entrySessionRef: result.entries.admin.entrySessionRef,
        token: result.entries.admin.token
      };
      await atomicProtectedJson(adminPath, admin);
    } else {
      admin = await readProtectedJson(adminPath, value => validateAdminFile(value, origin));
    }
    validateAdminFile(admin, origin);
    await verifyAdmin(origin, admin, options.fetchImpl);
    return { ...admin, runtimeDir: paths.runtimeDir };
  } finally {
    await releaseAdminLock(lock);
  }
}

function validatePairingResponse(value) {
  const code = "PREVIEW_PAIRING_INVALID";
  requireExact(value, ["protocolVersion", "pairing", "family", "person", "qr"], code);
  if (value.protocolVersion !== 1) fail(code);
  requireExact(value.pairing, ["pairingRef", "code", "expiresAt", "status"], code);
  requireString(value.pairing.pairingRef, REF.pairing, code);
  requireString(value.pairing.code, REF.pairingCode, code);
  requireIso(value.pairing.expiresAt, code);
  if (value.pairing.status !== "active") fail(code);
  requireExact(value.family, ["displayName"], code);
  requireDisplayString(value.family.displayName, code);
  requireExact(value.person, ["displayName"], code);
  requireDisplayString(value.person.displayName, code);
  requireExact(value.qr, ["payload", "url"], code);
  requireExact(value.qr.payload, ["version", "gateway", "pairingRef", "code", "expiresAt"], code);
  if (
    value.qr.payload.version !== 1 ||
    value.qr.payload.pairingRef !== value.pairing.pairingRef ||
    value.qr.payload.code !== value.pairing.code ||
    value.qr.payload.expiresAt !== value.pairing.expiresAt ||
    typeof value.qr.payload.gateway !== "string" ||
    typeof value.qr.url !== "string"
  ) fail(code);
  return value;
}

export async function createMemberPreviewPairing(options = {}) {
  const port = options.port;
  if (port !== 8791 && port !== 8792) fail("PREVIEW_PAIR_ARGUMENTS_INVALID");
  const origin = normalizeOrigin(options.origin ?? "http://127.0.0.1:8791");
  const admin = await loadOrInitializePreviewAdmin({
    origin,
    runtimeDir: options.runtimeDir,
    fetchImpl: options.fetchImpl
  });
  const paths = await prepareRuntime(admin.runtimeDir);
  if (port === 8792) {
    let proxy;
    try {
      proxy = await import("./member-preview-claim-loss-proxy.mjs");
    } catch {
      fail("PREVIEW_PROXY_UNAVAILABLE");
    }
    if (typeof proxy.resetConsumedClaimLossState !== "function") {
      fail("PREVIEW_PROXY_UNAVAILABLE");
    }
    await proxy.resetConsumedClaimLossState(join(paths.runDir, "claim-loss-state.json"));
  }
  const response = await previewJsonRequest(
    origin,
    `/api/v1/admin/members/${encodeURIComponent(admin.personRef)}/pairing-codes`,
    { fetchImpl: options.fetchImpl, method: "POST", headers: adminHeaders(admin) }
  );
  if (response.status !== 201) fail("PREVIEW_PAIRING_INVALID");
  const result = validatePairingResponse(response.body);
  if (Date.parse(result.pairing.expiresAt) - Date.now() < 240000) {
    fail("PREVIEW_PAIRING_TOO_SHORT");
  }
  const metadataPath = join(paths.configDir, `pairing-target-${port}.json`);
  await atomicProtectedJson(metadataPath, {
    protocolVersion: 2,
    pairingRef: result.pairing.pairingRef,
    expiresAt: result.pairing.expiresAt
  });
  const outputPath = join(paths.configDir, `member-web-url-${port}`);
  await writeMemberHandoff({
    outputPath,
    baseUrl: `http://127.0.0.1:${port}`,
    pairingRef: result.pairing.pairingRef,
    code: result.pairing.code
  });
  await chmod(outputPath, 0o600);
  return outputPath;
}

function parseCli(argv) {
  if (
    argv.length !== 2 || argv[0] !== "--port" ||
    (argv[1] !== "8791" && argv[1] !== "8792")
  ) fail("PREVIEW_PAIR_ARGUMENTS_INVALID");
  return Number(argv[1]);
}

async function main() {
  const port = parseCli(process.argv.slice(2));
  const outputPath = await createMemberPreviewPairing({ port });
  process.stdout.write(`${outputPath}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch {
    process.stderr.write("PREVIEW_PAIR_FAILED\n");
    process.exitCode = 1;
  }
}

export const previewInternals = Object.freeze({
  REF,
  PreviewError,
  adminHeaders,
  acquireAdminLock,
  atomicProtectedJson,
  atomicProtectedText,
  hasExactKeys,
  normalizeOrigin,
  prepareRuntime,
  protectedFile,
  readProtectedJson,
  releaseAdminLock,
  requireExact,
  requireIso,
  requireString,
  validatePairingResponse
});
