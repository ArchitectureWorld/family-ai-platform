import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterHealth,
  ProviderInvocationRequest,
  ProviderInvocationResult
} from "@family-ai/contracts";
import {
  FakeProviderAdapter,
  type ProviderAdapter
} from "@family-ai/provider-adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { ChatWorkMessageService } from "../src/chatWorkMessageService.js";
import { ChatWorkProviderRepository } from "../src/chatWorkProvider.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const initialNow = "2026-07-23T16:00:00.000Z";

function createFoundation(databasePath: string, now: () => Date) {
  const db = openGatewayDatabase(databasePath);
  const familyRepository = new FamilyDomainRepository(db);
  const onboarding = familyRepository.initializeFamily({
    familyName: "测试家庭",
    ownerName: "家庭创建者",
    deviceName: "测试电脑",
    deviceCredential: "provider-test-device-credential-with-enough-length"
  });
  return {
    db,
    ownerPersonRef: onboarding.owner.personRef,
    ownerDeviceRef: onboarding.device.deviceRef,
    domainRepository: new ChatWorkDomainRepository(db, now),
    providerRepository: new ChatWorkProviderRepository(db, now)
  };
}

describe("Chat Work Provider repository", () => {
  let directory = "";
  let db: GatewayDatabase;
  let domainRepository: ChatWorkDomainRepository;
  let providerRepository: ChatWorkProviderRepository;
  let currentNow: Date;
  let ownerPersonRef = "";
  let ownerDeviceRef = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-provider-"));
    currentNow = new Date(initialNow);
    const foundation = createFoundation(
      join(directory, "gateway.sqlite"),
      () => currentNow
    );
    db = foundation.db;
    ownerPersonRef = foundation.ownerPersonRef;
    ownerDeviceRef = foundation.ownerDeviceRef;
    domainRepository = foundation.domainRepository;
    providerRepository = foundation.providerRepository;
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function createUserMessage(clientMessageId = "provider-user-message-0001") {
    const chat = domainRepository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const message = domainRepository.appendThreadMessage({
      personRef: ownerPersonRef,
      threadRef: chat.chat.threadRef,
      clientMessageId,
      actor: { type: "person", personRef: ownerPersonRef },
      origin: {
        deviceRef: ownerDeviceRef,
        connectionRef: "connection:web-provider-test",
        entryAudience: "personal"
      },
      content: { type: "text", text: "请生成正式 Assistant 回复。", language: "zh-CN" },
      occurredAt: currentNow.toISOString()
    });
    return { chat, message };
  }

  it("creates one stable Provider Context from the active Assistant assignment", () => {
    const { chat } = createUserMessage();

    const first = providerRepository.resolveContext(ownerPersonRef, chat.chat.threadRef);
    currentNow = new Date("2026-07-23T16:01:00.000Z");
    const repeated = providerRepository.resolveContext(ownerPersonRef, chat.chat.threadRef);

    expect(first).toMatchObject({
      threadRef: chat.chat.threadRef,
      personRef: ownerPersonRef,
      assignmentRef: expect.stringMatching(/^assignment:/),
      agentRef: "agent:personal-assistant",
      providerProfileRef: "provider-profile:fake-local",
      externalSessionRef: null
    });
    expect(first.providerConversationRef).toMatch(/^conversation:/);
    expect(repeated).toEqual(first);
  });

  it("prepares a recoverable Provider Turn and increments attempts after failure", () => {
    const { message } = createUserMessage();

    const first = providerRepository.prepareTurn({
      personRef: ownerPersonRef,
      userMessage: message
    });
    expect(first).toMatchObject({
      userMessageRef: message.messageRef,
      threadRef: message.threadRef,
      status: "pending",
      attemptCount: 1,
      assistantMessageRef: null,
      externalSessionRef: null
    });
    expect(first.invocationRef).toMatch(/^invocation:/);
    expect(first.correlationRef).toMatch(/^correlation:/);
    expect(first.idempotencyKey).toMatch(/^thread-turn:/);

    providerRepository.markTurnFailed({
      userMessageRef: message.messageRef,
      error: {
        code: "PROVIDER_UNAVAILABLE",
        category: "availability",
        message: "个人助理暂时不可用。",
        retryable: true
      },
      completedAt: "2026-07-23T16:00:05.000Z"
    });

    const retry = providerRepository.prepareTurn({
      personRef: ownerPersonRef,
      userMessage: message
    });
    expect(retry).toMatchObject({
      invocationRef: first.invocationRef,
      correlationRef: first.correlationRef,
      idempotencyKey: first.idempotencyKey,
      status: "pending",
      attemptCount: 2,
      assistantMessageRef: null
    });
  });

  it("atomically persists the Assistant message, External Session and successful Turn", () => {
    const { chat, message } = createUserMessage();
    const turn = providerRepository.prepareTurn({
      personRef: ownerPersonRef,
      userMessage: message
    });

    const assistantMessageRef = providerRepository.commitTurnSucceeded({
      personRef: ownerPersonRef,
      userMessage: message,
      turn,
      output: {
        type: "text",
        text: "这是正式 Assistant 回复。",
        language: "zh-CN"
      },
      externalSessionRef: "external-session:provider-test-turn-1",
      completedAt: "2026-07-23T16:00:03.000Z"
    });

    const messages = domainRepository.listThreadMessages({
      personRef: ownerPersonRef,
      threadRef: chat.chat.threadRef
    }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      messageRef: assistantMessageRef,
      threadSequence: 2,
      clientMessageId: `assistant:${message.messageRef}`,
      actor: {
        type: "assistant",
        assignmentRef: turn.assignmentRef,
        agentRef: turn.agentRef,
        providerProfileRef: turn.providerProfileRef
      },
      origin: {
        deviceRef: null,
        connectionRef: null,
        entryAudience: "personal"
      },
      content: {
        type: "text",
        text: "这是正式 Assistant 回复。",
        language: "zh-CN"
      },
      occurredAt: "2026-07-23T16:00:03.000Z"
    });
    expect(domainRepository.getHomeChat(ownerPersonRef)?.currentEpisode?.lastMessageSequence).toBe(2);

    const succeeded = providerRepository.prepareTurn({
      personRef: ownerPersonRef,
      userMessage: message
    });
    expect(succeeded).toMatchObject({
      status: "succeeded",
      attemptCount: 1,
      assistantMessageRef
    });
    expect(providerRepository.resolveContext(ownerPersonRef, message.threadRef).externalSessionRef)
      .toBe("external-session:provider-test-turn-1");

    expect(providerRepository.commitTurnSucceeded({
      personRef: ownerPersonRef,
      userMessage: message,
      turn: succeeded,
      output: { type: "text", text: "不应重复保存。" },
      externalSessionRef: "external-session:provider-test-turn-1",
      completedAt: "2026-07-23T16:00:04.000Z"
    })).toBe(assistantMessageRef);
    expect(domainRepository.listThreadMessages({
      personRef: ownerPersonRef,
      threadRef: chat.chat.threadRef
    }).messages).toHaveLength(2);
  });
});

