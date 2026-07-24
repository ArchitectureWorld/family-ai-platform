import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_SYNC_EVENT_TYPES,
  SYNC_PROTOCOL_VERSION,
  knownSyncEventSchema,
  syncEventsResponseSchema,
  syncSseDataSchema
} from "@family-ai/contracts";
import { FakeProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { ChatWorkMessageService } from "../src/chatWorkMessageService.js";
import { ChatWorkProviderRepository } from "../src/chatWorkProvider.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";
import { formatDomainEventFrame } from "../src/eventStream.js";

const forbiddenPublicFragments = [
  "authorization",
  "entrysessiontoken",
  "entry_session_token",
  "devicecredential",
  "device_credential",
  "externalsessionref",
  "external_session_ref",
  "bearer "
] as const;

describe("Gateway known Event Sync producers", () => {
  let directory = "";
  let db: GatewayDatabase;
  let currentNow: Date;
  let events: DomainEventStore;
  let domain: ChatWorkDomainRepository;
  let provider: ChatWorkProviderRepository;
  let personRef = "";
  let deviceRef = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-sync-known-events-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const family = new FamilyDomainRepository(db);
    const onboarding = family.initializeFamily({
      familyName: "测试家庭",
      ownerName: "家庭创建者",
      deviceName: "测试电脑",
      deviceCredential: "sync-known-event-device-credential-with-enough-length"
    });
    personRef = onboarding.owner.personRef;
    deviceRef = onboarding.device.deviceRef;
    currentNow = new Date("2026-07-24T19:00:00.000Z");
    events = new DomainEventStore(db, () => currentNow);
    domain = new ChatWorkDomainRepository(db, () => currentNow);
    provider = new ChatWorkProviderRepository(db, () => currentNow);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("maps all seven current Gateway event types into one public REST and SSE contract", async () => {
    const chat = domain.ensureHomeChat({
      personRef,
      timezone: "UTC",
      localDate: "2026-07-24"
    });
    const adapter = new FakeProviderAdapter({
      failNext: true,
      clock: () => currentNow
    });
    const messages = new ChatWorkMessageService(
      domain,
      provider,
      adapter,
      () => currentNow
    );
    const input = {
      personRef,
      deviceRef,
      threadRef: chat.chat.threadRef,
      clientMessageId: "sync-known-event-message-0001",
      content: {
        type: "text" as const,
        text: "这段用户正文绝对不能进入公共事件。",
        language: "zh-CN"
      },
      occurredAt: currentNow.toISOString()
    };

    await expect(messages.sendPersonMessage(input)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE"
    });
    const personMessage = domain.listThreadMessages({
      personRef,
      threadRef: chat.chat.threadRef
    }).messages.find((message) => message.actor.type === "person");
    expect(personMessage).toBeTruthy();

    currentNow = new Date("2026-07-24T19:01:00.000Z");
    await messages.sendPersonMessage(input);

    currentNow = new Date("2026-07-24T19:02:00.000Z");
    const converted = domain.createWorkFromChat({
      personRef,
      title: "公开同步协议",
      goal: "验证七种正式事件",
      source: {
        homeChatStreamRef: chat.chat.homeChatStreamRef,
        dailyEpisodeRef: chat.currentEpisode?.dailyEpisodeRef ?? null,
        messageRefs: [personMessage!.messageRef]
      },
      decisions: ["使用统一 Event Sync Contract"],
      openQuestions: []
    });
    domain.saveWorkProgressSnapshot({
      personRef,
      snapshot: {
        workConversationRef: converted.conversation.workConversationRef,
        status: "waiting_confirmation",
        phaseSummary: "公共协议完成前验证",
        incompleteTasks: ["完成最终门禁"],
        risks: [],
        pendingConfirmations: ["确认合并"],
        deadlines: [],
        updatedAt: "2026-07-24T19:03:00.000Z"
      }
    });

    const internalEvents = events.listPersonEvents({ personRef, limit: 100 }).events;
    expect(new Set(internalEvents.map((event) => event.eventType)))
      .toEqual(new Set(KNOWN_SYNC_EVENT_TYPES));

    const publicEvents = internalEvents.map((event) => knownSyncEventSchema.parse(event));
    const response = syncEventsResponseSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      sync: {
        deviceRef,
        personRef,
        acknowledgedSequence: 0,
        requestedAfterSequence: 0,
        latestSequence: publicEvents.at(-1)?.eventSequence ?? 0
      },
      events: publicEvents,
      nextAfterSequence: null
    });
    expect(response.events).toEqual(publicEvents);

    for (const [index, event] of internalEvents.entries()) {
      const frame = formatDomainEventFrame(event);
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      expect(syncSseDataSchema.parse(JSON.parse(dataLine?.slice(6) ?? "null")))
        .toEqual(publicEvents[index]);
    }

    const failed = publicEvents.find(
      (event) => event.eventType === "thread.provider_turn.failed"
    );
    expect(failed?.payload.error.retryable).toBe(true);

    const serialized = JSON.stringify(response).toLowerCase();
    expect(serialized).not.toContain("这段用户正文绝对不能进入公共事件");
    expect(serialized).not.toContain("fake provider");
    expect(serialized).not.toContain("external-session:");
    for (const forbidden of forbiddenPublicFragments) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
