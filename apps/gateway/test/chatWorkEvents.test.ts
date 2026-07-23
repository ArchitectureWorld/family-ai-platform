import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { ChatWorkMessageService } from "../src/chatWorkMessageService.js";
import { ChatWorkProviderRepository } from "../src/chatWorkProvider.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

describe("Chat Work durable events", () => {
  let directory = "";
  let db: GatewayDatabase;
  let currentNow: Date;
  let store: DomainEventStore;
  let domainRepository: ChatWorkDomainRepository;
  let providerRepository: ChatWorkProviderRepository;
  let ownerPersonRef = "";
  let ownerDeviceRef = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-events-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const family = new FamilyDomainRepository(db);
    const onboarding = family.initializeFamily({
      familyName: "测试家庭",
      ownerName: "家庭创建者",
      deviceName: "测试电脑",
      deviceCredential: "chat-work-event-device-credential-with-enough-length"
    });
    ownerPersonRef = onboarding.owner.personRef;
    ownerDeviceRef = onboarding.device.deviceRef;
    currentNow = new Date("2026-07-23T19:00:00.000Z");
    store = new DomainEventStore(db, () => currentNow);
    domainRepository = new ChatWorkDomainRepository(db, () => currentNow);
    providerRepository = new ChatWorkProviderRepository(db, () => currentNow);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function ownerMessage(threadRef: string, clientMessageId: string, text: string) {
    return domainRepository.appendThreadMessage({
      personRef: ownerPersonRef,
      threadRef,
      clientMessageId,
      actor: { type: "person", personRef: ownerPersonRef },
      origin: {
        deviceRef: ownerDeviceRef,
        connectionRef: "connection:event-test",
        entryAudience: "personal"
      },
      content: { type: "text", text, language: "zh-CN" },
      occurredAt: currentNow.toISOString()
    });
  }

  it("emits atomic Chat, Work, message, conversion and progress events without message text", () => {
    const chat = domainRepository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const work = domainRepository.createWorkConversation({
      personRef: ownerPersonRef,
      title: "独立 Work",
      goal: "验证 Work 创建事件"
    });
    currentNow = new Date("2026-07-23T19:00:01.000Z");
    const message = ownerMessage(
      chat.chat.threadRef,
      "event-message-0001",
      "这段正文绝对不能进入事件 payload。"
    );
    const eventCountBeforeReplay = store.listPersonEvents({ personRef: ownerPersonRef }).events.length;
    ownerMessage(
      chat.chat.threadRef,
      "event-message-0001",
      "这段正文绝对不能进入事件 payload。"
    );
    expect(store.listPersonEvents({ personRef: ownerPersonRef }).events)
      .toHaveLength(eventCountBeforeReplay);

    currentNow = new Date("2026-07-23T19:00:02.000Z");
    const converted = domainRepository.createWorkFromChat({
      personRef: ownerPersonRef,
      title: "转换后的 Work",
      goal: "验证转换事件",
      source: {
        homeChatStreamRef: chat.chat.homeChatStreamRef,
        dailyEpisodeRef: chat.currentEpisode?.dailyEpisodeRef ?? null,
        messageRefs: [message.messageRef]
      },
      decisions: ["建立事件底座"],
      openQuestions: []
    });
    domainRepository.saveWorkProgressSnapshot({
      personRef: ownerPersonRef,
      snapshot: {
        workConversationRef: converted.conversation.workConversationRef,
        status: "active",
        phaseSummary: "事件底座开发中",
        incompleteTasks: ["SSE"],
        risks: [],
        pendingConfirmations: [],
        deadlines: [],
        updatedAt: "2026-07-23T19:00:03.000Z"
      }
    });

    const beforeInvalid = store.listPersonEvents({ personRef: ownerPersonRef }).events.length;
    expect(() => domainRepository.createWorkFromChat({
      personRef: ownerPersonRef,
      title: "无效转换",
      goal: "不得留下 Work 或事件",
      source: {
        homeChatStreamRef: chat.chat.homeChatStreamRef,
        dailyEpisodeRef: chat.currentEpisode?.dailyEpisodeRef ?? null,
        messageRefs: ["message:not-present"]
      },
      decisions: [],
      openQuestions: []
    })).toThrow();
    expect(store.listPersonEvents({ personRef: ownerPersonRef }).events).toHaveLength(beforeInvalid);

    const events = store.listPersonEvents({ personRef: ownerPersonRef, limit: 100 }).events;
    expect(events.map((event) => event.eventType)).toEqual([
      "chat.home.created",
      "work.created",
      "thread.message.created",
      "work.created",
      "chat.work.created",
      "work.progress.updated"
    ]);
    expect(events.map((event) => event.eventSequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[0]).toMatchObject({
      aggregateRef: chat.chat.homeChatStreamRef,
      threadRef: chat.chat.threadRef
    });
    expect(events[1]).toMatchObject({
      aggregateRef: work.workConversationRef,
      threadRef: work.threadRef
    });
    expect(events[2]?.payload).toMatchObject({
      messageRef: message.messageRef,
      threadSequence: 1,
      actorType: "person",
      clientMessageId: "event-message-0001"
    });
    expect(JSON.stringify(events)).not.toContain("这段正文绝对不能进入事件 payload");
    expect(JSON.stringify(events)).not.toContain("external-session:");
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_events").get())
      .toEqual({ count: events.length });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'pending'"
    ).get()).toEqual({ count: events.length });
  });

  it("emits Assistant and Provider success events once and replays without duplicates", async () => {
    const chat = domainRepository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const adapter = new FakeProviderAdapter({ clock: () => currentNow });
    const service = new ChatWorkMessageService(
      domainRepository,
      providerRepository,
      adapter,
      () => currentNow
    );
    const input = {
      personRef: ownerPersonRef,
      deviceRef: ownerDeviceRef,
      threadRef: chat.chat.threadRef,
      clientMessageId: "provider-event-message-0001",
      content: { type: "text" as const, text: "请回复，但不要把正文写入事件。", language: "zh-CN" },
      occurredAt: currentNow.toISOString()
    };

    const first = await service.sendPersonMessage(input);
    expect(first.replayedProviderTurn).toBe(false);
    const afterFirst = store.listPersonEvents({ personRef: ownerPersonRef }).events;
    expect(afterFirst.map((event) => event.eventType)).toEqual([
      "chat.home.created",
      "thread.message.created",
      "thread.message.created",
      "thread.provider_turn.succeeded"
    ]);
    expect(afterFirst[1]?.payload).toMatchObject({ actorType: "person" });
    expect(afterFirst[2]?.payload).toMatchObject({
      actorType: "assistant",
      messageRef: first.assistantMessageRef
    });
    expect(afterFirst[3]?.payload).toMatchObject({
      userMessageRef: first.message.messageRef,
      assistantMessageRef: first.assistantMessageRef,
      attemptCount: 1
    });
    expect(JSON.stringify(afterFirst)).not.toContain("请回复，但不要把正文写入事件");
    expect(JSON.stringify(afterFirst)).not.toContain("Fake Provider");
    expect(JSON.stringify(afterFirst)).not.toContain("external-session:");

    const replay = await service.sendPersonMessage(input);
    expect(replay.replayedProviderTurn).toBe(true);
    expect(replay.assistantMessageRef).toBe(first.assistantMessageRef);
    expect(adapter.calls).toHaveLength(1);
    expect(store.listPersonEvents({ personRef: ownerPersonRef }).events).toEqual(afterFirst);
  });

  it("records Provider failure, preserves the Person event and emits success only after retry", async () => {
    const chat = domainRepository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const adapter = new FakeProviderAdapter({
      failNext: true,
      clock: () => currentNow
    });
    const service = new ChatWorkMessageService(
      domainRepository,
      providerRepository,
      adapter,
      () => currentNow
    );
    const input = {
      personRef: ownerPersonRef,
      deviceRef: ownerDeviceRef,
      threadRef: chat.chat.threadRef,
      clientMessageId: "provider-event-retry-0001",
      content: { type: "text" as const, text: "第一次失败，第二次成功。", language: "zh-CN" },
      occurredAt: currentNow.toISOString()
    };

    await expect(service.sendPersonMessage(input)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE"
    });
    const failedEvents = store.listPersonEvents({ personRef: ownerPersonRef }).events;
    expect(failedEvents.map((event) => event.eventType)).toEqual([
      "chat.home.created",
      "thread.message.created",
      "thread.provider_turn.failed"
    ]);
    expect(failedEvents[2]?.payload).toMatchObject({
      attemptCount: 1,
      error: {
        code: "PROVIDER_UNAVAILABLE",
        category: "availability",
        retryable: 1
      }
    });

    currentNow = new Date("2026-07-23T19:01:00.000Z");
    const succeeded = await service.sendPersonMessage(input);
    expect(succeeded.replayedProviderTurn).toBe(false);
    expect(adapter.calls).toHaveLength(2);
    const events = store.listPersonEvents({ personRef: ownerPersonRef }).events;
    expect(events.map((event) => event.eventType)).toEqual([
      "chat.home.created",
      "thread.message.created",
      "thread.provider_turn.failed",
      "thread.message.created",
      "thread.provider_turn.succeeded"
    ]);
    expect(events.filter((event) =>
      event.eventType === "thread.message.created" &&
      event.payload.actorType === "person"
    )).toHaveLength(1);
    expect(events[4]?.payload).toMatchObject({ attemptCount: 2 });
  });
});
