#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const failures = [];
const fail = (code) => failures.push(code);
const requireOnce = (path, pattern, code) => {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  if ((read(path).match(new RegExp(pattern.source, flags)) ?? []).length !== 1) fail(code);
};
const rejectText = (path, pattern, code) => {
  if (pattern.test(read(path))) fail(code);
};

const ROOT_PROVISION =
  "python3 apps/gateway/runtime/gateway_lock_exec.py --database-from-env GATEWAY_DATABASE_PATH -- node apps/gateway/dist/provisionFederationService.js";
const ROOT_PROVISION_DEV = `npm run build:gateway && ${ROOT_PROVISION}`;
const GATEWAY_START =
  "python3 runtime/gateway_lock_exec.py --database-from-env GATEWAY_DATABASE_PATH -- node dist/index.js";
const GATEWAY_MIGRATE =
  'python3 runtime/gateway_lock_exec.py --database-from-env GATEWAY_DATABASE_PATH -- node dist/migrate.js --database "$GATEWAY_DATABASE_PATH"';
const protectedTarget = /(?:^|[\s'"=])(?:apps\/gateway\/|\.\.\/gateway\/)?dist\/(?:index|migrate|provisionFederationService|recoverGatewayDatabase)\.js(?:[\s'";]|$)/u;

function packagePaths(rootPackage) {
  const paths = ["package.json"];
  for (const pattern of rootPackage.workspaces ?? []) {
    if (typeof pattern !== "string" || !pattern.endsWith("/*")) {
      fail("WORKSPACE_PATTERN");
      continue;
    }
    const parent = pattern.slice(0, -2);
    const absolute = join(root, parent);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(absolute, entry.name, "package.json"))) {
        paths.push(`${parent}/${entry.name}/package.json`);
      }
    }
  }
  return [...new Set(paths)].sort();
}

