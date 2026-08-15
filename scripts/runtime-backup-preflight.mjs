#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, statfsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  die,
  inventoryDigest,
  inventoryTree,
  parseArgs,
  readJson,
  requireAbsolute,
  requireHex,
  requireRegular0600,
  requireSafeId,
  sealJson,
  sha256,
  sha256File,
  verifySidecar
} from "./runtime-release-lib.mjs";

const PREFIX = "RUNTIME_BACKUP_PREFLIGHT_FAILED";
const phaseRules = {
  "formal-production": {
    "prepare-backup": "current-retained",
    "cutover-final-backup": "current-retained",
    "activate-candidate": "candidate-retained",
    "rollback-unarmed-candidate": "candidate-retained"
  },
  "fixture-rehearsal": { "fixture-source-snapshot": "fixture-baseline" }
};

function inspectImage(imageId) {
  const raw = execFileSync("docker", ["image", "inspect", imageId], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const values = JSON.parse(raw);
  if (!Array.isArray(values) || values.length !== 1 || values[0].Id !== imageId) throw new Error("SOURCE_IMAGE_ID_MISMATCH");
  return values[0];
}

function validateController(path, imageId) {
  requireRegular0600(path, "CONTROLLER_DEFINITION");
  const definition = readJson(path, "CONTROLLER_DEFINITION");
  if (!["docker-compose", "systemd-user", "systemd-system"].includes(definition.kind)) throw new Error("CONTROLLER_KIND_INVALID");
  if (definition.imageId !== imageId) throw new Error("CONTROLLER_IMAGE_MISMATCH");
  if (definition.kind === "docker-compose") {
    requireSafeId(definition.projectName, "CONTROLLER_PROJECT");
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(definition.service ?? "")) throw new Error("CONTROLLER_SERVICE_INVALID");
  } else if (!/^[A-Za-z0-9@_.-]+\.service$/.test(definition.unit ?? "")) {
    throw new Error("CONTROLLER_UNIT_INVALID");
  }
  if (!Array.isArray(definition.sourceFiles) || definition.sourceFiles.length === 0) throw new Error("CONTROLLER_SOURCE_FILES_MISSING");
  const sourceFiles = definition.sourceFiles.map((source, index) => {
    requireRegular0600(source, `CONTROLLER_SOURCE_${index}`);
    return { path: source, sha256: sha256File(source), mode: statSync(source).mode & 0o777 };
  });
  return { definition, sha256: sha256File(path), sourceFiles };
}

function sqliteEvidence(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const quick = db.pragma("quick_check", { simple: true });
    if (quick !== "ok") throw new Error("SQLITE_QUICK_CHECK_FAILED");
    const foreign = db.pragma("foreign_key_check");
    if (!Array.isArray(foreign) || foreign.length !== 0) throw new Error("SQLITE_FOREIGN_KEY_CHECK_FAILED");
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
    if (!Number.isInteger(row?.version)) throw new Error("SCHEMA_VERSION_MISSING");
    return { schemaVersion: row.version, quickCheck: "ok", foreignKeyViolations: 0 };
  } finally { db.close(); }
}

