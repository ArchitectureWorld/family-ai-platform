import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const initialNow = "2026-07-23T12:00:00.000Z";

describe("Chat Work domain foundation", () => {
  let directory = "";
  let databasePath = "";
  let db: GatewayDatabase;
  let repository: ChatWorkDomainRepository;
  let currentNow: Date;
  let ownerPersonRef = "";
  let adultPersonRef = "";
  let ownerDeviceRef = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-"));
    databasePath = join(directory, "gateway.sqlite");
    db = openGatewayDatabase(databasePath);
    const familyRepository = new FamilyDomainRepository(db);
    const onboarding = familyRepository.initializeFamily({
      familyName: "测试家庭",
      ownerName: "家庭创建者",
      deviceName: "测试电脑",
      deviceCredential: "test-device-credential-with-enough-length"
    });
    ownerPersonRef = onboarding.owner.personRef;
    ownerDeviceRef = onboarding.device.deviceRef;
    adultPersonRef = familyRepository.createMember({
      familyRef: onboarding.family.familyRef,
      displayName: "另一位成人",
      familyRole: "adult"
    }).personRef;
    currentNow = new Date(initialNow);
    repository = new ChatWorkDomainRepository(db, () => currentNow);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function ownerMessageInput(threadRef: string, clientMessageId: string, text: string) {
    return {
      personRef: ownerPersonRef,
      threadRef,
      clientMessageId,
      actor: { type: "person" as const, personRef: ownerPersonRef },
      origin: {
        deviceRef: ownerDeviceRef,
        connectionRef: "connection:web-owner",
        entryAudience: "personal" as const
      },
      content: { type: "text" as const, text, language: "zh-CN" },
      occurredAt: currentNow.toISOString()
    };
  }

  it("creates one durable Home Chat and one open initial DailyEpisode per Person", () => {
    const first = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "America/Los_Angeles",
      localDate: "2026-07-23"
    });
    const repeated = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "Asia/Shanghai",
      localDate: "2026-07-24"
    });

    expect(repeated).toEqual(first);
    expect(first.chat.threadKind).toBe("home_chat");
    expect(first.chat.personRef).toBe(ownerPersonRef);
    expect(first.chat.currentEpisodeRef).toBe(first.currentEpisode?.dailyEpisodeRef);
    expect(first.currentEpisode).toMatchObject({
      threadRef: first.chat.threadRef,
      homeChatStreamRef: first.chat.homeChatStreamRef,
      localDate: "2026-07-23",
      timezone: "America/Los_Angeles",
      archiveStatus: "open",
      archiveVersion: 0,
      lastMessageSequence: 0
    });

    const activeCount = db.prepare(
      "SELECT COUNT(*) AS count FROM home_chat_streams WHERE person_ref = ? AND status = 'active'"
    ).get(ownerPersonRef);
    expect(activeCount).toEqual({ count: 1 });
  });

  it("keeps Home Chat and Work ownership isolated by Person", () => {
    const ownerChat = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const adultChat = repository.ensureHomeChat({
      personRef: adultPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const ownerWork = repository.createWorkConversation({
      personRef: ownerPersonRef,
      title: "家庭 AI 平台",
      goal: "建立正式 Chat / Work 领域底座"
    });
    currentNow = new Date("2026-07-23T12:01:00.000Z");
    const secondOwnerWork = repository.createWorkConversation({
      personRef: ownerPersonRef,
      title: "另一个事项",
      goal: "验证多个 Work 相互隔离"
    });
    const adultWork = repository.createWorkConversation({
      personRef: adultPersonRef,
      title: "成人私有事项",
      goal: "验证 Person 所有权"
    });

    expect(ownerDeviceRef).toMatch(/^device:/);
    expect(ownerChat.chat.threadRef).not.toBe(adultChat.chat.threadRef);
    expect(repository.getWorkConversation(adultPersonRef, ownerWork.workConversationRef)).toBeNull();
    expect(repository.getWorkConversation(ownerPersonRef, adultWork.workConversationRef)).toBeNull();
    expect(repository.listWorkConversations(ownerPersonRef).map((item) => item.workConversationRef))
      .toEqual([secondOwnerWork.workConversationRef, ownerWork.workConversationRef]);
    expect(repository.listWorkConversations(adultPersonRef).map((item) => item.workConversationRef))
      .toEqual([adultWork.workConversationRef]);
  });

  it("allocates stable sequences, preserves raw text, and replays the same logical message", () => {
    const chat = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const input = ownerMessageInput(
      chat.chat.threadRef,
      "owner-chat-0001",
      "  保留两侧空格。  "
    );

    const first = repository.appendThreadMessage(input);
    const repeated = repository.appendThreadMessage(input);

    expect(first.threadSequence).toBe(1);
    expect(first.content.text).toBe("  保留两侧空格。  ");
    expect(repeated).toEqual(first);
    expect(repository.getHomeChat(ownerPersonRef)?.chat.lastSequence).toBe(1);
    expect(repository.getHomeChat(ownerPersonRef)?.currentEpisode?.lastMessageSequence).toBe(1);
  });

  it("rejects a reused client message ID with different logical content", () => {
    const chat = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    repository.appendThreadMessage(
      ownerMessageInput(chat.chat.threadRef, "owner-chat-conflict", "第一份内容")
    );

    try {
      repository.appendThreadMessage(
        ownerMessageInput(chat.chat.threadRef, "owner-chat-conflict", "不同内容")
      );
      throw new Error("Expected a logical message conflict");
    } catch (error) {
      expect(error).toMatchObject({ code: "THREAD_MESSAGE_CONFLICT" });
    }
    expect(repository.listThreadMessages({
      personRef: ownerPersonRef,
      threadRef: chat.chat.threadRef
    }).messages).toHaveLength(1);
  });

  it("returns ascending message pages and rejects cross-Person Thread access", () => {
    const chat = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    for (let index = 1; index <= 5; index += 1) {
      currentNow = new Date(`2026-07-23T12:0${index}:00.000Z`);
      repository.appendThreadMessage(
        ownerMessageInput(
          chat.chat.threadRef,
          `owner-chat-page-${String(index).padStart(4, "0")}`,
          `第 ${index} 条消息`
        )
      );
    }

    const latest = repository.listThreadMessages({
      personRef: ownerPersonRef,
      threadRef: chat.chat.threadRef,
      limit: 2
    });
    expect(latest.messages.map((message) => message.threadSequence)).toEqual([4, 5]);
    expect(latest.nextBeforeSequence).toBe(4);

    const older = repository.listThreadMessages({
      personRef: ownerPersonRef,
      threadRef: chat.chat.threadRef,
      beforeSequence: latest.nextBeforeSequence!,
      limit: 2
    });
    expect(older.messages.map((message) => message.threadSequence)).toEqual([2, 3]);
    expect(older.nextBeforeSequence).toBe(2);

    try {
      repository.listThreadMessages({
        personRef: adultPersonRef,
        threadRef: chat.chat.threadRef
      });
      throw new Error("Expected cross-Person access to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "THREAD_NOT_FOUND" });
    }
  });
});
