import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
const rootfulTestFile = fileURLToPath(import.meta.url);
const fixtureHelper = String.raw`
import base64, hashlib, json, os, shutil, stat, sys
action, directory = sys.argv[1:3]
basename = os.path.basename(directory)
if not os.path.isabs(directory) or not basename.startswith("family-ai-"):
    raise SystemExit(64)
def exact_name(name):
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise SystemExit(65)
    return name
def file_hash(parent_fd, name):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)
    finally:
        os.close(descriptor)
def inspect_tree():
    parent_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parent = os.fstat(parent_fd)
        entries = []
        for name in sorted(os.listdir(parent_fd)):
            exact_name(name)
            state = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            row = {"name": name, "uid": state.st_uid, "gid": state.st_gid,
                   "mode": stat.S_IMODE(state.st_mode), "nlink": state.st_nlink}
            if stat.S_ISREG(state.st_mode):
                row.update({"type": "file", "size": state.st_size,
                            "sha256": file_hash(parent_fd, name)})
            elif stat.S_ISDIR(state.st_mode):
                row["type"] = "directory"
            else:
                row["type"] = "unsupported"
            entries.append(row)
        return {"directory": {"uid": parent.st_uid, "gid": parent.st_gid,
                              "mode": stat.S_IMODE(parent.st_mode),
                              "nlink": parent.st_nlink}, "entries": entries}
    finally:
        os.close(parent_fd)
if action == "prepare":
    payload = json.load(sys.stdin)
    os.mkdir(directory, 0o700)
    os.chown(directory, 1000, 1000)
    os.chmod(directory, 0o700)
    parent_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in payload.get("directories", []):
            name = exact_name(name)
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            os.chown(name, 1000, 1000, dir_fd=parent_fd, follow_symlinks=False)
        for name, encoded in payload.get("files", {}).items():
            name = exact_name(name)
            contents = base64.b64decode(encoded, validate=True)
            descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=parent_fd)
            try:
                os.fchown(descriptor, 1000, 1000)
                os.fchmod(descriptor, 0o600)
                os.write(descriptor, contents)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
    output = {"action": action, "tree": inspect_tree()}
elif action == "inspect":
    output = {"action": action, "tree": inspect_tree()}
elif action == "cleanup":
    tree = inspect_tree()
    if tree["directory"]["uid"] != 1000 or tree["directory"]["mode"] != 0o700:
        raise SystemExit(66)
    shutil.rmtree(directory)
    output = {"action": action, "removed": not os.path.lexists(directory)}
else:
    raise SystemExit(67)
print(json.dumps(output, separators=(",", ":"), sort_keys=True))
`;

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

