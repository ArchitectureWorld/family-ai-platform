import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
const load = "import sys;sys.dont_write_bytecode=True;import importlib.util;spec=importlib.util.spec_from_file_location('lock','/launcher.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)";
const claim = `${load};p,l=m.claim_lock(__import__('sys').argv[1]);print('LOCKED',flush=True)`;
const fixedClaim = `${load};\ntry:p,l=m.claim_lock(__import__('sys').argv[1]);print('LOCKED')\nexcept m.LockFailure as e:print(e.code,file=__import__('sys').stderr);raise SystemExit(1)`;
const builtImage = process.env.GATEWAY_LOCK_TEST_IMAGE;

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

test("exact built image runs real roles with one immutable loser boundary", {
  skip: builtImage === undefined,
  timeout: 120_000
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-built-rootful-lock-"));
  chmodSync(directory, 0o700);
  mkdirSync(join(directory, "attachments"), { mode: 0o700 });
  const databasePath = join(directory, "gateway.sqlite");
  const credentialPath = join(directory, "canvas.credential");
  writeFileSync(credentialPath, "Rootful-Canvas-Credential-0001", { mode: 0o600 });
  const holder = `family-built-lock-holder-${process.pid}`;
  const second = `family-built-lock-second-${process.pid}`;
  const common = (mount = "/data") => [
    "--user", "1000:1000",
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:size=16m,mode=1777",
    "--mount", `type=bind,src=${directory},dst=${mount}`,
    "--env", `GATEWAY_DATABASE_PATH=${mount}/gateway.sqlite`
  ];
  const snapshot = () => JSON.stringify(readdirSync(directory).sort().map((name) => {
    const path = join(directory, name);
    const state = statSync(path);
    return state.isFile() ? {
      name,
      uid: state.uid,
      gid: state.gid,
      mode: state.mode & 0o777,
      nlink: state.nlink,
      size: state.size,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex")
    } : { name, type: "directory", uid: state.uid, gid: state.gid, mode: state.mode & 0o777 };
  }));
  const waitReady = async (name) => {
    const deadline = Date.now() + 20_000;
    let ready;
    do {
      ready = docker(["exec", name, "node", "--input-type=module", "-e",
        "const r=await fetch('http://127.0.0.1:8790/health');if(!r.ok)process.exit(1)"
      ]);
      if (ready.status === 0) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline && docker(["inspect", "-f", "{{.State.Running}}", name]).stdout.trim() === "true");
    assert.fail(ready?.stderr || "built Gateway did not become ready");
  };
  const cleanup = () => {
    docker(["rm", "-f", holder, second]);
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    assert.equal(statSync(directory).uid, 1000);
    assert.equal(statSync(directory).gid, 1000);
    const migrate = docker([
      "run", "--rm", ...common(), builtImage,
      "node", "apps/gateway/dist/migrate.js", "--database", "/data/gateway.sqlite"
    ], { timeout: 30_000 });
    assert.equal(migrate.status, 0, migrate.stderr);
    assert.equal(migrate.stdout, '{"schemaVersion":15,"quickCheck":"ok","foreignKeyViolations":0}\n');

    const provision = docker([
      "run", "--rm", ...common(), builtImage,
      "node", "apps/gateway/dist/provisionFederationService.js",
      "--service-ref", "service:canvas-rootful", "--product", "canvas",
      "--credential-file", "/data/canvas.credential", "--database", "/data/gateway.sqlite"
    ], { timeout: 30_000 });
    assert.equal(provision.status, 0, provision.stderr);

    const gatewayEnvironment = [
      "--env", "GATEWAY_MODE=test",
      "--env", "FAMILY_AI_PROVIDER_MODE=fake",
      "--env", "GATEWAY_DEVICE_TOKEN=Rootful-Gateway-Device-Token-0001",
      "--env", "FAMILY_AI_ATTACHMENT_ROOT=/data/attachments"
    ];
    const started = docker([
      "run", "-d", "--name", holder, ...common(), ...gatewayEnvironment, builtImage
    ]);
    assert.equal(started.status, 0, started.stderr);
    await waitReady(holder);
    const beforeLosers = snapshot();

    const loserCommands = [
      ["node", "apps/gateway/dist/migrate.js", "--database", "/alias/gateway.sqlite"],
      ["node", "apps/gateway/dist/provisionFederationService.js",
        "--service-ref", "service:canvas-loser", "--product", "canvas",
        "--credential-file", "/alias/canvas.credential", "--database", "/alias/gateway.sqlite"],
      ["node", "apps/gateway/dist/index.js"]
    ];
    for (const command of loserCommands) {
      const loser = docker([
        "run", "--rm", ...common("/alias"), ...gatewayEnvironment, builtImage, ...command
      ], { timeout: 30_000 });
      assert.equal(loser.status, 1, loser.stderr);
      assert.equal(loser.stdout, "");
      assert.equal(loser.stderr, "GATEWAY_DATABASE_LOCK_BUSY\n");
      assert.equal(snapshot(), beforeLosers);
    }

    const hostBusy = spawnSync("python3", [
      "-c", fixedClaim.replaceAll("/launcher.py", launcher), databasePath
    ], { encoding: "utf8" });
    assert.equal(hostBusy.status, 1);
    assert.equal(hostBusy.stderr, "GATEWAY_DATABASE_LOCK_BUSY\n");
    assert.equal(snapshot(), beforeLosers);

    assert.equal(docker(["kill", "--signal", "TERM", holder]).status, 0);
    assert.equal(docker(["wait", holder]).status, 0);
    const restarted = docker([
      "run", "-d", "--name", second, ...common(), ...gatewayEnvironment, builtImage
    ]);
    assert.equal(restarted.status, 0, restarted.stderr);
    await waitReady(second);
    assert.equal(docker(["kill", "--signal", "KILL", second]).status, 0);
    assert.equal(docker(["wait", second]).status, 0);
    const afterKill = spawnSync("python3", [
      "-c", fixedClaim.replaceAll("/launcher.py", launcher), databasePath
    ], { encoding: "utf8" });
    assert.equal(afterKill.status, 0, afterKill.stderr);
    assert.equal(afterKill.stdout, "LOCKED\n");
  } finally {
    cleanup();
  }
});
