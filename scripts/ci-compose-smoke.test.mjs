import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "family-ci-artifact-import-"));
  const artifact = join(directory, "downloaded");
  const bin = join(directory, "bin");
  mkdirSync(artifact, { mode: 0o755 });
  chmodSync(artifact, 0o755);
  mkdirSync(bin, { mode: 0o700 });
  const archive = Buffer.from("fixture image archive\n");
  const manifest = {
    manifestKind: "gateway-image-v1",
    sourceCommit: "0".repeat(40),
    imageId: `sha256:${"1".repeat(64)}`,
    archiveSha256: hash(archive),
    clientDatabaseVersion: 2,
    releaseCapabilityReceiptSha256: "2".repeat(64),
    releaseBuildInputsSha256: "3".repeat(64),
    buildInputTreeHash: "4".repeat(64),
    protectedWalRecoveryV1: true,
    runtimeToolManifestSha256: hash("{}\n"),
    runtimeContract: { expected: {
      launcherSha256: "5".repeat(64), pythonVersion: "3.11.2",
      renameHelperSha256: "6".repeat(64), builtSha256: {}
    } }
  };
  for (const [name, bytes] of [
    ["gateway-image.tar", archive],
    ["gateway-image-manifest.json", `${JSON.stringify(manifest)}\n`],
    ["gateway-runtime-tools.json", "{}\n"]
  ]) {
    writeFileSync(join(artifact, name), bytes, { mode: 0o644 });
    writeFileSync(join(artifact, `${name}.sha256`), `${hash(bytes)}  ${name}\n`, { mode: 0o644 });
    chmodSync(join(artifact, name), 0o644);
    chmodSync(join(artifact, `${name}.sha256`), 0o644);
  }
  const capture = join(directory, "import-capture.json");
  const dockerMarker = join(directory, "unexpected-docker");
  writeFileSync(join(bin, "node"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--input-type=module" && args[1] === "-" && args[3] === "manifestKind") {
  const directory = path.dirname(args[2]);
  const files = fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name);
    return {name, mode: fs.statSync(file).mode & 0o777, hash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")};
  });
  fs.writeFileSync(process.env.CI_IMPORT_CAPTURE, JSON.stringify({directory, mode: fs.statSync(directory).mode & 0o777, files}));
}
const result = spawnSync(${JSON.stringify(process.execPath)}, args, {input: fs.readFileSync(0), encoding: "utf8"});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  writeFileSync(join(bin, "docker"), `#!${process.execPath}
require("node:fs").writeFileSync(process.env.CI_DOCKER_MARKER, "called");
process.exit(97);
`, { mode: 0o755 });
  return {
    directory, artifact, capture, dockerMarker,
    run: () => spawnSync("bash", [join(root, "scripts/ci-compose-smoke.sh"),
      "--image-manifest", join(artifact, "gateway-image-manifest.json")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI_IMPORT_CAPTURE: capture, CI_DOCKER_MARKER: dockerMarker }
    }),
    close: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("imports downloaded artifacts into a private copy before sealed validation", () => {
  const value = fixture();
  try {
    const before = readdirSync(value.artifact).sort().map(name => ({
      name, mode: 0o600, hash: hash(readFileSync(join(value.artifact, name)))
    }));
    const result = value.run();
    // A synthetic source revision stops the wrapper after exercising import and
    // hash validation, before it may load an image or run a runtime command.
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CI_CONTAINER_SMOKE_FAILED:SOURCE_COMMIT_MISMATCH/u);
    const imported = JSON.parse(readFileSync(value.capture, "utf8"));
    assert.notEqual(imported.directory, value.artifact);
    assert.equal(imported.mode, 0o700);
    assert.deepEqual(imported.files, before);
    assert.equal(existsSync(imported.directory), false, "The temporary import must be cleaned on failure");
    for (const name of readdirSync(value.artifact)) assert.equal(statSync(join(value.artifact, name)).mode & 0o777, 0o644);
    assert.equal(existsSync(value.dockerMarker), false);
  } finally { value.close(); }
});

test("rejects downloaded archive hash drift before any validator or Docker command", () => {
  const value = fixture();
  try {
    writeFileSync(join(value.artifact, "gateway-image.tar"), "tampered archive\n");
    const result = value.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CI_CONTAINER_SMOKE_FAILED:ARCHIVE_HASH_MISMATCH/u);
    assert.equal(existsSync(value.capture), false);
    assert.equal(existsSync(value.dockerMarker), false);
  } finally { value.close(); }
});

test("rejects linked artifact members without changing the target permissions", () => {
  const value = fixture();
  try {
    const target = join(value.directory, "foreign-tools.json");
    writeFileSync(target, "{}\n", { mode: 0o644 });
    chmodSync(target, 0o644);
    const member = join(value.artifact, "gateway-runtime-tools.json");
    rmSync(member);
    symlinkSync(target, member);
    const result = value.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CI_CONTAINER_SMOKE_FAILED:ARTIFACT_FILE_SET_INVALID/u);
    assert.equal(statSync(target).mode & 0o777, 0o644);
    assert.equal(existsSync(value.capture), false);
    assert.equal(existsSync(value.dockerMarker), false);
  } finally { value.close(); }
});
