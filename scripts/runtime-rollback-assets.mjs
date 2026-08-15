#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  die, fsyncTree, inventoryDigest, inventoryTree, parseArgs, readJson,
  requireAbsolute, requireHex, sealJson, sha256File
} from "./runtime-release-lib.mjs";

const PREFIX = "RUNTIME_ROLLBACK_ASSETS_FAILED";
const MAX_BYTES = 256 * 1024 * 1024;

function inspect(bundle, expected) {
  requireAbsolute(bundle, "BUNDLE", { type: "file" });
  requireHex(expected, 64, "EXPECTED_BUNDLE_SHA256");
  if (sha256File(bundle) !== expected) throw new Error("BUNDLE_SHA256_MISMATCH");
  const lines = execFileSync("tar", ["-tf", bundle], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);
  const verbose = execFileSync("tar", ["-tvf", bundle], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);
  if (verbose.length !== lines.length || verbose.some(line => !["-", "d"].includes(line[0]))) throw new Error("BUNDLE_ENTRY_TYPE_UNSAFE");
  const paths = new Set();
  for (const line of lines) {
    const path = line.replace(/\/$/, "");
    if (!path || path.startsWith("/") || path.split("/").some(part => part === "" || part === "." || part === "..") || paths.has(path)) throw new Error("BUNDLE_ENTRY_UNSAFE");
    paths.add(path);
  }
  if (!paths.has("manifest.json")) throw new Error("BUNDLE_MANIFEST_MISSING");
}

async function main() {
  const command = process.argv[2];
  if (command === "validate") {
    const args = parseArgs(process.argv.slice(2), { command, required: ["--bundle", "--expected-bundle-sha256"] });
    inspect(args["--bundle"], args["--expected-bundle-sha256"]);
    process.stdout.write(`${args["--expected-bundle-sha256"]}\n`);
    return;
  }
  const args = parseArgs(process.argv.slice(2), { command: "materialize", required: ["--bundle", "--expected-bundle-sha256", "--release-root", "--receipt"] });
  const digest = args["--expected-bundle-sha256"];
  inspect(args["--bundle"], digest);
  const root = requireAbsolute(args["--release-root"], "RELEASE_ROOT", { type: "dir", mode: 0o700 });
  const receipt = requireAbsolute(args["--receipt"], "RECEIPT", { exists: false });
  const recovery = join(root, "recovery");
  mkdirSync(recovery, { recursive: true, mode: 0o700 });
  chmodSync(recovery, 0o700);
  const target = requireAbsolute(join(recovery, digest), "MATERIALIZED_TARGET", { exists: false });
  const staging = join(recovery, `.${digest}.staging-${process.pid}`);
  mkdirSync(staging, { mode: 0o700 });
  execFileSync("tar", ["--extract", "--file", args["--bundle"], "--directory", staging, "--no-same-owner", "--no-same-permissions"], { stdio: ["ignore", "ignore", "pipe"] });
  let inventory = inventoryTree(staging);
  const bytes = inventory.reduce((sum, row) => sum + (row.size ?? 0), 0);
  if (bytes > MAX_BYTES) throw new Error("BUNDLE_TOO_LARGE");
  const manifest = readJson(join(staging, "manifest.json"), "BUNDLE_MANIFEST");
  if (manifest.manifestKind !== "rollback-client-bundle-v1" || !Array.isArray(manifest.files)) throw new Error("BUNDLE_MANIFEST_INVALID");
  const expectedFiles = new Map(manifest.files.map(row => [row.path, row.sha256]));
  for (const row of inventory.filter(row => row.type === "file" && row.path !== "manifest.json")) if (expectedFiles.get(row.path) !== row.sha256) throw new Error("BUNDLE_FILE_HASH_MISMATCH");
  if (expectedFiles.size !== inventory.filter(row => row.type === "file" && row.path !== "manifest.json").length) throw new Error("BUNDLE_FILE_SET_MISMATCH");
  for (const row of inventory) chmodSync(join(staging, row.path), row.type === "directory" ? 0o500 : 0o400);
  chmodSync(staging, 0o500);
  inventory = inventoryTree(staging);
  fsyncTree(staging);
  renameSync(staging, target);
  const value = { manifestKind: "rollback-materialization-v1", formatVersion: 1, createdAt: new Date().toISOString(), bundleSha256: digest, bundleManifestSha256: sha256File(join(target, "manifest.json")), materializedBasename: basename(target), materializedDevice: statSync(target).dev, materializedInode: statSync(target).ino, inventorySha256: inventoryDigest(inventory), files: inventory };
  process.stdout.write(`${sealJson(receipt, value)}\n`);
}

main().catch(error => die(PREFIX, error));