function ensurePrivateTree(records) {
  for (const record of records) {
    if ((record.mode & 0o077) !== 0) throw new Error(`RUNTIME_MODE_TOO_OPEN:${record.path}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    required: ["--scope", "--phase", "--release-id", "--runtime-root", "--controller-definition", "--capability-receipt", "--expected-capability-receipt-sha256", "--source-image-role", "--source-image-id", "--output"],
    optional: ["--source-image-revision", "--legacy-attachments", "--candidate-image-manifest", "--rollback-client-bundle", "--rollback-guard-image-archive", "--rollback-guard-image-id", "--rollback-recovery-template", "--rollback-recovery-instance-set", "--rollback-materialization-receipt"]
  });
  const scope = args["--scope"];
  const phase = args["--phase"];
  const role = args["--source-image-role"];
  if (phaseRules[scope]?.[phase] !== role) throw new Error("SCOPE_PHASE_ROLE_INVALID");
  const releaseId = requireSafeId(args["--release-id"], "RELEASE_ID");
  const runtimeRoot = requireAbsolute(args["--runtime-root"], "RUNTIME_ROOT", { type: "dir", mode: 0o700 });
  const output = requireAbsolute(args["--output"], "OUTPUT", { exists: false });
  if (dirname(output) === runtimeRoot || output.startsWith(`${runtimeRoot}/`)) throw new Error("OUTPUT_INSIDE_RUNTIME");
  const capabilityPath = requireAbsolute(args["--capability-receipt"], "CAPABILITY_RECEIPT", { type: "file" });
  const capabilitySha = verifySidecar(capabilityPath, args["--expected-capability-receipt-sha256"], "CAPABILITY_RECEIPT");
  const capability = readJson(capabilityPath, "CAPABILITY_RECEIPT");
  if (capability.manifestKind !== "gateway-capability-receipt-v1") throw new Error("CAPABILITY_RECEIPT_KIND_INVALID");
  const runtimeInventory = inventoryTree(runtimeRoot);
  ensurePrivateTree(runtimeInventory);
  const databasePath = join(runtimeRoot, "data", "gateway.sqlite");
  requireAbsolute(databasePath, "DATABASE", { type: "file" });
  const sqlite = sqliteEvidence(databasePath);
  const schemaEntry = capability.schemas.find(entry => entry.schemaVersion === sqlite.schemaVersion);
  if (!schemaEntry) throw new Error("SOURCE_SCHEMA_UNSUPPORTED");
  const attachmentRoot = join(runtimeRoot, "data", "attachments");
  let attachmentStatus;
  try {
    requireAbsolute(attachmentRoot, "ATTACHMENT_ROOT", { type: "dir" });
    attachmentStatus = "present";
  } catch (error) {
    if (schemaEntry.attachments !== "absent-legacy" || args["--legacy-attachments"] !== "absent-if-schema-before-v8") throw error;
    attachmentStatus = "not-applicable-legacy";
  }
  if (schemaEntry.attachments === "present" && attachmentStatus !== "present") throw new Error("ATTACHMENT_ROOT_REQUIRED");
  const sourceImageId = args["--source-image-id"];
  if (!/^sha256:[0-9a-f]{64}$/.test(sourceImageId)) throw new Error("SOURCE_IMAGE_ID_INVALID");
  const image = inspectImage(sourceImageId);
  const labels = image.Config?.Labels ?? {};
  const suppliedRevision = args["--source-image-revision"];
  if (suppliedRevision) requireHex(suppliedRevision, 40, "SOURCE_IMAGE_REVISION");
  const labelRevision = labels["org.opencontainers.image.revision"];
  const clientLabel = labels["org.architectureworld.family-ai.client-database-version"];
  let provenanceStatus = "legacy-unknown-revision";
  let clientStatus = "legacy-unknown";
  let revision = suppliedRevision ?? null;
  if (/^[0-9a-f]{40}$/.test(labelRevision ?? "")) {
    if (suppliedRevision && suppliedRevision !== labelRevision) throw new Error("SOURCE_IMAGE_REVISION_MISMATCH");
    revision = labelRevision;
    provenanceStatus = "verified-exact-revision";
  }
  if (/^[1-9][0-9]*$/.test(clientLabel ?? "")) clientStatus = "verified-label";
  if (role === "candidate-retained" && (provenanceStatus !== "verified-exact-revision" || clientStatus !== "verified-label")) throw new Error("CANDIDATE_IMAGE_PROVENANCE_REQUIRED");
  const controller = validateController(args["--controller-definition"], sourceImageId);
  const requiredAssets = ["--candidate-image-manifest", "--rollback-client-bundle", "--rollback-guard-image-archive", "--rollback-guard-image-id", "--rollback-recovery-template", "--rollback-recovery-instance-set", "--rollback-materialization-receipt"];
  const rollbackRequired = capability.release.rollbackClientRequired;
  if (!rollbackRequired && requiredAssets.some(key => args[key])) throw new Error("ROLLBACK_ASSETS_FORBIDDEN");
  if (rollbackRequired && requiredAssets.some(key => !args[key])) throw new Error("ROLLBACK_ASSETS_REQUIRED");
  const rollbackAssets = {};
  if (rollbackRequired) {
    for (const key of requiredAssets.filter(key => key !== "--rollback-guard-image-id")) {
      const path = requireRegular0600(args[key], key.slice(2).toUpperCase());
      rollbackAssets[key.slice(2).replaceAll("-", "_")] = { path, sha256: sha256File(path) };
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(args["--rollback-guard-image-id"])) throw new Error("ROLLBACK_GUARD_IMAGE_ID_INVALID");
    rollbackAssets.rollback_guard_image_id = args["--rollback-guard-image-id"];
    const candidate = readJson(args["--candidate-image-manifest"], "CANDIDATE_IMAGE_MANIFEST");
    const gateway = candidate.manifestKind === "gateway-image-v1" ? candidate : candidate.manifestKind === "release-candidate-v1" ? candidate.gatewayImage : null;
    if (gateway?.manifestKind !== "gateway-image-v1" || gateway.releaseCapabilityReceiptSha256 !== capabilitySha || !/^sha256:[0-9a-f]{64}$/.test(gateway.imageId ?? "") || !/^[0-9a-f]{40}$/.test(gateway.sourceCommit ?? "")) throw new Error("CANDIDATE_IMAGE_MANIFEST_INVALID");
    const candidateImage = inspectImage(gateway.imageId);
    const candidateLabels = candidateImage.Config?.Labels ?? {};
    if (candidateLabels["org.opencontainers.image.revision"] !== gateway.sourceCommit || candidateLabels["org.architectureworld.family-ai.release-capability-receipt-sha256"] !== capabilitySha || Number(candidateLabels["org.architectureworld.family-ai.client-database-version"]) !== capability.release.clientDatabaseVersion) throw new Error("CANDIDATE_IMAGE_PROVENANCE_INVALID");
    execFileSync("node", [join(dirname(new URL(import.meta.url).pathname), "runtime-rollback-assets.mjs"), "validate", "--bundle", args["--rollback-client-bundle"], "--expected-bundle-sha256", rollbackAssets.rollback_client_bundle.sha256], { stdio: ["ignore", "ignore", "pipe"] });
    const archiveManifest = JSON.parse(execFileSync("tar", ["-xOf", args["--rollback-guard-image-archive"], "manifest.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    if (!Array.isArray(archiveManifest) || archiveManifest.length !== 1 || !/^[0-9a-f]{64}\.json$/.test(archiveManifest[0]?.Config ?? "")) throw new Error("ROLLBACK_GUARD_ARCHIVE_INVALID");
    const configBytes = execFileSync("tar", ["-xOf", args["--rollback-guard-image-archive"], archiveManifest[0].Config], { stdio: ["ignore", "pipe", "pipe"] });
    if (`sha256:${sha256(configBytes)}` !== args["--rollback-guard-image-id"]) throw new Error("ROLLBACK_GUARD_ARCHIVE_ID_MISMATCH");
    const template = readFileSync(args["--rollback-recovery-template"], "utf8");
    if ((template.match(/\$\{RECOVERY_ASSET_DIR\}/g) ?? []).length !== 1) throw new Error("ROLLBACK_TEMPLATE_TOKEN_INVALID");
    const materialization = readJson(args["--rollback-materialization-receipt"], "ROLLBACK_MATERIALIZATION_RECEIPT");
    verifySidecar(args["--rollback-materialization-receipt"], sha256File(args["--rollback-materialization-receipt"]), "ROLLBACK_MATERIALIZATION_RECEIPT");
    if (materialization.manifestKind !== "rollback-materialization-v1" || materialization.bundleSha256 !== rollbackAssets.rollback_client_bundle.sha256) throw new Error("ROLLBACK_MATERIALIZATION_INVALID");
    const guard = inspectImage(args["--rollback-guard-image-id"]);
    if (guard.Id !== args["--rollback-guard-image-id"]) throw new Error("ROLLBACK_GUARD_IMAGE_MISMATCH");
  }
  const availableBytes = Number(statfsSync(dirname(runtimeRoot), { bigint: true }).bavail * statfsSync(dirname(runtimeRoot), { bigint: true }).bsize);
  const runtimeBytes = runtimeInventory.reduce((sum, record) => sum + (record.size ?? 0), 0);
  if (availableBytes < runtimeBytes * 2 + 16 * 1024 * 1024) throw new Error("INSUFFICIENT_SPACE");
  const preflight = {
    manifestKind: "runtime-backup-preflight-v1",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    scope, phase, releaseId, sourceImageRole: role,
    runtime: { root: runtimeRoot, device: statSync(runtimeRoot).dev, inode: statSync(runtimeRoot).ino, ownerUid: statSync(runtimeRoot).uid, inventorySha256: inventoryDigest(runtimeInventory), fileCount: runtimeInventory.filter(row => row.type === "file").length, totalBytes: runtimeBytes, databasePath, attachmentRoot, attachmentStatus },
    sqlite,
    capability: { path: capabilityPath, sha256: capabilitySha, snapshotFormat: capability.snapshotFormat, schemaEntry, release: capability.release, evidence: capability.evidence },
    sourceImage: { id: sourceImageId, revision, provenanceStatus, clientDatabaseVersionStatus: clientStatus, clientDatabaseVersion: clientLabel ? Number(clientLabel) : null, createdAt: image.Created ?? null, repoDigest: image.RepoDigests?.[0] ?? null },
    controller: { path: args["--controller-definition"], definitionSha256: controller.sha256, definition: controller.definition, sourceFiles: controller.sourceFiles },
    rollbackRequired,
    rollbackAssets,
    space: { availableBytes, requiredBytes: runtimeBytes * 2 + 16 * 1024 * 1024 }
  };
  const hash = sealJson(output, preflight);
  process.stdout.write(`${hash}\n`);
}

main().catch(error => die(PREFIX, error));
