import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../", import.meta.url));
const imageId = `sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);
const executable = (path, content) => writeFileSync(path, content, { mode: 0o700 });

function fixture({ isolated = true, hostUid = "1000", migrateFails = false, databaseAppears = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "family-dev-up-test-"));
  const root = join(directory, "repository");
  const bin = join(directory, "bin");
  const runtime = isolated ? join(directory, "isolated") : join(root, ".runtime");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(bin);
  for (const file of ["dev-up.sh", "runtime-isolation-lib.sh"]) copyFileSync(join(repository, "scripts", file), join(root, "scripts", file));
  copyFileSync(join(repository, "compose.yaml"), join(root, "compose.yaml"));
  const manifest = join(directory, "image.json");
  const revision = "c".repeat(40);
  writeFileSync(manifest, JSON.stringify({ manifestKind: "gateway-image-v1", imageId, sourceCommit: revision,
    clientDatabaseVersion: 2, labels: { "org.opencontainers.image.revision": revision, "org.architectureworld.family-ai.client-database-version": "2" } }));
  const log = join(directory, "docker.jsonl");
  const data = join(runtime, "data");
  const database = join(data, "gateway.sqlite");
  const ownerMarker = join(directory, "owned");
  executable(join(bin, "docker"), `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const data = process.env.TEST_DATA;
