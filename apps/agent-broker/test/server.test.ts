import { spawn, type ChildProcess } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      const args = process.argv.slice(3);
      const profileAt = args.indexOf("-p");
      const resumeAt = args.indexOf("--resume");
      const profile = profileAt >= 0 ? args[profileAt + 1] : "jarvis";
      const sessionId = resumeAt >= 0 ? args[resumeAt + 1] : "session-" + profile;
      await appendFile(process.argv[2], JSON.stringify({
        args,
        stdin: input,
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
    expect((await stat(socketPath)).mode & 0o777).toBe(0o660);
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

  it("uses fixed profile argv, stdin-only prompts, one-key environment, and Agent-scoped resume", async () => {
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
      body: { error: { code: "SESSION_SCOPE_MISMATCH" } }
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
        stdin: string;
        cwd: string;
        envKeys: string[];
        hermesHome: string;
      });
    expect(records).toHaveLength(5);
    expect(records[0]?.args).toEqual(["chat", "--cli", "--quiet", "--source", "tool"]);
    expect(records[1]?.args).toEqual([
      "-p",
      "zzh",
      "chat",
      "--cli",
      "--quiet",
      "--source",
      "tool"
    ]);
    expect(records[2]?.args).toEqual([
      "-p",
      "nsy",
      "chat",
      "--cli",
      "--quiet",
      "--source",
      "tool"
    ]);
    expect(records[4]?.args).toEqual([
      "-p",
      "zzh",
      "chat",
      "--cli",
      "--quiet",
      "--source",
      "tool",
      "--resume",
      "session-zzh"
    ]);
    for (const record of records) {
      expect(record.args.join(" ")).not.toContain("SENTINEL_PRIVATE_PROMPT");
      expect(record.stdin).toBe("SENTINEL_PRIVATE_PROMPT\n/exit\n");
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
    await expect.poll(async () => {
      try {
        const processStat = await readFile(`/proc/${descendantPid}/stat`, "utf8");
        return processStat.split(" ")[2] === "Z" ? "gone" : "running";
      } catch {
        return "gone";
      }
    }).toBe("gone");
  });

  it("recreates a stale owned socket on restart but preserves a non-socket at the exact path", async () => {
    const { root, runtimeDirectory, socketPath } = await fixture();
    await mkdir(runtimeDirectory, { recursive: true });
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
});
