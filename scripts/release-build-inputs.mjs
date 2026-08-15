#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

const fail = message => {
  process.stderr.write(`BUILD_INPUT_VALIDATION_FAILED:${message}\n`);
  process.exit(1);
};
const sha256 = value => createHash("sha256").update(value).digest("hex");
const pinnedMaterials = {
  platform: "linux/amd64",
  baseImageRef: "node:22.16.0-bookworm-slim",
  baseImageDigest: "sha256:1471ea646673136b8308550ac14b36d847ffb21c24bc31828279e443c924e488",
  debianSnapshot: "http://snapshot.debian.org/archive/debian/20250611T000000Z",
  debianSecuritySnapshot: "http://snapshot.debian.org/archive/debian-security/20250611T000000Z",
  toolchainPackages: {
    python3: "3.11.2-1+b1",
    make: "4.3-4.1",
    "g++": "4:12.2.0-3",
    git: "1:2.39.5-0+deb12u2"
  }
};
const git = (repository, args, options = {}) => {
  try {
    return execFileSync("git", ["-C", repository, ...args], {
      encoding: options.buffer ? undefined : "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    fail(`GIT_COMMAND_FAILED:${args[0]}`);
  }
};
const parseArgs = values => {
  if (values[0] !== "validate") fail("EXPECTED_VALIDATE_COMMAND");
  const allowed = new Set(["--repository", "--source-commit", "--manifest", "--output"]);
  const result = {};
  for (let index = 1; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!allowed.has(key) || value === undefined || result[key]) fail("INVALID_ARGUMENTS");
    result[key] = value;
  }
  for (const key of allowed) if (!result[key]) fail(`MISSING_${key.slice(2).toUpperCase()}`);
  return result;
};
const matches = (pattern, path) => {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path.startsWith(`${prefix}/`);
  }
  return path === pattern;
};
const toRepoPath = (repository, path) => {
  const value = relative(repository, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value.includes("\0")) fail("MANIFEST_OUTSIDE_REPOSITORY");
  return value;
};

const args = parseArgs(process.argv.slice(2));
if (!isAbsolute(args["--repository"])) fail("REPOSITORY_MUST_BE_ABSOLUTE");
const repository = realpathSync(args["--repository"]);
const manifestPath = realpathSync(args["--manifest"]);
const manifestRepoPath = toRepoPath(repository, manifestPath);
const outputPath = args["--output"];
if (!isAbsolute(outputPath ?? "") || existsSync(outputPath) || existsSync(`${outputPath}.sha256`)) {
  fail("OUTPUT_MUST_BE_ABSOLUTE_AND_NEW");
}
if (!existsSync(dirname(outputPath))) fail("OUTPUT_PARENT_MISSING");

const sourceCommit = String(git(repository, ["rev-parse", "--verify", `${args["--source-commit"]}^{commit}`])).trim();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) fail("SOURCE_COMMIT_INVALID");
const manifestBytes = git(repository, ["show", `${sourceCommit}:${manifestRepoPath}`], { buffer: true });
if (!Buffer.from(readFileSync(manifestPath)).equals(Buffer.from(manifestBytes))) {
  fail("WORKTREE_MANIFEST_DIFFERS_FROM_SOURCE_COMMIT");
}
let manifest;
try {
  manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
} catch {
  fail("MANIFEST_JSON_INVALID");
}
if (
  manifest.formatVersion !== 1 ||
  JSON.stringify(manifest.classifications) !== JSON.stringify(["runtime-build", "quality-tool", "docs-only"]) ||
  !Array.isArray(manifest.rules)
) {
  fail("MANIFEST_FORMAT_INVALID");
}
const material = manifest.buildMaterials;
if (JSON.stringify(material) !== JSON.stringify(pinnedMaterials)) {
  fail("BUILD_MATERIALS_INVALID");
}
for (const [name, version] of Object.entries(material.toolchainPackages)) {
  if (typeof version !== "string" || version.length === 0 || /[\r\n]/.test(version)) {
    fail(`TOOLCHAIN_PACKAGE_INVALID:${name}`);
  }
}

const tree = git(repository, ["ls-tree", "-r", "-z", "--full-tree", sourceCommit], { buffer: true });
const records = [];
const counts = { "runtime-build": 0, "quality-tool": 0, "docs-only": 0 };
const seen = new Set();
for (const rawEntry of Buffer.from(tree).toString("utf8").split("\0")) {
  if (!rawEntry) continue;
  const match = rawEntry.match(/^([0-9]{6}) ([a-z]+) ([0-9a-f]{40,64})\t(.+)$/s);
  if (!match) fail("TREE_ENTRY_INVALID");
  const [, mode, type, objectId, path] = match;
  if (path.startsWith("/") || path.includes("..") || path.includes("\0")) fail("TREE_PATH_INVALID");
  if (seen.has(path)) fail("TREE_PATH_DUPLICATE");
  seen.add(path);
  const rule = manifest.rules.find(candidate => matches(candidate.pattern, path));
  if (!rule) fail(`UNCLASSIFIED_PATH:${path}`);
  if (!manifest.classifications.includes(rule.classification)) fail(`UNKNOWN_CLASSIFICATION:${path}`);
  if (
    rule.classification === "docs-only" &&
    (/^(?:apps|packages|scripts|\.github)\//.test(path) && path !== "apps/gateway/README.md" ||
      /(?:^|\/)(?:test|tests)(?:\/|\.|$)/.test(path) ||
      /(?:Dockerfile|compose\.ya?ml|package(?:-lock)?\.json|tsconfig|vitest)/.test(path))
  ) {
    fail(`EXECUTABLE_OR_QUALITY_PATH_MARKED_DOCS:${path}`);
  }
  if (mode === "160000" || type === "commit") fail(`SUBMODULE_NOT_ALLOWED:${path}`);
  if (mode === "120000") {
    if (type !== "blob" || rule.pattern !== path || rule.allowSymlink !== true) {
      fail(`SYMLINK_NOT_EXPLICITLY_ALLOWED:${path}`);
    }
  } else if (!["100644", "100755"].includes(mode) || type !== "blob") {
    fail(`MODE_OR_TYPE_NOT_ALLOWED:${path}:${mode}:${type}`);
  }
  counts[rule.classification] += 1;
  if (rule.classification !== "docs-only") {
    records.push(Buffer.from(`${rule.classification}\0${path}\0${mode}\0${type}\0${objectId}\0`, "utf8"));
  }
}
if (!seen.has(manifestRepoPath)) fail("MANIFEST_NOT_TRACKED");
const manifestRule = manifest.rules.find(candidate => matches(candidate.pattern, manifestRepoPath));
if (manifestRule?.classification !== "runtime-build") fail("MANIFEST_MUST_BE_RUNTIME_BUILD");
records.sort(Buffer.compare);
const buildInputTreeHash = sha256(Buffer.concat(records));
const receipt = {
  manifestKind: "release-build-input-tree-v1",
  formatVersion: 1,
  sourceCommit,
  releaseBuildInputsSha256: sha256(manifestBytes),
  buildInputTreeHash,
  includedEntryCount: records.length,
  classificationCounts: counts,
  buildMaterials: material
};
const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
const receiptHash = sha256(bytes);
process.umask(0o077);
const outputFd = openSync(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
writeFileSync(outputFd, bytes);
const hashFd = openSync(`${outputPath}.sha256`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
writeFileSync(hashFd, `${receiptHash}  ${outputPath.split("/").at(-1)}\n`);
chmodSync(outputPath, 0o600);
chmodSync(`${outputPath}.sha256`, 0o600);
process.stdout.write(`${receiptHash}\n`);
