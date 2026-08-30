import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const launcher = join(root, "apps/gateway/runtime/gateway_lock_exec.py");
const image = "python@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de";
const load = "import importlib.util;spec=importlib.util.spec_from_file_location('lock','/launcher.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)";
const claim = `${load};p,l=m.claim_lock(__import__('sys').argv[1]);print('LOCKED',flush=True)`;
const fixedClaim = `${load};\ntry:p,l=m.claim_lock(__import__('sys').argv[1]);print('LOCKED')\nexcept m.LockFailure as e:print(e.code,file=__import__('sys').stderr);raise SystemExit(1)`;

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", timeout: 15_000, ...options });
}

test("rootful containers and host contend on one lock inode across bind aliases and crash release", async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-rootful-lock-"));
  chmodSync(directory, 0o700);
  const databasePath = join(directory, "gateway.sqlite");
  writeFileSync(databasePath, "fixture", { mode: 0o600 });
  const holder = `family-lock-holder-${process.pid}`;
  const second = `family-lock-second-${process.pid}`;
  const cleanup = () => {
    docker(["rm", "-f", holder, second]);
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const start = docker([
      "run", "-d", "--name", holder, "--user", "1000:1000",
      "--mount", `type=bind,src=${directory},dst=/data-a`,
      "--mount", `type=bind,src=${launcher},dst=/launcher.py,readonly`,
      image, "python3", "-c", `${claim};s=__import__('signal');s.signal(s.SIGTERM,lambda *_:__import__('sys').exit(0));s.pause()`,
      "/data-a/gateway.sqlite"
    ]);
    assert.equal(start.status, 0, start.stderr);
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(directory, ".family-ai-gateway.lock")) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(join(directory, ".family-ai-gateway.lock")), true);

    for (const mount of ["/data-a", "/data-b"]) {
      const busy = docker([
        "run", "--rm", "--user", "1000:1000",
        "--mount", `type=bind,src=${directory},dst=${mount}`,
        "--mount", `type=bind,src=${launcher},dst=/launcher.py,readonly`,
        image, "python3", "-c", fixedClaim, `${mount}/gateway.sqlite`
      ]);
      assert.equal(busy.status, 1);
      assert.equal(busy.stdout, "");
      assert.equal(busy.stderr, "GATEWAY_DATABASE_LOCK_BUSY\n");
    }
    const hostBusy = spawnSync("python3", ["-c", fixedClaim.replaceAll("/launcher.py", launcher), databasePath], {
      encoding: "utf8"
    });
    assert.equal(hostBusy.status, 1);
    assert.equal(hostBusy.stderr, "GATEWAY_DATABASE_LOCK_BUSY\n");

    assert.equal(docker(["kill", "--signal", "TERM", holder]).status, 0);
    assert.equal(docker(["wait", holder]).status, 0);
    const afterTerm = docker([
      "run", "--rm", "--user", "1000:1000",
      "--mount", `type=bind,src=${directory},dst=/data-b`,
      "--mount", `type=bind,src=${launcher},dst=/launcher.py,readonly`,
      image, "python3", "-c", fixedClaim, "/data-b/gateway.sqlite"
    ]);
    assert.equal(afterTerm.status, 0, afterTerm.stderr);
    assert.equal(afterTerm.stdout, "LOCKED\n");

    const restart = docker([
      "run", "-d", "--name", second, "--user", "1000:1000",
      "--mount", `type=bind,src=${directory},dst=/data-a`,
      "--mount", `type=bind,src=${launcher},dst=/launcher.py,readonly`,
      image, "python3", "-c", `${claim};s=__import__('signal');s.signal(s.SIGTERM,lambda *_:__import__('sys').exit(0));s.pause()`,
      "/data-a/gateway.sqlite"
    ]);
    assert.equal(restart.status, 0, restart.stderr);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(docker(["kill", "--signal", "KILL", second]).status, 0);
    assert.equal(docker(["wait", second]).status, 0);
    const afterKill = spawnSync("python3", [
      "-c", fixedClaim.replaceAll("/launcher.py", launcher), databasePath
    ], { encoding: "utf8" });
    assert.equal(afterKill.status, 0, afterKill.stderr);
    assert.equal(afterKill.stdout, "LOCKED\n");

    const lock = statSync(join(directory, ".family-ai-gateway.lock"));
    assert.equal(lock.uid, 1000);
    assert.equal(lock.gid, 1000);
    assert.equal(lock.mode & 0o777, 0o600);
    assert.equal(lock.nlink, 1);
  } finally {
    cleanup();
  }
}, 60_000);
