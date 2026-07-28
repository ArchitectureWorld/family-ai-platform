import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeProviderAdapter,
  ProviderAdapterRouter
} from "@family-ai/provider-adapter-sdk";
import { buildGatewayApp } from "../src/app.js";
import type { ConfiguredAgentRuntime } from "../src/agentManagement.js";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { openGatewayDatabase } from "../src/database.js";

const deviceToken = "family-onboarding-test-device-token-long-enough";
const ownerAdminRuntimes: readonly ConfiguredAgentRuntime[] = [
  {
    agentRef: "agent:hermes-jarvis",
    displayName: "Hermes Jarvis",
    providerProfileRef: "provider-profile:hermes-jarvis",
    providerKind: "hermes"
  },
  {
    agentRef: "agent:codex-cli",
    displayName: "Codex CLI",
    providerProfileRef: "provider-profile:codex-cli",
    providerKind: "codex"
  }
];
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

type EntryCredential = {
  entryBindingRef: string;
  entrySessionRef: string;
  token: string;
  audience: "family_admin" | "personal";
  agentRef: string;
};

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

function expectPublicError(
  response: { json(): unknown },
  expected: { code: string; category: string; retryable: boolean }
) {
  const body = response.json() as {
    error?: { code: string; category: string; message: string; retryable: boolean };
    code?: string;
    category?: string;
    message?: string;
    retryable?: boolean;
  };
  const error = body.error ?? body;
  expect(error).toMatchObject({
    code: expected.code,
    category: expected.category,
    message: expect.any(String),
    retryable: expected.retryable
  });
}