class ControlledProviderAdapter implements ProviderAdapter {
  readonly calls: ProviderInvocationRequest[] = [];
  private readonly resolvers: Array<(result: ProviderInvocationResult) => void> = [];

  async health(): Promise<AdapterHealth> {
    return {
      protocolVersion: "1.0",
      adapterRef: "adapter:controlled-test",
      status: "online",
      providerProfiles: ["provider-profile:fake-local"],
      checkedAt: initialNow
    };
  }

  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    this.calls.push(structuredClone(request));
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  succeed(callIndex: number, turn = 1): void {
    const request = this.calls[callIndex];
    const resolve = this.resolvers[callIndex];
    if (!request || !resolve) throw new Error(`Controlled Provider call ${callIndex} is missing`);
    resolve({
      protocolVersion: "1.0",
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "succeeded",
      completedAt: `2026-07-23T16:0${callIndex + 1}:30.000Z`,
      output: [{ type: "text", text: `Controlled Provider 第 ${turn} 轮回复。` }],
      externalSessionRef: `external-session:controlled-${callIndex}-turn-${turn}`
    });
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition did not become true");
}

describe("Chat Work Message service", () => {
  let directory = "";
  let db: GatewayDatabase;
  let domainRepository: ChatWorkDomainRepository;
  let providerRepository: ChatWorkProviderRepository;
  let currentNow: Date;
  let ownerPersonRef = "";
  let ownerDeviceRef = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-message-service-"));
    currentNow = new Date(initialNow);
    const foundation = createFoundation(
      join(directory, "gateway.sqlite"),
      () => currentNow
    );
    db = foundation.db;
    ownerPersonRef = foundation.ownerPersonRef;
    ownerDeviceRef = foundation.ownerDeviceRef;
    domainRepository = foundation.domainRepository;
    providerRepository = foundation.providerRepository;
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function command(threadRef: string, suffix: string) {
    return {
      personRef: ownerPersonRef,
      deviceRef: ownerDeviceRef,
      threadRef,
      clientMessageId: `provider-service-${suffix}-0001`,
      content: { type: "text" as const, text: `消息 ${suffix}`, language: "zh-CN" },
      occurredAt: currentNow.toISOString()
    };
  }

  it("continues one Provider Session per Thread and isolates Work Context", async () => {
    const adapter = new FakeProviderAdapter({ clock: () => currentNow });
    const service = new ChatWorkMessageService(
      domainRepository,
      providerRepository,
      adapter,
      () => currentNow
    );
    const chat = domainRepository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });

    const first = await service.sendPersonMessage(command(chat.chat.threadRef, "chat-first"));
    expect(first.replayedProviderTurn).toBe(false);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.externalSessionRef).toBeUndefined();

    currentNow = new Date("2026-07-23T16:01:00.000Z");
    await service.sendPersonMessage(command(chat.chat.threadRef, "chat-second"));
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.externalSessionRef).toBe(adapter.results[0]?.externalSessionRef);

