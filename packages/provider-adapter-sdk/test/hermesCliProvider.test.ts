import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HermesCliProviderAdapter,
  type HermesCliProviderOptions
} from "../src/hermesCliProvider.js";

const request = {
  protocolVersion: "1.0" as const,
  invocationRef: "invocation:018f47a2-1f10-7a3d-8c2d-61f369284f21",
  correlationRef: "correlation:018f47a2-1f10-7a3d-8c2d-61f369284f22",
  idempotencyKey: "device:test:message:0001",
  requestedAt: "2026-07-21T09:00:00.000Z",
  providerProfileRef: "provider-profile:hermes-local",
  targetAgentRef: "agent:personal-assistant",
  conversationRef: "conversation:018f47a2-1f10-7a3d-8c2d-61f369284f23",
  content: [{ type: "text" as const, text: "第一轮。" }],
  timeoutMs: 2_000
};

let cwd: string;
let script: string;

function environment(): Array<readonly [string, string]> {
  return [
    ["CODEX_HOME", join(cwd, ".codex")],
    ["HOME", cwd],
    ["LANG", "C.UTF-8"],
    ["PATH", process.env.PATH ?? "/usr/bin:/bin"],
    ["TERM", "dumb"]
  ];
}

function options(overrides: Partial<HermesCliProviderOptions> = {}): HermesCliProviderOptions {
  return {
    executable: process.execPath,
    prefixArgs: [script],
    cwd,
    allowedEnvironment: environment(),
    profileName: "family",
    model: "deepseek-v4-flash",
    provider: "sensenova",
    providerProfileRef: "provider-profile:hermes-local",
    clock: () => new Date("2026-07-21T09:00:01.000Z"),
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
    maxConcurrency: 2,
    ...overrides
  };
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-cli-provider-"));
  script = join(cwd, "fake-hermes.mjs");
  await writeFile(script, `
    import { appendFile } from "node:fs/promises";
    const args = process.argv.slice(2);
    await appendFile(process.env.HOME + "/invocations.jsonl", JSON.stringify({
      args,
      envKeys: Object.keys(process.env).sort()
    }) + "\\n");
    const prompt = args[args.indexOf("-q") + 1];
    if (prompt === "missing-session") {
      process.stderr.write("Hermes session not found: private-session-and-token\\n");
      process.exit(4);
    }
    if (prompt === "unavailable") {
      process.stderr.write("private command and cookie\\n");
      process.exit(7);
    }
    if (prompt === "partial-valid") {
      process.stdout.write("Hermes 已完成回答。");
      process.stderr.write("non-fatal finalize warning\\nsession_id: partial_session_51\\n");
      process.exit(1);
    }
    if (prompt === "partial-empty") {
      process.stderr.write("session_id: partial_session_52\\n");
      process.exit(1);
    }
    if (prompt === "partial-duplicate-id") {
      process.stdout.write("private ambiguous answer");
      process.stderr.write("session_id: partial_session_53\\nsession_id: partial_session_54\\n");
      process.exit(1);
    }
    if (prompt === "partial-fatal") {
      process.stdout.write("private unsafe answer");
      process.stderr.write("Authentication failed: invalid credential\\nsession_id: partial_session_55\\n");
      process.exit(1);
    }
    if (prompt === "partial-provider-error") {
      process.stdout.write("API call failed after 3 retries: HTTP 404: model route not found");
      process.stderr.write("session_id: partial_session_57\\n");
      process.exit(1);
    }
    if (prompt === "valid-exit-two") {
      process.stdout.write("private wrong-exit answer");
      process.stderr.write("session_id: partial_session_56\\n");
      process.exit(2);
    }
    if (prompt === "missing-id") {
      process.stdout.write("reply");
      process.stderr.write("private diagnostic\\n");
      process.exit(0);
    }
    if (prompt === "duplicate-id") {
      process.stdout.write("reply");
      process.stderr.write("session_id: first_id\\nsession_id: second_id\\n");
      process.exit(0);
    }
    if (prompt === "mismatched-resume") {
      process.stdout.write("private-mismatched-hermes-output");
      process.stderr.write("session_id: returned_other_session_99\\n");
      process.exit(0);
    }
    process.stdout.write(args.includes("--resume") ? "Hermes 第二轮。" : "Hermes 第一轮。");
    process.stderr.write("private diagnostic\\nsession_id: saved_session_42\\n");
  `, "utf8");
});

afterEach(async () => {
  await rm(cwd, { force: true, recursive: true });
});

