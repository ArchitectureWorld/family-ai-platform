#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync
} from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rmdir,
  rm,
  unlink
} from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { hostname, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const CLAIM_PATH = "/api/v1/web-entry/pairing/claim";
const MAX_STATE_BYTES = 4096;
const MAX_MANIFEST_BYTES = 16384;
const FIXED_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const LOG_EVENTS = new Set([
  "proxy-ready",
  "fault-owner",
  "fault-rearmed",
  "fault-consumed",
  "claim-pass-through",
  "proxy-stopped"
]);
const scriptPath = fileURLToPath(import.meta.url);
const rootDirectory = resolve(dirname(scriptPath), "..");

function claimLossError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function invalidState() {
  return claimLossError("CLAIM_LOSS_INVALID_STATE");
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidState();
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== "requestId\0state\0timestamp\0version") throw invalidState();
  if (value.version !== 1 || (value.state !== "in_flight" && value.state !== "consumed")) {
    throw invalidState();
  }
  if (
    typeof value.requestId !== "string" ||
    value.requestId.length < 1 ||
    value.requestId.length > 128 ||
    !/^[A-Za-z0-9:._-]+$/.test(value.requestId)
  ) {
    throw invalidState();
  }
  if (typeof value.timestamp !== "string") throw invalidState();
  const timestamp = new Date(value.timestamp);
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== value.timestamp) {
    throw invalidState();
  }
  return value;
}

function parseStateBytes(bytes) {
  if (bytes.length < 2 || bytes.length > MAX_STATE_BYTES) throw invalidState();
  try {
    return validateState(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error?.code === "CLAIM_LOSS_INVALID_STATE") throw error;
    throw invalidState();
  }
}

function stableStat(first, second) {
  return first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs;
}

function protectedFileStatus(status, maxBytes) {
  return status.isFile() &&
    (status.mode & 0o777) === 0o600 &&
    status.size >= 2 &&
    status.size <= maxBytes;
}

function readProtectedBytesSync(file, maxBytes, missingAllowed, invalid) {
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missingAllowed && error?.code === "ENOENT") return null;
    throw invalid();
  }
  try {
    const before = fstatSync(descriptor);
    if (!protectedFileStatus(before, maxBytes)) throw invalid();
    const first = Buffer.alloc(before.size);
    if (readSync(descriptor, first, 0, first.length, 0) !== first.length) throw invalid();
    const middle = fstatSync(descriptor);
    const second = Buffer.alloc(before.size);
    if (readSync(descriptor, second, 0, second.length, 0) !== second.length) throw invalid();
    const after = fstatSync(descriptor);
    if (!stableStat(before, middle) || !stableStat(middle, after) || !first.equals(second)) {
      throw invalid();
    }
    return first;
  } catch (error) {
    if (error?.code === "CLAIM_LOSS_INVALID_STATE") throw error;
    throw invalid();
  } finally {
    closeSync(descriptor);
  }
}

