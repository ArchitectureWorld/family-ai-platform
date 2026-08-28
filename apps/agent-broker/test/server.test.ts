import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentInvocationResultV1Schema,
  type AgentInvocationRequestV1
} from "@family-ai/contracts/federation";
import {
  createAgentBroker,
  type AgentBroker,
  type AgentBrokerLogEntry,
  type AgentBrokerOptions
} from "../src/server.js";

const temporaryDirectories: string[] = [];
const brokers: AgentBroker[] = [];
const childProcesses: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true })
    )
  );
});

async function fixture(): Promise<{
  root: string;
  runtimeDirectory: string;
  socketPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "family-agent-broker-"));
  temporaryDirectories.push(root);
  const runtimeDirectory = join(root, "run");
  return {
    root,
    runtimeDirectory,
    socketPath: join(runtimeDirectory, "agent-broker.sock")
  };
}

async function writeFakeHermes(root: string, capturePath: string): Promise<string> {
  const script = join(root, "fake-hermes.mjs");
  await writeFile(
    script,
    `
      import { appendFile } from "node:fs/promises";
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const frame = JSON.parse(input);
      const args = process.argv.slice(3);
      const profile = frame.profile === "default" ? "jarvis" : frame.profile;
      const sessionId = frame.resume ?? "session-" + profile;
      await appendFile(process.argv[2], JSON.stringify({
        args,
        frame,
        cwd: process.cwd(),
        envKeys: Object.keys(process.env).sort(),
        hermesHome: process.env.HERMES_HOME
      }) + "\\n");
      process.stdout.write("safe reply for " + profile);
      process.stderr.write("diagnostic:SENTINEL_STDERR_SECRET\\nsession_id: " + sessionId + "\\n");
    `,
    "utf8"
  );
  await writeFile(capturePath, "", "utf8");
  return script;
}

function requestFor(
  agentRef: AgentInvocationRequestV1["agentRef"],
  overrides: Partial<AgentInvocationRequestV1> = {}
): AgentInvocationRequestV1 {
  return {
    protocolVersion: 1,
    invocationRef: "invocation:broker-test-1",
    correlationRef: "correlation:broker-test-1",
    product: "family",
    actorContextRef: "actor-context:broker-test-1",
    agentRef,
    localSessionRef: "local-session:broker-test-1",
    prompt: "SENTINEL_PRIVATE_PROMPT",
    timeoutMs: 2_000,
    ...overrides
  };
}

async function udsRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ statusCode: number; body: unknown }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        method,
        path,
        headers:
          payload === undefined
            ? undefined
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload)
              }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: response.statusCode ?? 0,
            body: text.length === 0 ? undefined : JSON.parse(text)
          });
        });
      }
    );
    request.once("error", reject);
    request.end(payload);
  });
}

function openUdsInvocation(
  socketPath: string,
  body: AgentInvocationRequestV1
): {
  request: http.ClientRequest;
  response: Promise<{ statusCode: number; body: unknown }>;
} {
  const payload = JSON.stringify(body);
  let request!: http.ClientRequest;
  const response = new Promise<{ statusCode: number; body: unknown }>(
    (resolveResponse, rejectResponse) => {
      request = http.request(
        {
          socketPath,
          method: "POST",
          path: "/v1/invocations",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload)
          }
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.once("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolveResponse({
              statusCode: incoming.statusCode ?? 0,
              body: text.length === 0 ? undefined : JSON.parse(text)
            });
          });
        }
      );
      request.once("error", rejectResponse);
      request.end(payload);
    }
  );
  return { request, response };
}

async function processState(pid: number): Promise<"gone" | "running"> {
  try {
    const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
    return processStat.split(" ")[2] === "Z" ? "gone" : "running";
  } catch {
    return "gone";
  }
}

async function startBroker(
  options: AgentBrokerOptions
): Promise<AgentBroker> {
  const broker = createAgentBroker(options);
  brokers.push(broker);
  await broker.start();
  return broker;
}

