import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";

const bootstrapToken = "hermes-integration-bootstrap-token-with-safe-length";
const hermesKey = "hermes-integration-secret-key-with-safe-length";
const now = () => new Date("2026-07-25T13:00:00.000Z");
const directories: string[] = [];

type EntryCredential = { entrySessionRef: string; token: string };

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

function completion(text: string) {
  return new Response(JSON.stringify({
    object: "chat.completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop"
    }]
  }), { status: 200 });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Gateway Hermes Provider integration", () => {
  it("persists real Assistant turns, continues one Thread Session and isolates Work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "family-ai-hermes-integration-"));
    directories.push(directory);
    const databasePath = join(directory, "gateway.sqlite");
    const sessionIds: string[] = [];
    const idempotencyKeys: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${hermesKey}`);
      expect(headers.get("x-hermes-session-key")).toBe("family-ai:hermes:zzh");
      const sessionId = headers.get("x-hermes-session-id");
      const idempotencyKey = headers.get("idempotency-key");
      expect(sessionId).toMatch(/^external-session:hermes-[a-f0-9]{48}$/);
      expect(idempotencyKey).toMatch(/^thread-turn:/);
      sessionIds.push(String(sessionId));
      idempotencyKeys.push(String(idempotencyKey));
      return completion(`Hermes 于途第 ${sessionIds.length} 轮回复。`);
    }) as typeof fetch;
    const providerAdapter = new HermesProviderAdapter({
      profiles: [{
        providerProfileRef: "provider-profile:hermes-zzh",
        baseUrl: "http://host.docker.internal:8651",
        apiKey: hermesKey,
        model: "zzh",
        sessionKey: "family-ai:hermes:zzh"
      }],
      fetchImpl,
      clock: now
    });
    const app = await buildGatewayApp({
      databasePath,
      deviceToken: bootstrapToken,
      mode: "test",
      providerAdapter,
      now
    });

    try {
      const onboarding = await app.inject({
        method: "POST",
        url: "/api/v1/onboarding/family",
        headers: {
          authorization: `Bearer ${bootstrapToken}`,
          "x-device-ref": "device:test"
        },
        payload: {
          familyName: "Hermes 测试家庭",
          ownerName: "Alice",
          deviceName: "家庭服务器"
        }
      });
      expect(onboarding.statusCode).toBe(201);
      const initialized = onboarding.json() as {
        owner: { personRef: string };
        entries: { personal: EntryCredential };
      };

      const database = openGatewayDatabase(databasePath);
      try {
        database.prepare(
          `INSERT INTO provider_profiles
           (provider_profile_ref, provider_kind, display_name, created_at)
           VALUES(?, 'hermes', ?, ?)`
        ).run("provider-profile:hermes-zzh", "Hermes zzh", now().toISOString());
        database.prepare(
          "INSERT INTO agents(agent_ref, display_name, created_at) VALUES(?, ?, ?)"
        ).run("agent:yutu", "于途", now().toISOString());
        database.prepare(
          `UPDATE assistant_assignments
           SET agent_ref = ?, provider_profile_ref = ?
           WHERE person_ref = ? AND status = 'active'`
        ).run(
          "agent:yutu",
          "provider-profile:hermes-zzh",
          initialized.owner.personRef
        );
      } finally {
        database.close();
      }

      const headers = entryHeaders(initialized.entries.personal);
      const homeResponse = await app.inject({
        method: "GET",
        url: "/api/v1/chat?timezone=UTC",
        headers
      });
      expect(homeResponse.statusCode).toBe(200);
      const home = homeResponse.json() as { chat: { threadRef: string } };

      for (const [index, text] of ["第一轮", "第二轮"].entries()) {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/threads/${encodeURIComponent(home.chat.threadRef)}/messages`,
          headers,
          payload: {
            protocolVersion: 1,
            clientMessageId: `web:hermes-chat-${index + 1}`,
            occurredAt: `2026-07-25T13:00:0${index}.000Z`,
            content: { type: "text", text, language: "zh-CN" }
          }
        });
        expect(response.statusCode).toBe(201);
      }

      const workResponse = await app.inject({
        method: "POST",
        url: "/api/v1/work-conversations",
        headers,
        payload: {
          protocolVersion: 1,
          title: "独立 Hermes Work",
          goal: "验证 Work Session 隔离"
        }
      });
      expect(workResponse.statusCode).toBe(201);
      const work = workResponse.json() as {
        conversation: { threadRef: string; workConversationRef: string };
      };
      const workSend = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${encodeURIComponent(work.conversation.threadRef)}/messages`,
        headers,
        payload: {
          protocolVersion: 1,
          clientMessageId: "web:hermes-work-1",
          occurredAt: "2026-07-25T13:00:02.000Z",
          content: { type: "text", text: "Work 第一轮", language: "zh-CN" }
        }
      });
      expect(workSend.statusCode).toBe(201);

      expect(sessionIds).toHaveLength(3);
      expect(sessionIds[1]).toBe(sessionIds[0]);
      expect(sessionIds[2]).not.toBe(sessionIds[0]);
      expect(new Set(idempotencyKeys).size).toBe(3);

      const messages = await app.inject({
        method: "GET",
        url: `/api/v1/threads/${encodeURIComponent(home.chat.threadRef)}/messages?limit=100`,
        headers
      });
      expect(messages.statusCode).toBe(200);
      expect((messages.json() as {
        messages: Array<{ actor: { type: string }; content: { text: string } }>;
      }).messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          actor: { type: "assistant", assignmentRef: expect.any(String), agentRef: "agent:yutu", providerProfileRef: "provider-profile:hermes-zzh" },
          content: { type: "text", text: "Hermes 于途第 1 轮回复。" }
        }),
        expect.objectContaining({
          actor: { type: "assistant", assignmentRef: expect.any(String), agentRef: "agent:yutu", providerProfileRef: "provider-profile:hermes-zzh" },
          content: { type: "text", text: "Hermes 于途第 2 轮回复。" }
        })
      ]));

      const verificationDatabase = openGatewayDatabase(databasePath);
      try {
        const contexts = verificationDatabase.prepare(
          `SELECT thread_ref, external_session_ref
           FROM thread_provider_contexts ORDER BY thread_ref`
        ).all() as Array<{ thread_ref: string; external_session_ref: string }>;
        expect(contexts).toHaveLength(2);
        expect(new Set(contexts.map((context) => context.external_session_ref)).size).toBe(2);
        const serialized = JSON.stringify(
          verificationDatabase.prepare(
            `SELECT provider_profile_ref, display_name FROM provider_profiles
             UNION ALL
             SELECT agent_ref, display_name FROM agents`
          ).all()
        );
        expect(serialized).not.toContain(hermesKey);
        expect(serialized).not.toContain("host.docker.internal");
      } finally {
        verificationDatabase.close();
      }
    } finally {
      await app.close();
    }
  });
});
