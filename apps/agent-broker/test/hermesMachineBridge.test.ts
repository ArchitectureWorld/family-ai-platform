import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runControlledProcess } from "@family-ai/provider-adapter-sdk";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  try {
    for (const path of directories) {
      await expect(access(join(path, "unexpected-network"))).rejects.toThrow();
    }
  } finally {
    await Promise.all(directories.map((path) => rm(path, { force: true, recursive: true })));
  }
});

async function copyIsolatedBridge(
  source: string,
  entrypoint: string,
  fakeDirectBackend = false
): Promise<void> {
  await copyFile(source, join(dirname(entrypoint), "bridge_under_test.py"));
  await writeFile(entrypoint, `
import os
import json
from pathlib import Path
import sys
import bridge_under_test as bridge

# Keep a reintroduced legacy global Home within the fixture during regressions.
if hasattr(bridge, "BROKER_HERMES_HOME"):
    bridge.BROKER_HERMES_HOME = Path(os.environ["HERMES_HOME"])
def deny_network(*args, **kwargs):
    Path(__file__).with_name("unexpected-network").write_text("blocked", encoding="utf-8")
    raise RuntimeError("network disabled in bridge tests")
def fake_direct(request, timeout):
    payload = json.loads(request.data.decode("utf-8"))
    capture = Path(__file__).with_name("direct-requests.json")
    requests = json.loads(capture.read_text(encoding="utf-8")) if capture.exists() else []
    requests.append({"url": request.full_url, "model": payload["model"], "messages": payload["messages"]})
    capture.write_text(json.dumps(requests), encoding="utf-8")
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self, limit):
            return b'{"choices":[{"message":{"content":"fake direct reply"}}]}'
    return Response()
bridge.urlopen = ${fakeDirectBackend ? "fake_direct" : "deny_network"}
raise SystemExit(bridge.main())
`, "utf8");
}

async function runBridge(
  script: string,
  hermesHome: string,
  frame: unknown
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await runControlledProcess({
    executable: "/usr/bin/python3",
    args: [script],
    cwd: dirname(script),
    allowedEnvironment: [["HERMES_HOME", hermesHome]],
    stdin: `${JSON.stringify(frame)}\n`,
    timeoutMs: 3_000,
    maxStdinBytes: 128 * 1024,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024
  });
  expect(result.timedOut).toBe(false);
  expect(result.aborted).toBe(false);
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function runBridgeInput(
  script: string,
  hermesHome: string,
  input: string | readonly string[]
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/python3", [script], {
      cwd: dirname(script),
      env: { HERMES_HOME: hermesHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      })
    );
    child.stdin.on("error", () => {
      // Rejecting an invalid frame may close stdin before the next test chunk.
    });
    if (typeof input === "string") {
      child.stdin.end(input);
    } else {
      void (async () => {
        for (const chunk of input) {
          child.stdin.write(chunk);
          await new Promise((done) => setTimeout(done, 30));
        }
        child.stdin.end();
      })();
    }
  });
}

