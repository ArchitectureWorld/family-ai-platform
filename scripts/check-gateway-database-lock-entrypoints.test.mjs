import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const checker = "scripts/check-gateway-database-lock-entrypoints.mjs";

test("accepts only launcher-bound Gateway database entrypoints and manifests", () => {
  const result = spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    "GATEWAY_DATABASE_LOCK_ENTRYPOINTS_OK roles=3 directBypasses=0\n"
  );
});

test("rejects every independent direct-node or missing-manifest launcher bypass", () => {
  const fixture = mkdtempSync(join(tmpdir(), "family-ai-lock-entrypoints-"));
  const files = [
    "package.json",
    "apps/gateway/package.json",
    "Dockerfile",
    "compose.yaml",
    "scripts/runtime-candidate-manifest.mjs",
    "scripts/build-gateway-image.sh",
    "scripts/member-preview-up.sh",
    "scripts/test-runtime-retained-fixture.sh",
    "docs/development/2026-08-29-federation-service-bootstrap.md",
    "scripts/runtime-tool-manifest.mjs",
    "scripts/gateway-release-capabilities.json",
    "scripts/release-build-inputs.json"
  ];
  try {
    for (const path of files) {
      const target = join(fixture, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      cpSync(join(root, path), target);
    }
    const mutations = [
      ["package.json", /python3 apps\/gateway\/runtime\/gateway_lock_exec\.py --database-from-env GATEWAY_DATABASE_PATH -- node apps\/gateway\/dist\/provisionFederationService\.js/u, "node apps/gateway/dist/provisionFederationService.js"],
      ["apps/gateway/package.json", /python3 runtime\/gateway_lock_exec\.py --database-from-env GATEWAY_DATABASE_PATH -- node dist\/index\.js/u, "node dist/index.js"],
      ["apps/gateway/package.json", /python3 runtime\/gateway_lock_exec\.py --database-from-env GATEWAY_DATABASE_PATH -- node dist\/migrate\.js/u, "node dist/migrate.js"],
      ["Dockerfile", /ENTRYPOINT \["python3", "apps\/gateway\/runtime\/gateway_lock_exec\.py", "--database-from-env", "GATEWAY_DATABASE_PATH", "--"\]/u, 'ENTRYPOINT ["node", "apps/gateway/dist/index.js"]'],
      ["compose.yaml", /user: "1000:1000"/u, 'user: "0:0"'],
      ["scripts/runtime-candidate-manifest.mjs", /"node", "apps\/gateway\/dist\/migrate\.js", "--database", "\/runtime\/data\/gateway\.sqlite"/u, '"node", "apps/gateway/dist/index.js"'],
      ["scripts/runtime-candidate-manifest.mjs", /--expected-candidate-image-manifest-sha256/u, "--unchecked-candidate-image-manifest"],
      ["scripts/build-gateway-image.sh", /EXPECTED_LAUNCHER_SHA=.*gateway_lock_exec\.py/u, 'EXPECTED_LAUNCHER_SHA="$(printf 0%.0s {1..64})"'],
      ["scripts/member-preview-up.sh", /exec python3 "\$2" --database-from-env GATEWAY_DATABASE_PATH -- node apps\/gateway\/dist\/index\.js/u, 'exec node "$2"'],
      ["scripts/test-runtime-retained-fixture.sh", /python3 "\$ROOT_DIR\/apps\/gateway\/runtime\/gateway_lock_exec\.py"/u, 'node "$ROOT_DIR/apps/gateway/dist/migrate.js"'],
      ["docs/development/2026-08-29-federation-service-bootstrap.md", /FAMILY_IMAGE/u, "--entrypoint node FAMILY_IMAGE"],
      ["docs/development/2026-08-29-federation-service-bootstrap.md", /--env GATEWAY_DATABASE_PATH=\/runtime\/gateway\.sqlite/u, "--env GATEWAY_DATABASE_PATH=/runtime/other.sqlite"],
      ["scripts/runtime-tool-manifest.mjs", /apps\/gateway\/runtime\/gateway_lock_exec\.py/u, "apps/gateway/runtime/missing.py"],
      ["scripts/runtime-tool-manifest.mjs", /scripts\/gateway-image-runtime-contract\.mjs/u, "scripts/missing-image-contract.mjs"],
      ["scripts/gateway-release-capabilities.json", /"gatewayDatabaseFlockV1": true/u, '"gatewayDatabaseFlockV1": false'],
      ["scripts/release-build-inputs.json", /\{ "pattern": "apps\/gateway\/runtime\/\*\*", "classification": "runtime-build" \},?\n/u, ""],
      ["scripts/release-build-inputs.json", /\{ "pattern": "scripts\/gateway-image-runtime-contract\.mjs", "classification": "runtime-build" \},?\n/u, ""]
    ];
    for (const [path, pattern, replacement] of mutations) {
      const target = join(fixture, path);
      const baseline = readFileSync(target, "utf8");
      assert.match(baseline, pattern);
      writeFileSync(target, baseline.replace(pattern, replacement));
      const result = spawnSync(process.execPath, [checker, "--root", fixture], {
        cwd: root,
        encoding: "utf8"
      });
      assert.equal(result.status, 1, `${path}:${result.stdout}${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^GATEWAY_DATABASE_LOCK_ENTRYPOINTS_INVALID:/u);
      writeFileSync(target, baseline);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("rejects additive workspace bypasses, shell indirection, and duplicate Docker instructions", () => {
  const fixture = mkdtempSync(join(tmpdir(), "family-ai-lock-entrypoints-additive-"));
  const files = [
    "package.json",
    "apps/gateway/package.json",
    "Dockerfile",
    "compose.yaml",
    "scripts/runtime-candidate-manifest.mjs",
    "scripts/build-gateway-image.sh",
    "scripts/member-preview-up.sh",
    "scripts/test-runtime-retained-fixture.sh",
    "docs/development/2026-08-29-federation-service-bootstrap.md",
    "scripts/runtime-tool-manifest.mjs",
    "scripts/gateway-release-capabilities.json",
    "scripts/release-build-inputs.json"
  ];
  const run = () => spawnSync(process.execPath, [checker, "--root", fixture], {
    cwd: root,
    encoding: "utf8"
  });
  try {
    for (const path of files) {
      const target = join(fixture, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      cpSync(join(root, path), target);
    }
    const rootPackagePath = join(fixture, "package.json");
    const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
    rootPackage.scripts["gateway:bypass"] = "node apps/gateway/dist/index.js";
    writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
    assert.equal(run().status, 1, "additive root package bypass was accepted");

    rootPackage.scripts["gateway:bypass"] =
      "sh -c 'node apps/gateway/dist/index.js'";
    writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
    assert.equal(run().status, 1, "shell-indirected bypass was accepted");

    for (const command of [
      "node ./apps/gateway/dist/index.js",
      "node /app/apps/gateway/dist/migrate.js --database /data/gateway.sqlite",
      "node apps//gateway//dist//provisionFederationService.js",
      "node -- apps/gateway/dist/recoverGatewayDatabase.js",
      "env NODE_ENV=production node apps/gateway/dist/index.js",
      "sh -c 'env X=1 node -- /app/apps/gateway/dist/migrate.js'"
    ]) {
      rootPackage.scripts["gateway:bypass"] = command;
      writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
      assert.equal(run().status, 1, `protected command variant was accepted: ${command}`);
    }

    delete rootPackage.scripts["gateway:bypass"];
    writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
    const roguePackage = join(fixture, "apps/rogue/package.json");
    mkdirSync(dirname(roguePackage), { recursive: true, mode: 0o700 });
    writeFileSync(roguePackage, '{"scripts":{"start":"node ../gateway/dist/index.js"}}\n');
    assert.equal(run().status, 1, "additive workspace bypass was accepted");

    rmSync(join(fixture, "apps/rogue"), { recursive: true, force: true });
    const dockerfilePath = join(fixture, "Dockerfile");
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    writeFileSync(
      dockerfilePath,
      `${dockerfile}\nENTRYPOINT ["python3", "apps/gateway/runtime/gateway_lock_exec.py"]\n`
    );
    assert.equal(run().status, 1, "duplicate Docker ENTRYPOINT was accepted");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
