import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "family-onboarding-test-device-token-long-enough";
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

  async function openApp() {
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test"
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
      agent: { agentRef: "agent:personal-assistant", displayName: "个人助理" }
    });
    expect(personalContext.body).not.toContain(personal.token);

    expect(adminContext.json().person.personRef).toBe(personalContext.json().person.personRef);
    expect(adminContext.json().device.deviceRef).toBe(personalContext.json().device.deviceRef);
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

    for (const [entry, expectedAgent] of [
      [admin, "agent:family-manager"],
      [personal, "agent:personal-assistant"]
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
        device: { deviceRef: result.device.deviceRef },
        agent: { agentRef: expectedAgent }
      });
    }
  });
});
