#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  copyInventory, die, fsyncTree, inventoryDigest, inventoryTree, parseArgs,
  readJson, requireAbsolute, requireRegular0600, requireSafeId, sealJson,
  sha256File, verifySidecar
} from "./runtime-release-lib.mjs";

const PREFIX = "RUNTIME_CANDIDATE_FAILED";

function schema(path) {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma("quick_check", { simple: true }) !== "ok" || database.pragma("foreign_key_check").length !== 0) throw new Error("CANDIDATE_SQLITE_INVALID");
    const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
    if (!Number.isInteger(row?.version)) throw new Error("CANDIDATE_SCHEMA_INVALID");
    return row.version;
  } finally { database.close(); }
}

function imageRecord(path) {
  requireAbsolute(path, "CANDIDATE_IMAGE_MANIFEST", { type: "file" });
  const manifest = readJson(path, "CANDIDATE_IMAGE_MANIFEST");
  if (manifest.manifestKind === "gateway-image-v1") return manifest;
  if (manifest.manifestKind === "release-candidate-v1" && manifest.gatewayImage?.manifestKind === "gateway-image-v1") return manifest.gatewayImage;
  throw new Error("CANDIDATE_IMAGE_MANIFEST_KIND_INVALID");
}

function validateDefinition(path, image, receiptSha) {
  requireRegular0600(path, "CANDIDATE_DEFINITION");
  const value = readJson(path, "CANDIDATE_DEFINITION");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "attachmentRoot,databasePath,entrypoint,imageId,manifestKind,networkMode,releaseCapabilityReceiptSha256,runtimeMount,workerDisabled" ||
      value.manifestKind !== "gateway-migration-definition-v1" || value.imageId !== image.imageId ||
      value.releaseCapabilityReceiptSha256 !== receiptSha || value.networkMode !== "none" || value.workerDisabled !== true ||
      JSON.stringify(value.entrypoint) !== JSON.stringify(["node", "apps/gateway/dist/migrate.js"]) ||
      value.runtimeMount !== "/runtime" || value.databasePath !== "/runtime/data/gateway.sqlite" || value.attachmentRoot !== "/runtime/data/attachments") {
    throw new Error("CANDIDATE_DEFINITION_INVALID");
  }
  return value;
}

function validateManifest(path, expected) {
  const digest = verifySidecar(path, expected, "CANDIDATE_RUNTIME_MANIFEST");
  const value = readJson(path, "CANDIDATE_RUNTIME_MANIFEST");
  const allowed = ["afterSchema", "beforeSchema", "candidateDefinitionSha256", "candidateImageId", "candidateImageRevision", "capabilityReceiptSha256", "createdAt", "fileCount", "formatVersion", "manifestKind", "releaseId", "runtimeBasename", "runtimeDevice", "runtimeFiles", "runtimeInode", "runtimeInventorySha256", "sourceSnapshotSha256", "totalBytes"].sort().join(",");
  if (Object.keys(value).sort().join(",") !== allowed || value.manifestKind !== "candidate-runtime-v1" || value.formatVersion !== 1 || !Array.isArray(value.runtimeFiles) || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.releaseId ?? "") || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.runtimeBasename ?? "")) throw new Error("CANDIDATE_RUNTIME_MANIFEST_FORMAT_INVALID");
  process.stdout.write(`${digest}\n`);
}

