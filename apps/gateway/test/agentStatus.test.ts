import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { ProviderAdapterRouter } from "@family-ai/provider-adapter-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openGatewayDatabase } from "../src/database.js";
import {
  AgentStatusService,
  statusFor,
  type AgentStatusInput
} from "../src/agentStatus.js";

const checkedAt = "2026-07-28T12:00:00.000Z";

function snapshot(input: Partial<AgentStatusInput> = {}) {
  return statusFor({
    runtime: "active",
    health: "online",
    pending: 0,
    stalePending: 0,
    latestFailedAt: null,
    latestSucceededAt: null,
    checkedAt,
    ...input
  });
}

describe("Agent status aggregation", () => {
  it("applies problem over working over idle precedence", () => {
    expect(snapshot({ health: "offline", pending: 2 }).status).toBe("problem");
    expect(snapshot({ pending: 2 }).status).toBe("working");
    expect(snapshot().status).toBe("idle");
    expect(snapshot({ pending: 2, stalePending: 1 }).status).toBe("problem");
  });

  it("publishes only bounded problem text without private diagnostics", () => {
    const result = snapshot({
      health: "offline",
      privateError: {
        error_json: "/private/runtime/provider-session:secret",
        externalSessionRef: "external-session:secret"
      }
    });

    expect(result.publicProblem).toBe("Agent 当前无法连接。");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("error_json");
    expect(serialized).not.toContain("external-session");
    expect(serialized).not.toContain("/home/");
  });

  it("uses the fixed stalled-turn problem for pending work past timeout and grace", () => {
    const result = snapshot({ pending: 1, stalePending: 1 });
    expect(result.status).toBe("problem");
    expect(result.publicProblem).toBe("Agent 任务执行超时。");
  });

  it("reports only the fixed recent-invocation problem", () => {
    const result = snapshot({
      latestSucceededAt: "2026-07-28T11:59:00.000Z",
      latestFailedAt: "2026-07-28T12:00:00.000Z"
    });
    expect(result.status).toBe("problem");
    expect(result.publicProblem).toBe("Agent 最近一次调用失败。");
  });
});

describe("AgentStatusService", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("caches adapter health for at most five seconds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "family-ai-agent-status-"));
    directories.push(directory);
    const db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    db.prepare(
      `INSERT INTO provider_profiles
       (provider_profile_ref, provider_kind, display_name, created_at)
       VALUES(?, 'fake', 'Fake', ?)`
    ).run("provider-profile:fake-local", checkedAt);
    db.prepare(
      "INSERT INTO agents(agent_ref, display_name, created_at) VALUES(?, 'Agent', ?)"
    ).run("agent:test", checkedAt);
    db.prepare(
      `INSERT INTO agent_runtime_bindings
       (agent_ref, provider_profile_ref, status, created_at, updated_at)
       VALUES(?, ?, 'active', ?, ?)`
    ).run(
      "agent:test",
      "provider-profile:fake-local",
      checkedAt,
      checkedAt
    );

    let current = new Date(checkedAt);
    const health = vi.fn(async () => ({
      protocolVersion: 1 as const,
      adapterRef: "adapter:fake-local",
      status: "online" as const,
      providerProfiles: ["provider-profile:fake-local"],
      checkedAt: current.toISOString()
    }));
    const provider: ProviderAdapter = {
      health,
      async invoke() {
        throw new Error("not used");
      }
    };
    const service = new AgentStatusService(
      db,
      ProviderAdapterRouter.single("provider-profile:fake-local", provider),
      { now: () => current }
    );

    expect((await service.snapshot("agent:test")).status).toBe("idle");
    current = new Date(current.getTime() + 4999);
    expect((await service.snapshot("agent:test")).status).toBe("idle");
    expect(health).toHaveBeenCalledTimes(1);
    current = new Date(current.getTime() + 1);
    expect((await service.snapshot("agent:test")).status).toBe("idle");
    expect(health).toHaveBeenCalledTimes(2);
    db.close();
  });
});
