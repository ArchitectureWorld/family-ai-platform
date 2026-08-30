import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const launcher = join(root, "apps/gateway/runtime/gateway_lock_exec.py");
const image = "python@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de";
const load = "import sys;sys.dont_write_bytecode=True;import importlib.util;spec=importlib.util.spec_from_file_location('lock','/launcher.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)";
const claim = `${load};p,l=m.claim_lock(__import__('sys').argv[1],1000,1000);print('LOCKED',flush=True)`;
const fixedClaim = `${load};\ntry:p,l=m.claim_lock(__import__('sys').argv[1],1000,1000);print('LOCKED')\nexcept m.LockFailure as e:print(e.code,file=__import__('sys').stderr);raise SystemExit(1)`;
const builtImage = process.env.GATEWAY_LOCK_TEST_IMAGE;

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", timeout: 15_000, ...options });
}

const SETPRIV_UID1000 = [
  "setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "--"
];

function selectHost1000Runner(input) {
  if (input.uid === 1000) return { kind: "direct", command: [] };
  if (input.setprivAvailable && input.directSetprivWorks) {
    return { kind: "setpriv", command: SETPRIV_UID1000 };
  }
  if (input.setprivAvailable && input.sudoSetprivWorks) {
    return { kind: "sudo-setpriv", command: ["sudo", "-n", ...SETPRIV_UID1000] };
  }
  return {
    kind: "unavailable",
    code: "GATEWAY_ROOTFUL_UID1000_CAPABILITY_UNAVAILABLE"
  };
}

function commandSucceeds(command) {
  const result = spawnSync(command[0], [...command.slice(1), "id", "-u"], {
    encoding: "utf8"
  });
  return result.status === 0 && result.stdout === "1000\n" && result.stderr === "";
}

function detectHost1000Runner() {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return {
      kind: "unavailable",
      code: "GATEWAY_ROOTFUL_UID1000_CAPABILITY_UNAVAILABLE"
    };
  }
  const setprivAvailable = spawnSync("setpriv", ["--version"], {
    encoding: "utf8"
  }).status === 0;
  const direct = setprivAvailable && uid !== 1000
    ? commandSucceeds(SETPRIV_UID1000)
    : false;
  const sudo = setprivAvailable && uid !== 1000 && !direct
    ? commandSucceeds(["sudo", "-n", ...SETPRIV_UID1000])
    : false;
  return selectHost1000Runner({
    uid,
    setprivAvailable,
    directSetprivWorks: direct,
    sudoSetprivWorks: sudo
  });
}

const host1000Runner = detectHost1000Runner();

function runAsHost1000(argv, options = {}) {
  if (host1000Runner.kind === "unavailable") {
    throw new Error(host1000Runner.code);
  }
  const command = host1000Runner.command.length === 0
    ? argv
    : [...host1000Runner.command, ...argv];
  return spawnSync(command[0], command.slice(1), {
    cwd: root,
    encoding: "utf8",
    ...options
  });
}

function requireHost1000Capability(context) {
  if (host1000Runner.kind !== "unavailable") return true;
  if (process.env.CI) assert.fail(host1000Runner.code);
  context.skip(host1000Runner.code);
  return false;
}

function fixturePath(prefix) {
  return join(tmpdir(), `${prefix}${process.pid}-${randomUUID()}`);
}

function prepareFixture(prefix, input = {}) {
  const directory = fixturePath(prefix);
  const created = runAsHost1000([
    "install", "-d", "-m", "0700", "-o", "1000", "-g", "1000", directory
  ]);
  assert.equal(created.status, 0, created.stderr);
  const directoryState = statSync(directory);
  assert.equal(directoryState.uid, 1000);
  assert.equal(directoryState.gid, 1000);
  assert.equal(directoryState.mode & 0o777, 0o700);
  for (const [name, contents] of Object.entries(input.files ?? {})) {
    const written = runAsHost1000([
      "python3", "-c",
      "import os,sys;p=sys.argv[1];d=sys.stdin.buffer.read();f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(f,d);os.fsync(f);os.close(f)",
      join(directory, name)
    ], { input: contents });
    assert.equal(written.status, 0, written.stderr);
    assertProtectedFile(join(directory, name));
  }
  for (const name of input.directories ?? []) {
    const made = runAsHost1000([
      "install", "-d", "-m", "0700", "-o", "1000", "-g", "1000",
      join(directory, name)
    ]);
    assert.equal(made.status, 0, made.stderr);
    const state = statSync(join(directory, name));
    assert.equal(state.uid, 1000);
    assert.equal(state.gid, 1000);
    assert.equal(state.mode & 0o777, 0o700);
  }
  return directory;
}

