import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
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

async function copyIsolatedBridge(source: string, entrypoint: string): Promise<void> {
  await copyFile(source, join(dirname(entrypoint), "bridge_under_test.py"));
  await writeFile(entrypoint, `
import os
from pathlib import Path
import sys
import bridge_under_test as bridge

# Keep the production fallback configuration and session directory unreachable.
bridge.BROKER_HERMES_HOME = Path(os.environ["HERMES_HOME"])
def deny_network(*args, **kwargs):
    Path(__file__).with_name("unexpected-network").write_text("blocked", encoding="utf-8")
    raise RuntimeError("network disabled in bridge tests")
bridge.urlopen = deny_network
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
