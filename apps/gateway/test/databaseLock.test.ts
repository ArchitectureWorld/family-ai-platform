import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const worker = join(root, "apps/gateway/test/fixtures/databaseLockWorker.mjs");
const launcher = join(root, "apps/gateway/runtime/gateway_lock_exec.py");

const harness = String.raw`
import fcntl, os, sys
database, role, node, worker, mode, ready, release, *worker_args = sys.argv[1:]
parent = os.path.dirname(database)
lock_path = os.path.join(parent, ".family-ai-gateway.lock")
fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
os.chmod(lock_path, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
os.dup2(fd, 3, inheritable=True)
if fd != 3:
    os.close(fd)
else:
    os.set_inheritable(3, True)
if mode == "replace":
    os.rename(lock_path, lock_path + ".old")
    replacement = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(replacement)
os.environ["FAMILY_AI_GATEWAY_LOCK_ROLE"] = role
os.environ["FAMILY_AI_GATEWAY_LOCK_DATABASE"] = database
os.execv(node, [node, "--import", "tsx", worker, role, database, ready, release, *worker_args])
`;

describe("Gateway database launch lock", () => {
  let directory = "";

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const fixture = () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-lock-"));
    chmodSync(directory, 0o700);
    const databasePath = join(directory, "gateway.sqlite");
    writeFileSync(databasePath, "fixture", { mode: 0o600 });
    return databasePath;
  };

  const runWorker = (databasePath: string, input: {
    envRole?: string;
    fd3?: number;
  } = {}) => spawnSync(process.execPath, [
    "--import", "tsx", worker, "gateway", databasePath, "", ""
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FAMILY_AI_GATEWAY_LOCK_ROLE: input.envRole ?? "gateway"
    },
    stdio: input.fd3
      ? ["ignore", "pipe", "pipe", input.fd3]
      : ["ignore", "pipe", "pipe"]
  });

  it("rejects missing, fake and role-mismatched inherited fd3 with fixed errors", () => {
    const databasePath = fixture();
    const missing = runWorker(databasePath);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe("GATEWAY_DATABASE_LOCK_INVALID\n");

    const fakePath = join(directory, "fake.lock");
    writeFileSync(fakePath, "fake", { mode: 0o600 });
    const fakeDescriptor = openSync(fakePath, "r+");
    try {
      const fake = runWorker(databasePath, { fd3: fakeDescriptor });
      expect(fake.status).toBe(1);
      expect(fake.stderr).toBe("GATEWAY_DATABASE_LOCK_INVALID\n");

      const wrongRole = runWorker(databasePath, {
        envRole: "provision",
        fd3: fakeDescriptor
      });
      expect(wrongRole.status).toBe(1);
      expect(wrongRole.stderr).toBe("GATEWAY_DATABASE_LOCK_INVALID\n");
    } finally {
      closeSync(fakeDescriptor);
    }
  });

  it("accepts the exact inherited locked OFD and rejects lock-path replacement", () => {
    const databasePath = fixture();
    for (const [mode, expected] of [["valid", 0], ["replace", 1]] as const) {
      const result = spawnSync("python3", [
        "-c", harness, databasePath, "gateway", process.execPath, worker, mode, "", ""
      ], { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(expected);
      if (expected === 0) {
        expect(result.stdout).toBe("GATEWAY_DATABASE_LOCK_READY\n");
        expect(result.stderr).toBe("");
      } else {
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("GATEWAY_DATABASE_LOCK_INVALID\n");
      }
    }
  });

  it("derives the migrate role only from the exact CMD after the database-from-env boundary", () => {
    const databasePath = fixture();
    rmSync(databasePath);
    const exact = spawnSync("python3", [
      launcher,
      "--database-from-env", "GATEWAY_DATABASE_PATH",
      "--",
      "node", "apps/gateway/dist/migrate.js",
      "--database", databasePath
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GATEWAY_DATABASE_PATH: databasePath }
    });
    expect(exact.status, exact.stderr).toBe(0);
    expect(exact.stdout).toBe(
      '{"schemaVersion":15,"quickCheck":"ok","foreignKeyViolations":0}\n'
    );

    rmSync(databasePath);
    const legacyRole = spawnSync("python3", [
      launcher, "--role", "migrate", "--database", databasePath
    ], { cwd: root, encoding: "utf8" });
    expect(legacyRole.status).toBe(1);
    expect(legacyRole.stdout).toBe("");
    expect(legacyRole.stderr).toBe("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID\n");
    expect(existsSync(databasePath)).toBe(false);
  }, 20_000);

  it("injects unit identities without allowing production identity overrides", () => {
    const databasePath = fixture();
    const accepted = spawnSync("python3", [
      "-c", harness, databasePath, "gateway", process.execPath, worker,
      "valid", "", "", "1000", "1000"
    ], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
    expect(accepted.status, accepted.stderr).toBe(0);

    const rejected = spawnSync("python3", [
      "-c", harness, databasePath, "gateway", process.execPath, worker,
      "valid", "", "", "1001", "1000"
    ], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toBe("GATEWAY_DATABASE_LOCK_INVALID\n");

    const production = spawnSync("python3", [
      "-c", harness, databasePath, "gateway", process.execPath, worker,
      "valid", "", ""
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        FAMILY_AI_GATEWAY_EXPECTED_UID: "1001",
        FAMILY_AI_GATEWAY_EXPECTED_GID: "1001"
      }
    });
    expect(production.status, production.stderr).toBe(0);
  });

  it("fails nonblocking contention and releases after holder SIGKILL", async () => {
    const databasePath = fixture();
    const ready = join(directory, "ready");
    const release = join(directory, "release");
    const holder = spawn("python3", [
      "-c", harness, databasePath, "gateway", process.execPath, worker, "valid", ready, release
    ], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && holder.exitCode === null && Date.now() < deadline) {
      await delay(10);
    }
    expect(existsSync(ready)).toBe(true);

    const busy = spawnSync("python3", [
      launcher, "--database-from-env", "GATEWAY_DATABASE_PATH", "--",
      "node", "apps/gateway/dist/migrate.js", "--database", databasePath
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GATEWAY_DATABASE_PATH: databasePath }
    });
    expect(busy.status).toBe(1);
    expect(busy.stdout).toBe("");
    expect(busy.stderr).toBe("GATEWAY_DATABASE_LOCK_BUSY\n");

    holder.kill("SIGKILL");
    await new Promise<void>((resolveExit) => holder.once("close", () => resolveExit()));
    rmSync(databasePath);
    const after = spawnSync("python3", [
      launcher, "--database-from-env", "GATEWAY_DATABASE_PATH", "--",
      "node", "apps/gateway/dist/migrate.js", "--database", databasePath
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GATEWAY_DATABASE_PATH: databasePath }
    });
    expect(after.status, after.stderr).toBe(0);
    expect(after.stderr).toBe("");
    expect(after.stdout).toBe(
      '{"schemaVersion":15,"quickCheck":"ok","foreignKeyViolations":0}\n'
    );
  }, 20_000);
});