function assertProtectedFile(path) {
  const state = statSync(path);
  assert.equal(state.uid, 1000);
  assert.equal(state.gid, 1000);
  assert.equal(state.mode & 0o777, 0o600);
  assert.equal(state.nlink, 1);
}

function cleanupFixture(directory) {
  const expectedPrefix = join(tmpdir(), "family-ai-");
  assert.equal(directory.startsWith(expectedPrefix), true);
  const removed = runAsHost1000(["rm", "-rf", "--", directory]);
  assert.equal(removed.status, 0, removed.stderr);
}

function snapshot(directory) {
  return JSON.stringify(readdirSync(directory).sort().map((name) => {
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
    } : {
      name,
      type: "directory",
      uid: state.uid,
      gid: state.gid,
      mode: state.mode & 0o777
    };
  }));
}

test("selects an explicit uid1000 host runner without implicit inheritance", () => {
  assert.deepEqual(selectHost1000Runner({
    uid: 1000,
    setprivAvailable: false,
    directSetprivWorks: false,
    sudoSetprivWorks: false
  }), { kind: "direct", command: [] });
  assert.deepEqual(selectHost1000Runner({
    uid: 0,
    setprivAvailable: true,
    directSetprivWorks: true,
    sudoSetprivWorks: false
  }), {
    kind: "setpriv",
    command: ["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "--"]
  });
});

test("selects only proven uid1000 elevation for another host uid", () => {
  assert.deepEqual(selectHost1000Runner({
    uid: 1234,
    setprivAvailable: true,
    directSetprivWorks: true,
    sudoSetprivWorks: false
  }), {
    kind: "setpriv",
    command: ["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "--"]
  });
  assert.deepEqual(selectHost1000Runner({
    uid: 1234,
    setprivAvailable: true,
    directSetprivWorks: false,
    sudoSetprivWorks: true
  }), {
    kind: "sudo-setpriv",
    command: ["sudo", "-n", "setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "--"]
  });
  assert.deepEqual(selectHost1000Runner({
    uid: 1234,
    setprivAvailable: true,
    directSetprivWorks: false,
    sudoSetprivWorks: false
  }), {
    kind: "unavailable",
    code: "GATEWAY_ROOTFUL_UID1000_CAPABILITY_UNAVAILABLE"
  });
});

function authorizedHost(databasePath) {
  return runAsHost1000([
    "python3", launcher,
    "--database-from-env", "GATEWAY_DATABASE_PATH", "--",
    "node", "apps/gateway/dist/migrate.js", "--database", databasePath
  ], {
    env: { ...process.env, NODE_ENV: "production", GATEWAY_DATABASE_PATH: databasePath }
  });
}

test("rootful containers and host contend on one lock inode across bind aliases and crash release", async (context) => {
  if (!requireHost1000Capability(context)) return;
  const directory = prepareFixture("family-ai-rootful-lock-", {
    files: {
      "gateway.sqlite": "fixture",
      ".family-ai-gateway.lock": ""
    }
  });
  const databasePath = join(directory, "gateway.sqlite");
  const hostProbePath = join(directory, "host-probe.sqlite");
  const holder = `family-lock-holder-${process.pid}`;
  const second = `family-lock-second-${process.pid}`;
  const cleanup = () => {
    docker(["rm", "-f", holder, second]);
    cleanupFixture(directory);
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
    let holderLogs = "";
    while (!holderLogs.includes("LOCKED") && Date.now() < deadline) {
      holderLogs = docker(["logs", holder]).stdout;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(holderLogs, /LOCKED/u);
    const beforeBusy = snapshot(directory);

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
      assert.equal(snapshot(directory), beforeBusy);
    }
    const hostBusy = authorizedHost(hostProbePath);
    assert.equal(hostBusy.status, 1);
    assert.equal(hostBusy.stderr, "GATEWAY_DATABASE_LOCK_BUSY\n");
    assert.equal(snapshot(directory), beforeBusy);

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
    const afterKill = authorizedHost(hostProbePath);
    assert.equal(afterKill.status, 0, afterKill.stderr);
    assert.equal(afterKill.stdout, '{"schemaVersion":15,"quickCheck":"ok","foreignKeyViolations":0}\n');

    const lock = statSync(join(directory, ".family-ai-gateway.lock"));
    const database = statSync(databasePath);
    assert.equal(lock.uid, 1000);
    assert.equal(lock.gid, 1000);
    assert.equal(lock.mode & 0o777, 0o600);
    assert.equal(lock.nlink, 1);
    assert.equal(database.uid, 1000);
    assert.equal(database.gid, 1000);
    assert.equal(database.mode & 0o777, 0o600);
    assert.equal(database.nlink, 1);
  } finally {
    cleanup();
  }
}, 60_000);

test("exact built image runs real roles with one immutable loser boundary", {
  skip: builtImage === undefined,
  timeout: 120_000
}, async (context) => {
  if (!requireHost1000Capability(context)) return;
  const directory = prepareFixture("family-ai-built-rootful-lock-", {
    files: {
      ".family-ai-gateway.lock": "",
      "canvas.credential": "Rootful-Canvas-Credential-0001"
    },
    directories: ["attachments"]
  });
  const databasePath = join(directory, "gateway.sqlite");
  const hostProbePath = join(directory, "host-probe.sqlite");
  const credentialPath = join(directory, "canvas.credential");
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
    cleanupFixture(directory);
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
    assertProtectedFile(databasePath);
    assertProtectedFile(join(directory, ".family-ai-gateway.lock"));
    assertProtectedFile(credentialPath);

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
    const beforeLosers = snapshot(directory);

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
      assert.equal(snapshot(directory), beforeLosers);
    }

    const hostBusy = authorizedHost(hostProbePath);
    assert.equal(hostBusy.status, 1);
    assert.equal(hostBusy.stderr, "GATEWAY_DATABASE_LOCK_BUSY\n");
    assert.equal(snapshot(directory), beforeLosers);

    assert.equal(docker(["kill", "--signal", "TERM", holder]).status, 0);
    assert.equal(docker(["wait", holder]).status, 0);
    const restarted = docker([
      "run", "-d", "--name", second, ...common(), ...gatewayEnvironment, builtImage
    ]);
    assert.equal(restarted.status, 0, restarted.stderr);
    await waitReady(second);
    assert.equal(docker(["kill", "--signal", "KILL", second]).status, 0);
    assert.equal(docker(["wait", second]).status, 0);
    const afterKill = authorizedHost(hostProbePath);
    assert.equal(afterKill.status, 0, afterKill.stderr);
    assert.equal(afterKill.stdout, '{"schemaVersion":15,"quickCheck":"ok","foreignKeyViolations":0}\n');
  } finally {
    cleanup();
  }
});

test("exact built image rejects non-1000 identity even with test-shaped environment", {
  skip: builtImage === undefined,
  timeout: 60_000
}, () => {
  const volume = `family-lock-non1000-${process.pid}`;
  try {
    assert.equal(docker(["volume", "create", volume]).status, 0);
    const prepared = docker([
      "run", "--rm", "--user", "0:0", "--entrypoint", "sh",
      "--mount", `type=volume,src=${volume},dst=/probe`, builtImage,
      "-c", "chown 1234:1234 /probe && chmod 0700 /probe"
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const probe = docker([
      "run", "--rm", "--user", "1234:1234", "--network", "none", "--read-only",
      "--mount", `type=volume,src=${volume},dst=/probe`,
      "--env", "NODE_ENV=test",
      "--env", "FAMILY_AI_GATEWAY_LOCK_TEST_IDENTITY=1",
      "--env", "FAMILY_AI_GATEWAY_EXPECTED_UID=1234",
      "--env", "FAMILY_AI_GATEWAY_EXPECTED_GID=1234",
      "--env", "GATEWAY_DATABASE_PATH=/probe/gateway.sqlite",
      builtImage, "node", "apps/gateway/dist/migrate.js",
      "--database", "/probe/gateway.sqlite"
    ], { timeout: 30_000 });
    assert.equal(probe.status, 1);
    assert.equal(probe.stdout, "");
    assert.equal(probe.stderr, "GATEWAY_DATABASE_LOCK_INVALID\n");
  } finally {
    docker(["volume", "rm", "-f", volume]);
  }
});
