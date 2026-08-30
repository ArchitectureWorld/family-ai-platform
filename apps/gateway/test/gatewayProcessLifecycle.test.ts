import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const worker = join(root, "apps/gateway/test/fixtures/gatewayLockLifecycleWorker.mjs");
const launcher = join(root, "apps/gateway/runtime/gateway_lock_exec.py");
const harness = String.raw`
import fcntl, os, sys
database, node, worker, *args = sys.argv[1:]
os.umask(0o077)
lock_path = os.path.join(os.path.dirname(database), ".family-ai-gateway.lock")
fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
os.dup2(fd, 3, inheritable=True)
if fd != 3: os.close(fd)
else: os.set_inheritable(3, True)
os.environ["FAMILY_AI_GATEWAY_LOCK_ROLE"] = "gateway"
os.environ["FAMILY_AI_GATEWAY_LOCK_DATABASE"] = database
os.execv(node, [node, "--import", "tsx", worker, database, *args])
`;

describe("Gateway process lock lifecycle", () => {
  let directory = "";
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const paths = () => {
    directory = mkdtempSync(join(tmpdir(), "family-gateway-lifecycle-"));
    chmodSync(directory, 0o700);
    return Object.fromEntries([
      "gateway.sqlite", "ready", "closing", "release", "db-closed", "close-error"
    ].map((name) => [name, join(directory, name)])) as Record<string, string>;
  };
  const waitFor = async (path: string, child: ReturnType<typeof spawn>) => {
    const deadline = Date.now() + 10_000;
    while (!existsSync(path) && child.exitCode === null && Date.now() < deadline) {
      await delay(10);
    }
    expect(existsSync(path)).toBe(true);
  };
  const contender = (databasePath: string) => spawnSync("python3", [
    launcher, "--database-from-env", "GATEWAY_DATABASE_PATH", "--",
    "node", "apps/gateway/test/fixtures/authorizedLockProbe.mjs",
    "--database", databasePath
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", GATEWAY_DATABASE_PATH: databasePath }
  });
  const start = (input: Record<string, string>, mode: string, port = "0") => spawn("python3", [
    "-c", harness, input["gateway.sqlite"]!, process.execPath, worker,
    mode, input.ready!, input.closing!, input.release!, input["db-closed"]!,
    input["close-error"]!, port
  ], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });

  it("keeps the lock through the real database close barrier across double signals", async () => {
    const input = paths();
    const child = start(input, "signal");
    await waitFor(input.ready!, child);
    child.kill("SIGTERM");
    await waitFor(input.closing!, child);
    child.kill("SIGINT");
    await delay(50);
    expect(existsSync(input["db-closed"]!)).toBe(false);
    expect(contender(input["gateway.sqlite"]!).stderr).toBe("GATEWAY_DATABASE_LOCK_BUSY\n");
    writeFileSync(input.release!, "release\n", { mode: 0o600, flag: "wx" });
    await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
    expect(child.exitCode).toBe(0);
    expect(existsSync(input["db-closed"]!)).toBe(true);
    expect(contender(input["gateway.sqlite"]!).stdout).toBe("GATEWAY_DATABASE_LOCK_PROBE_OK\n");
  }, 20_000);

  it("does not manually unlock when app close throws and releases only on SIGKILL", async () => {
    const input = paths();
    const child = start(input, "throw");
    await waitFor(input.ready!, child);
    child.kill("SIGTERM");
    await waitFor(input.closing!, child);
    writeFileSync(input.release!, "release\n", { mode: 0o600, flag: "wx" });
    await waitFor(input["close-error"]!, child);
    expect(contender(input["gateway.sqlite"]!).stderr).toBe("GATEWAY_DATABASE_LOCK_BUSY\n");
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
    expect(contender(input["gateway.sqlite"]!).stdout).toBe("GATEWAY_DATABASE_LOCK_PROBE_OK\n");
  }, 20_000);

  it("awaits app close before releasing the lock after listen failure", async () => {
    const input = paths();
    const occupied = createServer();
    await new Promise<void>((resolveListen) => occupied.listen(0, "127.0.0.1", resolveListen));
    const address = occupied.address();
    expect(address && typeof address === "object").toBe(true);
    const child = start(input, "listen-failure", String((address as { port: number }).port));
    try {
      await waitFor(input.closing!, child);
      expect(existsSync(input["db-closed"]!)).toBe(false);
      expect(contender(input["gateway.sqlite"]!).stderr).toBe("GATEWAY_DATABASE_LOCK_BUSY\n");
      writeFileSync(input.release!, "release\n", { mode: 0o600, flag: "wx" });
      await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
      expect(child.exitCode).toBe(1);
      expect(existsSync(input["db-closed"]!)).toBe(true);
      expect(contender(input["gateway.sqlite"]!).stdout).toBe("GATEWAY_DATABASE_LOCK_PROBE_OK\n");
    } finally {
      occupied.close();
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 20_000);
});