describe("Family onboarding and dual-entry sessions", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;

  async function openApp(configuredAgentRuntimes?: readonly ConfiguredAgentRuntime[]) {
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      ...(configuredAgentRuntimes === undefined ? {} : { configuredAgentRuntimes })
    });
  }

  async function initialize() {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      family: { familyRef: string; displayName: string };
      owner: { personRef: string; displayName: string };
      device: { deviceRef: string; displayName: string };
      entries: { admin: EntryCredential; personal: EntryCredential };
    };
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-onboarding-"));
    databasePath = join(directory, "gateway.sqlite");
    await openApp();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("starts with an empty formal Family domain and protects setup with the local bootstrap device", async () => {
    const status = await app.inject({ method: "GET", url: "/api/v1/onboarding/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ initialized: false });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    expect(unauthorized.statusCode).toBe(401);
    expectPublicError(unauthorized, {
      code: "DEVICE_AUTH_INVALID",
      category: "permission",
      retryable: false
    });
  });

  it("creates one owner Person with two independent entry sessions on one Device", async () => {
    const result = await initialize();

    expect(result.family).toMatchObject({ displayName: "测试家庭" });
    expect(result.owner).toMatchObject({ displayName: "家庭创建者" });
    expect(result.device).toMatchObject({ displayName: "测试电脑" });
    expect(result.family.familyRef).toMatch(/^family:/);
    expect(result.owner.personRef).toMatch(/^person:/);
    expect(result.device.deviceRef).toMatch(/^device:/);

    const admin = result.entries.admin;
    const personal = result.entries.personal;
    expect(admin).toMatchObject({
      audience: "family_admin",
      agentRef: "agent:family-manager"
    });
    expect(personal).toMatchObject({
      audience: "personal",
      agentRef: "agent:personal-assistant"
    });
    expect(admin.entryBindingRef).not.toBe(personal.entryBindingRef);
    expect(admin.entrySessionRef).not.toBe(personal.entrySessionRef);
    expect(admin.token).not.toBe(personal.token);
    expect(admin.token.length).toBeGreaterThanOrEqual(32);
    expect(personal.token.length).toBeGreaterThanOrEqual(32);

    const after = await app.inject({ method: "GET", url: "/api/v1/onboarding/status" });
    expect(after.json()).toEqual({ initialized: true });

    const adminContext = await app.inject({
      method: "GET",
      url: "/api/v1/portal/context",
      headers: entryHeaders(admin)
    });
    expect(adminContext.statusCode).toBe(200);
    expect(adminContext.json()).toMatchObject({
      protocolVersion: 1,
      audience: "family_admin",
      entrySessionRef: admin.entrySessionRef,
      family: { familyRef: result.family.familyRef, displayName: "测试家庭" },
      person: { personRef: result.owner.personRef, displayName: "家庭创建者" },
      membership: { familyRole: "owner" },
      device: { deviceRef: result.device.deviceRef, displayName: "测试电脑" },
      agent: { agentRef: "agent:family-manager", displayName: "家庭管家" }
    });
    expect(adminContext.body).not.toContain(admin.token);

    const personalContext = await app.inject({
      method: "GET",
      url: "/api/v1/portal/context",
      headers: entryHeaders(personal)
    });
    expect(personalContext.statusCode).toBe(200);
    expect(personalContext.json()).toMatchObject({
      protocolVersion: 1,
      audience: "personal",
      entrySessionRef: personal.entrySessionRef,
      family: { familyRef: result.family.familyRef },
      person: { personRef: result.owner.personRef },
      device: { deviceRef: result.device.deviceRef },
      mountedAgents: [{
        agentRef: "agent:personal-assistant",
        displayName: "个人助理",
        isDefault: true,
        status: "idle",
        statusLabel: "空闲"
      }],
      defaultAgentRef: "agent:personal-assistant"
    });
    expect(personalContext.json()).not.toHaveProperty("agent");
    expect(personalContext.body).not.toContain("activeTurnCount");
    expect(personalContext.body).not.toContain("lastCheckedAt");
    expect(personalContext.body).not.toContain("publicProblem");
    expect(personalContext.body).not.toContain(personal.token);

    expect(adminContext.json().person.personRef).toBe(personalContext.json().person.personRef);
    expect(adminContext.json().device.deviceRef).toBe(personalContext.json().device.deviceRef);
  });

  it("keeps fresh real-mode onboarding free of visible Fake defaults and mounts", async () => {
    await app.close();
    const router = new ProviderAdapterRouter(
      ownerAdminRuntimes.map(runtime => [
        runtime.providerProfileRef,
        new FakeProviderAdapter()
      ] as const)
    );
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      providerRouter: router,
      configuredAgentRuntimes: ownerAdminRuntimes,
      authoritativeAgentRuntimeCatalog: true
    });
    const result = await initialize();

    const adminContext = await app.inject({
      method: "GET",
      url: "/api/v1/portal/context",
      headers: entryHeaders(result.entries.admin)
    });
    expect(adminContext.statusCode).toBe(200);
    expect(adminContext.json()).toMatchObject({
      agent: {
        agentRef: "agent:hermes-jarvis",
        providerProfileRef: "provider-profile:hermes-jarvis"
      }
    });

    const personalContext = await app.inject({
      method: "GET",
      url: "/api/v1/portal/context",
      headers: entryHeaders(result.entries.personal)
    });
    expect(personalContext.statusCode).toBe(200);
    expect(personalContext.json()).toMatchObject({
      mountedAgents: [],
      defaultAgentRef: null
    });
    for (const providerProfileRef of [
      adminContext.json().agent.providerProfileRef,
      ...personalContext.json().mountedAgents.map(
        (mount: { providerProfileRef: string }) => mount.providerProfileRef
      )
    ]) {
      expect(() => router.resolve(providerProfileRef)).not.toThrow();
    }
    expect(adminContext.body).not.toContain("provider-profile:fake-local");
    expect(personalContext.body).not.toContain("provider-profile:fake-local");

    const createdMember = await app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: entryHeaders(result.entries.admin),
      payload: { displayName: "No Default Member", familyRole: "adult" }
    });
    expect(createdMember.statusCode).toBe(201);
    expect(createdMember.json().member.personalAssistant).toBeNull();
    const memberMounts = await app.inject({
      method: "GET",
      url: `/api/v1/admin/members/${createdMember.json().member.personRef}/agent-mounts`,
      headers: entryHeaders(result.entries.admin)
    });
    expect(memberMounts.statusCode).toBe(200);
    expect(memberMounts.json()).toMatchObject({
      mountedAgents: [],
      defaultAgentRef: null
    });

    const db = openGatewayDatabase(databasePath);
    expect(db.prepare(
      `SELECT status FROM agent_runtime_bindings
       WHERE provider_profile_ref = 'provider-profile:fake-local'
       ORDER BY agent_ref`
    ).all()).toEqual([{ status: "disabled" }, { status: "disabled" }]);
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM admin_agent_assignments
       WHERE status = 'active'`
    ).get()).toEqual({ count: 2 });
    db.close();
  });

  it("creates one active default Personal assignment during onboarding", async () => {
    const result = await initialize();
    await app.close();
    const db = openGatewayDatabase(databasePath);
    try {
      expect(db.prepare(
        `SELECT COUNT(*) AS count
         FROM assistant_assignments
         WHERE person_ref = ? AND status = ? AND is_default = 1`
      ).get(result.owner.personRef, "active")).toEqual({ count: 1 });
    } finally {
      db.close();
    }
    await openApp();
  });

  it("provisions configured owner Admin agents without changing Personal or cross-Person isolation", async () => {
    await app.close();
    await openApp(ownerAdminRuntimes);
    const result = await initialize();

    const member = await app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: entryHeaders(result.entries.admin),
      payload: { displayName: "另一位成人", familyRole: "adult" }
    });
    expect(member.statusCode).toBe(201);
    const otherPersonRef = member.json().member.personRef as string;

    await app.close();
    const db = openGatewayDatabase(databasePath);
    let otherThreadRef = "";
    try {
      expect(db.prepare(
        `SELECT agent_ref, provider_profile_ref, status
         FROM admin_agent_assignments
         WHERE family_ref = ? AND person_ref = ?
         ORDER BY agent_ref`
      ).all(result.family.familyRef, result.owner.personRef)).toEqual([
        {
          agent_ref: "agent:codex-cli",
          provider_profile_ref: "provider-profile:codex-cli",
          status: "active"
        },
        {
          agent_ref: "agent:hermes-jarvis",
          provider_profile_ref: "provider-profile:hermes-jarvis",
          status: "active"
        }
      ]);
      expect(db.prepare(
        `SELECT agent_ref, is_default
         FROM assistant_assignments
         WHERE person_ref = ? AND status = 'active'
         ORDER BY agent_ref`
      ).all(result.owner.personRef)).toEqual([
        { agent_ref: "agent:personal-assistant", is_default: 1 }
      ]);

      const chatWork = new ChatWorkDomainRepository(
        db,
        () => new Date("2026-07-28T10:00:00.000Z")
      );
      otherThreadRef = chatWork.ensureHomeChat({
        personRef: otherPersonRef,
        timezone: "UTC",
        localDate: "2026-07-28"
      }).chat.threadRef;
    } finally {
      db.close();
    }
    await openApp(ownerAdminRuntimes);

    const crossPersonRead = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${encodeURIComponent(otherThreadRef)}/messages`,
      headers: entryHeaders(result.entries.personal)
    });
    expect(crossPersonRead.statusCode).toBe(404);
    expectPublicError(crossPersonRead, {
      code: "THREAD_NOT_FOUND",
      category: "permission",
      retryable: false
    });
  });

  it("allows setup only once and rejects client-selected identity fields", async () => {
    await initialize();

    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "第二个家庭",
        ownerName: "另一个人",
        deviceName: "另一台电脑"
      }
    });
    expect(repeated.statusCode).toBe(409);
    expectPublicError(repeated, {
      code: "ONBOARDING_ALREADY_COMPLETED",
      category: "conflict",
      retryable: false
    });

    const forged = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "伪造家庭",
        ownerName: "伪造用户",
        deviceName: "伪造设备",
        personRef: "person:chosen-by-client",
        agentRef: "agent:chosen-by-client"
      }
    });
    expect(forged.statusCode).toBe(400);
    expectPublicError(forged, {
      code: "REQUEST_INVALID",
      category: "validation",
      retryable: false
    });
  });

  it("keeps member administration inside the family_admin audience", async () => {
    const result = await initialize();
    const { admin, personal } = result.entries;

    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/admin/members",
      headers: entryHeaders(admin)
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().members).toHaveLength(1);
    expect(initial.json().members[0]).toMatchObject({
      personRef: result.owner.personRef,
      displayName: "家庭创建者",
      familyRole: "owner"
    });

    for (const [displayName, familyRole] of [
      ["另一位成人", "adult"],
      ["孩子", "child"],
      ["长辈", "elder"]
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/admin/members",
        headers: entryHeaders(admin),
        payload: { displayName, familyRole }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().member).toMatchObject({
        displayName,
        familyRole,
        status: "active",
        personalAssistant: {
          agentRef: "agent:personal-assistant",
          displayName: "个人助理"
        },
        entryStatus: "unclaimed"
      });
    }

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/members",
      headers: entryHeaders(admin)
    });
    expect(listed.json().members).toHaveLength(4);

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/admin/members",
      headers: entryHeaders(personal)
    });
    expect(forbidden.statusCode).toBe(403);
    expectPublicError(forbidden, {
      code: "ENTRY_AUDIENCE_FORBIDDEN",
      category: "permission",
      retryable: false
    });
  });

  it("rejects invalid entry sessions and restores both sessions after Gateway restart", async () => {
    const result = await initialize();
    const { admin, personal } = result.entries;

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/portal/context",
      headers: {
        authorization: "Bearer not-the-right-entry-token",
        "x-entry-session-ref": admin.entrySessionRef
      }
    });
    expect(invalid.statusCode).toBe(401);
    expectPublicError(invalid, {
      code: "ENTRY_SESSION_INVALID",
      category: "permission",
      retryable: false
    });

    await app.close();
    await openApp();

    for (const [entry, expectedAudience] of [
      [admin, "family_admin"],
      [personal, "personal"]
    ] as const) {
      const context = await app.inject({
        method: "GET",
        url: "/api/v1/portal/context",
        headers: entryHeaders(entry)
      });
      expect(context.statusCode).toBe(200);
      expect(context.json()).toMatchObject({
        protocolVersion: 1,
        entrySessionRef: entry.entrySessionRef,
        person: { personRef: result.owner.personRef },
        device: { deviceRef: result.device.deviceRef }
      });
      if (expectedAudience === "family_admin") {
        expect(context.json()).toMatchObject({ agent: { agentRef: "agent:family-manager" } });
      } else {
        expect(context.json()).toMatchObject({
          mountedAgents: [{ agentRef: "agent:personal-assistant", isDefault: true }],
          defaultAgentRef: "agent:personal-assistant"
        });
        expect(context.json()).not.toHaveProperty("agent");
      }
    }
  });
});
