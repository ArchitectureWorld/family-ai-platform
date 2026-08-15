#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  atomicWrite,
  copyInventory,
  die,
  fsyncTree,
  inventoryDigest,
  inventoryTree,
  parseArgs,
  readJson,
  requireAbsolute,
  requireHex,
  requireRegular0600,
  requireSafeId,
  sealJson,
  sha256File,
  verifySidecar
} from "./runtime-release-lib.mjs";

const PREFIX = "RUNTIME_SNAPSHOT_FAILED";

function checkStopped(evidence, checkAdmissionTtl = false) {
  if (checkAdmissionTtl && Date.parse(evidence.expiresAt) < Date.now()) throw new Error("STOP_EVIDENCE_EXPIRED");
  if (evidence.controller.kind === "docker-compose") {
    const raw = execFileSync("docker", ["inspect", evidence.controller.containerId], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const container = JSON.parse(raw)[0];
    if (container.State?.Running || container.State?.Restarting || container.Id !== evidence.controller.containerId || container.Image !== evidence.controller.imageId) throw new Error("STOP_LEASE_LOST");
  } else {
    const args = evidence.controller.kind === "systemd-user" ? ["--user"] : [];
    if (spawnSync("systemctl", [...args, "is-active", "--quiet", evidence.controller.unit]).status === 0) throw new Error("STOP_LEASE_LOST");
  }
  if (evidence.expectedBind !== "none") {
    const port = evidence.expectedBind.split(":").at(-1);
    const result = spawnSync("ss", ["-H", "-ltn", `sport = :${port}`], { encoding: "utf8" });
    if (result.status !== 0 || result.stdout.trim()) throw new Error("STOP_LISTENER_REAPPEARED");
  }
}

function copyFileRecord(source, destination, snapshotRoot) {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  chmodSync(destination, 0o600);
  return { relativePath: relative(snapshotRoot, destination), size: statSync(destination).size, mode: statSync(destination).mode & 0o777, sha256: sha256File(destination) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    command: "create",
    required: ["--scope", "--phase", "--release-id", "--preflight", "--expected-preflight-sha256", "--stop-evidence", "--runtime-root", "--output-root", "--backup-tool-manifest", "--expected-backup-tool-manifest-sha256"]
  });
  const releaseId = requireSafeId(args["--release-id"], "RELEASE_ID");
  const preflightPath = requireRegular0600(args["--preflight"], "PREFLIGHT");
  const preflightSha = verifySidecar(preflightPath, args["--expected-preflight-sha256"], "PREFLIGHT");
  const preflight = readJson(preflightPath, "PREFLIGHT");
  const evidencePath = requireRegular0600(args["--stop-evidence"], "STOP_EVIDENCE");
  const evidenceSha = sha256File(evidencePath);
  verifySidecar(evidencePath, evidenceSha, "STOP_EVIDENCE");
  const evidence = readJson(evidencePath, "STOP_EVIDENCE");
  const toolPath = requireRegular0600(args["--backup-tool-manifest"], "TOOL_MANIFEST");
  const toolSha = verifySidecar(toolPath, args["--expected-backup-tool-manifest-sha256"], "TOOL_MANIFEST");
  const tool = readJson(toolPath, "TOOL_MANIFEST");
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  execFileSync("node", [join(repository, "scripts", "runtime-tool-manifest.mjs"), "verify", "--repository", repository, "--manifest", toolPath, "--expected-sha256", toolSha], { stdio: ["ignore", "ignore", "pipe"] });
  if (preflight.manifestKind !== "runtime-backup-preflight-v1" || tool.manifestKind !== "runtime-tool-manifest-v1") throw new Error("INPUT_KIND_INVALID");
  for (const [left, right, name] of [[preflight.scope, args["--scope"], "SCOPE"], [preflight.phase, args["--phase"], "PHASE"], [preflight.releaseId, releaseId, "RELEASE_ID"], [preflightSha, evidence.expectedPreflightSha256, "EVIDENCE_PREFLIGHT"]]) if (left !== right) throw new Error(`${name}_MISMATCH`);
  if (evidence.scope !== preflight.scope || evidence.phase !== preflight.phase || evidence.releaseId !== releaseId) throw new Error("STOP_EVIDENCE_AUTHORITY_MISMATCH");
  const runtimeRoot = requireAbsolute(args["--runtime-root"], "RUNTIME_ROOT", { type: "dir", mode: 0o700 });
  if (runtimeRoot !== preflight.runtime.root || statSync(runtimeRoot).dev !== preflight.runtime.device || statSync(runtimeRoot).ino !== preflight.runtime.inode) throw new Error("RUNTIME_IDENTITY_MISMATCH");
  const outputRoot = requireAbsolute(args["--output-root"], "OUTPUT_ROOT", { type: "dir", mode: 0o700 });
  if (readdirSync(outputRoot).length !== 0) throw new Error("OUTPUT_ROOT_NOT_EMPTY");
  if (statSync(outputRoot).dev !== statSync(runtimeRoot).dev) throw new Error("OUTPUT_NOT_SAME_FILESYSTEM");
  checkStopped(evidence, true);
  const database = new Database(preflight.runtime.databasePath);
  try {
    database.pragma("wal_checkpoint(TRUNCATE)");
    if (database.pragma("quick_check", { simple: true }) !== "ok" || database.pragma("foreign_key_check").length !== 0) throw new Error("SQLITE_VALIDATION_FAILED");
  } finally { database.close(); }
  checkStopped(evidence);
  const sourceInventory = inventoryTree(runtimeRoot);
  const staging = join(outputRoot, `.snapshot.${randomUUID()}.staging`);
  const final = join(outputRoot, "snapshot");
  if (existsSync(final)) throw new Error("SNAPSHOT_ALREADY_EXISTS");
  mkdirSync(staging, { mode: 0o700 });
  const payload = join(staging, "payload");
  mkdirSync(payload, { mode: 0o700 });
  const runtimeDestination = join(payload, "runtime");
  copyInventory(runtimeRoot, runtimeDestination, sourceInventory);
  checkStopped(evidence);
  const sourceAfter = inventoryTree(runtimeRoot);
  const copied = inventoryTree(runtimeDestination);
  if (inventoryDigest(sourceAfter) !== inventoryDigest(sourceInventory) || inventoryDigest(copied) !== inventoryDigest(sourceInventory)) throw new Error("RUNTIME_CHANGED_DURING_COPY");
  const imageDir = join(payload, "image");
  mkdirSync(imageDir, { mode: 0o700 });
  const imageArchive = join(imageDir, "gateway-image.tar");
  execFileSync("docker", ["image", "save", "--output", imageArchive, preflight.sourceImage.id], { stdio: ["ignore", "ignore", "pipe"] });
  chmodSync(imageArchive, 0o600);
  checkStopped(evidence);
  execFileSync("docker", ["image", "load", "--input", imageArchive], { stdio: ["ignore", "ignore", "pipe"] });
  const inspectedId = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", preflight.sourceImage.id], { encoding: "utf8" }).trim();
  if (inspectedId !== preflight.sourceImage.id) throw new Error("IMAGE_ARCHIVE_ID_MISMATCH");
  const controllerDir = join(payload, "controller");
  mkdirSync(controllerDir, { mode: 0o700 });
  const originalDir = join(controllerDir, "original");
  mkdirSync(originalDir, { mode: 0o700 });
  const originalRecords = [];
  for (let index = 0; index < preflight.controller.sourceFiles.length; index += 1) {
    const source = preflight.controller.sourceFiles[index];
    if (sha256File(source.path) !== source.sha256) throw new Error("CONTROLLER_SOURCE_DRIFT");
    const destination = join(originalDir, `${String(index).padStart(2, "0")}-${basename(source.path)}`);
    originalRecords.push(copyFileRecord(source.path, destination, staging));
  }
  const exactReplayDir = join(controllerDir, "exact-replay");
  mkdirSync(exactReplayDir, { mode: 0o700 });
  const exactReplayPath = join(exactReplayDir, "definition.json");
  const exactReplay = { manifestKind: "gateway-exact-replay-v1", kind: preflight.controller.definition.kind, imageId: preflight.sourceImage.id, projectName: preflight.controller.definition.projectName ?? null, service: preflight.controller.definition.service ?? null, unit: preflight.controller.definition.unit ?? null, sourceFiles: originalRecords.map(row => row.relativePath) };
  atomicWrite(exactReplayPath, Buffer.from(`${JSON.stringify(exactReplay, null, 2)}\n`), 0o600);
  const verification = join(staging, "verification");
  mkdirSync(verification, { mode: 0o700 });
  atomicWrite(join(verification, "quick-check.txt"), Buffer.from("ok\n"), 0o600);
  atomicWrite(join(verification, "foreign-key-check.txt"), Buffer.from("0 violations\n"), 0o600);
  const capabilityRecord = copyFileRecord(preflight.capability.path, join(verification, "capability-receipt.json"), staging);
  const toolRecord = copyFileRecord(toolPath, join(verification, "backup-tool-manifest.json"), staging);
  const optionalRecords = {};
  if (preflight.rollbackRequired) {
    for (const [name, asset] of Object.entries(preflight.rollbackAssets)) {
      if (name === "rollback_guard_image_id") continue;
      const destination = join(payload, "rollback", `${name}${asset.path.endsWith(".tar") ? ".tar" : ".json"}`);
      optionalRecords[name] = copyFileRecord(asset.path, destination, staging);
    }
  }
  const manifest = {
    manifestKind: "runtime-snapshot-v1",
    formatVersion: preflight.capability.snapshotFormat.write,
    createdAt: new Date().toISOString(),
    releaseId,
    expectedPreflightSha256: preflightSha,
    backupToolManifestSha256: toolSha,
    backupToolGitSha: tool.sourceCommit,
    inputTreeHash: tool.inputTreeHash,
    imageId: preflight.sourceImage.id,
    imageProvenanceStatus: preflight.sourceImage.provenanceStatus,
    imageRevision: preflight.sourceImage.revision,
    imageCreatedAt: preflight.sourceImage.createdAt,
    repoDigest: preflight.sourceImage.repoDigest,
    imageArchiveSha256: sha256File(imageArchive),
    originalControllerDefinitionSha256: preflight.controller.definitionSha256,
    exactReplayDefinitionSha256: sha256File(exactReplayPath),
    schemaVersion: preflight.sqlite.schemaVersion,
    capabilityReceiptSha256: preflight.capability.sha256,
    capabilityEvidence: preflight.capability.evidence,
    capabilitySetId: preflight.capability.release.capabilitySetId,
    rollbackClientRequired: preflight.rollbackRequired,
    sourceImageClientDatabaseVersionStatus: preflight.sourceImage.clientDatabaseVersionStatus,
    sourceImageClientDatabaseVersion: preflight.sourceImage.clientDatabaseVersion,
    runtimeInventorySha256: inventoryDigest(sourceInventory),
    runtimeFiles: sourceInventory,
    fileCount: sourceInventory.filter(row => row.type === "file").length,
    totalBytes: sourceInventory.reduce((sum, row) => sum + (row.size ?? 0), 0),
    stopEvidence: { scope: evidence.scope, phase: evidence.phase, releaseId: evidence.releaseId, expectedPreflightSha256: evidence.expectedPreflightSha256, stoppedAt: evidence.capturedAt, stopEvidenceSha256: evidenceSha, controller: evidence.controller.kind === "docker-compose" ? { kind: evidence.controller.kind, projectName: evidence.controller.projectName, service: evidence.controller.service, containerId: evidence.controller.containerId, imageId: evidence.controller.imageId, createdAt: evidence.controller.createdAt, configSha256: evidence.controller.configSha256 } : { kind: evidence.controller.kind, unit: evidence.controller.unit, activeState: evidence.controller.activeState } },
    verification: { capability: capabilityRecord, toolManifest: toolRecord },
    rollbackAssets: preflight.rollbackRequired ? { ...optionalRecords, rollback_guard_image_id: preflight.rollbackAssets.rollback_guard_image_id } : {}
  };
  sealJson(join(staging, "manifest.json"), manifest);
  fsyncTree(staging);
  renameSync(staging, final);
  const parentFd = openSync(outputRoot, constants.O_RDONLY);
  try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  process.stdout.write(`${final}\n`);
}

main().catch(error => die(PREFIX, error));
