import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeProviderAdapter,
  ProviderAdapterRouter
} from "@family-ai/provider-adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import type { ConfiguredAgentRuntime } from "../src/agentManagement.js";
import { openGatewayDatabase } from "../src/database.js";

const deviceToken = "admin-workspace-privacy-device-token-long-enough";
const runtimes: readonly ConfiguredAgentRuntime[] = [
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

type Entry = { entrySessionRef: string; token: string };

function entryHeaders(entry: Entry) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

describe("Admin system workspace privacy", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let admin: Entry;
  let personal: Entry;
  let familyRef = "";
  let ownerPersonRef = "";

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-admin-workspace-privacy-"));
    databasePath = join(directory, "gateway.sqlite");
    const now = () => new Date("2026-07-28T10:00:00.000Z");
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      configuredAgentRuntimes: runtimes,
      providerRouter: new ProviderAdapterRouter([
        ["provider-profile:hermes-jarvis", new FakeProviderAdapter({ clock: now })],
        ["provider-profile:codex-cli", new FakeProviderAdapter({ clock: now })]
      ]),
      now
    });
    const initialized = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    expect(initialized.statusCode).toBe(201);
    const body = initialized.json() as {
      family: { familyRef: string };
      owner: { personRef: string };
      entries: { admin: Entry; personal: Entry };
    };
    admin = body.entries.admin;
    personal = body.entries.personal;
    familyRef = body.family.familyRef;
    ownerPersonRef = body.owner.personRef;
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects Personal credentials on every Admin workspace route", async () => {
    const requests = [
      { method: "GET", url: "/api/v1/admin/system-workspace" },
      {
        method: "GET",
        url: "/api/v1/admin/system-workspace/agents/agent%3Ahermes-jarvis/chat"
      },
      {
        method: "GET",
        url: "/api/v1/admin/system-workspace/agents/agent%3Ahermes-jarvis/work-conversations"
      },
      {
        method: "POST",
        url: "/api/v1/admin/system-workspace/agents/agent%3Ahermes-jarvis/work-conversations",
        payload: {
          protocolVersion: 1,
          title: "禁止",
          goal: "Personal 不可创建",
          personRef: ownerPersonRef,
          familyRef,
          providerProfileRef: "provider-profile:hermes-jarvis"
        }
      },
      {
        method: "GET",
        url: "/api/v1/admin/system-workspace/threads/thread%3Aprivacy/messages"
      },
      {
        method: "POST",
        url: "/api/v1/admin/system-workspace/threads/thread%3Aprivacy/messages",
        payload: {
          protocolVersion: 1,
          clientMessageId: "privacy-message-0001",
          occurredAt: "2026-07-28T10:00:00.000Z",
          content: { type: "text", text: "禁止", language: "zh-CN" },
          personRef: ownerPersonRef,
          familyRef,
          providerProfileRef: "provider-profile:hermes-jarvis"
        }
      },
      {
        method: "GET",
        url: "/api/v1/admin/system-workspace/work-conversations/work%3Aprivacy/progress"
      }
    ] as const;

    for (const request of requests) {
      const response = await app.inject({
        ...request,
        headers: entryHeaders(personal)
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
      expect(response.body).not.toContain("provider-profile:");
      expect(response.body).not.toContain("assignment:");
      expect(response.body).not.toContain("content_text");
    }
  });

  it("rejects client-selected Person, Family, Provider, and Agent identities", async () => {
    const work = await app.inject({
      method: "POST",
      url: "/api/v1/admin/system-workspace/agents/agent%3Ahermes-jarvis/work-conversations",
      headers: entryHeaders(admin),
      payload: {
        protocolVersion: 1,
        title: "伪造身份",
        goal: "必须拒绝",
        personRef: "person:forged",
        familyRef: "family:forged",
        agentRef: "agent:codex-cli",
        providerProfileRef: "provider-profile:codex-cli"
      }
    });
    expect(work.statusCode).toBe(400);
    expect(work.body).not.toContain("provider-profile:");
  });

  it("hides Personal Threads and another Person's Admin Threads", async () => {
    const personalChat = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    expect(personalChat.statusCode).toBe(200);
    const personalThreadRef = personalChat.json().chat.threadRef as string;

    const member = await app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: entryHeaders(admin),
      payload: { displayName: "另一位成人", familyRole: "adult" }
    });
    expect(member.statusCode).toBe(201);
    const otherPersonRef = member.json().member.personRef as string;
    const otherAdminThreadRef = "thread:other-admin-thread";
    const db = openGatewayDatabase(databasePath);
    try {
      db.prepare(
        `INSERT INTO admin_agent_assignments
         (assignment_ref, family_ref, person_ref, agent_ref, provider_profile_ref,
          status, effective_from, effective_to)
         VALUES(?, ?, ?, ?, ?, 'active', ?, NULL)`
      ).run(
        "assignment:other-admin-jarvis",
        familyRef,
        otherPersonRef,
        "agent:hermes-jarvis",
        "provider-profile:hermes-jarvis",
        "2026-07-28T10:00:00.000Z"
      );
      db.prepare(
        `INSERT INTO interaction_threads
         (thread_ref, person_ref, family_ref, agent_ref, entry_audience,
          thread_kind, last_sequence, created_at, last_active_at)
         VALUES(?, ?, ?, ?, 'family_admin', 'home_chat', 0, ?, ?)`
      ).run(
        otherAdminThreadRef,
        otherPersonRef,
        familyRef,
        "agent:hermes-jarvis",
        "2026-07-28T10:00:00.000Z",
        "2026-07-28T10:00:00.000Z"
      );
    } finally {
      db.close();
    }

    for (const threadRef of [personalThreadRef, otherAdminThreadRef]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/system-workspace/threads/${
          encodeURIComponent(threadRef)
        }/messages`,
        headers: entryHeaders(admin)
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("provider-profile:");
      expect(response.body).not.toContain("assignment:");
      expect(response.body).not.toContain("content_text");
    }
  });
});