    const work = domainRepository.createWorkConversation({
      personRef: ownerPersonRef,
      title: "独立 Work",
      goal: "验证 Provider Context 隔离"
    });
    currentNow = new Date("2026-07-23T16:02:00.000Z");
    await service.sendPersonMessage(command(work.threadRef, "work-first"));
    expect(adapter.calls).toHaveLength(3);
    expect(adapter.calls[2]?.externalSessionRef).toBeUndefined();

    const chatMessages = domainRepository.listThreadMessages({
      personRef: ownerPersonRef,
      threadRef: chat.chat.threadRef
    }).messages;
    expect(chatMessages.map((message) => message.content.text)).toEqual([
      "消息 chat-first",
      "Fake Provider 第 1 轮回复。",
      "消息 chat-second",
      "Fake Provider 第 2 轮回复。"
    ]);
    const workMessages = domainRepository.listThreadMessages({
      personRef: ownerPersonRef,
      threadRef: work.threadRef
    }).messages;
    expect(workMessages.map((message) => message.content.text)).toEqual([
      "消息 work-first",
      "Fake Provider 第 1 轮回复。"
    ]);
  });

  it("replays a successful Turn without another Provider call or duplicate messages", async () => {
    const adapter = new FakeProviderAdapter({ clock: () => currentNow });
    const service = new ChatWorkMessageService(
      domainRepository,
      providerRepository,
      adapter,
      () => currentNow
    );
    const chat = domainRepository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const input = command(chat.chat.threadRef, "replay");

    const first = await service.sendPersonMessage(input);
    const repeated = await service.sendPersonMessage(input);

    expect(first.replayedProviderTurn).toBe(false);
    expect(repeated).toMatchObject({
      message: first.message,
      assistantMessageRef: first.assistantMessageRef,
      replayedProviderTurn: true
    });
    expect(adapter.calls).toHaveLength(1);
    expect(domainRepository.listThreadMessages({
      personRef: ownerPersonRef,
      threadRef: chat.chat.threadRef
    }).messages).toHaveLength(2);
  });

  it("serializes Provider calls in one Thread but allows different Threads to run in parallel", async () => {
    const adapter = new ControlledProviderAdapter();
    const service = new ChatWorkMessageService(
      domainRepository,
      providerRepository,
      adapter,
      () => currentNow
    );
    const chat = domainRepository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const work = domainRepository.createWorkConversation({
      personRef: ownerPersonRef,
      title: "并行 Work",
      goal: "验证不同 Thread 并行"
    });

    const firstChat = service.sendPersonMessage(command(chat.chat.threadRef, "serial-one"));
    await waitFor(() => adapter.calls.length === 1);
    currentNow = new Date("2026-07-23T16:01:00.000Z");
    const secondChat = service.sendPersonMessage(command(chat.chat.threadRef, "serial-two"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(adapter.calls).toHaveLength(1);

    currentNow = new Date("2026-07-23T16:02:00.000Z");
    const firstWork = service.sendPersonMessage(command(work.threadRef, "parallel-work"));
    await waitFor(() => adapter.calls.length === 2);
    expect(adapter.calls.map((call) => call.conversationRef)).toHaveLength(2);
    expect(adapter.calls[0]?.conversationRef).not.toBe(adapter.calls[1]?.conversationRef);

    adapter.succeed(0, 1);
    adapter.succeed(1, 1);
    await firstChat;
    await firstWork;
    await waitFor(() => adapter.calls.length === 3);
    expect(adapter.calls[2]?.externalSessionRef).toBe("external-session:controlled-0-turn-1");
    adapter.succeed(2, 2);
    await secondChat;
  });
});
