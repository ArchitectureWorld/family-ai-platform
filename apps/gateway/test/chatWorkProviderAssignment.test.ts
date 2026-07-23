import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { ChatWorkProviderRepository } from "../src/chatWorkProvider.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const initialNow = "2026-07-23T19:00:00.000Z";

describe("Chat Work Provider assignment transitions", () => {
  let directory = "";
  let db: GatewayDatabase;
  let domainRepository: ChatWorkDomainRepository;
  let providerRepository: ChatWorkProviderRepository;
  let currentNow: Date;
  let personRef = "";
  let deviceRef = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-provider-assignment-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const familyRepository = new FamilyDomainRepository(db);
    const onboarding = familyRepository.initializeFamily({
      familyName: "测试家庭",
      ownerName: "家庭创建者",
      deviceName: "测试电脑",
      deviceCredential: "provider-assignment-device-credential"
    });
    personRef = onboarding.owner.personRef;
    deviceRef = onboarding.device.deviceRef;
    currentNow = new Date(initialNow);
    domainRepository = new ChatWorkDomainRepository(db, () => currentNow);
    providerRepository = new ChatWorkProviderRepository(db, () => currentNow);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function createMessage(clientMessageId: string) {
    const chat = domainRepository.ensureHomeChat({
      personRef,
      timezone: "UTC",
      localDate: "2026-07-23"
    });
    const message = domainRepository.appendThreadMessage({
      personRef,
      threadRef: chat.chat.threadRef,
      clientMessageId,
      actor: { type: "person", personRef },
      origin: {
        deviceRef,
        connectionRef: null,
        entryAudience: "personal"
      },
      content: { type: "text", text: "验证 Assignment 切换。" },
      occurredAt: currentNow.toISOString()
    });
    return { chat, message };
  }

  function replaceActiveAssignment(): string {
    const previous = db.prepare(
      `SELECT assignment_ref, agent_ref, provider_profile_ref
       FROM assistant_assignments
       WHERE person_ref = ? AND status = 'active'`
    ).get(personRef) as {
      assignment_ref: string;
      agent_ref: string;
      provider_profile_ref: string;
    };
    const replacementRef = "assignment:replacement-provider-turn";
    db.transaction(() => {
      db.prepare(
        `UPDATE assistant_assignments
         SET status = 'ended', effective_to = ?
         WHERE assignment_ref = ?`
      ).run(currentNow.toISOString(), previous.assignment_ref);
      db.prepare(
        `INSERT INTO assistant_assignments
         (assignment_ref, person_ref, agent_ref, provider_profile_ref,
          status, effective_from, effective_to)
         VALUES(?, ?, ?, ?, 'active', ?, NULL)`
      ).run(
        replacementRef,
        personRef,
        previous.agent_ref,
        previous.provider_profile_ref,
        currentNow.toISOString()
      );
    })();
    return replacementRef;
  }

  it("replays an already successful Turn even when no active Assignment remains", () => {
    const { message } = createMessage("assignment-success-replay-0001");
    const turn = providerRepository.prepareTurn({ personRef, userMessage: message });
    const assistantMessageRef = providerRepository.commitTurnSucceeded({
      personRef,
      userMessage: message,
      turn,
      output: { type: "text", text: "已完成的回复。" },
      externalSessionRef: "external-session:assignment-success-replay",
      completedAt: "2026-07-23T19:00:01.000Z"
    });

    db.prepare(
      `UPDATE assistant_assignments
       SET status = 'ended', effective_to = ?
       WHERE person_ref = ? AND status = 'active'`
    ).run("2026-07-23T19:01:00.000Z", personRef);

    const replay = providerRepository.prepareTurn({ personRef, userMessage: message });
    expect(replay).toMatchObject({
      status: "succeeded",
      assignmentRef: turn.assignmentRef,
      assistantMessageRef,
      attemptCount: 1
    });
  });

  it("rebinds a failed Turn to the replacement Assignment and new Provider identity", () => {
    const { message } = createMessage("assignment-failed-rebind-0001");
    const first = providerRepository.prepareTurn({ personRef, userMessage: message });
    providerRepository.markTurnFailed({
      userMessageRef: message.messageRef,
      error: {
        code: "PROVIDER_UNAVAILABLE",
        category: "availability",
        message: "个人助理暂时不可用。",
        retryable: true
      },
      completedAt: "2026-07-23T19:00:02.000Z"
    });

    currentNow = new Date("2026-07-23T19:05:00.000Z");
    const replacementRef = replaceActiveAssignment();
    const retry = providerRepository.prepareTurn({ personRef, userMessage: message });

    expect(retry).toMatchObject({
      status: "pending",
      attemptCount: 2,
      assignmentRef: replacementRef,
      agentRef: first.agentRef,
      providerProfileRef: first.providerProfileRef,
      providerConversationRef: first.providerConversationRef,
      externalSessionRef: null,
      requestedAt: currentNow.toISOString()
    });
    expect(retry.invocationRef).not.toBe(first.invocationRef);
    expect(retry.correlationRef).not.toBe(first.correlationRef);
    expect(retry.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
