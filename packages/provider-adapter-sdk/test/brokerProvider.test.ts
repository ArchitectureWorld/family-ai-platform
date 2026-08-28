import { mkdtemp, rm } from "node:fs/promises";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderInvocationRequest } from "@family-ai/contracts";
import { BrokerProviderAdapter } from "../src/brokerProvider.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

const providerRequest: ProviderInvocationRequest = {
  protocolVersion: "1.0",
  invocationRef: "invocation:broker-adapter-1",
  correlationRef: "correlation:broker-adapter-1",
  idempotencyKey: "device:test:message:broker-adapter-1",
  requestedAt: "2026-08-28T12:00:00.000Z",
  providerProfileRef: "provider-profile:broker-zzh",
  targetAgentRef: "agent:hermes-zzh",
  conversationRef: "conversation:broker-adapter-1",
  content: [
    { type: "text", text: "SENTINEL_PRIVATE_PROMPT?token=never-in-url" },
    { type: "text", text: "第二段" }
  ],
  timeoutMs: 2_000
};

function brokerResult(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    invocationRef: providerRequest.invocationRef,
    correlationRef: providerRequest.correlationRef,
    status: "succeeded",
    output: "来自于途的回复",
    completedAt: "2026-08-28T12:00:01.000Z",
    externalSessionRef: "external-session:hermes-zzh-session-42",
    ...overrides
  };
}

