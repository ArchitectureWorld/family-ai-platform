import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminAgentCatalogResponseSchema,
  memberAgentMountsResponseSchema
} from "@family-ai/contracts";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";

const deviceToken = "agent-routes-test-device-token-long-enough";
const configuredAgentRuntimes = [{
  agentRef: "agent:codex-cli",
  displayName: "Codex CLI",
  providerProfileRef: "provider-profile:codex-cli",
  providerKind: "codex" as const
}];
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

type Entry = { entrySessionRef: string; token: string };

function entryHeaders(entry: Entry) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

function expectBoundedAgentError(
  response: { statusCode: number; body: string; json(): unknown },
  code: "AGENT_RUNTIME_UNAVAILABLE" | "AGENT_NOT_MOUNTED"
) {
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({
    code,
    category: "conflict",
    message: expect.any(String),
    retryable: false
  });
  expect(response.body).not.toContain("provider-profile");
  expect(response.body).not.toContain("assignment:");
  expect(response.body).not.toContain("content_text");
}

describe("Admin Agent routes", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let admin: Entry;
  let personal: Entry;
  let personRef = "";

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-agent-routes-"));
    databasePath = join(directory, "gateway.sqlite");
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      configuredAgentRuntimes
    });
    const initialized = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: { familyName: "测试家庭", ownerName: "家庭创建者", deviceName: "测试电脑" }
    });
    const body = initialized.json() as {
      owner: { personRef: string };
      entries: { admin: Entry; personal: Entry };
    };
    expect(initialized.statusCode).toBe(201);
    personRef = body.owner.personRef;
    admin = body.entries.admin;
    personal = body.entries.personal;
  });

  function setRuntimeStatus(status: "active" | "disabled") {
    const db = openGatewayDatabase(databasePath);
    try {
      db.prepare(
        "UPDATE agent_runtime_bindings SET status = ? WHERE agent_ref = ?"
      ).run(status, "agent:codex-cli");
    } finally {
      db.close();
    }
  }

  function codexAssignment() {
    const db = openGatewayDatabase(databasePath);
    try {
      return db.prepare(
        `SELECT status, is_default
         FROM assistant_assignments
         WHERE person_ref = ? AND agent_ref = ?`
      ).get(personRef, "agent:codex-cli");
    } finally {
      db.close();
    }
  }

  async function mountCodex() {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/agent-mounts`,
      headers: entryHeaders(admin),
      payload: { agentRef: "agent:codex-cli" }
    });
    expect(response.statusCode).toBe(201);
  }

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("allows only family_admin to list the safe configured catalog", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/agents",
      headers: entryHeaders(admin)
    });
    expect(listed.statusCode).toBe(200);
    expect(adminAgentCatalogResponseSchema.parse(listed.json()).agents).toEqual(
      expect.arrayContaining([expect.objectContaining({
        agentRef: "agent:codex-cli",
        status: "problem",
        statusLabel: "有问题",
        activeTurnCount: 0,
        publicProblem: "Agent 状态尚未初始化。"
      })])
    );
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/admin/agents",
      headers: entryHeaders(personal)
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain("content_text");
  });

  it("mounts idempotently and allows a family_admin to clear a default", async () => {
    const mountUrl = `/api/v1/admin/members/${encodeURIComponent(personRef)}/agent-mounts`;
    const mounted = await app.inject({
      method: "POST",
      url: mountUrl,
      headers: entryHeaders(admin),
      payload: { agentRef: "agent:codex-cli" }
    });
    expect(mounted.statusCode).toBe(201);
    const first = memberAgentMountsResponseSchema.parse(mounted.json());
    const replay = await app.inject({
      method: "POST",
      url: mountUrl,
      headers: entryHeaders(admin),
      payload: { agentRef: "agent:codex-cli" }
    });
    expect(replay.statusCode).toBe(201);
    const second = memberAgentMountsResponseSchema.parse(replay.json());
    expect(second.mountedAgents.find((item) => item.agentRef === "agent:codex-cli")?.assignmentRef)
      .toBe(first.mountedAgents.find((item) => item.agentRef === "agent:codex-cli")?.assignmentRef);

    const cleared = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/default-agent`,
      headers: entryHeaders(admin),
      payload: { agentRef: null }
    });
    expect(cleared.statusCode).toBe(200);
    expect(memberAgentMountsResponseSchema.parse(cleared.json()).defaultAgentRef).toBeNull();
  });

  it("rejects personal mutations, cross-family members, and unconfigured Agents", async () => {
    const denied = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/agent-mounts/agent%3Acodex-cli`,
      headers: entryHeaders(personal)
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain("content_text");

    const foreign = await app.inject({
      method: "GET",
      url: "/api/v1/admin/members/person:other-family-member/agent-mounts",
      headers: entryHeaders(admin)
    });
    expect(foreign.statusCode).toBe(404);

    const unavailable = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/agent-mounts`,
      headers: entryHeaders(admin),
      payload: { agentRef: "agent:not-configured" }
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.body).not.toContain("provider-profile");
  });

  it("rejects absent, unconfigured, and disabled Agent deletes without ending a mount", async () => {
    const configuredAbsent = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/agent-mounts/agent%3Acodex-cli`,
      headers: entryHeaders(admin)
    });
    expectBoundedAgentError(configuredAbsent, "AGENT_NOT_MOUNTED");

    const unconfigured = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/agent-mounts/agent%3Anot-configured`,
      headers: entryHeaders(admin)
    });
    expectBoundedAgentError(unconfigured, "AGENT_RUNTIME_UNAVAILABLE");

    await mountCodex();
    setRuntimeStatus("disabled");
    const disabled = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/agent-mounts/agent%3Acodex-cli`,
      headers: entryHeaders(admin)
    });
    expectBoundedAgentError(disabled, "AGENT_RUNTIME_UNAVAILABLE");
    expect(codexAssignment()).toEqual({ status: "active", is_default: 0 });
  });

  it("rejects unconfigured and disabled non-null defaults without selecting a hidden mount", async () => {
    const unconfigured = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/default-agent`,
      headers: entryHeaders(admin),
      payload: { agentRef: "agent:not-configured" }
    });
    expectBoundedAgentError(unconfigured, "AGENT_RUNTIME_UNAVAILABLE");

    await mountCodex();
    setRuntimeStatus("disabled");
    const disabled = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/default-agent`,
      headers: entryHeaders(admin),
      payload: { agentRef: "agent:codex-cli" }
    });
    expectBoundedAgentError(disabled, "AGENT_RUNTIME_UNAVAILABLE");
    expect(codexAssignment()).toEqual({ status: "active", is_default: 0 });
  });
});
