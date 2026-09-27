import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readGatewayBuildDigests } from "./gateway-image-runtime-contract.mjs";

const image = process.env.GATEWAY_LOCK_TEST_IMAGE;
const manifestPath = process.env.GATEWAY_LOCK_TEST_MANIFEST;
const root = fileURLToPath(new URL("../", import.meta.url));
const recoveryExpectation = () => JSON.stringify({
  renameHelperSha256: createHash("sha256").update(readFileSync(join(root, "apps/gateway/runtime/rename_noreplace.py"))).digest("hex"),
  builtSha256: manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")).runtimeContract.expected.builtSha256 : readGatewayBuildDigests()
});

test("built Gateway image exposes only the approved CMD-through-launcher contract", {
  skip: image === undefined
}, () => {
  const inspected = JSON.parse(execFileSync(
    "docker",
    ["image", "inspect", image],
    { encoding: "utf8" }
  ))[0];
  assert.deepEqual(inspected.Config.Entrypoint, [
    "python3",
    "apps/gateway/runtime/gateway_lock_exec.py",
    "--database-from-env",
    "GATEWAY_DATABASE_PATH",
    "--"
  ]);
  assert.deepEqual(inspected.Config.Cmd, ["node", "apps/gateway/dist/index.js"]);
  assert.equal(inspected.Config.User, "node");

  const runtime = execFileSync("docker", [
    "run", "--rm", "--entrypoint", "python3", image, "-c",
    "import hashlib,os,stat; p='/app/apps/gateway/runtime/gateway_lock_exec.py'; s=os.stat(p); print(os.getuid(),os.getgid(),stat.S_IMODE(s.st_mode),s.st_nlink,hashlib.sha256(open(p,'rb').read()).hexdigest())"
  ], { encoding: "utf8" }).trim().split(" ");
  assert.deepEqual(runtime.slice(0, 4), ["1000", "1000", "493", "1"]);
  assert.match(runtime[4] ?? "", /^[0-9a-f]{64}$/u);

  const expectedLauncherSha256 = createHash("sha256").update(readFileSync(
    join(root, "apps/gateway/runtime/gateway_lock_exec.py")
  )).digest("hex");
  const contract = spawnSync(process.execPath, [
    join(root, "scripts/gateway-image-runtime-contract.mjs"),
    "inspect", "--image-id", inspected.Id,
    "--expected-launcher-sha256", expectedLauncherSha256,
    "--expected-python-version", "3.11.2",
    "--expected-recovery-json", recoveryExpectation()
  ], { encoding: "utf8" });
  assert.equal(contract.status, 0, contract.stderr);
  const wrongSource = spawnSync(process.execPath, [
    join(root, "scripts/gateway-image-runtime-contract.mjs"),
    "inspect", "--image-id", inspected.Id,
    "--expected-launcher-sha256", "0".repeat(64),
    "--expected-python-version", "3.11.2",
    "--expected-recovery-json", recoveryExpectation()
  ], { encoding: "utf8" });
  assert.equal(wrongSource.status, 1);
});

test("sealed image manifest binds expected source and runtime tool digests", {
  skip: manifestPath === undefined
}, () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.match(manifest.runtimeToolManifestSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    manifest.runtimeContract.expected.launcherSha256,
    manifest.runtimeContract.actual.launcher.sha256
  );
  assert.equal(manifest.runtimeContract.expected.pythonVersion, "3.11.2");
  assert.equal(manifest.runtimeContract.actual.pythonVersion, "3.11.2");
  assert.equal(manifest.protectedWalRecoveryV1, true);
  for (const file of manifest.runtimeContract.actual.recoveryFiles) {
    const expected = file.path.endsWith(".py") ? manifest.runtimeContract.expected.renameHelperSha256 : manifest.runtimeContract.expected.builtSha256[file.path];
    assert.equal(file.sha256, expected);
    assert.equal(file.uid, 1000);
    assert.equal(file.gid, 1000);
  }
  const artifactDirectory = dirname(manifestPath);
  const toolBytes = readFileSync(join(artifactDirectory, "gateway-runtime-tools.json"));
  assert.equal(
    createHash("sha256").update(toolBytes).digest("hex"),
    manifest.runtimeToolManifestSha256
  );
  assert.equal(
    readFileSync(`${manifestPath}.sha256`, "utf8").split(/\s/u)[0],
    createHash("sha256").update(readFileSync(manifestPath)).digest("hex")
  );
});

