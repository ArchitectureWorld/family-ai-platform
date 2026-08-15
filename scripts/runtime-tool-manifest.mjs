#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  die,
  parseArgs,
  readJson,
  requireAbsolute,
  requireHex,
  sealJson,
  sha256File,
  verifySidecar
} from "./runtime-release-lib.mjs";

const PREFIX = "RUNTIME_TOOL_MANIFEST_FAILED";
const toolPaths = [
  "scripts/runtime-release-lib.mjs",
  "scripts/runtime-tool-manifest.mjs",
  "scripts/runtime-backup-preflight.mjs",
  "scripts/runtime-stop-evidence.mjs",
  "scripts/runtime-snapshot.mjs",
  "scripts/runtime-backup.sh",
  "scripts/runtime-rollback-assets.mjs",
  "scripts/runtime-candidate-stage.sh",
  "scripts/runtime-candidate-manifest.mjs",
  "scripts/runtime-exchange-preflight.mjs",
  "scripts/atomic-dir-exchange.c",
  "scripts/build-atomic-dir-exchange.sh",
  "scripts/runtime-restore.sh",
  "scripts/runtime-restore.mjs",
  "apps/gateway/src/migrate.ts"
];

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function main() {
  const command = process.argv[2];
  if (command === "create") {
    const args = parseArgs(process.argv.slice(2), {
      command: "create",
      required: ["--repository", "--source-commit", "--expected-source-commit", "--release-build-inputs", "--output"]
    });
    const repository = requireAbsolute(args["--repository"], "REPOSITORY", { type: "dir", repositoryRoot: "/" });
    const source = requireHex(args["--source-commit"], 40, "SOURCE_COMMIT");
    const expected = requireHex(args["--expected-source-commit"], 40, "EXPECTED_SOURCE_COMMIT");
    if (source !== expected) throw new Error("SOURCE_COMMIT_MISMATCH");
    if (git(repository, ["rev-parse", `${source}^{commit}`]) !== source) throw new Error("SOURCE_COMMIT_INVALID");
    const inputManifest = requireAbsolute(args["--release-build-inputs"], "RELEASE_BUILD_INPUTS", { type: "file" });
    const output = requireAbsolute(args["--output"], "OUTPUT", { exists: false });
    const temporary = mkdtempSync(join(dirname(output), ".runtime-tool-receipt."));
    chmodSync(temporary, 0o700);
    try {
      const receiptPath = join(temporary, "build-inputs.json");
      execFileSync("node", [join(repository, "scripts/release-build-inputs.mjs"), "validate", "--repository", repository, "--source-commit", source, "--manifest", inputManifest, "--output", receiptPath], { stdio: ["ignore", "ignore", "pipe"] });
      const receipt = readJson(receiptPath, "BUILD_INPUT_RECEIPT");
      const tools = toolPaths.map(path => {
        const row = git(repository, ["ls-tree", source, "--", path]);
        const match = row.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/);
        if (!match || match[3] !== path) throw new Error(`TOOL_INPUT_INVALID:${path}`);
        const bytes = execFileSync("git", ["-C", repository, "cat-file", "blob", match[2]]);
        return { path, mode: match[1], objectId: match[2], sha256: createHash("sha256").update(bytes).digest("hex") };
      });
      const manifest = {
        manifestKind: "runtime-tool-manifest-v1",
        formatVersion: 1,
        sourceCommit: source,
        releaseBuildInputsSha256: receipt.releaseBuildInputsSha256,
        inputTreeHash: receipt.buildInputTreeHash,
        tools
      };
      process.stdout.write(`${sealJson(output, manifest)}\n`);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    return;
  }
  if (command === "verify") {
    const args = parseArgs(process.argv.slice(2), { command: "verify", required: ["--repository", "--manifest", "--expected-sha256"] });
    const repository = requireAbsolute(args["--repository"], "REPOSITORY", { type: "dir", repositoryRoot: "/" });
    const manifestPath = requireAbsolute(args["--manifest"], "MANIFEST", { type: "file" });
    const digest = verifySidecar(manifestPath, args["--expected-sha256"], "TOOL_MANIFEST");
    const manifest = readJson(manifestPath, "TOOL_MANIFEST");
    if (manifest.manifestKind !== "runtime-tool-manifest-v1" || manifest.formatVersion !== 1 || !Array.isArray(manifest.tools)) throw new Error("TOOL_MANIFEST_FORMAT_INVALID");
    if (git(repository, ["rev-parse", "HEAD"]) !== manifest.sourceCommit) throw new Error("TOOL_SOURCE_HEAD_MISMATCH");
    for (const tool of manifest.tools) {
      const path = join(repository, tool.path);
      requireAbsolute(path, "TOOL", { type: "file" });
      const mode = (statSync(path).mode & 0o111) ? "100755" : "100644";
      if (mode !== tool.mode || sha256File(path) !== tool.sha256) throw new Error(`TOOL_DRIFT:${tool.path}`);
    }
    process.stdout.write(`${digest}\n`);
    return;
  }
  throw new Error("UNKNOWN_COMMAND");
}

main().catch(error => die(PREFIX, error));