describe("Hermes machine bridge", () => {
  it("passes command-shaped multiline input and resume to cli.main as inert data", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-machine-bridge-"));
    temporaryDirectories.push(root);
    const bridge = join(root, "hermes_machine_bridge.py");
    const sourceBridge = fileURLToPath(
      new URL("../runtime/hermes_machine_bridge.py", import.meta.url)
    );
    const home = join(root, "personal-home");
    await mkdir(join(home, "profiles", "zzh"), { recursive: true });
    await copyIsolatedBridge(sourceBridge, bridge);
    await writeFile(
      join(root, "cli.py"),
      `
import json
import os
from pathlib import Path
import sys

def main(**kwargs):
    Path(__file__).with_name("capture.json").write_text(json.dumps({
        "kwargs": kwargs,
        "argv": sys.argv,
        "hermesHome": os.environ.get("HERMES_HOME"),
        "sessionSource": os.environ.get("HERMES_SESSION_SOURCE"),
    }), encoding="utf-8")
    print("safe bridge reply")
    print("session_id: resumed-safe-session", file=sys.stderr)
`,
      "utf8"
    );
    const query = "/exit\n/model forged\n!touch /tmp/never\n普通文本";
    const resume = "resumed-safe-session";

    const result = await runBridge(bridge, home, {
      protocolVersion: 1,
      profile: "zzh",
      query,
      resume
    });
    const capture = JSON.parse(
      await readFile(join(root, "capture.json"), "utf8")
    ) as {
      kwargs: { query: string; resume: string; quiet: boolean; toolsets: string[] };
      argv: string[];
      hermesHome: string;
      sessionSource: string;
    };

    expect(result).toMatchObject({ exitCode: 0, stdout: "safe bridge reply\n" });
    expect(result.stderr).toContain("session_id: resumed-safe-session");
    expect(capture.kwargs).toEqual({ query, resume, quiet: true, toolsets: ["hermes-cli"] });
    expect(capture.argv).toEqual([bridge]);
    expect(capture.hermesHome).toBe(join(home, "profiles", "zzh"));
    expect(capture.sessionSource).toBe("tool");
    expect(capture.argv.join(" ")).not.toMatch(/exit|model|touch|resumed-safe-session|personal-home/);
  });

  it.each([
    ["escaped controls", "\u0001"],
    ["isolated surrogates", "\ud800"]
  ])("admits one contract-maximal %s query frame", async (_label, unit) => {
    const root = await mkdtemp(join(tmpdir(), "hermes-machine-bridge-max-"));
    temporaryDirectories.push(root);
    const bridge = join(root, "hermes_machine_bridge.py");
    const sourceBridge = fileURLToPath(
      new URL("../runtime/hermes_machine_bridge.py", import.meta.url)
    );
    const home = join(root, "family-home");
    await mkdir(home, { recursive: true });
    await copyIsolatedBridge(sourceBridge, bridge);
    await writeFile(
      join(root, "cli.py"),
      `
import json
from pathlib import Path

def main(**kwargs):
    Path(__file__).with_name("capture.json").write_text(
        json.dumps(kwargs, ensure_ascii=True), encoding="utf-8"
    )
    print("safe bridge reply")
    print("session_id: bridge-max-session", file=__import__("sys").stderr)
`,
      "utf8"
    );
    const query = unit.repeat(12_000);

    const result = await runBridge(bridge, home, {
      protocolVersion: 1,
      profile: "default",
      query
    });
    const capture = JSON.parse(
      await readFile(join(root, "capture.json"), "utf8")
    ) as { query: string; quiet: boolean; resume: null; toolsets: string[] };

    expect(Buffer.byteLength(JSON.stringify({
      protocolVersion: 1,
      profile: "default",
      query
    }))).toBeGreaterThan(64 * 1024);
    expect(result).toMatchObject({ exitCode: 0, stdout: "safe bridge reply\n" });
    expect(capture).toEqual({ query, quiet: true, resume: null, toolsets: ["hermes-cli"] });
  });

  it.each([
    ["separate Homes", "home-a", "zzh", "home-b", "zzh"],
    ["sibling profiles", "personal-home", "zzh", "personal-home", "nsy"],
    ["default and named profiles", "shared-home", "default", "shared-home", "zzh"]
  ])("isolates direct configuration and same-name sessions across %s", async (
    _label, firstHomeName, firstProfile, secondHomeName, secondProfile
  ) => {
    const root = await mkdtemp(join(tmpdir(), "hermes-direct-isolation-"));
    temporaryDirectories.push(root);
    const bridge = join(root, "hermes_machine_bridge.py");
    const sourceBridge = fileURLToPath(new URL("../runtime/hermes_machine_bridge.py", import.meta.url));
    await copyIsolatedBridge(sourceBridge, bridge, true);
    const firstHome = join(root, firstHomeName);
    const secondHome = join(root, secondHomeName);
    const firstScope = firstProfile === "default" ? firstHome : join(firstHome, "profiles", firstProfile);
    const secondScope = secondProfile === "default" ? secondHome : join(secondHome, "profiles", secondProfile);
    const sessionId = "same-session-name";
    const config = (name: string) =>
      `direct_openai_compat: true\nmodel:\n  default: model-${name}\n  base_url: https://${name}.invalid/v1\n  api_key: test-only-${name}\n`;
    for (const home of new Set([firstHome, secondHome])) {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "config.yaml"), config("unscoped"), { mode: 0o600 });
    }
    for (const [scope, name] of [[firstScope, "first"], [secondScope, "second"]]) {
      await mkdir(join(scope, "broker-sessions"), { recursive: true, mode: 0o700 });
      await writeFile(join(scope, "config.yaml"), config(name), { mode: 0o600 });
      await writeFile(join(scope, "broker-sessions", `${sessionId}.json`), JSON.stringify([
        { role: "user", content: `history-${name}` },
        { role: "assistant", content: `reply-${name}` }
      ]), { mode: 0o600 });
    }
    const firstSession = join(firstScope, "broker-sessions", `${sessionId}.json`);
    const secondSession = join(secondScope, "broker-sessions", `${sessionId}.json`);
    const secondBefore = await readFile(secondSession, "utf8");
    const firstResult = await runBridge(bridge, firstHome, {
      protocolVersion: 1, profile: firstProfile, query: "turn-first", resume: sessionId
    });
    expect(firstResult).toEqual({ exitCode: 0, stdout: "fake direct reply\n", stderr: `session_id: ${sessionId}\n` });
    expect(await readFile(secondSession, "utf8")).toBe(secondBefore);
    const firstAfter = await readFile(firstSession, "utf8");
    const secondResult = await runBridge(bridge, secondHome, {
      protocolVersion: 1, profile: secondProfile, query: "turn-second", resume: sessionId
    });
    expect(secondResult).toEqual({ exitCode: 0, stdout: "fake direct reply\n", stderr: `session_id: ${sessionId}\n` });
    expect(await readFile(firstSession, "utf8")).toBe(firstAfter);
    expect(JSON.parse(await readFile(join(root, "direct-requests.json"), "utf8"))).toEqual([
      { url: "https://first.invalid/v1/chat/completions", model: "model-first", messages: [
        { role: "user", content: "history-first" },
        { role: "assistant", content: "reply-first" },
        { role: "user", content: "turn-first" }
      ] },
      { url: "https://second.invalid/v1/chat/completions", model: "model-second", messages: [
        { role: "user", content: "history-second" },
        { role: "assistant", content: "reply-second" },
        { role: "user", content: "turn-second" }
      ] }
    ]);
    for (const [scope, name] of [[firstScope, "first"], [secondScope, "second"]]) {
      expect(await readFile(join(scope, "config.yaml"), "utf8")).toBe(config(name));
      const session = join(scope, "broker-sessions", `${sessionId}.json`);
      expect(JSON.parse(await readFile(session, "utf8"))).toEqual([
        { role: "user", content: `history-${name}` },
        { role: "assistant", content: `reply-${name}` },
        { role: "user", content: `turn-${name}` },
        { role: "assistant", content: "fake direct reply" }
      ]);
      expect((await stat(session)).mode & 0o777).toBe(0o600);
    }
  });

  it("does not fall back to the parent Home direct configuration when a profile has none", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-direct-no-fallback-"));
    temporaryDirectories.push(root);
    const bridge = join(root, "hermes_machine_bridge.py");
    const home = join(root, "personal-home");
    await mkdir(join(home, "profiles", "zzh"), { recursive: true });
    await writeFile(join(home, "config.yaml"),
      "direct_openai_compat: true\nmodel:\n  default: other-model\n  base_url: https://other.invalid/v1\n  api_key: test-only-other\n",
      { mode: 0o600 });
    await copyIsolatedBridge(fileURLToPath(new URL("../runtime/hermes_machine_bridge.py", import.meta.url)), bridge, true);
    await writeFile(join(root, "cli.py"), `
import sys
def main(**kwargs):
    print("profile-local cli reply")
    print("session_id: profile-local-session", file=sys.stderr)
`, "utf8");
    const result = await runBridge(bridge, home, {
      protocolVersion: 1, profile: "zzh", query: "use this profile"
    });
    expect(result).toEqual({ exitCode: 0, stdout: "profile-local cli reply\n", stderr: "session_id: profile-local-session\n" });
    await expect(access(join(root, "direct-requests.json"))).rejects.toThrow();
    await expect(access(join(home, "broker-sessions"))).rejects.toThrow();
  });

  it.each([
    ["oversized", JSON.stringify({ protocolVersion: 1, profile: "default", query: "SENTINEL_SECRET".repeat(8_000) })],
    [
      "multiple",
      `${JSON.stringify({ protocolVersion: 1, profile: "default", query: "first SENTINEL_SECRET" })}\n${JSON.stringify({ protocolVersion: 1, profile: "default", query: "second" })}\n`
    ],
    [
      "multiple separately written frames",
      [
        `${JSON.stringify({ protocolVersion: 1, profile: "default", query: "first SENTINEL_SECRET" })}\n`,
        `${JSON.stringify({ protocolVersion: 1, profile: "default", query: "second" })}\n`
      ]
    ]
  ])("rejects %s stdin instead of admitting more than one bounded JSON frame", async (_case, input) => {
    const root = await mkdtemp(join(tmpdir(), "hermes-machine-bridge-invalid-"));
    temporaryDirectories.push(root);
    const bridge = join(root, "hermes_machine_bridge.py");
    const sourceBridge = fileURLToPath(
      new URL("../runtime/hermes_machine_bridge.py", import.meta.url)
    );
    const home = join(root, "family-home");
    await mkdir(home, { recursive: true });
    await copyIsolatedBridge(sourceBridge, bridge);
    await writeFile(
      join(root, "cli.py"),
      `
from pathlib import Path
Path(__file__).with_name("unexpected-import").write_text("called", encoding="utf-8")
def main(**kwargs):
    return None
`,
      "utf8"
    );

    const result = await runBridgeInput(bridge, home, input);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "bridge_error:unavailable\n"
    });
    expect(result.stderr).not.toContain("SENTINEL_SECRET");
    await expect(access(join(root, "unexpected-import"))).rejects.toThrow();
  });
});
