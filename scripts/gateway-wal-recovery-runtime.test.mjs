import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, closeSync, openSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = "apps/gateway/dist/recoverGatewayDatabase.js";
const launcher = "apps/gateway/runtime/gateway_lock_exec.py";
const run = (args) => spawnSync(process.execPath, [cli, ...args], {
  cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" }
});

test("built recovery self-check works without database, network or development loader", () => {
  const result = run(["--self-check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "RECOVERY_SELF_CHECK_OK\n");
  assert.equal(result.stderr, "");
});

test("CLI rejects direct execution and malformed commands without raw output", () => {
  for (const args of [
    [], ["--database", "/private/SECRET_SENTINEL", "--action", "recover"],
    ["--self-check", "--token", "SECRET_SENTINEL"],
    ["--database", "relative", "--action", "status"],
    ["--database", "/private/db", "--action", "resume"],
    ["--database", "/private/db", "--action", "recover", "--operation-id", "0".repeat(32)]
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "RECOVERY_INVALID\n");
  }
});

test("launcher accepts only exact built recovery targets and action argument sets", () => {
  const load = "import importlib.util,sys;sys.dont_write_bytecode=True;s=importlib.util.spec_from_file_location('lock',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);";
  for (const target of [cli, "dist/recoverGatewayDatabase.js"]) {
    for (const action of ["recover", "resume", "retry", "status"]) {
      const args = ["node", target, "--database", "/runtime/gateway.sqlite", "--action", action];
      if (action === "resume" || action === "retry") args.push("--operation-id", "0".repeat(32));
      const result = spawnSync("python3", ["-c", `${load}print(m.command_role(sys.argv[2:],'/runtime/gateway.sqlite'))`, launcher, ...args], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "recovery\n");
    }
  }
});

test("Gateway NOREPLACE helper is byte-parity pinned to audited Broker protocol", () => {
  assert.deepEqual(readFileSync(new URL("../apps/gateway/runtime/rename_noreplace.py", import.meta.url)),
    readFileSync(new URL("../apps/agent-broker/runtime/rename_noreplace.py", import.meta.url)));
});

const protectedRun = (database, action, operation) => spawnSync("python3", [launcher,
  "--database", database, "--", "node", cli, "--database", database, "--action", action,
  ...(operation === undefined ? [] : ["--operation-id", operation])
], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" }, timeout: 60_000 });

const snapshot = path => {
  const rows = [];
  const visit = current => {
    const s = statSync(current, { bigint: true });
    rows.push([current, s.dev, s.ino, s.mode, s.uid, s.gid, s.mtimeNs,
      s.isFile() ? createHash("sha256").update(readFileSync(current)).digest("hex") : null].map(String));
    if (s.isDirectory()) for (const name of readdirSync(current).sort()) visit(join(current, name));
  };
  visit(path); return rows;
};

test("real built CLI recovers committed WAL only, seals completion, and keeps status read-only", {
  skip: process.getuid?.() !== 1000 || process.getgid?.() !== 1000,
  timeout: 120_000
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-recovery-runtime-"));
  chmodSync(directory, 0o700);
  const database = join(directory, "gateway.sqlite");
  try {
    const migrated = spawnSync("python3", [launcher, "--database", database, "--", "node",
      "apps/gateway/dist/migrate.js", "--database", database], { cwd: root, encoding: "utf8" });
    assert.equal(migrated.status, 0, migrated.stderr);
    const writer = spawnSync(process.execPath, ["apps/gateway/test/fixtures/databaseRecoveryProcess.mjs", database], {
      cwd: root, encoding: "utf8", timeout: 15_000
    });
    assert.equal(writer.status, 0, writer.stderr);
    const recovered = protectedRun(database, "recover");
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.stderr, "");
    const value = JSON.parse(recovered.stdout);
    assert.deepEqual(Object.keys(value), ["status", "operationId"]);
    assert.equal(value.status, "recovered");
    assert.match(value.operationId, /^[0-9a-f]{32}$/u);
    for (const suffix of ["-wal", "-shm", "-journal"]) assert.equal(existsSync(database + suffix), false);
    assert.equal(existsSync(join(directory, ".gateway.sqlite.wal-recovery")), false);
    const before = snapshot(directory);
    const status = protectedRun(database, "status", value.operationId);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stderr, "");
    assert.deepEqual(JSON.parse(status.stdout), { operationId: value.operationId, state: "completed", stage: "marker-removed" });
    assert.deepEqual(snapshot(directory), before);
    for (let i = 0; i < 2; i++) assert.equal(protectedRun(database, "resume", value.operationId).stdout, recovered.stdout);
    const verified = spawnSync(process.execPath, ["--input-type=module", "-e",
      "import D from 'better-sqlite3';const d=new D(process.argv[1],{readonly:true,fileMustExist:true});console.log(JSON.stringify(d.prepare('SELECT family_ref FROM families ORDER BY family_ref').all()));d.close()", database
    ], { cwd: root, encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout), [{ family_ref: "family:recovery-committed" }]);
    for (const path of readdirSync(join(directory, ".gateway.sqlite.wal-recovery-completed", value.operationId, "receipts"))) {
      assert.doesNotMatch(readFileSync(join(directory, ".gateway.sqlite.wal-recovery-completed", value.operationId, "receipts", path), "utf8"), /Recovery committed|Recovery uncommitted|SECRET_SENTINEL/u);
    }
    if (process.env.GATEWAY_WAL_MATRIX === "1") {
      // Only inside the no-network/no-publish image gate: prove the ordinary
      // Gateway starts after recovery and holds the same lock while WAL is live.
      await new Promise((resolve, reject) => {
        const child = spawn("python3", [launcher, "--database", database, "--", "node", "apps/gateway/dist/index.js"], {
          cwd: root, env: { ...process.env, GATEWAY_MODE: "test", GATEWAY_DATABASE_PATH: database,
            FAMILY_AI_ATTACHMENT_ROOT: join(directory, "attachments"), GATEWAY_DEVICE_TOKEN: "Runtime-Recovery-Fixture-Device-0001" },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let ready = false;
        let failure;
        const timer = setTimeout(() => { failure = new Error("GATEWAY_START_TIMEOUT"); child.kill("SIGKILL"); }, 20_000);
        child.stdout.on("data", chunk => {
          if (!ready && chunk.toString().includes("Server listening")) {
            ready = true;
            try {
              assert.equal(existsSync(database + "-wal"), true);
              assert.equal(existsSync(database + "-shm"), true);
              assert.equal(protectedRun(database, "status", value.operationId).stderr, "RECOVERY_FAILED\n");
            } catch (error) { failure = error; }
            child.kill("SIGTERM");
          }
        });
        child.once("error", reject);
        child.once("close", code => {
          clearTimeout(timer);
          if (failure) reject(failure);
          else if (!ready || code !== 0) reject(new Error("GATEWAY_RESTART_PROOF_FAILED"));
          else resolve();
        });
      });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("launcher bad recovery args preserve the database parent and never echo input", () => {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-recovery-args-"));
  const database = join(directory, "gateway.sqlite");
  try {
    for (const extra of [[], ["--operation-id", "A".repeat(32)], ["--operation-id", "0".repeat(31)],
      ["--operation-id", "0".repeat(32), "--secret", "SECRET_SENTINEL"],
      ["--operation-id", "0".repeat(32), "--action", "status"],
      ["--operation-id", "0".repeat(32), "--database", "/SECRET_SENTINEL"]]) {
      const result = spawnSync("python3", [launcher, "--database", database, "--", "node", cli,
        "--database", database, "--action", "resume", ...extra], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "RECOVERY_INVALID\n");
    }
    assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("production CLI rejects a forged inherited fd and wrong role before recovery writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-recovery-fd-"));
  chmodSync(directory, 0o700);
  const database = join(directory, "gateway.sqlite");
  const fd = openSync(join(directory, ".family-ai-gateway.lock"), "wx", 0o600);
  try {
    const before = snapshot(directory);
    for (const role of ["recovery", "gateway"]) {
      const result = spawnSync(process.execPath, [cli, "--database", database, "--action", "recover"], {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", fd],
        env: { ...process.env, NODE_ENV: "production", FAMILY_AI_GATEWAY_LOCK_ROLE: role,
          FAMILY_AI_GATEWAY_LOCK_DATABASE: database }
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "RECOVERY_INVALID\n");
      assert.deepEqual(snapshot(directory), before);
    }
  } finally { closeSync(fd); rmSync(directory, { recursive: true, force: true }); }
});

test("recovery fails before workspace mutation while another authorized process holds the shared lock", {
  skip: process.getuid?.() !== 1000 || process.getgid?.() !== 1000
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-recovery-busy-"));
  chmodSync(directory, 0o700);
  const database = join(directory, "gateway.sqlite");
  writeFileSync(join(directory, ".family-ai-gateway.lock"), "", { mode: 0o600, flag: "wx" });
  try {
    const before = snapshot(directory);
    const result = spawnSync("python3", ["-c",
      "import fcntl,os,subprocess,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);p=subprocess.run(sys.argv[2:],capture_output=True);sys.stdout.buffer.write(p.stdout);sys.stderr.buffer.write(p.stderr);sys.exit(p.returncode)",
      join(directory, ".family-ai-gateway.lock"), "python3", launcher, "--database", database, "--", "node", cli,
      "--database", database, "--action", "recover"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "RECOVERY_FAILED\n");
    assert.deepEqual(snapshot(directory), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const faultHarness = String.raw`
import importlib.util, os, sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('lock',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
database=sys.argv[2]
p,l=m.claim_lock(database,1000,1000)
os.close(p)
os.dup2(l,3,inheritable=True)
if l != 3: os.close(l)
os.environ['FAMILY_AI_GATEWAY_LOCK_ROLE']='recovery'
os.environ['FAMILY_AI_GATEWAY_LOCK_DATABASE']=database
os.environ['NODE_ENV']='test'
os.execv(sys.argv[3],[sys.argv[3],'apps/gateway/test/fixtures/gatewayRecoveryRuntimeFault.mjs',*sys.argv[2:3],*sys.argv[4:]])
`;
const operationId = "000102030405060708090a0b0c0d0e0f";
const faultRun = (database, action, target = "", kind = "") => spawnSync("python3", [
  "-c", faultHarness, launcher, database, process.execPath, action, operationId, target, kind
], { cwd: root, encoding: "utf8", timeout: 90_000 });

if (process.env.GATEWAY_WAL_MATRIX === "1") {
  const { RECOVERY_STAGE_DEFINITIONS } = await import("../apps/gateway/dist/databaseRecovery.js");
  const shard = Number(process.env.GATEWAY_WAL_SHARD ?? "0");
  const shards = Number(process.env.GATEWAY_WAL_SHARDS ?? "1");
  for (const [index, definition] of RECOVERY_STAGE_DEFINITIONS.entries()) {
    if (index % shards !== shard) continue;
    test(`built production double-resume/status/retry after real SIGKILL: ${definition.name}`, { timeout: 180_000 }, () => {
      const directory = mkdtempSync(join(process.env.GATEWAY_WAL_FIXTURE_PARENT ?? tmpdir(), "family-ai-wal-stage-"));
      chmodSync(directory, 0o700);
      const database = join(directory, "gateway.sqlite");
      try {
        const migrated = spawnSync("python3", [launcher, "--database", database, "--", "node", "apps/gateway/dist/migrate.js", "--database", database], { cwd: root, encoding: "utf8" });
        assert.equal(migrated.status, 0, migrated.stderr);
        const writer = spawnSync(process.execPath, ["apps/gateway/test/fixtures/databaseRecoveryProcess.mjs", database], { cwd: root, encoding: "utf8", timeout: 15_000 });
        assert.equal(writer.status, 0, writer.stderr);
        let action = "recover";
        let kind = definition.phase === "rollback-precut" ? "candidate" : definition.phase === "snapshot-abort" ? "snapshot" : "";
        if (["retry-failed", "retry-reset", "retry-aborted"].includes(definition.phase)) {
          const prepared = faultRun(database, "recover", "", definition.phase === "retry-aborted" ? "snapshot" : "candidate");
          assert.equal(prepared.status, 0, prepared.stderr);
          action = "retry";
        }
        const killed = faultRun(database, action, `receipt:${definition.name}`, kind);
        assert.equal(killed.signal, "SIGKILL", `${killed.stdout}${killed.stderr}`);
        assert.equal(killed.stdout, "");
        assert.equal(killed.stderr, "");
        const terminal = definition.phase === "snapshot-abort" ? "aborted" : definition.phase === "rollback-precut" ? "restored" : "recovered";
        for (let index = 0; index < 2; index++) {
          const resumed = protectedRun(database, "resume", operationId);
          assert.equal(resumed.status, terminal === "aborted" ? 1 : 0, resumed.stderr);
          assert.equal(resumed.stdout, terminal === "aborted" ? "" : `${JSON.stringify({ status: terminal, operationId })}\n`);
          assert.equal(resumed.stderr, terminal === "aborted" ? "RECOVERY_FAILED\n" : "");
        }
        const before = snapshot(directory);
        const status = protectedRun(database, "status", operationId);
        assert.equal(status.status, 0, status.stderr);
        assert.equal(JSON.parse(status.stdout).state, terminal === "recovered" ? "completed" : "active");
        assert.deepEqual(snapshot(directory), before);
        if (terminal !== "recovered") {
          const retry = protectedRun(database, "retry", operationId);
          assert.equal(retry.status, 0, retry.stderr);
          assert.equal(retry.stdout, `${JSON.stringify({ status: "recovered", operationId })}\n`);
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
}

test("rootful sealed image executes the definitions-derived recovery matrix without host publication", {
  skip: process.env.GATEWAY_WAL_TEST_IMAGE === undefined,
  timeout: 3_600_000
}, async () => {
  const image = process.env.GATEWAY_WAL_TEST_IMAGE;
  assert.match(image, /^sha256:[0-9a-f]{64}$/u);
  const volumes = Array.from({ length: 4 }, () => `family-ai-wal-${randomUUID()}`);
  const invoke = args => spawnSync("docker", args, { cwd: root, encoding: "utf8", timeout: 3_500_000, maxBuffer: 16 * 1024 * 1024 });
  try {
    const results = await Promise.allSettled(volumes.map(async (volume, shard) => {
    const initialized = invoke(["run", "--rm", "--network", "none", "--read-only", "--user", "0:0", "--entrypoint", "python3",
      "--mount", `type=volume,src=${volume},dst=/runtime`, image, "-c", "import os;os.chown('/runtime',1000,1000);os.chmod('/runtime',0o700)"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const result = await promisify(execFile)("docker", ["run", "--rm", "--network", "none", "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--mount", `type=volume,src=${volume},dst=/runtime`,
      "--mount", `type=bind,src=${join(root, 'scripts/gateway-wal-recovery-runtime.test.mjs')},dst=/app/scripts/gateway-wal-recovery-runtime.test.mjs,readonly`,
      "--mount", `type=bind,src=${join(root, 'apps/gateway/test/fixtures')},dst=/app/apps/gateway/test/fixtures,readonly`,
      "--mount", `type=bind,src=${join(root, 'apps/agent-broker/runtime/rename_noreplace.py')},dst=/app/apps/agent-broker/runtime/rename_noreplace.py,readonly`,
      "--env", "GATEWAY_WAL_MATRIX=1", "--env", "GATEWAY_WAL_FIXTURE_PARENT=/runtime", "--env", "TMPDIR=/runtime",
      "--env", `GATEWAY_WAL_SHARD=${shard}`, "--env", "GATEWAY_WAL_SHARDS=4",
      "--entrypoint", "node", image, "--test", "scripts/gateway-wal-recovery-runtime.test.mjs"],
    { cwd: root, encoding: "utf8", timeout: 3_500_000, maxBuffer: 16 * 1024 * 1024 });
    // Emit the child TAP as evidence, including every authoritative stage and skip reason.
    process.stdout.write(result.stdout);
    assert.equal(result.stderr, "");
    }));
    for (const result of results) {
      if (result.status === "rejected") {
        if (result.reason?.stdout) process.stdout.write(result.reason.stdout);
        throw result.reason;
      }
    }
  } finally { for (const volume of volumes) invoke(["volume", "rm", volume]); }
});
