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

const deviceToken = "admin-workspace-routes-device-token-long-enough";
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

describe("Admin system workspace routes", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let admin: Entry;
  let ownerPersonRef = "";
  let jarvisAdapter: FakeProviderAdapter;
  let codexAdapter: FakeProviderAdapter;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-admin-workspace-routes-"));
    databasePath = join(directory, "gateway.sqlite");
    const now = () => new Date("2026-07-28T10:00:00.000Z");
    jarvisAdapter = new FakeProviderAdapter({ clock: now });
    codexAdapter = new FakeProviderAdapter({ clock: now });
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      configuredAgentRuntimes: runtimes,
      providerRouter: new ProviderAdapterRouter([
        ["provider-profile:hermes-jarvis", jarvisAdapter],
        ["provider-profile:codex-cli", codexAdapter]
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
    admin = initialized.json().entries.admin as Entry;
    ownerPersonRef = initialized.json().owner.personRef as string;
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function getChat(agentRef: string) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/admin/system-workspace/agents/${encodeURIComponent(agentRef)}/chat`,
      headers: entryHeaders(admin)
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      chat: { agentRef: string; threadRef: string };
    };
  }

  async function sendMessage(threadRef: string, suffix: string) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/system-workspace/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(admin),
      payload: {
        protocolVersion: 1,
        clientMessageId: `admin-workspace-${suffix}-0001`,
        occurredAt: "2026-07-28T10:00:00.000Z",
        content: { type: "text", text: `消息 ${suffix}`, language: "zh-CN" }
      }
    });
    expect(response.statusCode).toBe(201);
    return response;
  }

  async function listMessages(threadRef: string) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/admin/system-workspace/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(admin)
    });
    expect(response.statusCode).toBe(200);
    return response.json().messages as Array<Record<string, unknown>>;
  }

  it("creates one isolated Admin Chat per assigned Agent", async () => {
    const summary = await app.inject({
      method: "GET",
      url: "/api/v1/admin/system-workspace",
      headers: entryHeaders(admin)
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      protocolVersion: 1,
      agents: [
        { agentRef: "agent:codex-cli", displayName: "Codex CLI" },
        { agentRef: "agent:hermes-jarvis", displayName: "Hermes Jarvis" }
      ]
    });
    const jarvis = await getChat("agent:hermes-jarvis");
    const codex = await getChat("agent:codex-cli");
    expect(jarvis.chat.agentRef).toBe("agent:hermes-jarvis");
    expect(codex.chat.agentRef).toBe("agent:codex-cli");
    expect(jarvis.chat.threadRef).not.toBe(codex.chat.threadRef);
  });

  it("keeps Jarvis and Codex Provider Threads, actors, and Sessions isolated", async () => {
    const jarvis = await getChat("agent:hermes-jarvis");
    const codex = await getChat("agent:codex-cli");
    await sendMessage(jarvis.chat.threadRef, "jarvis");
    await sendMessage(codex.chat.threadRef, "codex");

    expect(await listMessages(jarvis.chat.threadRef)).toEqual([
      expect.objectContaining({
        actor: { type: "person", personRef: ownerPersonRef },
        origin: expect.objectContaining({ entryAudience: "family_admin" })
      }),
      expect.objectContaining({
        actor: {
          type: "agent",
          agentRef: "agent:hermes-jarvis",
          providerProfileRef: "provider-profile:hermes-jarvis"
        },
        origin: {
          deviceRef: null,
          connectionRef: null,
          entryAudience: "family_admin"
        }
      })
    ]);
    expect(await listMessages(codex.chat.threadRef)).toEqual([
      expect.objectContaining({
        actor: { type: "person", personRef: ownerPersonRef },
        origin: expect.objectContaining({ entryAudience: "family_admin" })
      }),
      expect.objectContaining({
        actor: {
          type: "agent",
          agentRef: "agent:codex-cli",
          providerProfileRef: "provider-profile:codex-cli"
        }
      })
    ]);
    expect(jarvisAdapter.calls).toHaveLength(1);
    expect(codexAdapter.calls).toHaveLength(1);
    expect(jarvisAdapter.calls[0]?.providerProfileRef).toBe(
      "provider-profile:hermes-jarvis"
    );
    expect(codexAdapter.calls[0]?.providerProfileRef).toBe(
      "provider-profile:codex-cli"
    );

    const db = openGatewayDatabase(databasePath);
    try {
      const contexts = db.prepare(
        `SELECT thread_ref, assignment_ref, agent_ref, provider_profile_ref,
                entry_audience, external_session_ref
         FROM thread_provider_contexts
         WHERE thread_ref IN (?, ?)
         ORDER BY agent_ref`
      ).all(jarvis.chat.threadRef, codex.chat.threadRef) as Array<Record<string, unknown>>;
      expect(contexts).toHaveLength(2);
      expect(contexts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          thread_ref: jarvis.chat.threadRef,
          assignment_ref: null,
          agent_ref: "agent:hermes-jarvis",
          provider_profile_ref: "provider-profile:hermes-jarvis",
          entry_audience: "family_admin"
        }),
        expect.objectContaining({
          thread_ref: codex.chat.threadRef,
          assignment_ref: null,
          agent_ref: "agent:codex-cli",
          provider_profile_ref: "provider-profile:codex-cli",
          entry_audience: "family_admin"
        })
      ]));
      expect(contexts[0]?.external_session_ref).not.toBe(
        contexts[1]?.external_session_ref
      );
    } finally {
      db.close();
    }
  });

  it("creates, lists, messages, and reads progress for one Agent Work only", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/system-workspace/agents/agent%3Ahermes-jarvis/work-conversations",
      headers: entryHeaders(admin),
      payload: {
        protocolVersion: 1,
        title: "Jarvis 运维 Work",
        goal: "只属于 Jarvis Admin Workspace"
      }
    });
    expect(created.statusCode).toBe(201);
    const work = created.json().conversation as {
      workConversationRef: string;
      threadRef: string;
      agentRef: string;
    };
    expect(work.agentRef).toBe("agent:hermes-jarvis");

    const jarvisWorks = await app.inject({
      method: "GET",
      url: "/api/v1/admin/system-workspace/agents/agent%3Ahermes-jarvis/work-conversations",
      headers: entryHeaders(admin)
    });
    const codexWorks = await app.inject({
      method: "GET",
      url: "/api/v1/admin/system-workspace/agents/agent%3Acodex-cli/work-conversations",
      headers: entryHeaders(admin)
    });
    expect(jarvisWorks.statusCode).toBe(200);
    expect(jarvisWorks.json().conversations).toEqual([
      expect.objectContaining({ workConversationRef: work.workConversationRef })
    ]);
    expect(codexWorks.statusCode).toBe(200);
    expect(codexWorks.json().conversations).toEqual([]);
    await sendMessage(work.threadRef, "jarvis-work");

    const db = openGatewayDatabase(databasePath);
    try {
      db.prepare(
        `INSERT INTO work_progress_snapshots
         (work_conversation_ref, status, phase_summary, incomplete_tasks_json, risks_json,
          pending_confirmations_json, deadlines_json, updated_at)
         VALUES(?, 'active', ?, '[]', '[]', '[]', '[]', ?)`
      ).run(
        work.workConversationRef,
        "正在验证 Admin Work",
        "2026-07-28T10:00:00.000Z"
      );
    } finally {
      db.close();
    }
    const progress = await app.inject({
      method: "GET",
      url: `/api/v1/admin/system-workspace/work-conversations/${
        encodeURIComponent(work.workConversationRef)
      }/progress`,
      headers: entryHeaders(admin)
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({
      protocolVersion: 1,
      snapshot: {
        workConversationRef: work.workConversationRef,
        phaseSummary: "正在验证 Admin Work"
      }
    });
  });
});
