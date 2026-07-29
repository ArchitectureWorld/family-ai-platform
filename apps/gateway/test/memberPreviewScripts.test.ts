import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const scripts = [
  "scripts/member-preview-up.sh",
  "scripts/member-preview-admin.mjs",
  "scripts/member-preview-pair.mjs",
  "scripts/member-preview-revoke.mjs",
  "scripts/member-preview-secret-audit.mjs",
  "scripts/member-preview-down.sh",
  "scripts/member-preview-claim-loss-proxy.mjs"
];

function read(relativePath: string): string {
  const path = join(root, relativePath);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const temporaryDirectories: string[] = [];
const childProcesses: ChildProcess[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-preview-lifecycle-"));
  temporaryDirectories.push(directory);
  return directory;
}

function executable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function lifecycleFixture(
  scriptName: "member-preview-up.sh" | "member-preview-down.sh",
  body?: string
): {
  root: string;
  script: string;
  env: NodeJS.ProcessEnv;
} {
  const fixture = temporaryDirectory();
  const fakeHome = join(fixture, "home");
  const approvedRoot = join(
    fakeHome,
    "Development",
    "family-ai-platform"
  );
  const scriptsDirectory = join(approvedRoot, "scripts");
  const binDirectory = join(fixture, "bin");
  mkdirSync(scriptsDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
  const localBin = join(fakeHome, ".local", "bin");
  const jarvisHome = join(fakeHome, ".hermes");
  const personalProfiles = join(fakeHome, "hermes-personal-assistants", "profiles");
  mkdirSync(localBin, { recursive: true, mode: 0o700 });
  mkdirSync(jarvisHome, { recursive: true, mode: 0o700 });
  mkdirSync(personalProfiles, { recursive: true, mode: 0o700 });
  writeFileSync(join(jarvisHome, "config.yaml"), "fixture: true\n", {
    mode: 0o600
  });
  for (const profile of ["zzh", "nsy", "zzg"]) {
    mkdirSync(join(personalProfiles, profile), { mode: 0o700 });
  }
  executable(join(localBin, "hermes"), "#!/usr/bin/env bash\nexit 0\n");
  executable(join(localBin, "codex"), "#!/usr/bin/env bash\nexit 0\n");
  const branch = spawnSync(
    "git",
    ["init", "-q", "-b", "main"],
    { cwd: approvedRoot, encoding: "utf8" }
  );
  if (branch.status !== 0) throw new Error("FIXTURE_GIT_INIT_FAILED");

  executable(
    join(binDirectory, "hostname"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"${FAKE_HOST:-Admin-YR}\"\n"
  );
  executable(
    join(binDirectory, "id"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"${FAKE_USER:-youran}\"\n"
  );
  executable(
    join(binDirectory, "getent"),
    "#!/usr/bin/env bash\nprintf '%s:x:1000:1000::%s:/bin/bash\\n' \"${2:-youran}\" \"$FAKE_HOME\"\n"
  );
  executable(join(binDirectory, "ss"), "#!/usr/bin/env bash\nexit 0\n");

  const original = read(`scripts/${scriptName}`);
  let source = original;
  if (body !== undefined) {
    const marker = scriptName === "member-preview-up.sh"
      ? "\nSUCCESS=0\n"
      : '\n[[ -e "$RUNTIME_DIR" ]] || exit 0\n';
    const end = original.indexOf(marker);
    if (end < 0) throw new Error("LIFECYCLE_LIBRARY_MARKER_MISSING");
    source = `${original.slice(0, end)}\n${body}\n`;
  }
  const script = join(scriptsDirectory, scriptName);
  executable(script, source);
  return {
    root: approvedRoot,
    script,
    env: {
      ...process.env,
      FAKE_HOME: fakeHome,
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`
    }
  };
}

function runFixture(
  fixture: ReturnType<typeof lifecycleFixture>
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [fixture.script], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: "utf8"
  });
}

function permissions(path: string): number {
  return statSync(path).mode & 0o777;
}

function processStarttime(pid: number): string {
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  return value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/u)[19] ?? "";
}

const fixtureOrigin = "http://127.0.0.1:45678";

function fixtureToken(character: string): string {
  return `${character.repeat(42)}A`;
}

function installAdminFixture(runtimeDir: string, origin = fixtureOrigin) {
  const configDir = join(runtimeDir, "config");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const admin = {
    version: 1,
    origin,
    familyRef: "family:preview-test",
    personRef: "person:preview-test",
    deviceRef: "device:preview-admin",
    entryBindingRef: "entry-binding:preview-admin",
    entrySessionRef: "entry-session:preview-admin",
    token: fixtureToken("A")
  };
  writeFileSync(
    join(configDir, "admin-entry.json"),
    `${JSON.stringify(admin)}\n`,
    { mode: 0o600 }
  );
  writeFileSync(
    join(configDir, "device-token"),
    `${fixtureToken("B")}\n`,
    { mode: 0o600 }
  );
  return admin;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function adminContext(admin: ReturnType<typeof installAdminFixture>) {
  return {
    protocolVersion: 1,
    audience: "family_admin",
    entrySessionRef: admin.entrySessionRef,
    entryBindingRef: admin.entryBindingRef,
    family: { familyRef: admin.familyRef, displayName: "Preview Family" },
    person: { personRef: admin.personRef, displayName: "Preview Person" },
    membership: { familyRole: "owner" },
    device: {
      deviceRef: admin.deviceRef,
      displayName: "Preview Admin",
      terminalType: "desktop",
      platform: "linux"
    },
    agent: {
      assignmentRef: "assignment:preview-admin",
      assignmentType: "family",
      agentRef: "agent:family-manager",
      displayName: "Family Manager",
      providerProfileRef: null
    }
  };
}

function initializedAdminFetch(
  admin: ReturnType<typeof installAdminFixture>,
  extra?: (
    url: URL,
    init: RequestInit,
    body: any
  ) => Response | Promise<Response> | undefined
) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (url.pathname === "/api/v1/onboarding/status") {
      return jsonResponse({ initialized: true });
    }
    if (url.pathname === "/api/v1/portal/context") {
      return jsonResponse(adminContext(admin));
    }
    const delegated = await extra?.(url, init, body);
    if (delegated) return delegated;
    throw new Error(`UNEXPECTED_PREVIEW_REQUEST:${init.method ?? "GET"}:${url.pathname}`);
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("READY_FILE_TIMEOUT");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("isolated Member Web Preview scripts", () => {
  it.each(scripts)("provides %s", relativePath => {
    expect(existsSync(join(root, relativePath))).toBe(true);
  });

  it.each([".gitignore", ".dockerignore"])(
    "ignores the protected runtime in %s",
    relativePath => {
      expect(read(relativePath).split("\n")).toContain(".runtime-preview/");
    }
  );

  it("pins Preview startup to the approved dynamic boundary and loopback ports", () => {
    const up = read("scripts/member-preview-up.sh");
    const forbiddenStaticHome = ["/home", "youran", ""].join("/");
    expect(up).toContain('hostname -s');
    expect(up).toContain('id -un');
    expect(up).toContain('getent passwd');
    expect(up).toContain('$REMOTE_USER_HOME/Development/family-ai-platform');
    expect(up).toContain('branch --show-current)" == "main"');
    expect(up).not.toContain('family-ai-platform-worktrees');
    expect(up).toContain('127.0.0.1');
    expect(up).toContain('8791');
    expect(up).toContain('8792');
    expect(up).toContain('umask 077');
    expect(up).toContain('memberPublicSha256');
    expect(up).not.toContain(forbiddenStaticHome);
    expect(up).not.toContain('0.0.0.0');
    expect(up).not.toContain('GATEWAY_PORT=8790');
    expect(up).not.toContain('docker compose');
    expect(up).not.toContain('dev-reset');
    expect(up).toContain('wait_health http://127.0.0.1:8791 1200');
  });

  it("discovers explicit real Provider inputs into the protected Gateway config", () => {
    const up = read("scripts/member-preview-up.sh");
    for (const key of [
      "FAMILY_AI_PROVIDER_MODE",
      "FAMILY_AI_HERMES_EXECUTABLE",
      "FAMILY_AI_HERMES_JARVIS_HOME",
      "FAMILY_AI_HERMES_PERSONAL_HOME",
      "FAMILY_AI_HERMES_PROFILES",
      "FAMILY_AI_CODEX_EXECUTABLE",
      "FAMILY_AI_CODEX_WORKING_DIRECTORY"
    ]) {
      expect(up).toContain(key);
    }
    expect(up).toContain("PREVIEW_PROVIDER_DISCOVERY_FAILED");
    expect(up).not.toMatch(/\b(?:echo|printf)\b[^\n]*(?:HERMES|CODEX)_[A-Z_]*PATH/);
  });

  it("ships Admin assets without copying host Provider state into the runtime image", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain(
      "/app/apps/gateway/admin-public /app/apps/gateway/admin-public"
    );
    for (const forbidden of [
      ".hermes",
      "hermes-personal-assistants",
      ".local/bin/codex",
      ".local/bin/hermes"
    ]) {
      expect(dockerfile).not.toContain(forbidden);
    }
  });

  it("uses PID-scoped fail-closed shutdown without production controls", () => {
    const down = read("scripts/member-preview-down.sh");
    expect(down).toContain('gateway.pid.json');
    expect(down).toContain('claim-loss-proxy.pid.json');
    expect(down).toContain('/proc/');
    expect(down).toContain('starttime');
    expect(down).toContain('ss -H -ltnp');
    expect(down).toContain("signal.pidfd_send_signal");
    expect(down).not.toContain('8790');
    expect(down).not.toMatch(/\b(?:pkill|killall)\b/);
    expect(down).not.toContain('docker');
  });

  it("pins every lifecycle TERM and exit wait to a pidfd", () => {
    const lifecycle = [
      read("scripts/member-preview-up.sh"),
      read("scripts/member-preview-down.sh")
    ].join("\n");
    expect(lifecycle).not.toMatch(/\bkill\s+-TERM\b/);
    expect(lifecycle.match(/os\.pidfd_open/g)?.length).toBe(2);
    expect(lifecycle.match(/signal\.pidfd_send_signal/g)?.length).toBe(2);
    expect(lifecycle.match(/select\.poll/g)?.length).toBe(2);
  });

  it("revalidates the original PID and starttime after owned health succeeds", () => {
    const up = read("scripts/member-preview-up.sh");
    for (const state of ["gateway_state", "proxy_state"]) {
      const stateStart = up.indexOf(`case "$${state}" in`);
      const start = up.indexOf("owned-match)", stateStart);
      const end = up.indexOf("owned-mismatch)", start);
      const branch = start >= 0 && end > start ? up.slice(start, end) : "";
      const health = branch.indexOf("wait_health");
      const manifest = branch.indexOf("manifest_status");
      const process = branch.indexOf("raw_pid_owned");
      expect(health).toBeGreaterThanOrEqual(0);
      expect(manifest).toBeGreaterThan(health);
      expect(process).toBeGreaterThan(manifest);
      expect(branch).toContain("starttime");
    }
  });

  // BuildKit has its own PID namespace; the host quality gate still runs this lifecycle test.
  it.skipIf(process.env.FAMILY_AI_CONTAINER_BUILD === "1")("uses pidfd validation and signaling against a real OS-assigned listener", async () => {
    const match = read("scripts/member-preview-up.sh").match(
      /<<'PYTHON'\n([\s\S]*?)\nPYTHON/
    );
    expect(match?.[1]).toBeTruthy();
    const original = match?.[1] ?? "";
    const helper = original.replace(
      'expected_port = 8791 if kind == "gateway" else 8792',
      "expected_port = port"
    );
    expect(helper).not.toBe(original);

    const fixture = temporaryDirectory();
    const entrypoint = "apps/gateway/dist/index.js";
    const entryPath = join(fixture, entrypoint);
    const readyPath = join(fixture, "ready");
    mkdirSync(join(fixture, "apps/gateway/dist"), { recursive: true });
    writeFileSync(
      entryPath,
      [
        'import { createServer } from "node:http";',
        'import { writeFileSync } from "node:fs";',
        "const server = createServer((_request, response) => response.end('ok'));",
        "server.listen(0, '127.0.0.1', () => {",
        "  const address = server.address();",
        "  if (!address || typeof address === 'string') process.exit(2);",
        "  writeFileSync(process.env.READY_FILE, String(address.port));",
        "});"
      ].join("\n")
    );
    const child = spawn(process.execPath, [entrypoint], {
      cwd: fixture,
      env: { ...process.env, READY_FILE: readyPath },
      stdio: "ignore"
    });
    childProcesses.push(child);
    await waitForFile(readyPath);
    const pid = child.pid;
    if (pid === undefined) throw new Error("PID_MISSING");
    const port = Number(readFileSync(readyPath, "utf8"));
    const starttime = processStarttime(pid);
    const manifest = join(fixture, "gateway.pid.json");
    writeFileSync(manifest, `${JSON.stringify({ pid, starttime })}\n`, { mode: 0o600 });
    chmodSync(manifest, 0o600);

    const rejected = spawnSync(
      "python3",
      ["-", String(pid), starttime, "gateway", entrypoint, String(port), fixture, manifest],
      { input: helper, encoding: "utf8" }
    );
    expect(rejected.status).not.toBe(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(existsSync(manifest)).toBe(true);
    writeFileSync(manifest, `${JSON.stringify({
      version: 1,
      kind: "gateway",
      pid,
      starttime,
      cwd: fixture,
      entrypoint,
      host: "127.0.0.1",
      port,
      launchCommit: "a".repeat(40),
      distSha256: "b".repeat(64),
      memberPublicSha256: "c".repeat(64),
      configSha256: "d".repeat(64)
    })}\n`, { mode: 0o600 });
    chmodSync(manifest, 0o600);

    const stopped = spawnSync(
      "python3",
      ["-", String(pid), starttime, "gateway", entrypoint, String(port), fixture, manifest],
      { input: helper, encoding: "utf8" }
    );
    expect(stopped.status).toBe(0);
    expect(existsSync(manifest)).toBe(false);
  });

  it("tightens the complete reused runtime and writes protected files atomically", () => {
    const fixture = lifecycleFixture(
      "member-preview-up.sh",
      [
        "prepare_runtime",
        "prepare_config",
        "write_manifest \"$RUN_DIR/test.pid.json\" '{\"ok\":true}'",
        "atomic_text_file \"$RUN_DIR/test.snapshot\" 'snapshot'",
        "printf 'LIFECYCLE_FIXTURE_PASS\\n'"
      ].join("\n")
    );
    const runtime = join(fixture.root, ".runtime-preview");
    const directories = ["", "config", "data", "run", "logs"].map(path =>
      join(runtime, path)
    );
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true });
      chmodSync(directory, 0o777);
    }
    const reusedFiles = [
      "config/admin-entry.json",
      "config/pairing-target-8791.json",
      "config/pairing-target-8792.json",
      "config/member-web-url-8791",
      "config/member-web-url-8792",
      "run/gateway.pid.json",
      "run/claim-loss-proxy.pid.json",
      "run/claim-loss-state.json",
      "run/baseline-8790.snapshot",
      "logs/gateway.log",
      "logs/claim-loss-proxy.log",
      "data/gateway.sqlite",
      "data/gateway.sqlite-wal",
      "data/gateway.sqlite-shm"
    ].map(path => join(runtime, path));
    for (const path of reusedFiles) {
      writeFileSync(path, "fixture\n");
      chmodSync(path, 0o666);
    }

    const result = runFixture(fixture);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("LIFECYCLE_FIXTURE_PASS\n");
    expect(result.stderr).toBe("");
    for (const directory of directories) expect(permissions(directory)).toBe(0o700);
    for (const path of [
      ...reusedFiles,
      join(runtime, "config/device-token"),
      join(runtime, "config/gateway.env"),
      join(runtime, "run/test.pid.json"),
      join(runtime, "run/test.snapshot")
    ]) expect(permissions(path)).toBe(0o600);
    const gatewayEnvironment = readFileSync(
      join(runtime, "config/gateway.env"),
      "utf8"
    ).trimEnd().split("\n");
    expect(gatewayEnvironment.map(line => line.slice(0, line.indexOf("=")))).toEqual([
      "GATEWAY_MODE",
      "GATEWAY_HOST",
      "GATEWAY_PORT",
      "GATEWAY_DATABASE_PATH",
      "GATEWAY_DEVICE_TOKEN",
      "GATEWAY_PREVIEW_ADMIN_ENTRY_PATH",
      "GATEWAY_PREVIEW_ADMIN_ORIGIN",
      "FAMILY_AI_PROVIDER_MODE",
      "FAMILY_AI_HERMES_EXECUTABLE",
      "FAMILY_AI_HERMES_JARVIS_HOME",
      "FAMILY_AI_HERMES_PERSONAL_HOME",
      "FAMILY_AI_HERMES_PROFILES",
      "FAMILY_AI_CODEX_EXECUTABLE",
      "FAMILY_AI_CODEX_WORKING_DIRECTORY"
    ]);
    expect(gatewayEnvironment).toContain("FAMILY_AI_PROVIDER_MODE=real");
    expect(gatewayEnvironment).toContain("FAMILY_AI_HERMES_PROFILES=nsy,zzg,zzh");
    expect(gatewayEnvironment.some(line =>
      line.startsWith("FAMILY_AI_HERMES_MODEL=")
    )).toBe(false);
    expect(gatewayEnvironment.some(line =>
      line.startsWith("FAMILY_AI_HERMES_PROVIDER=")
    )).toBe(false);
    expect(
      ["config", "run"].flatMap(directory =>
        readdirSync(join(runtime, directory)).filter(name => name.includes(".tmp."))
      )
    ).toEqual([]);
  });

  it("fails closed on reused symlinks, non-regular SQLite files and atomic targets", () => {
    const symlinkFixture = lifecycleFixture(
      "member-preview-up.sh",
      "prepare_runtime"
    );
    const symlinkRuntime = join(symlinkFixture.root, ".runtime-preview");
    mkdirSync(join(symlinkRuntime, "config"), { recursive: true });
    const victim = join(symlinkFixture.root, "victim");
    writeFileSync(victim, "unchanged\n");
    symlinkSync(victim, join(symlinkRuntime, "config/admin-entry.json"));
    const symlinkResult = runFixture(symlinkFixture);
    expect(symlinkResult.status).not.toBe(0);
    expect(symlinkResult.stderr).toContain("PREVIEW_RUNTIME_INVALID");
    expect(readFileSync(victim, "utf8")).toBe("unchanged\n");

    const fifoFixture = lifecycleFixture(
      "member-preview-up.sh",
      "prepare_runtime"
    );
    const fifoData = join(fifoFixture.root, ".runtime-preview/data");
    mkdirSync(fifoData, { recursive: true });
    const fifo = spawnSync("mkfifo", [join(fifoData, "gateway.sqlite-wal")]);
    if (fifo.status !== 0) throw new Error("MKFIFO_FAILED");
    const fifoResult = runFixture(fifoFixture);
    expect(fifoResult.status).not.toBe(0);
    expect(fifoResult.stderr).toContain("PREVIEW_RUNTIME_INVALID");

    const atomicFixture = lifecycleFixture(
      "member-preview-up.sh",
      [
        "prepare_runtime",
        "atomic_text_file \"$RUN_DIR/atomic-target\" 'replacement'"
      ].join("\n")
    );
    const atomicRun = join(atomicFixture.root, ".runtime-preview/run");
    mkdirSync(atomicRun, { recursive: true });
    const atomicVictim = join(atomicFixture.root, "atomic-victim");
    writeFileSync(atomicVictim, "preserved\n");
    symlinkSync(atomicVictim, join(atomicRun, "atomic-target"));
    const atomicResult = runFixture(atomicFixture);
    expect(atomicResult.status).not.toBe(0);
    expect(atomicResult.stderr).toContain("PREVIEW_ATOMIC_WRITE_FAILED");
    expect(readFileSync(atomicVictim, "utf8")).toBe("preserved\n");
  });

  it("tightens the full reused runtime before a no-manifest down", () => {
    const fixture = lifecycleFixture("member-preview-down.sh");
    const runtime = join(fixture.root, ".runtime-preview");
    const directories = ["", "config", "data", "run", "logs"].map(path =>
      join(runtime, path)
    );
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true });
      chmodSync(directory, 0o777);
    }
    const protectedFiles = [
      "config/device-token",
      "config/gateway.env",
      "config/admin-entry.json",
      "config/pairing-target-8791.json",
      "config/pairing-target-8792.json",
      "config/member-web-url-8791",
      "config/member-web-url-8792",
      "run/claim-loss-state.json",
      "logs/gateway.log",
      "logs/claim-loss-proxy.log",
      "data/gateway.sqlite",
      "data/gateway.sqlite-wal"
    ].map(path => join(runtime, path));
    for (const path of protectedFiles) {
      writeFileSync(path, "fixture\n");
      chmodSync(path, 0o666);
    }
    const result = runFixture(fixture);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Member Preview down: PASS\n");
    for (const directory of directories) expect(permissions(directory)).toBe(0o700);
    for (const path of protectedFiles) expect(permissions(path)).toBe(0o600);
  });


  it("executes stale, live, malformed and lockId-protected start-lock cleanup", () => {
    const stale = lifecycleFixture("member-preview-up.sh", [
      "prepare_runtime",
      "acquire_start_lock",
      "release_start_lock",
      "printf 'STALE_LOCK_RECOVERED\\n'"
    ].join("\n"));
    const staleRun = join(stale.root, ".runtime-preview/run");
    const staleLock = join(staleRun, "start.lock");
    mkdirSync(staleLock, { recursive: true, mode: 0o700 });
    writeFileSync(join(staleLock, "owner.json"), `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      starttime: "1",
      cwd: stale.root,
      lockId: "00000000-0000-4000-8000-000000000001"
    })}\n`, { mode: 0o600 });
    const staleResult = runFixture(stale);
    expect(staleResult.status).toBe(0);
    expect(staleResult.stdout).toBe("STALE_LOCK_RECOVERED\n");
    expect(existsSync(staleLock)).toBe(false);
    expect(
      readdirSync(staleRun).filter(name => name.startsWith("start.lock.stale."))
    ).toHaveLength(1);

    const live = lifecycleFixture("member-preview-up.sh", [
      "prepare_runtime",
      "acquire_start_lock"
    ].join("\n"));
    const liveProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: live.root,
      stdio: "ignore"
    });
    childProcesses.push(liveProcess);
    if (!liveProcess.pid) throw new Error("LIVE_LOCK_PID_MISSING");
    const liveLock = join(live.root, ".runtime-preview/run/start.lock");
    mkdirSync(liveLock, { recursive: true, mode: 0o700 });
    writeFileSync(join(liveLock, "owner.json"), `${JSON.stringify({
      version: 1,
      pid: liveProcess.pid,
      starttime: processStarttime(liveProcess.pid),
      cwd: live.root,
      lockId: "00000000-0000-4000-8000-000000000002"
    })}\n`, { mode: 0o600 });
    const liveResult = runFixture(live);
    expect(liveResult.status).not.toBe(0);
    expect(liveResult.stderr).toContain("PREVIEW_START_BUSY");

    const malformed = lifecycleFixture("member-preview-up.sh", [
      "prepare_runtime",
      "acquire_start_lock"
    ].join("\n"));
    const malformedLock = join(
      malformed.root,
      ".runtime-preview/run/start.lock"
    );
    mkdirSync(malformedLock, { recursive: true, mode: 0o700 });
    writeFileSync(join(malformedLock, "owner.json"), "{}\n", { mode: 0o600 });
    const malformedResult = runFixture(malformed);
    expect(malformedResult.status).not.toBe(0);
    expect(malformedResult.stderr).toContain("PREVIEW_START_LOCK_AMBIGUOUS");

    const lockId = lifecycleFixture("member-preview-up.sh", [
      "prepare_runtime",
      "acquire_start_lock",
      "node -e 'const fs=require(\"node:fs\");const p=process.argv[1];const v=JSON.parse(fs.readFileSync(p));v.lockId=\"00000000-0000-4000-8000-000000000099\";fs.writeFileSync(p,JSON.stringify(v)+\"\\\\n\")' \"$START_LOCK_DIR/owner.json\"",
      "release_start_lock",
      "[[ -f \"$START_LOCK_DIR/owner.json\" ]]",
      "printf 'LOCK_ID_PRESERVED\\n'"
    ].join("\n"));
    const lockIdResult = runFixture(lockId);
    expect(lockIdResult.status).not.toBe(0);
    expect(lockIdResult.stdout).toBe("");
    expect(existsSync(join(
      lockId.root, ".runtime-preview/run/start.lock/owner.json"
    ))).toBe(true);
  });

  it("initializes one admin under concurrency and fails closed on missing or stale state", async () => {
    const { loadOrInitializePreviewAdmin } = await import(
      `${new URL("../../../scripts/member-preview-pair.mjs", import.meta.url).href}?admin=${Date.now()}`
    );
    const runtimeDir = temporaryDirectory();
    const configDir = join(runtimeDir, "config");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDir, "device-token"), `${fixtureToken("B")}\n`, {
      mode: 0o600
    });
    let initialized = false;
    let onboardingCalls = 0;
    let statusCalls = 0;
    let releaseFirstStatus!: () => void;
    const firstStatusGate = new Promise<void>(resolve => {
      releaseFirstStatus = resolve;
    });
    const onboardingAdmin = {
      version: 1,
      origin: fixtureOrigin,
      familyRef: "family:preview-test",
      personRef: "person:preview-test",
      deviceRef: "device:preview-admin",
      entryBindingRef: "entry-binding:preview-admin",
      entrySessionRef: "entry-session:preview-admin",
      token: fixtureToken("A")
    };
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/onboarding/status") {
        statusCalls += 1;
        if (statusCalls === 1) {
          await firstStatusGate;
        }
        return jsonResponse({ initialized });
      }
      if (url.pathname === "/api/v1/onboarding/family") {
        onboardingCalls += 1;
        initialized = true;
        return jsonResponse({
          family: {
            familyRef: onboardingAdmin.familyRef,
            displayName: "Preview Family",
            status: "active"
          },
          owner: {
            personRef: onboardingAdmin.personRef,
            displayName: "Preview Person",
            status: "active"
          },
          device: {
            deviceRef: onboardingAdmin.deviceRef,
            displayName: "Preview Admin",
            status: "active"
          },
          entries: {
            admin: {
              entryBindingRef: onboardingAdmin.entryBindingRef,
              entrySessionRef: onboardingAdmin.entrySessionRef,
              token: onboardingAdmin.token,
              audience: "family_admin",
              agentRef: "agent:family-manager"
            },
            personal: {
              entryBindingRef: "entry-binding:preview-personal",
              entrySessionRef: "entry-session:preview-personal",
              token: fixtureToken("P"),
              audience: "personal",
              agentRef: "agent:personal-assistant"
            }
          }
        }, 201);
      }
      if (url.pathname === "/api/v1/portal/context") {
        return jsonResponse(adminContext(onboardingAdmin));
      }
      throw new Error(`UNEXPECTED_ADMIN_REQUEST:${url.pathname}`);
    };
    const first = loadOrInitializePreviewAdmin({
      origin: fixtureOrigin,
      runtimeDir,
      fetchImpl
    });
    await waitForFile(join(
      runtimeDir, "run/admin-init.lock/owner.json"
    ));
    const second = loadOrInitializePreviewAdmin({
      origin: fixtureOrigin,
      runtimeDir,
      fetchImpl
    });
    releaseFirstStatus();
    const results = await Promise.all([first, second]);
    expect(onboardingCalls).toBe(1);
    expect(results[0]).toEqual(results[1]);

    const missingRuntime = temporaryDirectory();
    await expect(loadOrInitializePreviewAdmin({
      origin: fixtureOrigin,
      runtimeDir: missingRuntime,
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/onboarding/status") {
          return jsonResponse({ initialized: true });
        }
        throw new Error("MISSING_ADMIN_MUST_NOT_CONTINUE");
      }
    })).rejects.toBeTruthy();

    const staleRuntime = temporaryDirectory();
    const staleAdmin = installAdminFixture(
      staleRuntime,
      "http://127.0.0.1:45679"
    );
    await expect(loadOrInitializePreviewAdmin({
      origin: fixtureOrigin,
      runtimeDir: staleRuntime,
      fetchImpl: initializedAdminFetch(staleAdmin)
    })).rejects.toBeTruthy();
  });

  it("writes protected bootstrap and initialized Admin Web handoffs without exposing credentials", async () => {
    const { createAdminPreviewHandoff } = await import(
      `${new URL("../../../scripts/member-preview-admin.mjs", import.meta.url).href}?admin-handoff=${Date.now()}`
    );
    const lanOrigin = "https://192.168.110.84:9443";

    const newRuntime = temporaryDirectory();
    const newConfig = join(newRuntime, "config");
    mkdirSync(newConfig, { recursive: true, mode: 0o700 });
    const bootstrapToken = fixtureToken("B");
    writeFileSync(join(newConfig, "device-token"), `${bootstrapToken}\n`, {
      mode: 0o600
    });
    const victim = join(newRuntime, "must-not-change");
    writeFileSync(victim, "safe\n", { mode: 0o600 });
    symlinkSync(victim, join(newConfig, "admin-web-url-9443"));
    let onboardingCalls = 0;
    const bootstrapPath = await createAdminPreviewHandoff({
      origin: lanOrigin,
      gatewayOrigin: fixtureOrigin,
      runtimeDir: newRuntime,
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/onboarding/status") {
          return jsonResponse({ initialized: false });
        }
        onboardingCalls += 1;
        throw new Error("BOOTSTRAP_HANDOFF_MUST_NOT_INITIALIZE");
      }
    });
    expect(onboardingCalls).toBe(0);
    expect(bootstrapPath).toBe(join(newConfig, "admin-web-url-9443"));
    expect(permissions(bootstrapPath)).toBe(0o600);
    expect(readFileSync(victim, "utf8")).toBe("safe\n");
    expect(readFileSync(bootstrapPath, "utf8")).toBe(
      `${lanOrigin}/admin/#deviceRef=device%3Atest&bootstrapToken=${bootstrapToken}\n`
    );

    const initializedRuntime = temporaryDirectory();
    const admin = installAdminFixture(initializedRuntime);
    const initializedPath = await createAdminPreviewHandoff({
      origin: lanOrigin,
      gatewayOrigin: fixtureOrigin,
      runtimeDir: initializedRuntime,
      fetchImpl: initializedAdminFetch(admin)
    });
    expect(permissions(initializedPath)).toBe(0o600);
    expect(readFileSync(initializedPath, "utf8")).toBe(
      `${lanOrigin}/admin/#entrySessionRef=entry-session%3Apreview-admin&token=${admin.token}\n`
    );

    for (const origin of [
      "http://192.168.110.84:9443",
      "https://127.0.0.1:9443",
      "https://8.8.8.8:9443",
      "https://192.168.110.84:443",
      "https://user@192.168.110.84:9443",
      "https://192.168.110.84:9443/path",
      "https://192.168.110.84:9443/?query=1",
      "https://192.168.110.84:9443/#fragment"
    ]) {
      await expect(createAdminPreviewHandoff({
        origin,
        gatewayOrigin: fixtureOrigin,
        runtimeDir: initializedRuntime,
        fetchImpl: initializedAdminFetch(admin)
      }), origin).rejects.toBeTruthy();
    }
  });

  it("writes only durable long-lived Pair material and rearms consumed 8792 state", async () => {
    const { createMemberPreviewPairing } = await import(
      `${new URL("../../../scripts/member-preview-pair.mjs", import.meta.url).href}?pair=${Date.now()}`
    );
    const runtimeDir = temporaryDirectory();
    const admin = installAdminFixture(runtimeDir);
    let pairingCount = 0;
    let lifetime = 300_000;
    const fetchImpl = initializedAdminFetch(admin, (url, init) => {
      if (
        url.pathname.endsWith("/pairing-codes") &&
        init.method === "POST"
      ) {
        pairingCount += 1;
        const pairingRef = `pairing:preview-${pairingCount}`;
        const code = pairingCount === 1 ? "ABCD-EFGH" : "JKLM-NPQR";
        const expiresAt = new Date(Date.now() + lifetime).toISOString();
        return jsonResponse({
          protocolVersion: 1,
          pairing: { pairingRef, code, expiresAt, status: "active" },
          family: { displayName: "Preview Family" },
          person: { displayName: "Preview Person" },
          qr: {
            payload: {
              version: 1,
              gateway: fixtureOrigin,
              pairingRef,
              code,
              expiresAt
            },
            url: `${fixtureOrigin}/member/`
          }
        }, 201);
      }
      return undefined;
    });
    const handoff8791 = await createMemberPreviewPairing({
      port: 8791,
      origin: fixtureOrigin,
      runtimeDir,
      fetchImpl
    });
    expect(permissions(handoff8791)).toBe(0o600);
    expect(readFileSync(handoff8791, "utf8")).toContain("ABCD-EFGH");
    const metadata8791 = JSON.parse(readFileSync(
      join(runtimeDir, "config/pairing-target-8791.json"),
      "utf8"
    ));
    expect(metadata8791).toEqual({
      protocolVersion: 2,
      pairingRef: "pairing:preview-1",
      expiresAt: expect.any(String)
    });
    expect(metadata8791).not.toHaveProperty("code");

    const consumedState = join(runtimeDir, "run/claim-loss-state.json");
    mkdirSync(join(runtimeDir, "run"), { recursive: true, mode: 0o700 });
    writeFileSync(consumedState, `${JSON.stringify({
      version: 1,
      state: "consumed",
      requestId: "request:preview",
      timestamp: new Date().toISOString()
    })}\n`, { mode: 0o600 });
    const handoff8792 = await createMemberPreviewPairing({
      port: 8792,
      origin: fixtureOrigin,
      runtimeDir,
      fetchImpl
    });
    expect(existsSync(consumedState)).toBe(false);
    expect(permissions(handoff8792)).toBe(0o600);

    const shortRuntime = temporaryDirectory();
    const shortAdmin = installAdminFixture(shortRuntime);
    lifetime = 239_000;
    await expect(createMemberPreviewPairing({
      port: 8791,
      origin: fixtureOrigin,
      runtimeDir: shortRuntime,
      fetchImpl: initializedAdminFetch(shortAdmin, (url, init) =>
        fetchImpl(url, init)
      )
    })).rejects.toMatchObject({ code: "PREVIEW_PAIRING_TOO_SHORT" });
    expect(existsSync(
      join(shortRuntime, "config/pairing-target-8791.json")
    )).toBe(false);
    expect(existsSync(
      join(shortRuntime, "config/member-web-url-8791")
    )).toBe(false);
  });

  it("reads the revoke target from a real readonly SQLite database without mutation", async () => {
    const { revokeMemberPreviewDevice } = await import(
      `${new URL("../../../scripts/member-preview-revoke.mjs", import.meta.url).href}?revoke=${Date.now()}`
    );
    const runtimeDir = temporaryDirectory();
    const admin = installAdminFixture(runtimeDir);
    const dataDir = join(runtimeDir, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const pairingRef = "pairing:preview-revoke";
    writeFileSync(
      join(runtimeDir, "config/pairing-target-8791.json"),
      `${JSON.stringify({
        protocolVersion: 2,
        pairingRef,
        expiresAt: new Date(Date.now() + 300_000).toISOString()
      })}\n`,
      { mode: 0o600 }
    );
    const databasePath = join(dataDir, "gateway.sqlite");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE mobile_pairing_codes (
        pairing_ref TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        consumed_device_ref TEXT,
        family_ref TEXT NOT NULL,
        person_ref TEXT NOT NULL
      );
      CREATE TABLE managed_devices (
        device_ref TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        terminal_type TEXT NOT NULL,
        platform TEXT NOT NULL
      );
      CREATE TABLE device_bindings (
        device_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        family_ref TEXT NOT NULL,
        person_ref TEXT NOT NULL,
        owner_scope TEXT NOT NULL
      );
    `);
    database.prepare(
      "INSERT INTO mobile_pairing_codes VALUES (?, ?, ?, ?, ?)"
    ).run(pairingRef, "consumed", "device:preview-web", admin.familyRef, admin.personRef);
    database.prepare(
      "INSERT INTO managed_devices VALUES (?, ?, ?, ?)"
    ).run("device:preview-web", "active", "web", "browser");
    database.prepare(
      "INSERT INTO device_bindings VALUES (?, ?, ?, ?, ?)"
    ).run("device:preview-web", "active", admin.familyRef, admin.personRef, "person");
    database.close();
    chmodSync(databasePath, 0o600);
    const before = createHash("sha256")
      .update(readFileSync(databasePath))
      .digest("hex");
    let deletedPath = "";
    await revokeMemberPreviewDevice({
      port: 8791,
      origin: fixtureOrigin,
      runtimeDir,
      fetchImpl: initializedAdminFetch(admin, (url, init) => {
        if (init.method === "DELETE") {
          deletedPath = url.pathname;
          return jsonResponse({ protocolVersion: 1, status: "revoked" });
        }
        return undefined;
      })
    });
    const after = createHash("sha256")
      .update(readFileSync(databasePath))
      .digest("hex");
    expect(deletedPath).toBe("/api/v1/admin/devices/device%3Apreview-web");
    expect(after).toBe(before);
  });
  it("keeps Pair, revoke and audit outputs secret-safe", () => {
    const pair = read("scripts/member-preview-pair.mjs");
    const revoke = read("scripts/member-preview-revoke.mjs");
    const audit = read("scripts/member-preview-secret-audit.mjs");

    expect(pair).toContain('loadOrInitializePreviewAdmin');
    expect(pair).toContain('writeMemberHandoff');
    expect(pair).toContain('240000');
    expect(pair).not.toMatch(/console\.(?:log|info)\([^)]*(?:code|token|pairingRef)/);

    expect(revoke).toContain('readonly: true');
    expect(revoke).toContain('fileMustExist: true');
    expect(revoke).toContain('WHERE p.pairing_ref = ?');
    expect(revoke).toContain('Preview Web Device revoke: PASS');
    expect(revoke).not.toMatch(/\b(?:UPDATE|INSERT|REPLACE|DELETE FROM)\b/i);

    expect(audit).toContain('Preview secret audit: PASS');
    expect(audit).toContain('FAIL PUBLIC_ERROR');
    expect(audit).toContain('FAIL GATEWAY_LOG');
    expect(audit).toContain('FAIL PROXY_LOG');
  });
});