function runFixtureHelper(action, directory, payload = {}) {
  const result = runAsHost1000([
    "python3", "-c", fixtureHelper, action, directory
  ], { input: JSON.stringify(payload) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.length > 0 && result.stdout.length <= 32_768);
  const output = JSON.parse(result.stdout);
  assert.equal(output.action, action);
  return output;
}

function prepareFixture(prefix, input = {}) {
  const directory = fixturePath(prefix);
  const files = Object.fromEntries(Object.entries(input.files ?? {}).map(
    ([name, contents]) => [name, Buffer.from(contents).toString("base64")]
  ));
  const output = runFixtureHelper("prepare", directory, {
    files,
    directories: input.directories ?? []
  });
  assertProtectedDirectoryTree(output.tree);
  return directory;
}

function assertProtectedDirectoryTree(tree) {
  assert.deepEqual(
    { uid: tree.directory.uid, gid: tree.directory.gid, mode: tree.directory.mode },
    { uid: 1000, gid: 1000, mode: 0o700 }
  );
}

function assertProtectedFile(directory, name) {
  const output = runFixtureHelper("inspect", directory);
  assertProtectedDirectoryTree(output.tree);
  const state = output.tree.entries.find((entry) => entry.name === name);
  assert.ok(state);
  assert.deepEqual(
    { type: state.type, uid: state.uid, gid: state.gid, mode: state.mode, nlink: state.nlink },
    { type: "file", uid: 1000, gid: 1000, mode: 0o600, nlink: 1 }
  );
}

function cleanupFixture(directory) {
  const output = runFixtureHelper("cleanup", directory);
  assert.equal(output.removed, true);
}

function snapshot(directory) {
  const output = runFixtureHelper("inspect", directory);
  assertProtectedDirectoryTree(output.tree);
  return JSON.stringify(output.tree);
}

function dockerSocketGid() {
  const result = spawnSync("stat", ["-c", "%g", "/var/run/docker.sock"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\n$/u);
  return result.stdout.trim();
}

function childTestArguments(sourceRoot = root, nodePath = process.execPath) {
  return [
    nodePath,
    "--test",
    "--test-name-pattern",
    "^rootful containers and host contend on one lock inode",
    join(sourceRoot, "scripts/gateway-database-lock-rootful.test.mjs")
  ];
}

function runRootOrchestratedNon1000Parent() {
  if (process.env.GATEWAY_ROOTFUL_FORCE_CONTAINER_PARENT === "1") return undefined;
  const uid = process.getuid?.();
  const prefix = uid === 0
    ? []
    : spawnSync("sudo", ["-n", "true"], { encoding: "utf8" }).status === 0
      ? ["sudo", "-n"]
      : undefined;
  if (prefix === undefined) return undefined;
  const harness = fixturePath("family-ai-rootful-harness-");
  const mountedRoot = join(harness, "repo");
  const runRoot = (argv) => {
    const command = [...prefix, ...argv];
    return spawnSync(command[0], command.slice(1), { encoding: "utf8" });
  };
  let mounted = false;
  try {
    const prepared = runRoot([
      "install", "-d", "-m", "0755", "-o", "0", "-g", "0", harness, mountedRoot
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const bound = runRoot(["mount", "--bind", root, mountedRoot]);
    assert.equal(bound.status, 0, bound.stderr);
    mounted = true;
    const readonly = runRoot(["mount", "-o", "remount,bind,ro", mountedRoot]);
    assert.equal(readonly.status, 0, readonly.stderr);
    const parent = [
      ...prefix,
      "setpriv",
      "--reuid=1234",
      "--regid=1234",
      "--groups", dockerSocketGid(),
      "--inh-caps", "+setuid,+setgid",
      "--ambient-caps", "+setuid,+setgid",
      "--bounding-set", "+setuid,+setgid",
      "--",
      "/usr/bin/env",
      "GATEWAY_ROOTFUL_NON1000_CHILD=1",
      "HOME=/tmp",
      "DOCKER_CONFIG=/tmp/family-ai-empty-docker-config",
      `PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
      ...childTestArguments(mountedRoot)
    ];
    return spawnSync(parent[0], parent.slice(1), {
      cwd: mountedRoot,
      encoding: "utf8",
      timeout: 90_000
    });
  } finally {
    if (mounted) {
      const unmounted = runRoot(["umount", "--", mountedRoot]);
      assert.equal(unmounted.status, 0, unmounted.stderr);
    }
    const removed = runRoot(["rm", "-rf", "--", harness]);
    assert.equal(removed.status, 0, removed.stderr);
  }
}

function runContainerizedNon1000Parent() {
  if (builtImage === undefined) {
    return {
      status: 1,
      stdout: "",
      stderr: "GATEWAY_ROOTFUL_QUALITY_IMAGE_UNAVAILABLE\n"
    };
  }
  const orchestration = fixturePath("family-ai-rootful-quality-");
  mkdirSync(orchestration, { mode: 0o777 });
  chmodSync(orchestration, 0o777);
  try {
    const dockerWrapper = join(orchestration, "docker");
    writeFileSync(
      dockerWrapper,
      "#!/bin/sh\nexec /host-lib/ld-linux-x86-64.so.2 --library-path /host-lib /host-bin/docker \"$@\"\n",
      { mode: 0o755 }
    );
    chmodSync(dockerWrapper, 0o755);
    return docker([
      "run", "--rm",
      "--user", "0:0",
      "--group-add", dockerSocketGid(),
      "--cap-add", "SETUID",
      "--cap-add", "SETGID",
      "--network", "none",
      "--workdir", root,
      "--mount", `type=bind,src=${root},dst=${root},readonly`,
      "--mount", `type=bind,src=${orchestration},dst=${orchestration}`,
      "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
      "--mount", "type=bind,src=/usr/bin/docker,dst=/host-bin/docker,readonly",
      "--mount", "type=bind,src=/lib/x86_64-linux-gnu/libc.so.6,dst=/host-lib/libc.so.6,readonly",
      "--mount", "type=bind,src=/lib64/ld-linux-x86-64.so.2,dst=/host-lib/ld-linux-x86-64.so.2,readonly",
      "--mount", `type=bind,src=${dockerWrapper},dst=/quality-bin/docker,readonly`,
      "--entrypoint", "/usr/bin/setpriv",
      builtImage,
      "--reuid=1234",
      "--regid=1234",
      "--groups", dockerSocketGid(),
      "--inh-caps", "+setuid,+setgid",
      "--ambient-caps", "+setuid,+setgid",
      "--bounding-set", "+setuid,+setgid",
      "--",
      "env",
      `TMPDIR=${orchestration}`,
      "GATEWAY_ROOTFUL_NON1000_CHILD=1",
      "HOME=/tmp",
      "DOCKER_CONFIG=/tmp/family-ai-empty-docker-config",
      "PATH=/quality-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ...childTestArguments(root, "node")
    ], { timeout: 90_000 });
  } finally {
    rmSync(orchestration, { recursive: true, force: true });
  }
}

test("runs the full contention gate from a real uid1234 parent", {
  skip: process.env.GATEWAY_ROOTFUL_NON1000_CHILD === "1",
  timeout: 100_000
}, () => {
  const orchestrated = runRootOrchestratedNon1000Parent();
  const result = orchestrated ?? runContainerizedNon1000Parent();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /# pass 1\b/u);
  assert.match(result.stdout, /# fail 0\b/u);
});

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
  if (process.env.GATEWAY_ROOTFUL_NON1000_CHILD === "1") {
    assert.equal(process.getuid?.(), 1234);
    assert.equal(process.getgid?.(), 1234);
  }
  if (!requireHost1000Capability(context)) return;
  const directory = prepareFixture("family-ai-rootful-lock-", {
    files: {
      "gateway.sqlite": "fixture",
      ".family-ai-gateway.lock": ""
    }
  });
  const databasePath = join(directory, "gateway.sqlite");
  const hostProbePath = join(directory, "host-probe.sqlite");
  if (process.env.GATEWAY_ROOTFUL_NON1000_CHILD === "1") {
    const denied = spawnSync("python3", [
      "-c",
      "import errno,os,sys\ntry: os.close(os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW));print('READABLE');raise SystemExit(1)\nexcept PermissionError as error:\n print('EACCES' if error.errno==errno.EACCES else 'OTHER')",
      databasePath
    ], { encoding: "utf8" });
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(denied.stdout, "EACCES\n");
    assert.equal(denied.stderr, "");
  }
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

    assertProtectedFile(directory, ".family-ai-gateway.lock");
    assertProtectedFile(directory, "gateway.sqlite");
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
    assertProtectedDirectoryTree(runFixtureHelper("inspect", directory).tree);
    const migrate = docker([
      "run", "--rm", ...common(), builtImage,
      "node", "apps/gateway/dist/migrate.js", "--database", "/data/gateway.sqlite"
    ], { timeout: 30_000 });
    assert.equal(migrate.status, 0, migrate.stderr);
    assert.equal(migrate.stdout, '{"schemaVersion":15,"quickCheck":"ok","foreignKeyViolations":0}\n');
    assertProtectedFile(directory, "gateway.sqlite");
    assertProtectedFile(directory, ".family-ai-gateway.lock");
    assertProtectedFile(directory, "canvas.credential");

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
