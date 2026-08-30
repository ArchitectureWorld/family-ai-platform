#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

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
const protectedTargets = new Set([
  "apps/gateway/dist/index.js",
  "apps/gateway/dist/migrate.js",
  "apps/gateway/dist/provisionFederationService.js",
  "apps/gateway/dist/recoverGatewayDatabase.js"
]);

function shellTokens(command) {
  const tokens = [];
  let current = "";
  let quote = "";
  let escaped = false;
  const push = () => {
    if (current) tokens.push(current);
    current = "";
  };
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = "";
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      push();
    } else if (";&|()".includes(character)) {
      push();
      tokens.push(character);
    } else {
      current += character;
    }
  }
  if (quote || escaped) throw new Error("PACKAGE_SCRIPT_TOKENIZE");
  push();
  return tokens;
}

function normalizedProtectedPath(token, packagePath) {
  const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
  let absolute;
  if (value.startsWith("/app/")) {
    absolute = resolve(root, value.slice("/app/".length));
  } else if (isAbsolute(value)) {
    const marker = normalize(value).lastIndexOf("/apps/gateway/dist/");
    if (marker < 0) return null;
    absolute = resolve(root, normalize(value).slice(marker + 1));
  } else {
    absolute = resolve(root, dirname(packagePath), normalize(value));
  }
  const repositoryPath = relative(root, absolute).split("\\").join("/");
  return protectedTargets.has(repositoryPath) ? repositoryPath : null;
}

function containsProtectedCommand(command, packagePath) {
  const tokens = shellTokens(command);
  for (let index = 0; index < tokens.length; index += 1) {
    if (normalizedProtectedPath(tokens[index], packagePath)) return true;
    if (
      (tokens[index] === "sh" || tokens[index] === "bash")
      && tokens[index + 1] === "-c"
      && typeof tokens[index + 2] === "string"
      && containsProtectedCommand(tokens[index + 2], packagePath)
    ) return true;
  }
  return false;
}

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
      } else if (containsProtectedCommand(command, path)) {
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
  requireOnce("scripts/runtime-candidate-manifest.mjs", /inspectGatewayImageRuntime\(image\.imageId,\s*\{/u, "CANDIDATE_IMAGE_INSPECT");
  requireOnce("scripts/runtime-candidate-manifest.mjs", /image\.runtimeContract/u, "CANDIDATE_RUNTIME_BINDING");
  requireOnce("scripts/runtime-candidate-manifest.mjs", /required: \[[^\n]*"--expected-candidate-image-manifest-sha256"/u, "CANDIDATE_IMAGE_MANIFEST_DIGEST");
  rejectText("scripts/runtime-candidate-manifest.mjs", /definition\.entrypoint|--entrypoint/u, "CANDIDATE_ENTRYPOINT_OVERRIDE");
  requireOnce("scripts/member-preview-up.sh", /exec python3 "\$2" --database-from-env GATEWAY_DATABASE_PATH -- node apps\/gateway\/dist\/index\.js/u, "PREVIEW_COMMAND");
  requireOnce("scripts/test-runtime-retained-fixture.sh", /--database-from-env GATEWAY_DATABASE_PATH -- \\\n+  node apps\/gateway\/dist\/migrate\.js/u, "RETAINED_COMMAND");
  requireOnce("scripts/test-runtime-retained-fixture.sh", /command:\["node","apps\/gateway\/dist\/migrate\.js","--database","\/runtime\/data\/gateway\.sqlite"\]/u, "RETAINED_DEFINITION");
  rejectText("scripts/test-runtime-retained-fixture.sh", /(?:^|\n)\s*node "\$ROOT_DIR\/apps\/gateway\/dist\/(?:index|migrate|provisionFederationService|recoverGatewayDatabase)\.js"/u, "RETAINED_DIRECT_NODE");
  rejectText("scripts/federation-bootstrap-runtime.test.mjs", /spawnSync\("python3", \[\s*lockLauncher,\s*"--database-from-env"/u, "HOST_PRODUCTION_LAUNCHER");
  rejectText("docs/development/2026-08-29-federation-service-bootstrap.md", /--entrypoint\s+node|--role\b/u, "DOCS_DIRECT_NODE");
  requireOnce("docs/development/2026-08-29-federation-service-bootstrap.md", /GATEWAY_DATABASE_PATH=\/absolute\/protected\/runtime\/gateway\.sqlite npm --silent run provision:federation-service -- \\\n+(?:.*\n){3}  --database \/absolute\/protected\/runtime\/gateway\.sqlite/u, "DOCS_NPM_DATABASE_IDENTITY");
  requireOnce("docs/development/2026-08-29-federation-service-bootstrap.md", /--env GATEWAY_DATABASE_PATH=\/runtime\/gateway\.sqlite/u, "DOCS_DATABASE_ENV");
  requireOnce("docs/development/2026-08-29-federation-service-bootstrap.md", /--database \/runtime\/gateway\.sqlite/u, "DOCS_DATABASE_ARGUMENT");

  requireOnce("scripts/runtime-tool-manifest.mjs", /apps\/gateway\/runtime\/gateway_lock_exec\.py/u, "TOOL_MANIFEST_LAUNCHER");
  requireOnce("scripts/runtime-tool-manifest.mjs", /apps\/gateway\/src\/databaseLock\.ts/u, "TOOL_MANIFEST_NODE_LOCK");
  requireOnce("scripts/runtime-tool-manifest.mjs", /scripts\/gateway-image-runtime-contract\.mjs/u, "TOOL_MANIFEST_IMAGE_CONTRACT");
  requireOnce("scripts/build-gateway-image.sh", /EXPECTED_LAUNCHER_SHA=.*gateway_lock_exec\.py/u, "BUILD_EXPECTED_LAUNCHER");
  requireOnce("scripts/build-gateway-image.sh", /runtimeToolManifestSha256, runtimeContractJson/u, "BUILD_TOOL_BINDING");
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
