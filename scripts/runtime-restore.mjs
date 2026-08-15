#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  atomicWrite, copyInventory, die, fsyncTree, inventoryDigest, inventoryTree,
  parseArgs, readJson, requireAbsolute, requireRegular0600, requireSafeId,
  sealJson, sha256File, verifySidecar
} from "./runtime-release-lib.mjs";

const PREFIX = "RUNTIME_RESTORE_FAILED";

function stopped(evidence, checkAdmissionTtl = false) {
  if (checkAdmissionTtl && Date.parse(evidence.expiresAt) < Date.now()) throw new Error("STOP_EVIDENCE_EXPIRED");
  if (evidence.controller.kind === "docker-compose") {
    const container = JSON.parse(execFileSync("docker", ["inspect", evidence.controller.containerId], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
    if (container.Id !== evidence.controller.containerId || container.Image !== evidence.controller.imageId || container.State?.Running || container.State?.Restarting) throw new Error("STOP_LEASE_LOST");
  } else {
    const base = evidence.controller.kind === "systemd-user" ? ["--user"] : [];
    if (spawnSync("systemctl", [...base, "is-active", "--quiet", evidence.controller.unit]).status === 0) throw new Error("STOP_LEASE_LOST");
  }
  if (evidence.expectedBind !== "none") {
    const port = evidence.expectedBind.split(":").at(-1);
    const result = spawnSync("ss", ["-H", "-ltn", `sport = :${port}`], { encoding: "utf8" });
    if (result.status !== 0 || result.stdout.trim()) throw new Error("STOP_LISTENER_REAPPEARED");
  }
}

function sqlite(path, expectedSchema) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const version = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version;
    if (version !== expectedSchema || db.pragma("quick_check", { simple: true }) !== "ok" || db.pragma("foreign_key_check").length) throw new Error("RESTORED_SQLITE_INVALID");
  } finally { db.close(); }
}

function sealed(path, name) {
  requireRegular0600(path, name);
  verifySidecar(path, sha256File(path), name);
  return readJson(path, name);
}

