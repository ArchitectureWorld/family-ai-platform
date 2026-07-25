import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeProviderAdapter,
  HermesProviderAdapter,
  ProviderAdapterRouter
} from "@family-ai/provider-adapter-sdk";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";

const bootstrapToken = "session-switch-bootstrap-token-with-safe-length";
const directories: string[] = [];

type EntryCredential = { entrySessionRef: string; token: string };

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Hermes assignment Session transition", () => {
  it("keeps the Home Chat while replacing the old Fake Session on the next turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "family-ai-session-switch-"));
    directories.push(directory);
    const databasePath = join(directory, "gateway.sqlite");
    const first = await buildGatewayApp({
      databasePath,
      deviceToken: bootstrapToken,
      mode: "test",
      providerAdapter: new FakeProviderAdapter({
        clock: () => new Date("2026-07-25T15:00:01.000Z")
      }),
      now: () => new Date("2026-07-25T15:00:00.000Z")
    });

    const onboarding = await first.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: {
        authorization: `Bearer ${bootstrapToken}`,
        "x-device-ref": "device:test"
      },
      payload: {
        familyName: "Session 切换家庭",
        ownerName: "Owner",
        deviceName: "家庭服务器"
      }
    });
    expect(onboarding.statusCode).toBe(201);
    const initialized = onboarding.json() as {
      entries: { personal: EntryCredential };
    };
    const headers = entryHeaders(initialized.entries.personal);
    const homeResponse = await first.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers
    });
    expect(homeResponse.statusCode).toBe(200);
    const threadRef = (homeResponse.json() as { chat: { threadRef: string } }).chat.threadRef;
    const firstSend = await first.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers,
      payload: {
        protocolVersion: 1,
        clientMessageId: "web:before-hermes-switch",
        occurredAt: "2026-07-25T15:00:00.000Z",
        content: { type: "text", text: "切换前消息", language: "zh-CN" }
      }
    });
    expect(firstSend.statusCode).toBe(201);
    await first.close();

    const before = openGatewayDatabase(databasePath);
    try {
      expect((before.prepare(
        `SELECT external_session_ref FROM thread_provider_contexts WHERE thread_ref = ?`
      ).get(threadRef) as { external_session_ref: string }).external_session_ref)
        .toMatch(/^external-session:fake-/);
    } finally {
      before.close();
    }

    const hermesSessionIds: string[] = [];
    const hermes = new HermesProviderAdapter({
      profiles: [
        {
          providerProfileRef: "provider-profile:hermes-jarvis",
          baseUrl: "http://hermes.test:8650",
          apiKey: "jarvis-session-switch-key-safe-length",
          model: "jarvis",
          sessionKey: "family-ai:hermes:jarvis"
        },
        {
          providerProfileRef: "provider-profile:hermes-zzh",
          baseUrl: "http://hermes.test:8651",
          apiKey: "zzh-session-switch-key-safe-length",
          model: "zzh",
          sessionKey: "family-ai:hermes:zzh"
        }
      ],
      fetchImpl: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const sessionId = new Headers(init?.headers).get("x-hermes-session-id");
        hermesSessionIds.push(String(sessionId));
        return new Response(JSON.stringify({
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "于途已接管这个 Chat。" },
            finish_reason: "stop"
          }]
        }), { status: 200 });
      }) as typeof fetch,
      clock: () => new Date("2026-07-25T15:01:01.000Z")
    });
    const router = new ProviderAdapterRouter([
      {
        providerProfileRefs: ["provider-profile:fake-local"],
        adapter: new FakeProviderAdapter()
      },
      {
        providerProfileRefs: [
          "provider-profile:hermes-jarvis",
          "provider-profile:hermes-zzh"
        ],
        adapter: hermes
      }
    ]);
    const second = await buildGatewayApp({
      databasePath,
      deviceToken: bootstrapToken,
      mode: "test",
      providerAdapter: router,
      assignmentPreset: "hermes-jarvis-yutu-v1",
      now: () => new Date("2026-07-25T15:01:00.000Z")
    });

    try {
      const restored = await second.inject({
        method: "GET",
        url: "/api/v1/chat",
        headers
      });
      expect(restored.statusCode).toBe(200);
      expect((restored.json() as { chat: { threadRef: string } }).chat.threadRef)
        .toBe(threadRef);

      const secondSend = await second.inject({
        method: "POST",
        url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
        headers,
        payload: {
          protocolVersion: 1,
          clientMessageId: "web:after-hermes-switch",
          occurredAt: "2026-07-25T15:01:00.000Z",
          content: { type: "text", text: "切换后消息", language: "zh-CN" }
        }
      });
      expect(secondSend.statusCode).toBe(201);
      expect(hermesSessionIds).toHaveLength(1);
      expect(hermesSessionIds[0]).toMatch(/^external-session:hermes-[a-f0-9]{48}$/);

      const messages = await second.inject({
        method: "GET",
        url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages?limit=100`,
        headers
      });
      expect(messages.statusCode).toBe(200);
      const history = (messages.json() as {
        messages: Array<{
          actor: { type: string; agentRef?: string; providerProfileRef?: string };
          content: { text: string };
        }>;
      }).messages;
      expect(history).toEqual(expect.arrayContaining([
        expect.objectContaining({
          actor: expect.objectContaining({
            type: "assistant",
            agentRef: "agent:personal-assistant",
            providerProfileRef: "provider-profile:fake-local"
          }),
          content: expect.objectContaining({ text: "Fake Provider 第 1 轮回复。" })
        }),
        expect.objectContaining({
          actor: expect.objectContaining({
            type: "assistant",
            agentRef: "agent:yutu",
            providerProfileRef: "provider-profile:hermes-zzh"
          }),
          content: expect.objectContaining({ text: "于途已接管这个 Chat。" })
        })
      ]));
    } finally {
      await second.close();
    }

    const after = openGatewayDatabase(databasePath);
    try {
      expect((after.prepare(
        `SELECT assignment_ref, agent_ref, provider_profile_ref, external_session_ref
         FROM thread_provider_contexts WHERE thread_ref = ?`
      ).get(threadRef) as {
        assignment_ref: string;
        agent_ref: string;
        provider_profile_ref: string;
        external_session_ref: string;
      })).toMatchObject({
        assignment_ref: expect.stringMatching(/^assignment:/),
        agent_ref: "agent:yutu",
        provider_profile_ref: "provider-profile:hermes-zzh",
        external_session_ref: expect.stringMatching(/^external-session:hermes-/)
      });
    } finally {
      after.close();
    }
  });
});
