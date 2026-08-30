#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const values = process.argv.slice(2);
let root = resolve(new URL("../", import.meta.url).pathname);
if (values.length > 0) {
  if (values.length !== 2 || values[0] !== "--root") {
    process.stderr.write("GATEWAY_DATABASE_LOCK_ENTRYPOINTS_INVALID\n");
    process.exit(1);
  }
  root = resolve(values[1]);
}

const read = path => readFileSync(join(root, path), "utf8");
const json = path => JSON.parse(read(path));
const failures = [];
const requireText = (path, pattern, code) => {
  if (!pattern.test(read(path))) failures.push(code);
};
const rejectText = (path, pattern, code) => {
  if (pattern.test(read(path))) failures.push(code);
};

try {
  const rootPackage = json("package.json");
  const gatewayPackage = json("apps/gateway/package.json");
  if (!/^python3 apps\/gateway\/runtime\/gateway_lock_exec\.py --role provision --$/.test(
    rootPackage.scripts?.["provision:federation-service"] ?? ""
  )) failures.push("ROOT_PROVISION_ENTRYPOINT");
  if (!/python3 apps\/gateway\/runtime\/gateway_lock_exec\.py --role provision --$/.test(
    rootPackage.scripts?.["provision:federation-service:dev"] ?? ""
  )) failures.push("ROOT_PROVISION_DEV_ENTRYPOINT");
  if (gatewayPackage.scripts?.start !== "python3 runtime/gateway_lock_exec.py --role gateway") {
    failures.push("GATEWAY_START_ENTRYPOINT");
  }
  if (gatewayPackage.scripts?.migrate !== "python3 runtime/gateway_lock_exec.py --role migrate") {
    failures.push("GATEWAY_MIGRATE_ENTRYPOINT");
  }

  requireText("Dockerfile", /ENTRYPOINT \["python3", "apps\/gateway\/runtime\/gateway_lock_exec\.py"\]/u, "DOCKER_ENTRYPOINT");
  requireText("Dockerfile", /CMD \["--role", "gateway"\]/u, "DOCKER_GATEWAY_ROLE");
  rejectText("Dockerfile", /(?:CMD|ENTRYPOINT) \["node", "apps\/gateway\/dist\/(?:index|migrate|provisionFederationService)\.js"/u, "DOCKER_DIRECT_NODE");
  requireText("Dockerfile", /COPY --from=build --chown=node:node \/app\/apps\/gateway\/runtime \/app\/apps\/gateway\/runtime/u, "DOCKER_LAUNCHER_COPY");
  requireText("compose.yaml", /user: "1000:1000"/u, "COMPOSE_NUMERIC_USER");

  requireText("scripts/runtime-candidate-manifest.mjs", /JSON\.stringify\(\["--role", "migrate"\]\)/u, "CANDIDATE_ROLE");
  rejectText("scripts/runtime-candidate-manifest.mjs", /--entrypoint["']?,\s*["']node/u, "CANDIDATE_DIRECT_NODE");
  requireText("scripts/member-preview-up.sh", /exec python3 "\$2" --role gateway/u, "PREVIEW_LAUNCHER");
  rejectText("scripts/member-preview-up.sh", /exec node "\$2"/u, "PREVIEW_DIRECT_NODE");
  requireText("scripts/test-runtime-retained-fixture.sh", /gateway_lock_exec\.py" \\\n+  --role migrate/u, "RETAINED_LAUNCHER");
  rejectText("scripts/test-runtime-retained-fixture.sh", /node "\$ROOT_DIR\/apps\/gateway\/dist\/migrate\.js"/u, "RETAINED_DIRECT_NODE");
  rejectText("docs/development/2026-08-29-federation-service-bootstrap.md", /--entrypoint node/u, "DOCS_DIRECT_NODE");

  requireText("scripts/runtime-tool-manifest.mjs", /apps\/gateway\/runtime\/gateway_lock_exec\.py/u, "TOOL_MANIFEST_LAUNCHER");
  requireText("scripts/runtime-tool-manifest.mjs", /apps\/gateway\/src\/databaseLock\.ts/u, "TOOL_MANIFEST_NODE_LOCK");
  const release = json("scripts/gateway-release-capabilities.json");
  if (release.gatewayDatabaseFlockV1 !== true) failures.push("CAPABILITY_FLOCK");
  const inputs = json("scripts/release-build-inputs.json");
  if (!inputs.rules?.some(rule =>
    rule.pattern === "apps/gateway/runtime/**" && rule.classification === "runtime-build"
  )) failures.push("BUILD_INPUT_LAUNCHER");
  if (!inputs.rules?.some(rule =>
    rule.pattern === "docs/development/2026-08-29-federation-service-bootstrap.md"
      && rule.classification === "quality-tool"
  )) failures.push("BUILD_INPUT_BOOTSTRAP_DOC");
} catch {
  failures.push("INPUT_READ");
}

if (failures.length > 0) {
  process.stderr.write(`GATEWAY_DATABASE_LOCK_ENTRYPOINTS_INVALID:${failures.join(",")}\n`);
  process.exit(1);
}
process.stdout.write("GATEWAY_DATABASE_LOCK_ENTRYPOINTS_OK roles=3 directBypasses=0\n");