async function main() {
  if (process.argv[2] === "validate") {
    const args = parseArgs(process.argv.slice(2), { command: "validate", required: ["--manifest", "--expected-sha256"] });
    validateManifest(requireRegular0600(args["--manifest"], "CANDIDATE_RUNTIME_MANIFEST"), args["--expected-sha256"]);
    return;
  }
  const args = parseArgs(process.argv.slice(2), { command: "stage", required: ["--release-id", "--source-snapshot", "--candidate-image-manifest", "--capability-receipt", "--expected-capability-receipt-sha256", "--candidate-definition", "--target-parent", "--output-name", "--manifest"] });
  const releaseId = requireSafeId(args["--release-id"], "RELEASE_ID");
  const snapshot = requireAbsolute(args["--source-snapshot"], "SOURCE_SNAPSHOT", { type: "dir", mode: 0o700 });
  const snapshotManifestPath = join(snapshot, "manifest.json");
  const snapshotSha = verifySidecar(snapshotManifestPath, sha256File(snapshotManifestPath), "SOURCE_SNAPSHOT_MANIFEST");
  const snapshotManifest = readJson(snapshotManifestPath, "SOURCE_SNAPSHOT_MANIFEST");
  if (snapshotManifest.manifestKind !== "runtime-snapshot-v1" || snapshotManifest.releaseId !== releaseId || !snapshotManifest.capabilityReceiptSha256) throw new Error("SOURCE_SNAPSHOT_INVALID");
  const capability = requireRegular0600(args["--capability-receipt"], "CAPABILITY_RECEIPT");
  const receiptSha = verifySidecar(capability, args["--expected-capability-receipt-sha256"], "CAPABILITY_RECEIPT");
  if (receiptSha !== snapshotManifest.capabilityReceiptSha256) throw new Error("CAPABILITY_RECEIPT_SNAPSHOT_MISMATCH");
  const receipt = readJson(capability, "CAPABILITY_RECEIPT");
  const image = imageRecord(args["--candidate-image-manifest"]);
  if (image.releaseCapabilityReceiptSha256 !== receiptSha || image.sourceCommit !== image.labels?.["org.opencontainers.image.revision"] || !/^sha256:[0-9a-f]{64}$/.test(image.imageId ?? "")) throw new Error("CANDIDATE_IMAGE_BINDING_INVALID");
  const inspectedImage = JSON.parse(execFileSync("docker", ["image", "inspect", image.imageId], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
  const actualLabels = inspectedImage?.Config?.Labels ?? {};
  if (inspectedImage?.Id !== image.imageId || actualLabels["org.opencontainers.image.revision"] !== image.sourceCommit || actualLabels["org.architectureworld.family-ai.release-capability-receipt-sha256"] !== receiptSha || Number(actualLabels["org.architectureworld.family-ai.client-database-version"]) !== receipt.release.clientDatabaseVersion) throw new Error("CANDIDATE_IMAGE_RUNTIME_PROVENANCE_INVALID");
  if (receipt.release?.schemaHead !== Number(image.labels?.["org.architectureworld.family-ai.schema-head"] ?? receipt.release?.schemaHead)) throw new Error("CANDIDATE_SCHEMA_HEAD_MISMATCH");
  const definition = validateDefinition(args["--candidate-definition"], image, receiptSha);
  const parent = requireAbsolute(args["--target-parent"], "TARGET_PARENT", { type: "dir", mode: 0o700 });
  const outputName = requireSafeId(args["--output-name"], "OUTPUT_NAME");
  const target = requireAbsolute(join(parent, outputName), "CANDIDATE_TARGET", { exists: false });
  const manifestOutput = requireAbsolute(args["--manifest"], "MANIFEST", { exists: false });
  if (statSync(parent).dev !== statSync(snapshot).dev) throw new Error("CANDIDATE_CROSS_FILESYSTEM");
  const sourceRuntime = requireAbsolute(join(snapshot, "payload", "runtime"), "SNAPSHOT_RUNTIME", { type: "dir" });
  const sourceInventory = inventoryTree(sourceRuntime);
  if (inventoryDigest(sourceInventory) !== snapshotManifest.runtimeInventorySha256) throw new Error("SNAPSHOT_RUNTIME_DRIFT");
  const staging = join(parent, `.${outputName}.staging-${process.pid}`);
  requireAbsolute(staging, "CANDIDATE_STAGING", { exists: false });
  copyInventory(sourceRuntime, staging, sourceInventory);
  chmodSync(staging, 0o700);
  const databasePath = join(staging, "data", "gateway.sqlite");
  const beforeSchema = schema(databasePath);
  execFileSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${statSync(staging).uid}:${statSync(staging).gid}`, "--mount", `type=bind,src=${staging},dst=${definition.runtimeMount}`, "--entrypoint", "node", image.imageId, ...definition.entrypoint.slice(1), "--database", definition.databasePath], { stdio: ["ignore", "pipe", "pipe"] });
  const afterSchema = schema(databasePath);
  if (afterSchema !== receipt.release.schemaHead) throw new Error("CANDIDATE_MIGRATION_HEAD_MISMATCH");
  const inventory = inventoryTree(staging);
  fsyncTree(staging);
  renameSync(staging, target);
  const value = { manifestKind: "candidate-runtime-v1", formatVersion: 1, createdAt: new Date().toISOString(), releaseId, sourceSnapshotSha256: snapshotSha, candidateImageId: image.imageId, candidateImageRevision: image.sourceCommit, capabilityReceiptSha256: receiptSha, candidateDefinitionSha256: sha256File(args["--candidate-definition"]), beforeSchema, afterSchema, runtimeBasename: outputName, runtimeInventorySha256: inventoryDigest(inventory), runtimeFiles: inventory, fileCount: inventory.filter(row => row.type === "file").length, totalBytes: inventory.reduce((sum, row) => sum + (row.size ?? 0), 0), runtimeDevice: statSync(target).dev, runtimeInode: statSync(target).ino };
  process.stdout.write(`${sealJson(manifestOutput, value)}\n`);
}

main().catch(error => die(PREFIX, error));