async function readProtectedBytes(file, maxBytes, missingAllowed, invalid) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missingAllowed && error?.code === "ENOENT") return null;
    throw invalid();
  }
  try {
    const before = await handle.stat();
    if (!protectedFileStatus(before, maxBytes)) throw invalid();
    const first = Buffer.alloc(before.size);
    const firstRead = await handle.read(first, 0, first.length, 0);
    const middle = await handle.stat();
    const second = Buffer.alloc(before.size);
    const secondRead = await handle.read(second, 0, second.length, 0);
    const after = await handle.stat();
    if (
      firstRead.bytesRead !== first.length ||
      secondRead.bytesRead !== second.length ||
      !stableStat(before, middle) ||
      !stableStat(middle, after) ||
      !first.equals(second)
    ) {
      throw invalid();
    }
    return first;
  } catch (error) {
    if (
      error?.code === "CLAIM_LOSS_INVALID_STATE" ||
      error?.code === "CLAIM_LOSS_STARTUP_AMBIGUOUS"
    ) {
      throw error;
    }
    throw invalid();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function readStateSync(stateFile) {
  try {
    const bytes = readProtectedBytesSync(stateFile, MAX_STATE_BYTES, true, invalidState);
    return bytes === null ? null : parseStateBytes(bytes);
  } catch (error) {
    if (error?.code === "CLAIM_LOSS_INVALID_STATE") throw error;
    throw invalidState();
  }
}

async function readState(stateFile) {
  try {
    const bytes = await readProtectedBytes(stateFile, MAX_STATE_BYTES, true, invalidState);
    return bytes === null ? null : parseStateBytes(bytes);
  } catch (error) {
    if (error?.code === "CLAIM_LOSS_INVALID_STATE") throw error;
    throw invalidState();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWriteState(stateFile, value) {
  const directory = dirname(stateFile);
  const temporary = join(directory, `.claim-loss-state.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, stateFile);
    await chmod(stateFile, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function stateLockPath(stateFile) {
  return `${stateFile}.reset.lock`;
}

async function withStateLock(stateFile, operation) {
  const lockPath = stateLockPath(stateFile);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw claimLossError("CLAIM_LOSS_STATE_BUSY");
    throw claimLossError("CLAIM_LOSS_STATE_IO");
  }
  try {
    await chmod(lockPath, 0o700);
    return await operation();
  } finally {
    await rmdir(lockPath).catch(() => undefined);
  }
}

async function removeOwnedInFlight(stateFile, requestId) {
  return withStateLock(stateFile, async () => {
    const state = await readState(stateFile);
    if (state === null) return false;
    if (state.state !== "in_flight" || state.requestId !== requestId) return false;
    await unlink(stateFile);
    await syncDirectory(dirname(stateFile));
    return true;
  });
}

async function consumeOwnedInFlight(stateFile, requestId) {
  return withStateLock(stateFile, async () => {
    const state = await readState(stateFile);
    if (state === null || state.state !== "in_flight" || state.requestId !== requestId) {
      throw claimLossError("CLAIM_LOSS_OWNER_LOST");
    }
    await atomicWriteState(stateFile, {
      version: 1,
      state: "consumed",
      requestId,
      timestamp: new Date().toISOString()
    });
  });
}

async function observeContendedState(stateFile) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const state = await readState(stateFile);
      if (state !== null) return state;
    } catch (error) {
      if (error?.code !== "CLAIM_LOSS_INVALID_STATE" || attempt === 7) throw error;
    }
    await new Promise(resolvePromise => setImmediate(resolvePromise));
  }
  throw invalidState();
}

async function tryBecomeFaultOwner(stateFile, requestId) {
  const directory = dirname(stateFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let handle;
  try {
    handle = await open(
      stateFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw claimLossError("CLAIM_LOSS_STATE_IO");
    await observeContendedState(stateFile);
    return false;
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      version: 1,
      state: "in_flight",
      requestId,
      timestamp: new Date().toISOString()
    })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(stateFile, 0o600);
    await syncDirectory(directory);
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(stateFile).catch(() => undefined);
    throw claimLossError("CLAIM_LOSS_STATE_IO");
  }
}

export async function resetConsumedClaimLossState(stateFile) {
  if (typeof stateFile !== "string" || stateFile.length === 0 || !resolve(stateFile).startsWith("/")) {
    throw invalidState();
  }
  return withStateLock(stateFile, async () => {
    const state = await readState(stateFile);
    if (state === null) return "absent";
    if (state.state === "in_flight") throw claimLossError("CLAIM_LOSS_IN_FLIGHT");
    await unlink(stateFile);
    await syncDirectory(dirname(stateFile));
    return "rearmed";
  });
}

function connectionNominations(rawHeaders) {
  const nominated = new Set();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() !== "connection") continue;
    for (const token of String(rawHeaders[index + 1] ?? "").split(",")) {
      const name = token.trim().toLowerCase();
      if (/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) nominated.add(name);
    }
  }
  return nominated;
}

function endToEndRawHeaders(rawHeaders) {
  const removed = new Set([...FIXED_HOP_HEADERS, ...connectionNominations(rawHeaders)]);
  const filtered = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index]);
    if (removed.has(name.toLowerCase())) continue;
    filtered.push(name, String(rawHeaders[index + 1] ?? ""));
  }
  return filtered;
}

function safeLog(log, event, requestId) {
  if (!LOG_EVENTS.has(event)) return;
  try {
    log({ event, requestId, timestamp: new Date().toISOString() });
  } catch {
    // Logging is deliberately non-authoritative and never changes proxy behavior.
  }
}

function destroyDownstream(response) {
  if (response.socket && !response.socket.destroyed) response.socket.destroy();
  else response.destroy();
}

function proxyOrdinaryResponse(upstreamResponse, downstreamResponse) {
  const headers = endToEndRawHeaders(upstreamResponse.rawHeaders);
  downstreamResponse.writeHead(
    upstreamResponse.statusCode ?? 502,
    upstreamResponse.statusMessage ?? "",
    headers
  );
  upstreamResponse.pipe(downstreamResponse);
}

function proxyOwnerNon204(upstreamResponse, downstreamResponse, stateFile, requestId, log) {
  const headers = endToEndRawHeaders(upstreamResponse.rawHeaders);
  downstreamResponse.writeHead(
    upstreamResponse.statusCode ?? 502,
    upstreamResponse.statusMessage ?? "",
    headers
  );
  upstreamResponse.pipe(downstreamResponse, { end: false });
  upstreamResponse.once("end", async () => {
    try {
      await removeOwnedInFlight(stateFile, requestId);
      safeLog(log, "fault-rearmed", requestId);
      downstreamResponse.end();
    } catch {
      destroyDownstream(downstreamResponse);
    }
  });
}

export function createClaimLossProxy({ upstreamOrigin, stateFile, log }) {
  if (typeof upstreamOrigin !== "string" || typeof stateFile !== "string" || typeof log !== "function") {
    throw claimLossError("CLAIM_LOSS_INVALID_OPTIONS");
  }
  let parsedUpstream;
  try {
    parsedUpstream = new URL(upstreamOrigin);
  } catch {
    throw claimLossError("CLAIM_LOSS_INVALID_OPTIONS");
  }
  if (
    parsedUpstream.protocol !== "http:" ||
    parsedUpstream.username !== "" ||
    parsedUpstream.password !== "" ||
    parsedUpstream.pathname !== "/" ||
    parsedUpstream.search !== "" ||
    parsedUpstream.hash !== "" ||
    parsedUpstream.hostname !== "127.0.0.1"
  ) {
    throw claimLossError("CLAIM_LOSS_INVALID_OPTIONS");
  }
  const initialState = readStateSync(stateFile);
  if (initialState?.state === "in_flight") throw claimLossError("CLAIM_LOSS_IN_FLIGHT");

  const server = createServer(async (incoming, downstream) => {
    const requestId = randomUUID();
    const isClaim = incoming.method === "POST" && incoming.url === CLAIM_PATH;
    let faultOwner = false;
    if (isClaim) {
      try {
        faultOwner = await tryBecomeFaultOwner(stateFile, requestId);
      } catch {
        destroyDownstream(downstream);
        incoming.resume();
        return;
      }
      safeLog(log, faultOwner ? "fault-owner" : "claim-pass-through", requestId);
    }

    if (typeof incoming.url !== "string" || !incoming.url.startsWith("/") || incoming.url.startsWith("//")) {
      if (faultOwner) await removeOwnedInFlight(stateFile, requestId).catch(() => undefined);
      destroyDownstream(downstream);
      incoming.resume();
      return;
    }
    const target = new URL(incoming.url ?? "/", parsedUpstream);
    let upstreamComplete = false;
    let ownerFinalized = false;
    const rearmOwner = async () => {
      if (!faultOwner || ownerFinalized) return;
      ownerFinalized = true;
      try {
        await removeOwnedInFlight(stateFile, requestId);
        safeLog(log, "fault-rearmed", requestId);
      } catch {
        // Leaving in_flight is the fail-closed outcome for ambiguous cleanup.
      }
    };
    const upstreamRequest = httpRequest(target, {
      method: incoming.method,
      headers: endToEndRawHeaders(incoming.rawHeaders),
      agent: false,
      setHost: false
    }, upstreamResponse => {
      const isSuccessfulOwner = faultOwner && upstreamResponse.statusCode === 204;
      if (isSuccessfulOwner) {
        upstreamResponse.resume();
        upstreamResponse.once("end", async () => {
          upstreamComplete = true;
          if (ownerFinalized) return;
          ownerFinalized = true;
          try {
            await consumeOwnedInFlight(stateFile, requestId);
            safeLog(log, "fault-consumed", requestId);
          } finally {
            destroyDownstream(downstream);
          }
        });
        upstreamResponse.once("aborted", async () => {
          await rearmOwner();
          destroyDownstream(downstream);
        });
        upstreamResponse.once("error", async () => {
          await rearmOwner();
          destroyDownstream(downstream);
        });
        return;
      }
      if (faultOwner) {
        upstreamResponse.once("end", () => {
          upstreamComplete = true;
        });
        upstreamResponse.once("aborted", async () => {
          await rearmOwner();
          destroyDownstream(downstream);
        });
        upstreamResponse.once("error", async () => {
          await rearmOwner();
          destroyDownstream(downstream);
        });
        proxyOwnerNon204(upstreamResponse, downstream, stateFile, requestId, log);
      } else {
        proxyOrdinaryResponse(upstreamResponse, downstream);
      }
    });
    upstreamRequest.once("error", async () => {
      if (!upstreamComplete) await rearmOwner();
      destroyDownstream(downstream);
    });
    downstream.once("close", () => {
      if (!upstreamComplete && !upstreamRequest.destroyed) upstreamRequest.destroy();
    });
    incoming.once("error", () => upstreamRequest.destroy());
    incoming.pipe(upstreamRequest);
  });

  server.once("listening", () => safeLog(log, "proxy-ready", randomUUID()));
  server.once("close", () => safeLog(log, "proxy-stopped", randomUUID()));
  return server;
}

function validateStaleProxyManifest(value, expectedRoot) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw claimLossError("CLAIM_LOSS_STARTUP_AMBIGUOUS");
  }
  const expectedKeys = [
    "cwd", "entrypoint", "host", "kind", "launchCommit", "pid", "port",
    "proxyConfigSha256", "proxySourceSha256", "starttime", "upstreamOrigin", "version"
  ].sort();
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
    throw claimLossError("CLAIM_LOSS_STARTUP_AMBIGUOUS");
  }
  if (
    value.version !== 1 || value.kind !== "claim_loss_proxy" ||
    !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
    typeof value.starttime !== "string" || !/^[1-9][0-9]*$/.test(value.starttime) ||
    value.cwd !== expectedRoot ||
    value.entrypoint !== "scripts/member-preview-claim-loss-proxy.mjs" ||
    value.host !== "127.0.0.1" || value.port !== 8792 ||
    value.upstreamOrigin !== "http://127.0.0.1:8791" ||
    typeof value.launchCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.launchCommit) ||
    typeof value.proxySourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.proxySourceSha256) ||
    typeof value.proxyConfigSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.proxyConfigSha256)
  ) {
    throw claimLossError("CLAIM_LOSS_STARTUP_AMBIGUOUS");
  }
  return value;
}

function startupAmbiguous() {
  return claimLossError("CLAIM_LOSS_STARTUP_AMBIGUOUS");
}

async function readRecoveryStateSnapshot(stateFile) {
  const bytes = await readProtectedBytes(stateFile, MAX_STATE_BYTES, true, invalidState);
  if (bytes === null) return null;
  return { bytes, value: parseStateBytes(bytes) };
}

async function readManifestSnapshot(manifestFile, expectedRoot) {
  const bytes = await readProtectedBytes(
    manifestFile,
    MAX_MANIFEST_BYTES,
    false,
    startupAmbiguous
  );
  try {
    return {
      bytes,
      value: validateStaleProxyManifest(JSON.parse(bytes.toString("utf8")), expectedRoot)
    };
  } catch {
    throw startupAmbiguous();
  }
}

function processMatchesManifest(process, manifest, expectedRoot) {
  return process.starttime === manifest.starttime &&
    process.cwd === expectedRoot &&
    process.argv.length === 2 &&
    basename(process.argv[0]) === "node" &&
    resolve(process.cwd, process.argv[1]) === resolve(expectedRoot, manifest.entrypoint);
}

function listenerMatchesManifest(listeners, manifest) {
  return listeners.length === 1 &&
    listeners[0].localAddress === `127.0.0.1:${manifest.port}` &&
    listeners[0].pids.length === 1 &&
    listeners[0].pids[0] === manifest.pid;
}

async function inspectLinuxProcess(pid) {
  let statText;
  try {
    statText = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw startupAmbiguous();
  }
  const close = statText.lastIndexOf(")");
  if (close < 0) throw startupAmbiguous();
  const fields = statText.slice(close + 2).trim().split(/\s+/);
  if (!/^[1-9][0-9]*$/.test(fields[19] ?? "")) throw startupAmbiguous();
  try {
    const cwd = await readlink(`/proc/${pid}/cwd`);
    const command = await readFile(`/proc/${pid}/cmdline`);
    return {
      starttime: fields[19],
      cwd,
      argv: command.toString("utf8").split("\0").filter(Boolean)
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw startupAmbiguous();
  }
}

async function inspectLinuxListeners(port) {
  let output;
  try {
    output = execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    throw startupAmbiguous();
  }
  return output.trim().split("\n").filter(Boolean).map(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) throw startupAmbiguous();
    return {
      localAddress: fields[3],
      pids: [...line.matchAll(/(?:^|[,\s])pid=([1-9][0-9]*)(?=[,)\s]|$)/g)]
        .map(match => Number(match[1]))
    };
  });
}

const linuxRecoveryInspector = {
  inspectProcess: inspectLinuxProcess,
  inspectListeners: inspectLinuxListeners
};

async function inspectRecoveryOwnership(manifest, inspector) {
  const process = await inspector.inspectProcess(manifest.pid);
  const listeners = await inspector.inspectListeners(manifest.port);
  if (process === null) {
    if (listeners.length !== 0) throw startupAmbiguous();
    return "absent";
  }
  if (
    !processMatchesManifest(process, manifest, manifest.cwd) ||
    !listenerMatchesManifest(listeners, manifest)
  ) {
    throw startupAmbiguous();
  }
  return "owned";
}

async function recoverCliInFlightState(
  stateFile,
  manifestFile,
  expectedRoot,
  inspector = linuxRecoveryInspector
) {
  const stateSnapshot = await readRecoveryStateSnapshot(stateFile);
  if (stateSnapshot === null || stateSnapshot.value.state === "consumed") return "unchanged";
  const manifestSnapshot = await readManifestSnapshot(manifestFile, expectedRoot);
  if (await inspectRecoveryOwnership(manifestSnapshot.value, inspector) === "owned") {
    throw claimLossError("CLAIM_LOSS_IN_FLIGHT");
  }
  await withStateLock(stateFile, async () => {
    const current = await readRecoveryStateSnapshot(stateFile);
    const currentManifest = await readManifestSnapshot(manifestFile, expectedRoot);
    if (
      current === null ||
      current.value.state !== "in_flight" ||
      current.value.requestId !== stateSnapshot.value.requestId ||
      !current.bytes.equals(stateSnapshot.bytes) ||
      !currentManifest.bytes.equals(manifestSnapshot.bytes)
    ) {
      throw startupAmbiguous();
    }
    if (await inspectRecoveryOwnership(currentManifest.value, inspector) !== "absent") {
      throw startupAmbiguous();
    }
    await unlink(stateFile);
    await syncDirectory(dirname(stateFile));
  });
  return "rearmed";
}

export const __proxyInternals = Object.freeze({ recoverCliInFlightState });

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(scriptPath);
  } catch {
    return false;
  }
}

async function main() {
  if (process.argv.length !== 2) throw claimLossError("CLAIM_LOSS_INVALID_ARGUMENTS");
  if (hostname() !== "Admin-YR" || userInfo().username !== "youran") {
    throw claimLossError("CLAIM_LOSS_BOUNDARY");
  }
  const approvedRoot = realpathSync(join(
    userInfo().homedir,
    "Development/family-ai-platform-worktrees/member-web-entry-hardening"
  ));
  if (realpathSync(rootDirectory) !== approvedRoot) throw claimLossError("CLAIM_LOSS_BOUNDARY");
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  if (realpathSync(gitRoot) !== approvedRoot || branch !== "fix/member-web-entry-hardening") {
    throw claimLossError("CLAIM_LOSS_BOUNDARY");
  }
  process.umask(0o077);
  const runDirectory = join(rootDirectory, ".runtime-preview/run");
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await chmod(runDirectory, 0o700);
  const stateFile = join(runDirectory, "claim-loss-state.json");
  const manifestFile = join(runDirectory, "claim-loss-proxy.pid.json");
  await recoverCliInFlightState(stateFile, manifestFile, rootDirectory);
  const log = record => process.stdout.write(`${JSON.stringify(record)}\n`);
  const server = createClaimLossProxy({
    upstreamOrigin: "http://127.0.0.1:8791",
    stateFile,
    log
  });
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(8792, "127.0.0.1", resolvePromise);
  });
}

if (isMainModule()) {
  main().catch(error => {
    const allowed = new Set([
      "CLAIM_LOSS_INVALID_ARGUMENTS",
      "CLAIM_LOSS_BOUNDARY",
      "CLAIM_LOSS_IN_FLIGHT",
      "CLAIM_LOSS_INVALID_STATE",
      "CLAIM_LOSS_STARTUP_AMBIGUOUS"
    ]);
    const label = allowed.has(error?.code) ? error.code : "CLAIM_LOSS_PROXY_FAILED";
    process.stderr.write(`${label}\n`);
    process.exitCode = 1;
  });
}
