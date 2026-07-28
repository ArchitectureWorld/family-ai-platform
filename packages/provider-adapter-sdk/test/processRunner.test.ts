import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlledProcessError,
  runControlledProcess
} from "../src/processRunner.js";

const temporaryDirectories: string[] = [];

async function fixture(source: string): Promise<{ cwd: string; script: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "controlled-runner-"));
  temporaryDirectories.push(cwd);
  const script = join(cwd, "fake cli.mjs");
  await writeFile(script, source, "utf8");
  return { cwd, script };
}

function environment(home: string): Array<readonly [string, string]> {
  return [
    ["CODEX_HOME", join(home, ".codex")],
    ["HOME", home],
    ["LANG", "C.UTF-8"],
    ["PATH", process.env.PATH ?? "/usr/bin:/bin"],
    ["TERM", "dumb"]
  ];
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true
  })));
});

describe("runControlledProcess", () => {
  it("uses literal argv, a five-key environment allowlist, and no shell expansion", async () => {
    const { cwd, script } = await fixture(`
      import { writeFile } from "node:fs/promises";
      const args = process.argv.slice(2);
      const marker = args[1];
      await writeFile(process.env.HOME + "/record.json", JSON.stringify({
        args,
        envKeys: Object.keys(process.env).sort(),
        shell: args.length !== 2 || args[0] !== "literal;$(touch should-not-exist)"
      }));
      process.stdout.write("ok");
    `);
    const marker = join(cwd, "should-not-exist");

    const result = await runControlledProcess({
      executable: process.execPath,
      prefixArgs: [script],
      args: ["literal;$(touch should-not-exist)", marker],
      cwd,
      allowedEnvironment: environment(cwd),
      timeoutMs: 2_000,
      terminationGraceMs: 50,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxConcurrency: 2
    });

    const recorded = JSON.parse(await readFile(join(cwd, "record.json"), "utf8")) as {
      args: string[];
      envKeys: string[];
      shell: boolean;
    };
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(recorded.shell).toBe(false);
    expect(recorded.envKeys.sort()).toEqual([
      "CODEX_HOME",
      "HOME",
      "LANG",
      "PATH",
      "TERM"
    ]);
    expect(recorded.args).toEqual(["literal;$(touch should-not-exist)", marker]);
    await expect(access(marker)).rejects.toThrow();
  });

  it.each([
    ["stdout", "STDOUT_LIMIT_EXCEEDED"],
    ["stderr", "STDERR_LIMIT_EXCEEDED"]
  ] as const)("terminates and rejects when %s exceeds its byte cap", async (stream, code) => {
    const { cwd, script } = await fixture(`
      const stream = process.argv[2] === "stdout" ? process.stdout : process.stderr;
      stream.write("private-secret-".repeat(2048));
      setInterval(() => {}, 1000);
    `);

    const execution = runControlledProcess({
      executable: process.execPath,
      prefixArgs: [script],
      args: [stream],
      cwd,
      allowedEnvironment: environment(cwd),
      timeoutMs: 2_000,
      terminationGraceMs: 30,
      maxStdoutBytes: stream === "stdout" ? 64 : 1024,
      maxStderrBytes: stream === "stderr" ? 64 : 1024,
      maxConcurrency: 2
    });

    await expect(execution).rejects.toMatchObject({ code });
    await expect(execution).rejects.not.toThrow(/private-secret/);
  });

  it("times out and removes the whole child process group", async () => {
    const { cwd, script } = await fixture(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
        stdio: "ignore"
      });
      writeFileSync(process.env.HOME + "/descendant.pid", String(descendant.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);

    const result = await runControlledProcess({
      executable: process.execPath,
      prefixArgs: [script],
      args: [],
      cwd,
      allowedEnvironment: environment(cwd),
      timeoutMs: 500,
      terminationGraceMs: 40,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxConcurrency: 2
    });
    const descendantPid = Number(await readFile(join(cwd, "descendant.pid"), "utf8"));

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    await expect.poll(async () => {
      try {
        const stat = await readFile(`/proc/${descendantPid}/stat`, "utf8");
        return stat.split(" ")[2] === "Z" ? "gone" : "running";
      } catch {
        return "gone";
      }
    }).toBe("gone");
  });

  it("aborts with the same bounded process-group cleanup path", async () => {
    const { cwd, script } = await fixture(`
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 50);

    const result = await runControlledProcess({
      executable: process.execPath,
      prefixArgs: [script],
      args: [],
      cwd,
      allowedEnvironment: environment(cwd),
      abortSignal: abortController.signal,
      timeoutMs: 2_000,
      terminationGraceMs: 30,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxConcurrency: 2
    });

    expect(result).toMatchObject({ aborted: true, timedOut: false, exitCode: null });
  });

  it("honors the configured global concurrency bound", async () => {
    const { cwd, script } = await fixture(`
      setTimeout(() => {
        process.stdout.write("done");
      }, 120);
    `);
    const options = {
      executable: process.execPath,
      prefixArgs: [script],
      args: [],
      cwd,
      allowedEnvironment: environment(cwd),
      timeoutMs: 2_000,
      terminationGraceMs: 30,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxConcurrency: 1
    };
    const startedAt = Date.now();

    const results = await Promise.all([
      runControlledProcess(options),
      runControlledProcess(options)
    ]);

    expect(results.map((result) => result.stdout)).toEqual(["done", "done"]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
  });

  it.each([
    [{ executable: "" }, "INVALID_OPTIONS"],
    [{ cwd: "" }, "INVALID_OPTIONS"],
    [{ args: ["nul\u0000byte"] }, "INVALID_OPTIONS"],
    [{ allowedEnvironment: [["HOME", "/tmp"], ["HOME", "/other"]] }, "INVALID_OPTIONS"]
  ])("rejects invalid launch options without including their value", async (overrides, code) => {
    const { cwd, script } = await fixture(`process.stdout.write("unexpected");`);
    const execution = runControlledProcess({
      executable: process.execPath,
      prefixArgs: [script],
      args: [],
      cwd,
      allowedEnvironment: environment(cwd),
      timeoutMs: 2_000,
      terminationGraceMs: 30,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxConcurrency: 2,
      ...overrides
    });

    await expect(execution).rejects.toBeInstanceOf(ControlledProcessError);
    await expect(execution).rejects.toMatchObject({ code });
    await expect(execution).rejects.not.toThrow(/nul|other|unexpected/);
  });
});