describe("HermesCliProviderAdapter", () => {
  it("uses quiet mode and continues only the caller-supplied persisted session", async () => {
    const adapter = new HermesCliProviderAdapter(options());

    const first = await adapter.invoke(request);
    expect(first).toMatchObject({
      status: "succeeded",
      output: [{ type: "text", text: "Hermes 第一轮。" }],
      externalSessionRef: "external-session:hermes-saved_session_42"
    });
    if (!first.externalSessionRef) throw new Error("first session reference missing");
    const second = await adapter.invoke({
      ...request,
      invocationRef: "invocation:018f47a2-1f10-7a3d-8c2d-61f369284f24",
      idempotencyKey: "device:test:message:0002",
      externalSessionRef: first.externalSessionRef,
      content: [{ type: "text" as const, text: "第二轮。" }]
    });
    const invocations = (await readFile(join(cwd, "invocations.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; envKeys: string[] });

    expect(second.output).toEqual([{ type: "text", text: "Hermes 第二轮。" }]);
    expect(invocations[0]?.args).toEqual([
      "chat", "-q", "第一轮。",
      "-m", "deepseek-v4-flash", "--provider", "sensenova",
      "--quiet", "--source", "tool", "-p", "family"
    ]);
    expect(invocations[0]?.envKeys.sort()).toEqual([
      "CODEX_HOME", "HOME", "LANG", "PATH", "TERM"
    ]);
    expect(invocations[1]?.args).toContain("--resume");
    expect(invocations[1]?.args).toContain("saved_session_42");
    expect(invocations[1]?.args).not.toContain("--last");
  });

  it("omits the profile flag for the default profile", async () => {
    const adapter = new HermesCliProviderAdapter(options({ profileName: "default" }));
    await adapter.invoke(request);
    const invocation = JSON.parse(
      (await readFile(join(cwd, "invocations.jsonl"), "utf8")).trim()
    ) as { args: string[] };
    expect(invocation.args).not.toContain("-p");
  });

  it("accepts an exit-1 Hermes result only when answer and session marker are valid", async () => {
    const adapter = new HermesCliProviderAdapter(options());
    const result = await adapter.invoke({
      ...request,
      content: [{ type: "text" as const, text: "partial-valid" }]
    });

    expect(result).toMatchObject({
      status: "succeeded",
      output: [{ type: "text", text: "Hermes 已完成回答。" }],
      externalSessionRef: "external-session:hermes-partial_session_51"
    });
  });

  it.each([
    ["partial-empty", "PROVIDER_UNAVAILABLE"],
    ["partial-duplicate-id", "PROVIDER_UNAVAILABLE"],
    ["partial-fatal", "PROVIDER_UNAVAILABLE"],
    ["partial-provider-error", "PROVIDER_UNAVAILABLE"],
    ["valid-exit-two", "PROVIDER_UNAVAILABLE"]
  ])("rejects unsafe non-zero Hermes result %s", async (prompt, code) => {
    const adapter = new HermesCliProviderAdapter(options());
    const result = await adapter.invoke({
      ...request,
      content: [{ type: "text" as const, text: prompt }]
    });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ status: "failed", error: { code } });
    expect(serialized).not.toMatch(
      /private|ambiguous|unsafe|wrong-exit|credential|authentication|route not found|stderr/i
    );
  });

  it.each([
    ["missing-id", "PROVIDER_RESPONSE_INVALID"],
    ["duplicate-id", "PROVIDER_RESPONSE_INVALID"],
    ["unavailable", "PROVIDER_UNAVAILABLE"]
  ])("maps %s to a fixed sanitized public failure", async (prompt, code) => {
    const adapter = new HermesCliProviderAdapter(options());
    const result = await adapter.invoke({
      ...request,
      content: [{ type: "text" as const, text: prompt }]
    });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ status: "failed", error: { code } });
    expect(serialized).not.toMatch(/private|cookie|command|diagnostic|stderr|prompt/i);
  });

  it("maps a provider-specific missing session without exposing its raw identifier", async () => {
    const adapter = new HermesCliProviderAdapter(options());
    const result = await adapter.invoke({
      ...request,
      externalSessionRef: "external-session:hermes-does_not_exist",
      content: [{ type: "text" as const, text: "missing-session" }]
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_SESSION_NOT_FOUND" }
    });
    expect(JSON.stringify(result)).not.toMatch(/private-session|token|does_not_exist|stderr/i);
  });

  it("rejects a resumed response whose Session ID differs from the persisted ID", async () => {
    const adapter = new HermesCliProviderAdapter(options());
    const result = await adapter.invoke({
      ...request,
      externalSessionRef: "external-session:hermes-caller_session_11",
      content: [{ type: "text" as const, text: "mismatched-resume" }]
    });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_RESPONSE_INVALID" }
    });
    expect(serialized).not.toMatch(
      /caller_session_11|returned_other_session_99|private-mismatched-hermes-output|stderr/i
    );
  });

  it("maps a controlled timeout to PROVIDER_TIMEOUT", async () => {
    await writeFile(script, `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `, "utf8");
    const adapter = new HermesCliProviderAdapter(options());
    const result = await adapter.invoke({ ...request, timeoutMs: 100 });

    expect(result).toMatchObject({
      status: "timed_out",
      error: { code: "PROVIDER_TIMEOUT", category: "timeout" }
    });
  });
});
