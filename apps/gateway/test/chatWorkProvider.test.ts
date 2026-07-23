import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { ChatWorkProviderRepository } from "../src/chatWorkProvider.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const initialNow = "2026-07-23T16:00:00.000Z";

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
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const familyRepository = new FamilyDomainRepository(db);
    const onboarding = familyRepository.initializeFamily({
      familyName: "测试家庭",
      ownerName: "家庭创建者",
      deviceName: "测试电脑",
      deviceCredential: "provider-test-device-credential-with-enough-length"
    });
    ownerPersonRef = onboarding.owner.personRef;
    ownerDeviceRef = onboarding.device.deviceRef;
    currentNow = new Date(initialNow);
    domainRepository = new ChatWorkDomainRepository(db, () => currentNow);
    providerRepository = new ChatWorkProviderRepository(db, () => currentNow);
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
