import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

interface AssistantAssignmentRow {
  assignment_ref: string;
  agent_ref: string;
  provider_profile_ref: string;
}

const fixedNow = new Date("2026-07-23T15:00:00.000Z");

describe("Chat Work message provenance", () => {
  let directory = "";
  let db: GatewayDatabase;
  let repository: ChatWorkDomainRepository;
  let ownerPersonRef = "";
  let adultPersonRef = "";
  let ownerDeviceRef = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-provenance-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const familyRepository = new FamilyDomainRepository(db);
    const onboarding = familyRepository.initializeFamily({
      familyName: "来源校验家庭",
      ownerName: "家庭创建者",
      deviceName: "创建者电脑",
      deviceCredential: "provenance-device-credential-with-enough-length"
    });
    ownerPersonRef = onboarding.owner.personRef;
    ownerDeviceRef = onboarding.device.deviceRef;
    adultPersonRef = familyRepository.createMember({
      familyRef: onboarding.family.familyRef,
      displayName: "另一位成人",
      familyRole: "adult"
    }).personRef;
    repository = new ChatWorkDomainRepository(db, () => fixedNow);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function assignmentFor(personRef: string): AssistantAssignmentRow {
    const row = db.prepare(
      `SELECT assignment_ref, agent_ref, provider_profile_ref
       FROM assistant_assignments
       WHERE person_ref = ? AND status = 'active'`
    ).get(personRef) as AssistantAssignmentRow | undefined;
    if (!row) throw new Error(`Missing assistant assignment for ${personRef}`);
    return row;
  }

  it("replays one logical message after reconnecting and preserves its first accepted origin", () => {
    const chat = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const firstInput = {
      personRef: ownerPersonRef,
      threadRef: chat.chat.threadRef,
      clientMessageId: "reconnect-message-0001",
      actor: { type: "person" as const, personRef: ownerPersonRef },
      origin: {
        deviceRef: ownerDeviceRef,
        connectionRef: "connection:web-before-reconnect",
        entryAudience: "personal" as const
      },
      content: { type: "text" as const, text: "重连后不要重复保存。", language: "zh-CN" },
      occurredAt: fixedNow.toISOString()
    };

    const first = repository.appendThreadMessage(firstInput);
    const replayed = repository.appendThreadMessage({
      ...firstInput,
      origin: {
        ...firstInput.origin,
        connectionRef: "connection:web-after-reconnect"
      }
    });

    expect(replayed).toEqual(first);
    expect(replayed.origin.connectionRef).toBe("connection:web-before-reconnect");
    expect(repository.listThreadMessages({
      personRef: ownerPersonRef,
      threadRef: chat.chat.threadRef
    }).messages).toHaveLength(1);
  });

  it("rejects a Person message whose device is not bound to that Person", () => {
    const adultChat = repository.ensureHomeChat({
      personRef: adultPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });

    try {
      repository.appendThreadMessage({
        personRef: adultPersonRef,
        threadRef: adultChat.chat.threadRef,
        clientMessageId: "forged-device-origin-0001",
        actor: { type: "person", personRef: adultPersonRef },
        origin: {
          deviceRef: ownerDeviceRef,
          connectionRef: "connection:forged-device",
          entryAudience: "personal"
        },
        content: { type: "text", text: "不应接受这个设备来源。", language: "zh-CN" },
        occurredAt: fixedNow.toISOString()
      });
      throw new Error("Expected an invalid device provenance error");
    } catch (error) {
      expect(error).toMatchObject({ code: "THREAD_MESSAGE_INVALID" });
    }
    expect(repository.listThreadMessages({
      personRef: adultPersonRef,
      threadRef: adultChat.chat.threadRef
    }).messages).toEqual([]);
  });

  it("requires an Assistant message assignment to belong to the Thread owner", () => {
    const ownerChat = repository.ensureHomeChat({
      personRef: ownerPersonRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const ownerAssignment = assignmentFor(ownerPersonRef);
    const adultAssignment = assignmentFor(adultPersonRef);

    const accepted = repository.appendThreadMessage({
      personRef: ownerPersonRef,
      threadRef: ownerChat.chat.threadRef,
      clientMessageId: "owner-assistant-message-0001",
      actor: {
        type: "assistant",
        assignmentRef: ownerAssignment.assignment_ref,
        agentRef: ownerAssignment.agent_ref,
        providerProfileRef: ownerAssignment.provider_profile_ref
      },
      origin: {
        deviceRef: null,
        connectionRef: null,
        entryAudience: "personal"
      },
      content: { type: "text", text: "这是创建者的个人助理回复。", language: "zh-CN" },
      occurredAt: fixedNow.toISOString()
    });
    expect(accepted.actor).toEqual({
      type: "assistant",
      assignmentRef: ownerAssignment.assignment_ref,
      agentRef: ownerAssignment.agent_ref,
      providerProfileRef: ownerAssignment.provider_profile_ref
    });

    try {
      repository.appendThreadMessage({
        personRef: ownerPersonRef,
        threadRef: ownerChat.chat.threadRef,
        clientMessageId: "forged-assistant-message-0001",
        actor: {
          type: "assistant",
          assignmentRef: adultAssignment.assignment_ref,
          agentRef: adultAssignment.agent_ref,
          providerProfileRef: adultAssignment.provider_profile_ref
        },
        origin: {
          deviceRef: null,
          connectionRef: null,
          entryAudience: "personal"
        },
        content: { type: "text", text: "不应串用另一位成员的助理。", language: "zh-CN" },
        occurredAt: fixedNow.toISOString()
      });
      throw new Error("Expected an invalid assistant provenance error");
    } catch (error) {
      expect(error).toMatchObject({ code: "THREAD_MESSAGE_INVALID" });
    }
    expect(repository.listThreadMessages({
      personRef: ownerPersonRef,
      threadRef: ownerChat.chat.threadRef
    }).messages).toEqual([accepted]);
  });
});