const database = data + "/gateway.sqlite";
const image = process.env.TEST_IMAGE;
const log = value => fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(value) + "\\n");
log(args);
const option = flag => args[args.indexOf(flag) + 1];
if (args[0] === "run") {
  assert.equal(option("--network"), "none");
  assert(args.includes("--read-only"));
  assert.equal(option("--cap-drop"), "ALL");
  assert.match(option("--security-opt"), /^no-new-privileges(?::true)?$/);
  assert(!args.includes("--privileged"));
  assert(!args.includes("--env-file"));
  assert(!args.includes("-p"));
  assert.equal(args.filter(value => value === "--mount").length, 1);
  assert.equal(option("--mount"), "type=bind,src=" + data + ",dst=/app/.runtime/data");
  assert(args.includes(image));
  if (args.includes("--entrypoint")) {
    assert.equal(option("--user"), "0:0");
    assert.equal(option("--entrypoint"), "python3");
    assert(args.includes("CHOWN") && args.includes("DAC_OVERRIDE"));
    assert(!fs.existsSync(database), "owner preparation must not touch an existing database");
    const code = args[args.indexOf("-c") + 1].replaceAll("/app/.runtime/data", data);
    const prepared = spawnSync("python3", ["-c", code], { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    fs.writeFileSync(process.env.TEST_OWNER_MARKER, "ready");
  } else {
    assert.equal(option("--user"), "1000:1000");
    assert(!args.includes("--cap-add"));
    assert(args.includes("GATEWAY_DATABASE_PATH=/app/.runtime/data/gateway.sqlite"));
    assert.deepEqual(args.slice(args.indexOf(image) + 1), ["node", "apps/gateway/dist/migrate.js", "--database", "/app/.runtime/data/gateway.sqlite"]);
    assert(!fs.existsSync(database), "migration must never run for an existing database");
    if (process.env.TEST_MIGRATE_FAIL === "1") process.exit(43);
    fs.writeFileSync(database, "initialized fixture database", { mode: 0o600 });
  }
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  if (process.env.TEST_DATABASE_APPEARS === "1") fs.writeFileSync(database, "concurrently retained database", { mode: 0o600 });
  console.log(image); process.exit(0);
}
if (args[0] === "ps") process.exit(0);
if (args[0] === "inspect") {
  console.log(args.includes("{{.Image}}") ? image : "fixture-speakers_default"); process.exit(0);
}
if (args[0] !== "compose") process.exit(95);
if (args.includes("version") || args.includes("build") || args.includes("down")) process.exit(0);
if (args.includes("config")) {
  console.log(JSON.stringify({ services: { gateway: {
    image, read_only: true, ports: [{ target: 8790, host_ip: "127.0.0.1" }],
    volumes: [{ type: "bind", source: data, target: "/app/.runtime/data" }]
  } } })); process.exit(0);
}
if (args.includes("up")) {
  if (!fs.existsSync(database)) { console.error("GATEWAY_DATABASE_INVALID"); process.exit(44); }
  if (args.includes("--file")) {
    const compose = fs.readFileSync(option("--file"), "utf8");
    assert(compose.includes('user: "1000:1000"'), "protected runtime requires fixed UID/GID");
  }
  process.exit(0);
}
if (args.includes("port")) { console.log("127.0.0.1:45678"); process.exit(0); }
if (args.includes("ps")) { console.log(process.env.TEST_CONTAINER); process.exit(0); }
process.exit(96);
`);
  executable(join(bin, "curl"), '#!/usr/bin/env bash\nprintf \'{"service":"family-ai-gateway-foundation"}\\n\'\n');
  executable(join(bin, "ss"), "#!/usr/bin/env bash\nexit 0\n");
  executable(join(bin, "id"), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$TEST_HOST_UID"\n');
  executable(join(bin, "stat"), `#!/usr/bin/env bash
if [[ "$1" == "-c" && "$2" == "%u:%g" && "$TEST_HOST_UID" != "1000" && ! -f "$TEST_OWNER_MARKER" ]]; then
  printf '%s:%s\\n' "$TEST_HOST_UID" "$TEST_HOST_UID"
else
  exec /usr/bin/stat "$@"
fi
`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_DATA: data,
    TEST_IMAGE: imageId, TEST_CONTAINER: containerId, TEST_HOST_UID: hostUid, TEST_OWNER_MARKER: ownerMarker,
    TEST_MIGRATE_FAIL: migrateFails ? "1" : "0", TEST_DATABASE_APPEARS: databaseAppears ? "1" : "0" };
  for (const name of ["FAMILY_AI_RUNTIME_ROOT", "COMPOSE_PROJECT_NAME", "FAMILY_AI_HOST_PORT", "FAMILY_AI_IMAGE_REF", "FAMILY_AI_IMAGE_MANIFEST"]) delete env[name];
  if (isolated) Object.assign(env, { FAMILY_AI_RUNTIME_ROOT: runtime, COMPOSE_PROJECT_NAME: "fixture-speakers",
    FAMILY_AI_HOST_PORT: "0", FAMILY_AI_IMAGE_REF: imageId, FAMILY_AI_IMAGE_MANIFEST: manifest });
  const run = () => spawnSync("bash", [join(root, "scripts/dev-up.sh")], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const initializeExisting = () => {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    mkdirSync(join(runtime, "config"), { mode: 0o700 });
    chmodSync(runtime, 0o700);
    writeFileSync(join(runtime, "config/device-token"), "d".repeat(64), { mode: 0o600 });
  };
  return { run, calls, runtime, data, database, initializeExisting, root, directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

for (const isolated of [true, false]) test(`initializes a fresh ${isolated ? "isolated" : "local disposable"} runtime before starting Gateway with its exact image`, () => {
  const f = fixture({ isolated });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    const migration = calls.findIndex(args => args.includes("apps/gateway/dist/migrate.js"));
    const startup = calls.findIndex(args => args[0] === "compose" && args.includes("up"));
    assert(migration >= 0 && migration < startup);
    assert.equal(readFileSync(f.database, "utf8"), "initialized fixture database");
    if (isolated) assert(!calls.some(args => args.includes("build")));
    else assert(calls.findIndex(args => args.includes("build")) < migration);
  } finally { f.cleanup(); }
});

test("accepts an existing empty disposable data directory but not retained content", () => {
  const f = fixture({ isolated: false });
  try {
    f.initializeExisting();
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.calls().filter(args => args.includes("apps/gateway/dist/migrate.js")).length, 1);
  } finally { f.cleanup(); }
});

test("prepares only a new empty data directory for fixed UID 1000 on a different-UID host", () => {
  const f = fixture({ hostUid: "1001" });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    const prepared = calls.findIndex(args => args.includes("--entrypoint"));
    const migrated = calls.findIndex(args => args.includes("apps/gateway/dist/migrate.js"));
    assert(prepared >= 0 && prepared < migrated);
    assert.equal(calls.filter(args => args.includes("--entrypoint")).length, 1);
  } finally { f.cleanup(); }
});

test("leaves an existing disposable database unchanged and never launches migration or ownership changes", () => {
  const f = fixture({ isolated: false });
  try {
    f.initializeExisting(); writeFileSync(f.database, "existing older database", { mode: 0o600 });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert(!f.calls().some(args => args[0] === "run"));
    assert.equal(readFileSync(f.database, "utf8"), "existing older database");
  } finally { f.cleanup(); }
});

for (const residue of ["gateway.sqlite-wal", "attachments"]) test(`refuses absent database with retained ${residue} and never attempts migration/start`, () => {
  const f = fixture({ isolated: false });
  try {
    f.initializeExisting();
    if (residue === "attachments") { mkdirSync(join(f.data, residue)); writeFileSync(join(f.data, residue, "private-file"), "preserve"); }
    else writeFileSync(join(f.data, residue), "preserve");
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert(!f.calls().some(args => args[0] === "run" || args.includes("up")));
    const path = residue === "attachments" ? join(f.data, residue, "private-file") : join(f.data, residue);
    assert.equal(readFileSync(path, "utf8"), "preserve");
  } finally { f.cleanup(); }
});

test("refuses a dangling database symlink without initializing its target", () => {
  const f = fixture({ isolated: false });
  try {
    f.initializeExisting(); symlinkSync(join(f.directory, "outside.sqlite"), f.database);
    assert.notEqual(f.run().status, 0);
    assert(!f.calls().some(args => args[0] === "run" || args.includes("up")));
    assert(!existsSync(join(f.directory, "outside.sqlite")));
  } finally { f.cleanup(); }
});

test("never starts Gateway after protected migration fails", () => {
  const f = fixture({ migrateFails: true });
  try {
    assert.notEqual(f.run().status, 0);
    assert(f.calls().some(args => args.includes("apps/gateway/dist/migrate.js")));
    assert(!f.calls().some(args => args.includes("up")));
  } finally { f.cleanup(); }
});

test("rechecks the data directory after image preparation and refuses a newly appeared database", () => {
  const f = fixture({ databaseAppears: true });
  try {
    assert.notEqual(f.run().status, 0);
    assert(!f.calls().some(args => args[0] === "run" || args.includes("up")));
    assert.equal(readFileSync(f.database, "utf8"), "concurrently retained database");
  } finally { f.cleanup(); }
});
