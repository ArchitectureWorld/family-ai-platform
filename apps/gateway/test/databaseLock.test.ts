import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayDatabaseLockMetadataMatchesForTest } from "../src/databaseLock.js";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const worker = join(root, "apps/gateway/test/fixtures/databaseLockWorker.mjs");
const launcher = join(root, "apps/gateway/runtime/gateway_lock_exec.py");
const loadLauncher = String.raw`
import importlib.util, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("gateway_lock", sys.argv[1])
gateway_lock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway_lock)
`;
const currentUid = process.getuid?.();
const currentGid = process.getgid?.();
if (currentUid === undefined || currentGid === undefined) {
  throw new Error("Gateway lock tests require POSIX uid/gid");
}

it.each(["naked", "shared", "other-exclusive", "exclusive"] as const)(
  "accepts only an already exclusive inherited OFD: %s",
  (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "family-ai-lock-exclusive-proof-"));
    chmodSync(directory, 0o700);
    try {
      const result = spawnSync("python3", ["-c", `${loadLauncher}
import fcntl, os, subprocess
database, kind = sys.argv[2:]
p,l=gateway_lock.open_validated_lock(database,os.getuid(),os.getgid())
os.close(p)
os.dup2(l,3,inheritable=True)
if l != 3: os.close(l)
other=None
if kind == 'shared': fcntl.flock(3,fcntl.LOCK_SH)
elif kind == 'exclusive': fcntl.flock(3,fcntl.LOCK_EX)
elif kind == 'other-exclusive':
    other=subprocess.Popen([sys.executable,'-c',"import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX);print('LOCKED',flush=True);sys.stdin.read()",os.path.join(os.path.dirname(database),'.family-ai-gateway.lock')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
    assert other.stdout.readline() == 'LOCKED\\n'
code=0
try:
    gateway_lock.assert_inherited(3,'recovery',database,os.getuid(),os.getgid())
except gateway_lock.LockFailure as error:
    sys.stderr.write(error.code+'\\n')
    code=1
finally:
    if other is not None:
        other.stdin.close()
        other.wait(timeout=5)
raise SystemExit(code)
`, launcher, join(directory, "gateway.sqlite"), kind], { encoding: "utf8", timeout: 10_000 });
      expect(result.status).toBe(kind === "exclusive" ? 0 : 1);
      expect(result.stdout).toBe(kind === "exclusive" ? "GATEWAY_DATABASE_LOCK_OK\n" : "");
      expect(result.stderr).toBe(kind === "exclusive" ? "" : "GATEWAY_DATABASE_LOCK_INVALID\n");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
);

function claimHostLock(databasePath: string) {
  return spawnSync("python3", [
    "-c",
    `${loadLauncher}\ntry:\n parent, lock = gateway_lock.claim_lock(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))\n print("LOCKED")\nexcept gateway_lock.LockFailure as error:\n print(error.code, file=sys.stderr)\n raise SystemExit(1)`,
    launcher,
    databasePath,
    String(currentUid),
    String(currentGid)
  ], { cwd: root, encoding: "utf8" });
}

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
    const exact = spawnSync("python3", [
      "-c",
      `${loadLauncher}\nimport json, os\nos.environ["GATEWAY_DATABASE_PATH"] = sys.argv[2]\nprint(json.dumps(gateway_lock.parse_normal(sys.argv[3:])))`,
      launcher,
      databasePath,
      "--database-from-env", "GATEWAY_DATABASE_PATH", "--",
      "node", "apps/gateway/dist/migrate.js", "--database", databasePath
    ], {
      cwd: root,
      encoding: "utf8"
    });
    expect(exact.status, exact.stderr).toBe(0);
    expect(exact.stdout).toBe(
      `["migrate", "${databasePath}", ["node", "apps/gateway/dist/migrate.js", "--database", "${databasePath}"]]\n`
    );

    const legacyRole = spawnSync("python3", [
      launcher, "--role", "migrate", "--database", databasePath
    ], { cwd: root, encoding: "utf8" });
    expect(legacyRole.status).toBe(1);
    expect(legacyRole.stdout).toBe("");
    expect(legacyRole.stderr).toBe("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID\n");
    expect(readFileSync(databasePath, "utf8")).toBe("fixture");
  }, 20_000);

  it("injects unit identities without allowing production identity overrides", () => {
    const databasePath = fixture();
    const accepted = spawnSync("python3", [
      "-c", harness, databasePath, "gateway", process.execPath, worker,
      "valid", "", "", String(currentUid), String(currentGid)
    ], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
    expect(accepted.status, accepted.stderr).toBe(0);

    const nonCurrentUid = currentUid === 1234 ? 1235 : 1234;
    const rejected = spawnSync("python3", [
      "-c", harness, databasePath, "gateway", process.execPath, worker,
      "valid", "", "", String(nonCurrentUid), String(currentGid)
    ], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toBe("GATEWAY_DATABASE_LOCK_INVALID\n");
  });

  it("accepts a simulated non-1000 identity only when unit expectations match", () => {
    const metadata = {
      parent: { uid: 1234, gid: 2345, mode: 0o700, nlink: 1 },
      lock: { uid: 1234, gid: 2345, mode: 0o600, nlink: 1 }
    };
    expect(gatewayDatabaseLockMetadataMatchesForTest(
      metadata,
      { uid: 1234, gid: 2345 }
    )).toBe(true);
    expect(gatewayDatabaseLockMetadataMatchesForTest(
      metadata,
      { uid: 1000, gid: 1000 }
    )).toBe(false);
  });

  it("lets host units inject current lock identity while production main stays fixed", () => {
    const databasePath = fixture();
    const claimed = claimHostLock(databasePath);
    expect(claimed.status, claimed.stderr).toBe(0);
    expect(claimed.stdout).toBe("LOCKED\n");

    const simulated = spawnSync("python3", [
      "-c",
      `${loadLauncher}\nimport stat, types\nparent = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=1234, st_gid=2345)\nlock = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=1234, st_gid=2345, st_nlink=1)\nprint(gateway_lock.protected_parent(parent, 1234, 2345), gateway_lock.protected_lock(lock, 1234, 2345), gateway_lock.protected_parent(parent, gateway_lock.APP_UID, gateway_lock.APP_GID), gateway_lock.protected_lock(lock, gateway_lock.APP_UID, gateway_lock.APP_GID))`,
      launcher
    ], { cwd: root, encoding: "utf8" });
    expect(simulated.status, simulated.stderr).toBe(0);
    expect(simulated.stdout).toBe("True True False False\n");
    expect(readFileSync(launcher, "utf8")).toContain(
      "claim_lock(database, APP_UID, APP_GID)"
    );
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

    const busy = claimHostLock(databasePath);
    expect(busy.status).toBe(1);
    expect(busy.stdout).toBe("");
    expect(busy.stderr).toBe("GATEWAY_DATABASE_LOCK_BUSY\n");

    holder.kill("SIGKILL");
    await new Promise<void>((resolveExit) => holder.once("close", () => resolveExit()));
    const after = claimHostLock(databasePath);
    expect(after.status, after.stderr).toBe(0);
    expect(after.stderr).toBe("");
    expect(after.stdout).toBe("LOCKED\n");
  }, 20_000);
});