describe("Unix-socket Agent Broker", () => {
  it("listens only on a mode-0660 UDS and returns the exact three descriptors", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    const capturePath = join(root, "capture.jsonl");
    const script = await writeFakeHermes(root, capturePath);
    const broker = await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      prefixArgs: [script, capturePath],
      processCwd: () => root,
      runtimeProbe: async () => true,
      clock: () => new Date("2026-08-28T12:00:00.000Z")
    });

    expect(broker.server.address()).toBe(socketPath);
    const runtimeStat = await stat(runtimeDirectory);
    const socketStat = await stat(socketPath);
    expect(runtimeStat.mode & 0o777).toBe(0o700);
    expect(socketStat.mode & 0o777).toBe(0o660);
    if (typeof process.getuid === "function") {
      expect(runtimeStat.uid).toBe(process.getuid());
      expect(socketStat.uid).toBe(process.getuid());
    }
    const response = await udsRequest(socketPath, "GET", "/v1/agents");

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      agents: [
        expect.objectContaining({
          agentRef: "agent:hermes-jarvis",
          displayName: "Jarvis",
          status: "available"
        }),
        expect.objectContaining({
          agentRef: "agent:hermes-zzh",
          displayName: "于途",
          status: "available"
        }),
        expect.objectContaining({
          agentRef: "agent:hermes-nsy",
          displayName: "乔晶晶",
          status: "available"
        })
      ]
    });
    expect(JSON.stringify(response.body)).not.toMatch(/\/home\/youran|profile|service/i);

    const health = await udsRequest(socketPath, "GET", "/v1/health");
    expect(health).toMatchObject({
      statusCode: 200,
      body: { status: "ok", agents: [{ status: "available" }, { status: "available" }, { status: "available" }] }
    });
  });

  it("uses a single JSON frame, fixed argv, one-key environment, and Agent-scoped resume", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    const capturePath = join(root, "capture.jsonl");
    const script = await writeFakeHermes(root, capturePath);
    const logs: AgentBrokerLogEntry[] = [];
    await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      prefixArgs: [script, capturePath],
      processCwd: () => root,
      runtimeProbe: async () => true,
      logger: (entry) => logs.push(entry),
      clock: () => new Date("2026-08-28T12:00:00.000Z")
    });

    for (const agentRef of [
      "agent:hermes-jarvis",
      "agent:hermes-zzh",
      "agent:hermes-nsy"
    ] as const) {
      const response = await udsRequest(
        socketPath,
        "POST",
        "/v1/invocations",
        requestFor(agentRef, {
          invocationRef: `invocation:${agentRef.slice("agent:hermes-".length)}-1`,
          localSessionRef: `local-session:${agentRef.slice("agent:hermes-".length)}-1`
        })
      );
      expect(response.statusCode).toBe(200);
      expect(() => agentInvocationResultV1Schema.parse(response.body)).not.toThrow();
      expect(response.body).toMatchObject({ status: "succeeded" });
    }

    const firstZzh = await udsRequest(
      socketPath,
      "POST",
      "/v1/invocations",
      requestFor("agent:hermes-zzh", {
        invocationRef: "invocation:zzh-resume-source"
      })
    );
    const externalSessionRef = (firstZzh.body as { externalSessionRef: string }).externalSessionRef;
    const mismatch = await udsRequest(
      socketPath,
      "POST",
      "/v1/invocations",
      requestFor("agent:hermes-nsy", {
        invocationRef: "invocation:nsy-cross-agent-resume",
        externalSessionRef
      })
    );
    expect(mismatch).toMatchObject({
      statusCode: 409,
      body: {
        error: {
          code: "SESSION_SCOPE_MISMATCH",
          category: "conflict",
          retryable: false
        }
      }
    });
    const resumed = await udsRequest(
      socketPath,
      "POST",
      "/v1/invocations",
      requestFor("agent:hermes-zzh", {
        invocationRef: "invocation:zzh-resume-target",
        externalSessionRef
      })
    );
    expect(resumed).toMatchObject({ statusCode: 200, body: { status: "succeeded", externalSessionRef } });

    const records = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        args: string[];
        frame: {
          protocolVersion: number;
          profile: string;
          query: string;
          resume?: string;
        };
        cwd: string;
        envKeys: string[];
        hermesHome: string;
      });
    expect(records).toHaveLength(5);
    expect(records.map((record) => record.args)).toEqual([[], [], [], [], []]);
    expect(records[0]?.frame).toEqual({
      protocolVersion: 1,
      profile: "default",
      query: "SENTINEL_PRIVATE_PROMPT"
    });
    expect(records[1]?.frame.profile).toBe("zzh");
    expect(records[2]?.frame.profile).toBe("nsy");
    expect(records[4]?.frame).toEqual({
      protocolVersion: 1,
      profile: "zzh",
      query: "SENTINEL_PRIVATE_PROMPT",
      resume: "session-zzh"
    });
    for (const record of records) {
      expect(record.args.join(" ")).not.toContain("SENTINEL_PRIVATE_PROMPT");
      expect(record.envKeys).toEqual(["HERMES_HOME"]);
      expect(record.cwd).toBe(root);
    }
    expect(records[0]?.hermesHome).toBe(join("/home", "youran", ".hermes"));
    expect(records[1]?.hermesHome).toBe(
      join("/home", "youran", "hermes-personal-assistants")
    );
    expect(JSON.stringify(resumed.body)).not.toMatch(/SENTINEL_PRIVATE_PROMPT|SENTINEL_STDERR_SECRET/);
    expect(JSON.stringify(logs)).not.toMatch(/SENTINEL_PRIVATE_PROMPT|SENTINEL_STDERR_SECRET/);
  });

  it.each([
    "/exit",
    "/model forged-model",
    "!touch /tmp/never",
    "第一行\n/exit\n第三行"
  ])("keeps command-shaped prompt %j as one inert JSON query", async (prompt) => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    const capturePath = join(root, "capture.jsonl");
    const script = await writeFakeHermes(root, capturePath);
    await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      prefixArgs: [script, capturePath],
      processCwd: () => root,
      runtimeProbe: async () => true
    });

    const response = await udsRequest(
      socketPath,
      "POST",
      "/v1/invocations",
      requestFor("agent:hermes-zzh", { prompt })
    );
    const record = JSON.parse(
      (await readFile(capturePath, "utf8")).trim()
    ) as { args: string[]; frame: { query: string } };

    expect(response).toMatchObject({ statusCode: 200, body: { status: "succeeded" } });
    expect(record.args).toEqual([]);
    expect(record.frame.query).toBe(prompt);
  });

  it("requires exit code zero even when stdout and session metadata look valid", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    const script = join(root, "exit-one-hermes.mjs");
    await writeFile(
      script,
      `
        process.stdout.write("plausible but failed reply");
        process.stderr.write("session_id: plausible-session\\n");
        process.exitCode = 1;
      `,
      "utf8"
    );
    await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      prefixArgs: [script],
      processCwd: () => root,
      runtimeProbe: async () => true
    });

    const response = await udsRequest(
      socketPath,
      "POST",
      "/v1/invocations",
      requestFor("agent:hermes-jarvis")
    );

    expect(response).toMatchObject({
      statusCode: 200,
      body: {
        status: "failed",
        output: "个人助理暂时不可用，请稍后重试。"
      }
    });
    expect(JSON.stringify(response.body)).not.toContain("plausible but failed reply");
  });

  it.each([
    ["home", "/tmp/forged-home"],
    ["profile", "forged"],
    ["executable", "/tmp/forged-hermes"],
    ["model", "forged-model"],
    ["provider", "forged-provider"],
    ["cwd", "/tmp/forged-cwd"],
    ["prefixArgs", ["--forged"]],
    ["environment", { SECRET: "forged" }],
    ["env", { SECRET: "forged" }]
  ])("rejects the request-side %s runtime override before spawn", async (field, value) => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    const capturePath = join(root, "capture.jsonl");
    const script = await writeFakeHermes(root, capturePath);
    await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      prefixArgs: [script, capturePath],
      processCwd: () => root,
      runtimeProbe: async () => true
    });

    const response = await udsRequest(socketPath, "POST", "/v1/invocations", {
      ...requestFor("agent:hermes-zzh"),
      [field]: value
    });

    expect(response).toMatchObject({
      statusCode: 400,
      body: { error: { code: "INVALID_REQUEST" } }
    });
    expect(await readFile(capturePath, "utf8")).toBe("");
  });

  it("rejects an unknown AgentRef before spawn", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    const capturePath = join(root, "capture.jsonl");
    const script = await writeFakeHermes(root, capturePath);
    await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      prefixArgs: [script, capturePath],
      processCwd: () => root,
      runtimeProbe: async () => true
    });

    const response = await udsRequest(
      socketPath,
      "POST",
      "/v1/invocations",
      requestFor("agent:hermes-unknown")
    );

    expect(response).toMatchObject({
      statusCode: 404,
      body: { error: { code: "AGENT_NOT_FOUND" } }
    });
    expect(await readFile(capturePath, "utf8")).toBe("");
  });

  it("returns bounded safe failures and kills the whole fake Hermes process group on timeout", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    const descendantPath = join(root, "descendant.pid");
    const script = join(root, "hanging-hermes.mjs");
    await writeFile(
      script,
      `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
        writeFileSync(process.argv[2], String(descendant.pid));
        process.stderr.write("SENTINEL_TIMEOUT_STDERR_SECRET");
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      `,
      "utf8"
    );
    const logs: AgentBrokerLogEntry[] = [];
    await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      prefixArgs: [script, descendantPath],
      processCwd: () => root,
      runtimeProbe: async () => true,
      terminationGraceMs: 40,
      logger: (entry) => logs.push(entry)
    });

    const response = await udsRequest(
      socketPath,
      "POST",
      "/v1/invocations",
      requestFor("agent:hermes-jarvis", { timeoutMs: 1_000 })
    );
    const descendantPid = Number(await readFile(descendantPath, "utf8"));

    expect(response).toMatchObject({
      statusCode: 200,
      body: { status: "timed_out", output: "个人助理响应超时，请稍后重试。" }
    });
    expect(() => agentInvocationResultV1Schema.parse(response.body)).not.toThrow();
    expect(JSON.stringify(response.body)).not.toMatch(/SENTINEL_PRIVATE_PROMPT|SENTINEL_TIMEOUT_STDERR_SECRET/);
    expect(JSON.stringify(logs)).not.toMatch(/SENTINEL_PRIVATE_PROMPT|SENTINEL_TIMEOUT_STDERR_SECRET/);
    await expect.poll(() => processState(descendantPid)).toBe("gone");
  });

  it("starts timeout at admission and never spawns a queued invocation after its deadline", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    const capturePath = join(root, "admission.jsonl");
    const script = join(root, "admission-hermes.mjs");
    await writeFile(
      script,
      `
        import { appendFile } from "node:fs/promises";
        let input = "";
        for await (const chunk of process.stdin) input += chunk;
        const frame = JSON.parse(input);
        await appendFile(process.argv[2], frame.query + "\\n");
        if (frame.query === "hold admission") {
          process.on("SIGTERM", () => {});
          setInterval(() => {}, 1000);
        } else {
          process.stdout.write("unexpected queued reply");
          process.stderr.write("session_id: queued-session\\n");
        }
      `,
      "utf8"
    );
    await writeFile(capturePath, "", "utf8");
    const broker = await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      prefixArgs: [script, capturePath],
      processCwd: () => root,
      runtimeProbe: async () => true,
      maxConcurrency: 1,
      terminationGraceMs: 30
    });
    const first = openUdsInvocation(
      socketPath,
      requestFor("agent:hermes-jarvis", {
        invocationRef: "invocation:admission-holder",
        prompt: "hold admission",
        timeoutMs: 2_500
      })
    );
    await expect.poll(() => readFile(capturePath, "utf8")).toContain("hold admission");
    const startedAt = Date.now();

    const queued = await udsRequest(
      socketPath,
      "POST",
      "/v1/invocations",
      requestFor("agent:hermes-jarvis", {
        invocationRef: "invocation:admission-queued",
        prompt: "must never spawn",
        timeoutMs: 1_000
      })
    );
    const elapsed = Date.now() - startedAt;
    first.request.destroy();
    await first.response.catch(() => undefined);

    expect(queued).toMatchObject({
      statusCode: 200,
      body: { status: "timed_out" }
    });
    expect(elapsed).toBeLessThan(1_800);
    expect(await readFile(capturePath, "utf8")).toBe("hold admission\n");
    await broker.close();
    brokers.splice(brokers.indexOf(broker), 1);
  });

  it("aborts the fake Hermes process group when the HTTP client disconnects", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    const descendantPath = join(root, "disconnect-descendant.pid");
    const script = join(root, "disconnect-hermes.mjs");
    await writeFile(
      script,
      `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
        writeFileSync(process.argv[2], String(descendant.pid));
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      `,
      "utf8"
    );
    await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      prefixArgs: [script, descendantPath],
      processCwd: () => root,
      runtimeProbe: async () => true,
      terminationGraceMs: 30
    });
    const invocation = openUdsInvocation(
      socketPath,
      requestFor("agent:hermes-jarvis", {
        invocationRef: "invocation:disconnect",
        timeoutMs: 2_000
      })
    );
    const ignoredResponse = invocation.response.catch(() => undefined);
    await expect.poll(() => access(descendantPath).then(() => true, () => false)).toBe(true);
    const descendantPid = Number(await readFile(descendantPath, "utf8"));

    invocation.request.destroy();

    await expect.poll(() => processState(descendantPid)).toBe("gone");
    await ignoredResponse;
  });

  it("aborts all active process groups before Broker close completes", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    const descendantPath = join(root, "close-descendant.pid");
    const script = join(root, "close-hermes.mjs");
    await writeFile(
      script,
      `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
        writeFileSync(process.argv[2], String(descendant.pid));
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      `,
      "utf8"
    );
    const broker = await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      prefixArgs: [script, descendantPath],
      processCwd: () => root,
      runtimeProbe: async () => true,
      terminationGraceMs: 30
    });
    const invocation = openUdsInvocation(
      socketPath,
      requestFor("agent:hermes-jarvis", {
        invocationRef: "invocation:broker-close",
        timeoutMs: 2_000
      })
    );
    const ignoredResponse = invocation.response.catch(() => undefined);
    await expect.poll(() => access(descendantPath).then(() => true, () => false)).toBe(true);
    const descendantPid = Number(await readFile(descendantPath, "utf8"));
    const closing = broker.close();
    let closeResult: "closed" | "late";
    try {
      closeResult = await Promise.race([
        closing.then(() => "closed" as const),
        new Promise<"late">((resolveLate) =>
          setTimeout(() => resolveLate("late"), 700)
        )
      ]);
    } finally {
      invocation.request.destroy();
      await closing;
      brokers.splice(brokers.indexOf(broker), 1);
      await ignoredResponse;
    }

    expect(closeResult).toBe("closed");
    await expect.poll(() => processState(descendantPid)).toBe("gone");
  });

  it("recreates a stale owned socket on restart but preserves a non-socket at the exact path", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "noop-hermes.mjs"), "", "utf8");
    const staleOwner = spawn(
      process.execPath,
      [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write("ready\\n"));`
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    childProcesses.push(staleOwner);
    await new Promise<void>((resolve, reject) => {
      staleOwner.stdout?.once("data", () => resolve());
      staleOwner.once("error", reject);
    });
    await chmod(socketPath, 0o660);
    staleOwner.kill("SIGKILL");
    await new Promise<void>((resolve) => staleOwner.once("exit", () => resolve()));
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    const broker = await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      processCwd: () => root,
      runtimeProbe: async () => true
    });
    expect(broker.server.address()).toBe(socketPath);
    await broker.close();
    brokers.splice(brokers.indexOf(broker), 1);

    const restarted = await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      processCwd: () => root,
      runtimeProbe: async () => true
    });
    expect(restarted.server.address()).toBe(socketPath);
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    await restarted.close();
    brokers.splice(brokers.indexOf(restarted), 1);

    await writeFile(socketPath, "do-not-delete", "utf8");
    const refused = createAgentBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      processCwd: () => root,
      runtimeProbe: async () => true
    });
    await expect(refused.start()).rejects.toThrow(/socket path/i);
    expect(await readFile(socketPath, "utf8")).toBe("do-not-delete");
    await expect(access(socketPath)).resolves.toBeUndefined();
  });

  it("rejects unsafe or symlinked RuntimeDirectory ownership boundaries", async () => {
    const unsafe = await fixture();
    await mkdir(unsafe.runtimeDirectory, { recursive: true, mode: 0o700 });
    await chmod(unsafe.runtimeDirectory, 0o770);
    await expect(
      startBroker({
        runtimeDirectory: unsafe.runtimeDirectory,
        socketPath: unsafe.socketPath,
        executable: process.execPath,
        processCwd: () => unsafe.root,
        runtimeProbe: async () => true
      })
    ).rejects.toThrow(/RuntimeDirectory.*mode/i);

    const linked = await fixture();
    const actualRuntime = join(linked.root, "actual-run");
    await mkdir(actualRuntime, { mode: 0o700 });
    await symlink(actualRuntime, linked.runtimeDirectory);
    await expect(
      startBroker({
        runtimeDirectory: linked.runtimeDirectory,
        socketPath: linked.socketPath,
        executable: process.execPath,
        processCwd: () => linked.root,
        runtimeProbe: async () => true
      })
    ).rejects.toThrow(/RuntimeDirectory.*directory/i);
  });

  it("preserves a stale socket whose mode is not the exact owned mode", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    await mkdir(runtimeDirectory, { mode: 0o700 });
    const staleOwner = spawn(
      process.execPath,
      [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write("ready\\n"));`
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    childProcesses.push(staleOwner);
    await new Promise<void>((resolve, reject) => {
      staleOwner.stdout?.once("data", () => resolve());
      staleOwner.once("error", reject);
    });
    await chmod(socketPath, 0o666);
    staleOwner.kill("SIGKILL");
    await new Promise<void>((resolve) => staleOwner.once("exit", () => resolve()));
    const original = await lstat(socketPath, { bigint: true });
    const broker = createAgentBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      processCwd: () => root,
      runtimeProbe: async () => true
    });
    brokers.push(broker);
    let rejection: unknown;

    try {
      await broker.start();
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/socket path.*mode/i);
    const preserved = await lstat(socketPath, { bigint: true });
    expect(preserved.ino).toBe(original.ino);
    expect(preserved.mode & 0o777n).toBe(0o666n);
  });

  it("does not unlink a foreign replacement installed before Broker close", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    const broker = await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      processCwd: () => root,
      runtimeProbe: async () => true
    });
    await unlink(socketPath);
    await writeFile(socketPath, "foreign replacement", "utf8");

    await broker.close();
    brokers.splice(brokers.indexOf(broker), 1);

    expect(await readFile(socketPath, "utf8")).toBe("foreign replacement");
  });

  it("classifies unexpected internal failures as retryable internal errors", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    await startBroker({
      runtimeDirectory,
      socketPath,
      executable: process.execPath,
      processCwd: () => root,
      runtimeProbe: async () => {
        throw new Error("SENTINEL_INTERNAL_SECRET");
      }
    });

    const response = await udsRequest(socketPath, "GET", "/v1/health");

    expect(response).toEqual({
      statusCode: 500,
      body: {
        error: {
          code: "BROKER_INTERNAL",
          category: "internal",
          message: "本机个人助理服务暂时不可用。",
          retryable: true
        }
      }
    });
    expect(JSON.stringify(response.body)).not.toContain("SENTINEL_INTERNAL_SECRET");
  });
});
