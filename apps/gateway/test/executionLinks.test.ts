import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

describe("Family Work external execution links", () => {
  let directory = "";
  let db: GatewayDatabase;
  let repository: ChatWorkDomainRepository;
  let personRef = "";
  let workRef = "";
  let now = new Date("2026-08-27T00:00:00.000Z");

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-execution-links-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const onboarding = new FamilyDomainRepository(db).initializeFamily({
      familyName: "测试家庭",
      ownerName: "创建者",
      deviceName: "测试设备",
      deviceCredential: "test-device-credential-with-enough-length"
    });
    personRef = onboarding.owner.personRef;
    repository = new ChatWorkDomainRepository(db, () => now);
    workRef = repository.createWorkConversation({
      personRef,
      title: "照明工作",
      goal: "完成照明方案"
    }).workConversationRef;
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const target = () => ({
    externalResource: {
      schemaVersion: "resource-ref/1.0" as const,
      system: "super-canvas" as const,
      kind: "workflow",
      id: "workflow:one",
      uri: "ai://super-canvas/workflow/workflow:one"
    },
    rootSession: {
      schemaVersion: "resource-ref/1.0" as const,
      system: "super-canvas" as const,
      kind: "session",
      id: "session:one",
      uri: "ai://super-canvas/session/session:one"
    },
    deepLink: "http://127.0.0.1:3000/session-alpha/session:one"
  });

  it("creates and replays one link without copying Canvas objects", () => {
    const first = repository.createExecutionLink({
      personRef,
      workConversationRef: workRef,
      idempotencyKey: "work-one-canvas-42",
      sourceSequence: 42,
      ...target()
    });
    const replay = repository.createExecutionLink({
      personRef,
      workConversationRef: workRef,
      idempotencyKey: "work-one-canvas-42",
      sourceSequence: 42,
      ...target()
    });

    expect(replay).toEqual(first);
    expect(repository.listExecutionLinks(personRef, workRef)).toEqual([first]);
    expect(JSON.stringify(first)).not.toContain("messages");
    expect(JSON.stringify(first)).not.toContain("runEvents");
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_external_links").get()).toEqual({ count: 1 });
  });

  it("rejects idempotency payload conflicts and duplicate active targets", () => {
    repository.createExecutionLink({
      personRef,
      workConversationRef: workRef,
      idempotencyKey: "work-one-canvas-42",
      sourceSequence: 42,
      ...target()
    });
    expect(() => repository.createExecutionLink({
      personRef,
      workConversationRef: workRef,
      idempotencyKey: "work-one-canvas-42",
      sourceSequence: 43,
      ...target()
    })).toThrow(/different payload/i);
    expect(() => repository.createExecutionLink({
      personRef,
      workConversationRef: workRef,
      idempotencyKey: "other-idempotency-key",
      sourceSequence: 42,
      ...target()
    })).toThrow(/already linked/i);
  });

  it("revokes a link without deleting its Family Work", () => {
    const link = repository.createExecutionLink({
      personRef,
      workConversationRef: workRef,
      idempotencyKey: "work-one-canvas-42",
      sourceSequence: 42,
      ...target()
    });
    now = new Date("2026-08-27T01:00:00.000Z");

    const revoked = repository.revokeExecutionLink({
      personRef,
      workConversationRef: workRef,
      linkRef: link.linkRef
    });

    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).toBe(now.toISOString());
    expect(revoked.deepLink).toBeNull();
    expect(repository.getWorkConversation(personRef, workRef)).not.toBeNull();
  });
});
