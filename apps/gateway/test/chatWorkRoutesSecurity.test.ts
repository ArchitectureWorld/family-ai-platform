import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { openGatewayDatabase, sha256 } from "../src/database.js";

const deviceToken = "chat-work-security-bootstrap-device-token";
const testNow = new Date("2026-07-24T06:30:00.000Z");
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

interface EntryCredential {
  entrySessionRef: string;
  token: string;
}

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
  const body = response.json() as Record<string, unknown>;
  expect(body).toMatchObject({
    ...expected,
    message: expect.any(String)
  });
  expect(body).not.toHaveProperty("error");
  expect(body).not.toHaveProperty("protocolVersion");
}

describe("Chat Work HTTP route security", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let admin: EntryCredential;
  let personal: EntryCredential;
  let familyRef = "";
  let ownerPersonRef = "";
  let ownerDeviceRef = "";

  async function openApp(now: Date = testNow) {
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      now: () => now
    });
  }

  function createSecondPersonalEntry(input: {
    familyRef: string;
    personRef: string;
  }): EntryCredential & { deviceRef: string } {
    const db = openGatewayDatabase(databasePath);
    const now = testNow.toISOString();
    const expiresAt = "2026-08-24T06:30:00.000Z";
    const deviceRef = `device:${randomUUID()}`;
    const deviceBindingRef = `device-binding:${randomUUID()}`;
    const entryBindingRef = `entry-binding:${randomUUID()}`;
    const entrySessionRef = `entry-session:${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");

    db.transaction(() => {
      db.prepare(
        `INSERT INTO managed_devices
         (device_ref, display_name, terminal_type, platform, status, credential_hash,
          created_at, updated_at, revoked_at)
         VALUES(?, 'Second Web', 'web', 'test', 'active', ?, ?, ?, NULL)`
      ).run(deviceRef, sha256("second-device-credential"), now, now);
      db.prepare(
        `INSERT INTO device_bindings
         (device_binding_ref, device_ref, owner_scope, family_ref, person_ref,
          status, bound_at, revoked_at)
         VALUES(?, ?, 'person', ?, ?, 'active', ?, NULL)`
      ).run(deviceBindingRef, deviceRef, input.familyRef, input.personRef, now);
      db.prepare(
        `INSERT INTO entry_bindings
         (entry_binding_ref, device_ref, family_ref, person_ref, audience, status,
          bound_at, last_used_at)
         VALUES(?, ?, ?, ?, 'personal', 'active', ?, NULL)`
      ).run(entryBindingRef, deviceRef, input.familyRef, input.personRef, now);
      db.prepare(
        `INSERT INTO entry_sessions
         (entry_session_ref, entry_binding_ref, token_hash, status,
          created_at, expires_at, revoked_at)
         VALUES(?, ?, ?, 'active', ?, ?, NULL)`
      ).run(entrySessionRef, entryBindingRef, sha256(token), now, expiresAt);
    })();
    db.close();
    return { deviceRef, entrySessionRef, token };
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-route-security-"));
    databasePath = join(directory, "gateway.sqlite");
    await openApp();
    const onboarding = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    expect(onboarding.statusCode).toBe(201);
    const body = onboarding.json() as {
      family: { familyRef: string };
      owner: { personRef: string };
      device: { deviceRef: string };
      entries: { admin: EntryCredential; personal: EntryCredential };
    };
    familyRef = body.family.familyRef;
    ownerPersonRef = body.owner.personRef;
    ownerDeviceRef = body.device.deviceRef;
    admin = body.entries.admin;
    personal = body.entries.personal;
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires a personal Entry Session and keeps Chat Work errors in PublicError form", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC"
    });
    expect(missing.statusCode).toBe(401);
    expectPublicError(missing, {
      code: "ENTRY_SESSION_INVALID",
      category: "permission",
      retryable: false
    });

    const adminResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(admin)
    });
    expect(adminResponse.statusCode).toBe(403);
    expectPublicError(adminResponse, {
      code: "ENTRY_AUDIENCE_FORBIDDEN",
      category: "permission",
      retryable: false
    });

    const valid = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    expect(valid.statusCode).toBe(200);
  });

  it("rejects forged identity fields and unsupported Work protocol versions", async () => {
    for (const payload of [
      {
        protocolVersion: 1,
        title: "伪造 Work",
        goal: "不允许客户端指定 Person",
        personRef: "person:forged"
      },
      {
        protocolVersion: 1,
        title: "伪造 Work",
        goal: "不允许客户端指定 Agent",
        agentRef: "agent:forged"
      },
      {
        protocolVersion: 2,
        title: "错误版本",
        goal: "必须拒绝"
      }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/work-conversations",
        headers: entryHeaders(personal),
        payload
      });
      expect(response.statusCode).toBe(400);
      expectPublicError(response, {
        code: "REQUEST_INVALID",
        category: "validation",
        retryable: false
      });
    }
  });

  it("rejects client-selected actor, origin, connection and malformed message queries", async () => {
    const chat = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    const threadRef = chat.json().chat.threadRef as string;
    const base = {
      protocolVersion: 1,
      clientMessageId: "security-message-0001",
      occurredAt: "2026-07-24T06:31:00.000Z",
      content: { type: "text", text: "安全测试" }
    };

    for (const forged of [
      { actor: { type: "person", personRef: "person:forged" } },
      { origin: { deviceRef: "device:forged" } },
      { connectionRef: "connection:forged" },
      { deviceRef: "device:forged" },
      { protocolVersion: 2 }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
        headers: entryHeaders(personal),
        payload: { ...base, ...forged }
      });
      expect(response.statusCode).toBe(400);
      expectPublicError(response, {
        code: "REQUEST_INVALID",
        category: "validation",
        retryable: false
      });
    }

    for (const query of ["limit=0", "limit=201", "beforeSequence=0", "unknown=1"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages?${query}`,
        headers: entryHeaders(personal)
      });
      expect(response.statusCode).toBe(400);
      expectPublicError(response, {
        code: "REQUEST_INVALID",
        category: "validation",
        retryable: false
      });
    }

    const malformedThread = await app.inject({
      method: "GET",
      url: "/api/v1/threads/not-a-thread/messages",
      headers: entryHeaders(personal)
    });
    expect(malformedThread.statusCode).toBe(400);
    expectPublicError(malformedThread, {
      code: "REQUEST_INVALID",
      category: "validation",
      retryable: false
    });
  });

  it("rejects forged Chat-to-Work fields and hides missing progress", async () => {
    const forged = await app.inject({
      method: "POST",
      url: "/api/v1/chat/work-conversions",
      headers: entryHeaders(personal),
      payload: {
        protocolVersion: 1,
        title: "伪造转换",
        goal: "必须拒绝",
        personRef: "person:forged",
        source: {
          homeChatStreamRef: "home-chat:forged",
          dailyEpisodeRef: null,
          messageRefs: ["message:forged"]
        },
        decisions: [],
        openQuestions: []
      }
    });
    expect(forged.statusCode).toBe(400);
    expectPublicError(forged, {
      code: "REQUEST_INVALID",
      category: "validation",
      retryable: false
    });

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/work-conversations/work:not-present/progress",
      headers: entryHeaders(personal)
    });
    expect(missing.statusCode).toBe(404);
    expectPublicError(missing, {
      code: "WORK_PROGRESS_NOT_FOUND",
      category: "permission",
      retryable: false
    });

    const malformedWork = await app.inject({
      method: "GET",
      url: "/api/v1/work-conversations/not-a-work/progress",
      headers: entryHeaders(personal)
    });
    expect(malformedWork.statusCode).toBe(400);
    expectPublicError(malformedWork, {
      code: "REQUEST_INVALID",
      category: "validation",
      retryable: false
    });
  });

  it("prevents another Person from reading the owner's Thread, Work or progress", async () => {
    const chat = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    const ownerThreadRef = chat.json().chat.threadRef as string;

    const ownerWork = await app.inject({
      method: "POST",
      url: "/api/v1/work-conversations",
      headers: entryHeaders(personal),
      payload: {
        protocolVersion: 1,
        title: "Owner Work",
        goal: "验证跨 Person 隔离"
      }
    });
    expect(ownerWork.statusCode).toBe(201);
    const ownerWorkRef = ownerWork.json().conversation.workConversationRef as string;

    const member = await app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: entryHeaders(admin),
      payload: { displayName: "另一位成人", familyRole: "adult" }
    });
    expect(member.statusCode).toBe(201);
    const secondPersonRef = member.json().member.personRef as string;

    await app.close();
    const second = createSecondPersonalEntry({ familyRef, personRef: secondPersonRef });
    const db = openGatewayDatabase(databasePath);
    const repository = new ChatWorkDomainRepository(db, () => testNow);
    repository.saveWorkProgressSnapshot({
      personRef: ownerPersonRef,
      snapshot: {
        workConversationRef: ownerWorkRef,
        status: "active",
        phaseSummary: "Owner 私有进度",
        incompleteTasks: [],
        risks: [],
        pendingConfirmations: [],
        deadlines: [],
        updatedAt: testNow.toISOString()
      }
    });
    db.close();
    await openApp();

    const secondWorks = await app.inject({
      method: "GET",
      url: "/api/v1/work-conversations",
      headers: entryHeaders(second)
    });
    expect(secondWorks.statusCode).toBe(200);
    expect(secondWorks.json()).toEqual({ protocolVersion: 1, conversations: [] });

    for (const request of [
      {
        method: "GET" as const,
        url: `/api/v1/threads/${encodeURIComponent(ownerThreadRef)}/messages`
      },
      {
        method: "POST" as const,
        url: `/api/v1/threads/${encodeURIComponent(ownerThreadRef)}/messages`,
        payload: {
          protocolVersion: 1,
          clientMessageId: "cross-person-message-0001",
          occurredAt: "2026-07-24T06:31:00.000Z",
          content: { type: "text", text: "不应写入" }
        }
      }
    ]) {
      const response = await app.inject({
        ...request,
        headers: entryHeaders(second)
      });
      expect(response.statusCode).toBe(404);
      expectPublicError(response, {
        code: "THREAD_NOT_FOUND",
        category: "permission",
        retryable: false
      });
    }

    const hiddenProgress = await app.inject({
      method: "GET",
      url: `/api/v1/work-conversations/${encodeURIComponent(ownerWorkRef)}/progress`,
      headers: entryHeaders(second)
    });
    expect(hiddenProgress.statusCode).toBe(404);
    expectPublicError(hiddenProgress, {
      code: "WORK_PROGRESS_NOT_FOUND",
      category: "permission",
      retryable: false
    });
  });

  it("rejects expired sessions and revoked devices before Chat Work access", async () => {
    await app.close();
    let db = openGatewayDatabase(databasePath);
    db.prepare(
      "UPDATE entry_sessions SET expires_at = ? WHERE entry_session_ref = ?"
    ).run("2026-07-23T00:00:00.000Z", personal.entrySessionRef);
    db.close();
    await openApp();

    const expired = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    expect(expired.statusCode).toBe(401);
    expectPublicError(expired, {
      code: "ENTRY_SESSION_EXPIRED",
      category: "permission",
      retryable: false
    });

    await app.close();
    db = openGatewayDatabase(databasePath);
    db.prepare(
      `UPDATE entry_sessions
       SET status = 'active', expires_at = ?
       WHERE entry_session_ref = ?`
    ).run("2026-08-24T00:00:00.000Z", personal.entrySessionRef);
    db.prepare(
      "UPDATE managed_devices SET status = 'revoked', revoked_at = ? WHERE device_ref = ?"
    ).run("2026-07-24T06:40:00.000Z", ownerDeviceRef);
    db.close();
    await openApp(new Date("2026-07-24T06:40:00.000Z"));

    const revoked = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    expect(revoked.statusCode).toBe(403);
    expectPublicError(revoked, {
      code: "DEVICE_REVOKED",
      category: "permission",
      retryable: false
    });
    expect(revoked.body).not.toContain(personal.token);
    expect(revoked.body).not.toContain("SELECT");
  });
});