async function main() {
  const recovery = ["--recovery-release-root", "--recovery-instance-output", "--materialization-receipt-output", "--guard-handoff-manifest-output"];
  const args = parseArgs(process.argv.slice(2), { required: ["--scope", "--phase", "--release-id", "--preflight", "--expected-preflight-sha256", "--stop-evidence", "--exchange-capability", "--snapshot", "--target-runtime-root", "--client-rollback-mode", "--receipt"], optional: ["--candidate-manifest", "--committed-exchange-receipt", ...recovery] });
  if (![["formal-production", "candidate-rollback"], ["formal-production", "restore-previous"], ["fixture-rehearsal", "candidate-rollback"], ["fixture-rehearsal", "restore-previous"]].some(([scope, phase]) => args["--scope"] === scope && args["--phase"] === phase)) throw new Error("SCOPE_PHASE_INVALID");
  const releaseId = requireSafeId(args["--release-id"], "RELEASE_ID");
  const preflightPath = requireRegular0600(args["--preflight"], "PREFLIGHT");
  const preflightSha = verifySidecar(preflightPath, args["--expected-preflight-sha256"], "PREFLIGHT");
  const preflight = readJson(preflightPath, "PREFLIGHT");
  const evidence = sealed(args["--stop-evidence"], "STOP_EVIDENCE");
  const exchange = sealed(args["--exchange-capability"], "EXCHANGE_CAPABILITY");
  const snapshot = requireAbsolute(args["--snapshot"], "SNAPSHOT", { type: "dir", mode: 0o700 });
  const snapshotManifestPath = join(snapshot, "manifest.json");
  const snapshotManifest = sealed(snapshotManifestPath, "SNAPSHOT_MANIFEST");
  const target = requireAbsolute(args["--target-runtime-root"], "TARGET_RUNTIME_ROOT", { type: "dir", mode: 0o700 });
  const receipt = requireAbsolute(args["--receipt"], "RECEIPT", { exists: false });
  if (preflight.scope !== args["--scope"] || preflight.releaseId !== releaseId || evidence.scope !== args["--scope"] || evidence.phase !== args["--phase"] || evidence.releaseId !== releaseId || evidence.expectedPreflightSha256 !== preflightSha || snapshotManifest.releaseId !== releaseId || snapshotManifest.expectedPreflightSha256 !== preflightSha) throw new Error("RESTORE_AUTHORITY_MISMATCH");
  if (target !== preflight.runtime.root || statSync(dirname(target)).dev !== exchange.targetParentDevice || exchange.probeResult !== "exchanged-and-restored") throw new Error("RESTORE_TARGET_MISMATCH");
  const helper = requireAbsolute(exchange.helperPath, "EXCHANGE_HELPER", { type: "file" });
  if (sha256File(helper) !== exchange.helperSha256) throw new Error("EXCHANGE_HELPER_DRIFT");
  const mode = args["--client-rollback-mode"];
  if (mode === "previous-native") {
    if (recovery.some(key => args[key])) throw new Error("RECOVERY_ARGUMENTS_FORBIDDEN");
  } else if (mode === "read-only-recovery") {
    if (recovery.some(key => !args[key])) throw new Error("RECOVERY_ARGUMENTS_REQUIRED");
  } else throw new Error("CLIENT_ROLLBACK_MODE_INVALID");
  let recoveryInputs = null;
  if (mode === "read-only-recovery") {
    const releaseRoot = requireAbsolute(args["--recovery-release-root"], "RECOVERY_RELEASE_ROOT", { type: "dir", mode: 0o700 });
    const bundle = requireAbsolute(join(snapshot, "payload", "rollback", "rollback_client_bundle.tar"), "SNAPSHOT_ROLLBACK_BUNDLE", { type: "file" });
    const template = requireAbsolute(join(snapshot, "payload", "rollback", "rollback_recovery_template.json"), "SNAPSHOT_RECOVERY_TEMPLATE", { type: "file" });
    const bundleSha = snapshotManifest.rollbackAssets?.rollback_client_bundle?.sha256;
    if (!/^[0-9a-f]{64}$/.test(bundleSha ?? "") || sha256File(bundle) !== bundleSha || sha256File(template) !== snapshotManifest.rollbackAssets?.rollback_recovery_template?.sha256) throw new Error("SNAPSHOT_RECOVERY_ASSET_DRIFT");
    if (existsSync(args["--recovery-instance-output"]) || existsSync(args["--materialization-receipt-output"]) || existsSync(args["--guard-handoff-manifest-output"])) throw new Error("RECOVERY_OUTPUT_MUST_BE_NEW");
    recoveryInputs = { releaseRoot, bundle, template, bundleSha };
  }
  if (args["--phase"] === "candidate-rollback") {
    if (!args["--candidate-manifest"] || !args["--committed-exchange-receipt"]) throw new Error("CANDIDATE_EXCHANGE_EVIDENCE_REQUIRED");
    const candidate = sealed(args["--candidate-manifest"], "CANDIDATE_MANIFEST");
    const committed = sealed(args["--committed-exchange-receipt"], "COMMITTED_EXCHANGE_RECEIPT");
    if (candidate.releaseId !== releaseId || candidate.runtimeInode !== statSync(target).ino || committed.releaseId !== releaseId || committed.direction !== "candidate-activated") throw new Error("CANDIDATE_EXCHANGE_EVIDENCE_INVALID");
  } else if (args["--candidate-manifest"] || args["--committed-exchange-receipt"]) throw new Error("CANDIDATE_EXCHANGE_EVIDENCE_FORBIDDEN");
  stopped(evidence, true);
  const source = requireAbsolute(join(snapshot, "payload", "runtime"), "SNAPSHOT_RUNTIME", { type: "dir" });
  const sourceInventory = inventoryTree(source);
  if (inventoryDigest(sourceInventory) !== snapshotManifest.runtimeInventorySha256) throw new Error("SNAPSHOT_RUNTIME_DRIFT");
  const parked = join(dirname(target), `.parked-${releaseId}`);
  const intentPath = `${receipt}.intent.json`;
  let intent;
  let exchangeCommitted = false;
  if (existsSync(parked) || existsSync(intentPath)) {
    if (!existsSync(parked) || !existsSync(intentPath)) throw new Error("RESTORE_INCOMPLETE_STATE_INVALID");
    requireAbsolute(parked, "PARKED_RUNTIME", { type: "dir", mode: 0o700 });
    intent = sealed(intentPath, "EXCHANGE_INTENT");
    if (intent.releaseId !== releaseId || intent.snapshotManifestSha256 !== sha256File(snapshotManifestPath) || intent.helperSha256 !== exchange.helperSha256) throw new Error("RESTORE_INTENT_AUTHORITY_MISMATCH");
    const targetInode = statSync(target).ino;
    const parkedInode = statSync(parked).ino;
    if (targetInode === intent.restoredBeforeInode && parkedInode === intent.targetBeforeInode) exchangeCommitted = true;
    else if (targetInode !== intent.targetBeforeInode || parkedInode !== intent.restoredBeforeInode) throw new Error("RESTORE_INTENT_INODE_AMBIGUOUS");
  } else {
    requireAbsolute(parked, "PARKED_RUNTIME", { exists: false });
    copyInventory(source, parked, sourceInventory);
    chmodSync(parked, 0o700);
    fsyncTree(parked);
    sqlite(join(parked, "data", "gateway.sqlite"), snapshotManifest.schemaVersion);
    intent = { manifestKind: "runtime-exchange-intent-v1", formatVersion: 1, releaseId, direction: "restore-previous", targetBasename: basename(target), parkedBasename: basename(parked), targetBeforeInode: statSync(target).ino, restoredBeforeInode: statSync(parked).ino, snapshotManifestSha256: sha256File(snapshotManifestPath), helperSha256: exchange.helperSha256 };
    sealJson(intentPath, intent);
  }
  if (!exchangeCommitted) {
    stopped(evidence);
    execFileSync(helper, [target, parked], { stdio: ["ignore", "ignore", "pipe"] });
  }
  if (statSync(target).ino !== intent.restoredBeforeInode || statSync(parked).ino !== intent.targetBeforeInode) throw new Error("RESTORE_EXCHANGE_INODE_MISMATCH");
  sqlite(join(target, "data", "gateway.sqlite"), snapshotManifest.schemaVersion);
  let handoffSha = null;
  if (mode === "read-only-recovery") {
    const { releaseRoot, bundle, template: templatePath, bundleSha } = recoveryInputs;
    execFileSync("node", [join(dirname(new URL(import.meta.url).pathname), "runtime-rollback-assets.mjs"), "materialize", "--bundle", bundle, "--expected-bundle-sha256", bundleSha, "--release-root", releaseRoot, "--receipt", args["--materialization-receipt-output"]], { stdio: ["ignore", "ignore", "pipe"] });
    const template = JSON.stringify(readJson(templatePath, "RECOVERY_TEMPLATE"));
    if ((template.match(/\$\{RECOVERY_ASSET_DIR\}/g) ?? []).length !== 1) throw new Error("RECOVERY_TEMPLATE_TOKEN_INVALID");
    const materialized = join(releaseRoot, "recovery", bundleSha);
    const instanceOutput = requireAbsolute(args["--recovery-instance-output"], "RECOVERY_INSTANCE_OUTPUT", { exists: false });
    mkdirSync(instanceOutput, { mode: 0o700 });
    atomicWrite(join(instanceOutput, "instance.json"), Buffer.from(`${template.replace('${RECOVERY_ASSET_DIR}', materialized)}\n`), 0o600);
    const handoff = requireAbsolute(args["--guard-handoff-manifest-output"], "GUARD_HANDOFF", { exists: false });
    handoffSha = sealJson(handoff, { manifestKind: "rollback-guard-handoff-v1", formatVersion: 1, releaseId, snapshotManifestSha256: sha256File(snapshotManifestPath), materializationReceiptSha256: sha256File(args["--materialization-receipt-output"]), instanceSha256: sha256File(join(instanceOutput, "instance.json")), guardImageId: snapshotManifest.rollbackAssets?.rollback_guard_image_id });
  }
  stopped(evidence);
  const value = { manifestKind: "runtime-restore-receipt-v1", formatVersion: 1, createdAt: new Date().toISOString(), releaseId, scope: args["--scope"], phase: args["--phase"], clientRollbackMode: mode, snapshotManifestSha256: sha256File(snapshotManifestPath), preflightSha256: preflightSha, stopEvidenceSha256: sha256File(args["--stop-evidence"]), exchangeCapabilitySha256: sha256File(args["--exchange-capability"]), exchangeIntentSha256: sha256File(intentPath), restoredRuntimeInode: statSync(target).ino, parkedRuntimeInode: statSync(parked).ino, runtimeInventorySha256: inventoryDigest(inventoryTree(target)), guardHandoffManifestSha256: handoffSha };
  process.stdout.write(`${sealJson(receipt, value)}\n`);
}

main().catch(error => die(PREFIX, error));
