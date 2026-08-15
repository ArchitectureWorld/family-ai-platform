#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { die, parseArgs, requireAbsolute, sealJson, sha256File } from "./runtime-release-lib.mjs";

const PREFIX = "RUNTIME_EXCHANGE_PREFLIGHT_FAILED";

function helper(path) {
  requireAbsolute(path, "HELPER", { type: "file" });
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o700 && mode !== 0o500) throw new Error("HELPER_MODE_INVALID");
  return path;
}

async function main() {
  if (process.argv[2] === "build-receipt") {
    const args = parseArgs(process.argv.slice(2), { command: "build-receipt", required: ["--helper", "--source", "--build-script", "--output"] });
    const binary = helper(args["--helper"]);
    const source = requireAbsolute(args["--source"], "SOURCE", { type: "file" });
    const build = requireAbsolute(args["--build-script"], "BUILD_SCRIPT", { type: "file" });
    const output = requireAbsolute(args["--output"], "OUTPUT", { exists: false });
    process.stdout.write(`${sealJson(output, { manifestKind: "atomic-dir-exchange-build-v1", formatVersion: 1, helper: { basename: basename(binary), sha256: sha256File(binary) }, source: { basename: basename(source), sha256: sha256File(source) }, buildScript: { basename: basename(build), sha256: sha256File(build) } })}\n`);
    return;
  }
  const args = parseArgs(process.argv.slice(2), { required: ["--helper", "--target-parent", "--output"] });
  const binary = helper(args["--helper"]);
  const parent = requireAbsolute(args["--target-parent"], "TARGET_PARENT", { type: "dir", mode: 0o700 });
  const output = requireAbsolute(args["--output"], "OUTPUT", { exists: false });
  if (dirname(output) === parent) throw new Error("OUTPUT_INSIDE_TARGET_PARENT");
  const left = join(parent, `.exchange-left-${randomUUID()}`);
  const right = join(parent, `.exchange-right-${randomUUID()}`);
  mkdirSync(left, { mode: 0o700 });
  mkdirSync(right, { mode: 0o700 });
  const leftInode = statSync(left).ino;
  const rightInode = statSync(right).ino;
  try {
    execFileSync(binary, [left, right], { stdio: ["ignore", "ignore", "pipe"] });
    if (statSync(left).ino !== rightInode || statSync(right).ino !== leftInode) throw new Error("EXCHANGE_PROBE_INODE_MISMATCH");
    execFileSync(binary, [left, right], { stdio: ["ignore", "ignore", "pipe"] });
    if (statSync(left).ino !== leftInode || statSync(right).ino !== rightInode) throw new Error("EXCHANGE_RESTORE_INODE_MISMATCH");
  } finally {
    rmdirSync(left);
    rmdirSync(right);
  }
  const receipt = { manifestKind: "runtime-exchange-capability-v1", formatVersion: 1, createdAt: new Date().toISOString(), targetParentDevice: statSync(parent).dev, targetParentInode: statSync(parent).ino, helperPath: binary, helperSha256: sha256File(binary), helperMode: statSync(binary).mode & 0o777, probeResult: "exchanged-and-restored" };
  process.stdout.write(`${sealJson(output, receipt)}\n`);
}

main().catch(error => die(PREFIX, error));
