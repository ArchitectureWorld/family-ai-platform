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

  it("creates a Work from Chat references without copying source message bodies", () => {
    const chat = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const first = repository.appendThreadMessage(
      ownerMessageInput(chat.chat.threadRef, "owner-chat-source-0001", "第一个来源消息")
    );
    currentNow = new Date("2026-07-23T12:01:00.000Z");
    const second = repository.appendThreadMessage(
      ownerMessageInput(chat.chat.threadRef, "owner-chat-source-0002", "第二个来源消息")
    );

    const result = repository.createWorkFromChat({
      personRef: ownerPersonRef,
      title: "正式领域底座",
      goal: "把 Chat 讨论转为独立 Work",
      source: {
        homeChatStreamRef: chat.chat.homeChatStreamRef,
        dailyEpisodeRef: chat.currentEpisode!.dailyEpisodeRef,
        messageRefs: [first.messageRef, second.messageRef]
      },
      decisions: ["先稳定 Gateway 领域模型"],
      openQuestions: ["何时加入 SSE"]
    });

    expect(result.conversation.threadKind).toBe("work");
    expect(result.conversion).toMatchObject({
      homeChatStreamRef: chat.chat.homeChatStreamRef,
      dailyEpisodeRef: chat.currentEpisode!.dailyEpisodeRef,
      sourceMessageRefs: [first.messageRef, second.messageRef],
      workConversationRef: result.conversation.workConversationRef
    });
    const stored = repository.getChatWorkConversion(
      ownerPersonRef,
      result.conversion.conversionRef
    );
    expect(stored).toMatchObject({
      ...result.conversion,
      decisions: ["先稳定 Gateway 领域模型"],
      openQuestions: ["何时加入 SSE"]
    });
    expect(repository.getChatWorkConversion(
      adultPersonRef,
      result.conversion.conversionRef
    )).toBeNull();
    expect(JSON.stringify(stored)).not.toContain("第一个来源消息");
    expect(JSON.stringify(stored)).not.toContain("第二个来源消息");
  });

  it("rolls back the Work when any Chat source reference is invalid", () => {
    const chat = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const valid = repository.appendThreadMessage(
      ownerMessageInput(chat.chat.threadRef, "owner-chat-valid-source", "有效来源消息")
    );
    const before = repository.listWorkConversations(ownerPersonRef).length;

    try {
      repository.createWorkFromChat({
        personRef: ownerPersonRef,
        title: "不应保存",
        goal: "验证事务回滚",
        source: {
          homeChatStreamRef: chat.chat.homeChatStreamRef,
          dailyEpisodeRef: chat.currentEpisode!.dailyEpisodeRef,
          messageRefs: [valid.messageRef, "message:not-in-this-chat"]
        },
        decisions: [],
        openQuestions: []
      });
      throw new Error("Expected invalid Chat source to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "CHAT_SOURCE_INVALID" });
    }

    expect(repository.listWorkConversations(ownerPersonRef)).toHaveLength(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_work_conversions").get())
      .toEqual({ count: 0 });
  });

  it("upserts Work progress and restores Chat Work state after a database restart", () => {
    const chat = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const sourceMessage = repository.appendThreadMessage(
      ownerMessageInput(chat.chat.threadRef, "owner-chat-restart-source", "重启后仍需存在")
    );
    const conversionResult = repository.createWorkFromChat({
      personRef: ownerPersonRef,
      title: "持续事项",
      goal: "验证状态恢复",
      source: {
        homeChatStreamRef: chat.chat.homeChatStreamRef,
        dailyEpisodeRef: chat.currentEpisode!.dailyEpisodeRef,
        messageRefs: [sourceMessage.messageRef]
      },
      decisions: ["保持 SQLite 为权威"],
      openQuestions: []
    });
    const firstSnapshot = repository.saveWorkProgressSnapshot({
      personRef: ownerPersonRef,
      snapshot: {
        workConversationRef: conversionResult.conversation.workConversationRef,
        status: "active",
        phaseSummary: "完成领域模型设计",
        incompleteTasks: ["实现 HTTP 路由"],
        risks: ["不能影响 PR #14"],
        pendingConfirmations: [],
        deadlines: [{
          label: "完成 Gateway 底座",
          dueAt: "2026-07-24T12:00:00.000Z"
        }],
        updatedAt: "2026-07-23T13:00:00.000Z"
      }
    });
    const latestSnapshot = repository.saveWorkProgressSnapshot({
      personRef: ownerPersonRef,
      snapshot: {
        ...firstSnapshot,
        phaseSummary: "领域底座已进入验证",
        incompleteTasks: ["完成冲突扫描"],
        updatedAt: "2026-07-23T14:00:00.000Z"
      }
    });
    expect(repository.getWorkProgressSnapshot(
      ownerPersonRef,
      conversionResult.conversation.workConversationRef
    )).toEqual(latestSnapshot);
    expect(repository.getWorkProgressSnapshot(
      adultPersonRef,
      conversionResult.conversation.workConversationRef
    )).toBeNull();

    db.close();
    db = openGatewayDatabase(databasePath);
    repository = new ChatWorkDomainRepository(db, () => currentNow);

    expect(repository.getHomeChat(ownerPersonRef)).toEqual({
      chat: {
        ...chat.chat,
        lastSequence: 1,
        lastActiveAt: initialNow
      },
      currentEpisode: {
        ...chat.currentEpisode!,
        lastMessageSequence: 1
      }
    });
    expect(repository.listThreadMessages({
      personRef: ownerPersonRef,
      threadRef: chat.chat.threadRef
    }).messages).toEqual([sourceMessage]);
    expect(repository.getWorkConversation(
      ownerPersonRef,
      conversionResult.conversation.workConversationRef
    )).toEqual(conversionResult.conversation);
    expect(repository.getChatWorkConversion(
      ownerPersonRef,
      conversionResult.conversion.conversionRef
    )).toMatchObject({
      ...conversionResult.conversion,
      decisions: ["保持 SQLite 为权威"],
      openQuestions: []
    });
    expect(repository.getWorkProgressSnapshot(
      ownerPersonRef,
      conversionResult.conversation.workConversationRef
    )).toEqual(latestSnapshot);
  });
});