async function startUdsServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "broker-provider-adapter-"));
  temporaryDirectories.push(root);
  const socketPath = join(root, "broker.sock");
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return socketPath;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function adapter(
  socketPath: string,
  options: { maxResponseBytes?: number; maxDeadlineMs?: number } = {}
): BrokerProviderAdapter {
  return new BrokerProviderAdapter({
    socketPath,
    targetAgentRef: "agent:hermes-zzh",
    providerProfileRef: "provider-profile:broker-zzh",
    clock: () => new Date("2026-08-28T12:00:02.000Z"),
    ...options
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("BrokerProviderAdapter", () => {
  it("sends only the strict bounded Family projection in the UDS body", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    const socketPath = await startUdsServer((request, response) => {
      capturedUrl = request.url ?? "";
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        sendJson(response, 200, brokerResult());
      });
    });

    const result = await adapter(socketPath).invoke(providerRequest);

    expect(capturedUrl).toBe("/v1/invocations");
    expect(capturedUrl).not.toContain("SENTINEL_PRIVATE_PROMPT");
    expect(capturedBody).toEqual({
      protocolVersion: 1,
      invocationRef: "invocation:broker-adapter-1",
      correlationRef: "correlation:broker-adapter-1",
      product: "family",
      actorContextRef: "actor-context:broker-adapter-1",
      agentRef: "agent:hermes-zzh",
      localSessionRef: "local-session:broker-adapter-1",
      prompt: "SENTINEL_PRIVATE_PROMPT?token=never-in-url\n\n第二段",
      timeoutMs: 2_000
    });
    expect(result).toEqual({
      protocolVersion: "1.0",
      invocationRef: providerRequest.invocationRef,
      correlationRef: providerRequest.correlationRef,
      status: "succeeded",
      completedAt: "2026-08-28T12:00:01.000Z",
      output: [{ type: "text", text: "来自于途的回复" }],
      externalSessionRef: "external-session:hermes-zzh-session-42"
    });
  });

  it("preserves an Agent-scoped external session only in the UDS body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const socketPath = await startUdsServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        capturedBody = JSON.parse(
          Buffer.concat(chunks).toString("utf8")
        ) as Record<string, unknown>;
        sendJson(response, 200, brokerResult());
      });
    });

    await adapter(socketPath).invoke({
      ...providerRequest,
      externalSessionRef: "external-session:hermes-zzh-session-42"
    });

    expect(capturedBody?.externalSessionRef).toBe(
      "external-session:hermes-zzh-session-42"
    );
  });

  it("rejects a malformed scoped session before opening a Broker invocation", async () => {
    let calls = 0;
    const socketPath = await startUdsServer((_request, response) => {
      calls += 1;
      sendJson(response, 200, brokerResult());
    });

    const result = await adapter(socketPath).invoke({
      ...providerRequest,
      externalSessionRef: "external-session:hermes-zzh-"
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_RESPONSE_INVALID" }
    });
    expect(calls).toBe(0);
  });

  it.each([
    ["mismatched invocation", brokerResult({ invocationRef: "invocation:other" })],
    ["mismatched correlation", brokerResult({ correlationRef: "correlation:other" })],
    ["wrong Agent session", brokerResult({
      externalSessionRef: "external-session:hermes-nsy-session-42"
    })],
    ["extra field", brokerResult({ privateHome: "/private/hermes/home" })]
  ])("rejects a %s response without reflecting private material", async (_label, body) => {
    const socketPath = await startUdsServer((_request, response) => {
      sendJson(response, 200, body);
    });

    const result = await adapter(socketPath).invoke(providerRequest);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_RESPONSE_INVALID" }
    });
    expect(JSON.stringify(result)).not.toMatch(/other|privateHome|hermes\/home|session-42/i);
  });

  it.each([
    ["duplicate identity", `{"protocolVersion":1,"invocationRef":"${providerRequest.invocationRef}","invocationRef":"invocation:other","correlationRef":"${providerRequest.correlationRef}","status":"succeeded","output":"private duplicate","completedAt":"2026-08-28T12:00:01.000Z","externalSessionRef":"external-session:hermes-zzh-session-42"}`],
    ["truncated JSON", "{\"protocolVersion\":1"],
    ["non-JSON", "private stderr and token"]
  ])("rejects %s", async (_label, payload) => {
    const socketPath = await startUdsServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(payload);
    });

    const result = await adapter(socketPath).invoke(providerRequest);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_RESPONSE_INVALID" }
    });
    expect(JSON.stringify(result)).not.toMatch(/private|stderr|token|duplicate/i);
  });

  it("destroys an oversized Broker response and reports only a sanitized failure", async () => {
    const socketPath = await startUdsServer((_request, response) => {
      sendJson(response, 200, brokerResult({ output: "S".repeat(8_000) }));
    });

    const result = await adapter(socketPath, { maxResponseBytes: 1024 })
      .invoke(providerRequest);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_RESPONSE_INVALID" }
    });
    expect(JSON.stringify(result)).not.toContain("SSSSSSSS");
  });

  it.each([
    ["timed_out", "PROVIDER_TIMEOUT"],
    ["cancelled", "PROVIDER_CANCELLED"],
    ["failed", "PROVIDER_UNAVAILABLE"]
  ])("maps Broker %s to %s", async (status, code) => {
    const socketPath = await startUdsServer((_request, response) => {
      sendJson(response, 200, brokerResult({
        status,
        output: "private broker failure detail"
      }));
    });

    const result = await adapter(socketPath).invoke(providerRequest);

    expect(result).toMatchObject({ status, error: { code } });
    expect(result).not.toHaveProperty("output");
    expect(JSON.stringify(result)).not.toContain("private broker failure detail");
  });

  it("maps unavailable transport and HTTP availability errors without Fake fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "broker-provider-missing-"));
    temporaryDirectories.push(root);
    const unavailable = await adapter(join(root, "missing.sock")).invoke(
      providerRequest
    );
    expect(unavailable).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_UNAVAILABLE" }
    });
    expect(JSON.stringify(unavailable)).not.toContain(root);

    const socketPath = await startUdsServer((_request, response) => {
      sendJson(response, 503, {
        error: { code: "PRIVATE_BROKER_FAILURE", path: "/private/home" }
      });
    });
    const httpFailure = await adapter(socketPath).invoke(providerRequest);
    expect(httpFailure).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_UNAVAILABLE" }
    });
    expect(JSON.stringify(httpFailure)).not.toMatch(/PRIVATE_BROKER|private\/home/i);
  });

  it("enforces a total deadline and destroys the UDS request", async () => {
    let connectionClosed = false;
    const socketPath = await startUdsServer((request) => {
      request.once("aborted", () => {
        connectionClosed = true;
      });
    });

    const result = await adapter(socketPath, { maxDeadlineMs: 30 })
      .invoke(providerRequest);

    expect(result).toMatchObject({
      status: "timed_out",
      error: { code: "PROVIDER_TIMEOUT" }
    });
    await expect.poll(() => connectionClosed).toBe(true);
  });

  it("fails closed when Broker health is unavailable, invalid, or not Agent-specific", async () => {
    let healthBody: unknown = {
      status: "ok",
      agents: [{
        protocolVersion: 1,
        agentRef: "agent:hermes-zzh",
        displayName: "于途",
        kind: "agent",
        runtime: "hermes-local",
        status: "available",
        capabilities: ["chat"],
        system: false,
        observedAt: "2026-08-28T12:00:00.000Z"
      }]
    };
    const socketPath = await startUdsServer((request, response) => {
      expect(request.url).toBe("/v1/health");
      sendJson(response, 200, healthBody);
    });
    const broker = adapter(socketPath);

    await expect(broker.health()).resolves.toEqual({
      protocolVersion: "1.0",
      adapterRef: "adapter:agent-broker",
      status: "online",
      providerProfiles: ["provider-profile:broker-zzh"],
      checkedAt: "2026-08-28T12:00:02.000Z"
    });

    healthBody = {
      status: "ok",
      agents: [{
        protocolVersion: 1,
        agentRef: "agent:hermes-nsy",
        displayName: "乔晶晶",
        kind: "agent",
        runtime: "hermes-local",
        status: "available",
        capabilities: ["chat"],
        system: false,
        observedAt: "2026-08-28T12:00:00.000Z"
      }]
    };
    await expect(broker.health()).resolves.toMatchObject({ status: "offline" });
  });
});
