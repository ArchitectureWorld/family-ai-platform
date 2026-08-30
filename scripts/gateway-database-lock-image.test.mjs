import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const image = process.env.GATEWAY_LOCK_TEST_IMAGE;
const manifestPath = process.env.GATEWAY_LOCK_TEST_MANIFEST;
const root = fileURLToPath(new URL("../", import.meta.url));

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
    "inspect", "--image-id", image,
    "--expected-launcher-sha256", expectedLauncherSha256,
    "--expected-python-version", "3.11.2"
  ], { encoding: "utf8" });
  assert.equal(contract.status, 0, contract.stderr);
  const wrongSource = spawnSync(process.execPath, [
    join(root, "scripts/gateway-image-runtime-contract.mjs"),
    "inspect", "--image-id", image,
    "--expected-launcher-sha256", "0".repeat(64),
    "--expected-python-version", "3.11.2"
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

test("runtime provenance rejects an image that copied different launcher bytes", {
  skip: image === undefined,
  timeout: 60_000
}, () => {
  const fixture = mkdtempSync(join(tmpdir(), "family-lock-wrong-launcher-"));
  const tag = `family-lock-wrong-launcher:${process.pid}`;
  try {
    writeFileSync(join(fixture, "gateway_lock_exec.py"), "#!/usr/bin/env python3\nraise SystemExit(1)\n");
    chmodSync(join(fixture, "gateway_lock_exec.py"), 0o755);
    writeFileSync(join(fixture, "Dockerfile"), [
      `FROM ${image}`,
      "USER root",
      "COPY --chown=1000:1000 gateway_lock_exec.py /app/apps/gateway/runtime/gateway_lock_exec.py",
      "RUN chmod 0755 /app/apps/gateway/runtime/gateway_lock_exec.py",
      "USER node",
      ""
    ].join("\n"));
    const built = spawnSync("docker", ["build", "--quiet", "--tag", tag, fixture], {
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
      "--expected-python-version", "3.11.2"
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "GATEWAY_IMAGE_RUNTIME_INVALID\n");
  } finally {
    spawnSync("docker", ["image", "rm", "--force", tag]);
    rmSync(fixture, { recursive: true, force: true });
  }
});
