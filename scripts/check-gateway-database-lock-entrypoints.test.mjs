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
      ["package.json", /python3 apps\/gateway\/runtime\/gateway_lock_exec\.py --role provision --/u, "node apps/gateway/dist/provisionFederationService.js"],
      ["apps/gateway/package.json", /python3 runtime\/gateway_lock_exec\.py --role gateway/u, "node dist/index.js"],
      ["apps/gateway/package.json", /python3 runtime\/gateway_lock_exec\.py --role migrate/u, "node dist/migrate.js"],
      ["Dockerfile", /ENTRYPOINT \["python3", "apps\/gateway\/runtime\/gateway_lock_exec\.py"\]/u, 'ENTRYPOINT ["node", "apps/gateway/dist/index.js"]'],
      ["compose.yaml", /user: "1000:1000"/u, 'user: "0:0"'],
      ["scripts/runtime-candidate-manifest.mjs", /\["--role", "migrate"\]/u, '["node", "apps/gateway/dist/migrate.js"]'],
      ["scripts/member-preview-up.sh", /exec python3 "\$2" --role gateway/u, 'exec node "$2"'],
      ["scripts/test-runtime-retained-fixture.sh", /python3 "\$ROOT_DIR\/apps\/gateway\/runtime\/gateway_lock_exec\.py"/u, 'node "$ROOT_DIR/apps/gateway/dist/migrate.js"'],
      ["docs/development/2026-08-29-federation-service-bootstrap.md", /FAMILY_IMAGE/u, "--entrypoint node FAMILY_IMAGE"],
      ["scripts/runtime-tool-manifest.mjs", /apps\/gateway\/runtime\/gateway_lock_exec\.py/u, "apps/gateway/runtime/missing.py"],
      ["scripts/gateway-release-capabilities.json", /"gatewayDatabaseFlockV1": true/u, '"gatewayDatabaseFlockV1": false'],
      ["scripts/release-build-inputs.json", /\{ "pattern": "apps\/gateway\/runtime\/\*\*", "classification": "runtime-build" \},?\n/u, ""]
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