try {
  const rootPackage = json("package.json");
  const allowed = new Map([
    ["package.json\0provision:federation-service", ROOT_PROVISION],
    ["package.json\0provision:federation-service:dev", ROOT_PROVISION_DEV],
    ["apps/gateway/package.json\0start", GATEWAY_START],
    ["apps/gateway/package.json\0migrate", GATEWAY_MIGRATE]
  ]);
  for (const path of packagePaths(rootPackage)) {
    const value = json(path);
    for (const [name, command] of Object.entries(value.scripts ?? {})) {
      if (typeof command !== "string") {
        fail("PACKAGE_SCRIPT_FORMAT");
        continue;
      }
      const expected = allowed.get(`${path}\0${name}`);
      if (expected !== undefined) {
        if (command !== expected) fail("PACKAGE_LOCK_COMMAND");
      } else if (protectedTarget.test(command)) {
        fail("PACKAGE_DIRECT_NODE");
      }
    }
  }
  for (const [key, expected] of allowed) {
    const [path, name] = key.split("\0");
    if (json(path).scripts?.[name] !== expected) fail("PACKAGE_REQUIRED_COMMAND");
  }

  const instructions = read("Dockerfile").split(/\r?\n/u)
    .filter((line) => /^(?:ENTRYPOINT|CMD)\b/u.test(line));
  if (instructions.length !== 2) fail("DOCKER_INSTRUCTION_COUNT");
  const entrypoints = instructions.filter((line) => line.startsWith("ENTRYPOINT "));
  const commands = instructions.filter((line) => line.startsWith("CMD "));
  try {
    if (entrypoints.length !== 1 || JSON.stringify(JSON.parse(entrypoints[0].slice(11))) !== JSON.stringify([
      "python3", "apps/gateway/runtime/gateway_lock_exec.py",
      "--database-from-env", "GATEWAY_DATABASE_PATH", "--"
    ])) fail("DOCKER_ENTRYPOINT");
    if (commands.length !== 1 || JSON.stringify(JSON.parse(commands[0].slice(4))) !== JSON.stringify([
      "node", "apps/gateway/dist/index.js"
    ])) fail("DOCKER_CMD");
  } catch {
    fail("DOCKER_JSON");
  }
  requireOnce("Dockerfile", /COPY --from=build --chown=node:node \/app\/apps\/gateway\/runtime \/app\/apps\/gateway\/runtime/u, "DOCKER_LAUNCHER_COPY");
  requireOnce("compose.yaml", /user: "1000:1000"/u, "COMPOSE_NUMERIC_USER");

  requireOnce("scripts/runtime-candidate-manifest.mjs", /"node", "apps\/gateway\/dist\/migrate\.js", "--database", "\/runtime\/data\/gateway\.sqlite"/u, "CANDIDATE_COMMAND");
  requireOnce("scripts/runtime-candidate-manifest.mjs", /image\.imageId, \.\.\.definition\.command/u, "CANDIDATE_CMD_OVERRIDE");
  requireOnce("scripts/runtime-candidate-manifest.mjs", /inspectGatewayImageRuntime\(image\.imageId\)/u, "CANDIDATE_IMAGE_INSPECT");
  requireOnce("scripts/runtime-candidate-manifest.mjs", /image\.runtimeContract/u, "CANDIDATE_RUNTIME_BINDING");
  rejectText("scripts/runtime-candidate-manifest.mjs", /definition\.entrypoint|--entrypoint/u, "CANDIDATE_ENTRYPOINT_OVERRIDE");
  requireOnce("scripts/member-preview-up.sh", /exec python3 "\$2" --database-from-env GATEWAY_DATABASE_PATH -- node apps\/gateway\/dist\/index\.js/u, "PREVIEW_COMMAND");
  requireOnce("scripts/test-runtime-retained-fixture.sh", /--database-from-env GATEWAY_DATABASE_PATH -- \\\n+  node apps\/gateway\/dist\/migrate\.js/u, "RETAINED_COMMAND");
  requireOnce("scripts/test-runtime-retained-fixture.sh", /command:\["node","apps\/gateway\/dist\/migrate\.js","--database","\/runtime\/data\/gateway\.sqlite"\]/u, "RETAINED_DEFINITION");
  rejectText("scripts/test-runtime-retained-fixture.sh", /(?:^|\n)\s*node "\$ROOT_DIR\/apps\/gateway\/dist\/(?:index|migrate|provisionFederationService|recoverGatewayDatabase)\.js"/u, "RETAINED_DIRECT_NODE");
  rejectText("docs/development/2026-08-29-federation-service-bootstrap.md", /--entrypoint\s+node|--role\b/u, "DOCS_DIRECT_NODE");

  requireOnce("scripts/runtime-tool-manifest.mjs", /apps\/gateway\/runtime\/gateway_lock_exec\.py/u, "TOOL_MANIFEST_LAUNCHER");
  requireOnce("scripts/runtime-tool-manifest.mjs", /apps\/gateway\/src\/databaseLock\.ts/u, "TOOL_MANIFEST_NODE_LOCK");
  requireOnce("scripts/runtime-tool-manifest.mjs", /scripts\/gateway-image-runtime-contract\.mjs/u, "TOOL_MANIFEST_IMAGE_CONTRACT");
  const release = json("scripts/gateway-release-capabilities.json");
  if (release.gatewayDatabaseFlockV1 !== true) fail("CAPABILITY_FLOCK");
  const inputs = json("scripts/release-build-inputs.json");
  if (!inputs.rules?.some((rule) =>
    rule.pattern === "apps/gateway/runtime/**" && rule.classification === "runtime-build"
  )) fail("BUILD_INPUT_LAUNCHER");
  if (!inputs.rules?.some((rule) =>
    rule.pattern === "scripts/gateway-image-runtime-contract.mjs"
      && rule.classification === "runtime-build"
  )) fail("BUILD_INPUT_IMAGE_CONTRACT");
  if (!inputs.rules?.some((rule) =>
    rule.pattern === "docs/development/2026-08-29-federation-service-bootstrap.md"
      && rule.classification === "quality-tool"
  )) fail("BUILD_INPUT_BOOTSTRAP_DOC");
} catch {
  fail("INPUT_READ");
}

if (failures.length > 0) {
  process.stderr.write(`GATEWAY_DATABASE_LOCK_ENTRYPOINTS_INVALID:${failures.join(",")}\n`);
  process.exit(1);
}
process.stdout.write("GATEWAY_DATABASE_LOCK_ENTRYPOINTS_OK roles=3 directBypasses=0\n");