for (const runtimePath of [
  "apps/gateway/runtime/gateway_lock_exec.py",
  "apps/gateway/runtime/rename_noreplace.py",
  "apps/gateway/dist/recoverGatewayDatabase.js"
]) test(`runtime provenance rejects copied byte drift: ${runtimePath}`, {
  skip: image === undefined,
  timeout: 60_000
}, () => {
  const fixture = mkdtempSync(join(tmpdir(), "family-lock-wrong-launcher-"));
  const tag = `family-lock-wrong-launcher:${process.pid}`;
  const baseTag = /^sha256:[0-9a-f]{64}$/u.test(image ?? "")
    ? `family-lock-provenance-base:${process.pid}-${randomUUID()}`
    : undefined;
  try {
    if (baseTag !== undefined) {
      const tagged = spawnSync("docker", ["image", "tag", image, baseTag], {
        encoding: "utf8"
      });
      assert.equal(tagged.status, 0, tagged.stderr);
      const taggedIdentity = spawnSync("docker", [
        "image", "inspect", "--format", "{{.Id}}", baseTag
      ], { encoding: "utf8" });
      assert.equal(taggedIdentity.status, 0, taggedIdentity.stderr);
      assert.equal(taggedIdentity.stdout.trim(), image);
    }
    writeFileSync(join(fixture, "gateway_lock_exec.py"), "#!/usr/bin/env python3\nraise SystemExit(1)\n");
    chmodSync(join(fixture, "gateway_lock_exec.py"), 0o755);
    writeFileSync(join(fixture, "Dockerfile"), [
      `FROM ${baseTag ?? image}`,
      "USER root",
      `COPY --chown=1000:1000 gateway_lock_exec.py /app/${runtimePath}`,
      `RUN chmod ${runtimePath.endsWith(".py") ? "0755" : "0644"} /app/${runtimePath}`,
      "USER node",
      ""
    ].join("\n"));
    const built = spawnSync("docker", ["build", "--pull=false", "--quiet", "--tag", tag, fixture], {
      encoding: "utf8",
      timeout: 90_000
    });
    assert.equal(built.status, 0, built.stderr);
    const expectedLauncherSha256 = createHash("sha256").update(readFileSync(
      join(root, "apps/gateway/runtime/gateway_lock_exec.py")
    )).digest("hex");
    const result = spawnSync(process.execPath, [
      join(root, "scripts/gateway-image-runtime-contract.mjs"),
      "inspect", "--image-id", spawnSync("docker", [
        "image", "inspect", "--format", "{{.Id}}", tag
      ], { encoding: "utf8" }).stdout.trim(),
      "--expected-launcher-sha256", expectedLauncherSha256,
      "--expected-python-version", "3.11.2",
      "--expected-recovery-json", recoveryExpectation()
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "GATEWAY_IMAGE_RUNTIME_INVALID\n");
  } finally {
    spawnSync("docker", ["image", "rm", "--force", "--no-prune", tag]);
    if (baseTag !== undefined) {
      const borrowed = spawnSync("docker", [
        "image", "inspect", "--format", "{{json .RepoTags}}", image
      ], { encoding: "utf8" });
      assert.equal(borrowed.status, 0, borrowed.stderr);
      const tags = JSON.parse(borrowed.stdout) ?? [];
      // Docker removes the image when its last tag is removed. A source loaded
      // by immutable ID must retain one protection tag for the following gates.
      if (tags.some((value) => value !== baseTag)) {
        const removed = spawnSync("docker", ["image", "rm", "--no-prune", baseTag], {
          encoding: "utf8"
        });
        assert.equal(removed.status, 0, removed.stderr);
      }
      const preserved = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" });
      assert.equal(preserved.status, 0, "Cleanup must preserve the borrowed sealed source image");
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});
