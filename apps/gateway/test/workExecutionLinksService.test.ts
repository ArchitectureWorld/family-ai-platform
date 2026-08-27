import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentRepository } from "../src/attachmentRepository.js";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";
import {
  WorkExecutionLinkService,
  type CanvasWorkflowClient
} from "../src/workExecutionLinks.js";

describe("WorkExecutionLinkService", () => {
  let directory = "";
  let db: GatewayDatabase;
  let repository: ChatWorkDomainRepository;
  let personRef = "";
  let familyRef = "";
  let workRef = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-link-service-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const onboarding = new FamilyDomainRepository(db).initializeFamily({
      familyName: "测试家庭",
      ownerName: "创建者",
      deviceName: "测试设备",
      deviceCredential: "test-device-credential-with-enough-length"
    });
    personRef = onboarding.owner.personRef;
    familyRef = onboarding.family.familyRef;
    repository = new ChatWorkDomainRepository(
      db,
      () => new Date("2026-08-27T00:00:00.000Z")
    );
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

  function client(): CanvasWorkflowClient & {
    createFamilyWorkflow: ReturnType<typeof vi.fn>;
    revokeFamilyWorkflow: ReturnType<typeof vi.fn>;
  } {
    return {
      createFamilyWorkflow: vi.fn(async () => ({
        schemaVersion: "family-workflow-result/1.0" as const,
        workflow: {
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
      })),
      revokeFamilyWorkflow: vi.fn(async () => undefined)
    };
  }

  const attachments = {
    integrationAssetRef: vi.fn()
  } as unknown as AttachmentRepository;

  it("sends only server-owned Work summary and refs then persists the link", async () => {
    const canvas = client();
    const service = new WorkExecutionLinkService(
      repository,
      attachments,
      canvas,
      () => new Date("2026-08-27T00:00:00.000Z")
    );

    const link = await service.create({
      personRef,
      familyRef,
      agentRef: "agent:personal-assistant",
      workConversationRef: workRef,
      command: {
        protocolVersion: 1,
        idempotencyKey: "work-one-canvas-42",
        messageRefs: [],
        attachmentRefs: []
      }
    });

    expect(link.externalResource.id).toBe("workflow:one");
    expect(canvas.createFamilyWorkflow).toHaveBeenCalledTimes(1);
    const request = canvas.createFamilyWorkflow.mock.calls[0]?.[0];
    expect(request.actor.principal.id).toBe(personRef);
    expect(request.actor.scopes).toEqual(["canvas:session:write"]);
    expect(request.work).toMatchObject({
      sourceWork: { id: workRef },
      title: "照明工作",
      goal: "完成照明方案",
      messageRefs: [],
      assets: []
    });
    expect(JSON.stringify(request)).not.toContain("localPath");
  });

  it("does not persist a Family link when Canvas fails", async () => {
    const canvas = client();
    canvas.createFamilyWorkflow.mockRejectedValueOnce(new Error("canvas down"));
    const service = new WorkExecutionLinkService(repository, attachments, canvas);

    await expect(service.create({
      personRef,
      familyRef,
      agentRef: "agent:personal-assistant",
      workConversationRef: workRef,
      command: {
        protocolVersion: 1,
        idempotencyKey: "work-one-canvas-42",
        messageRefs: [],
        attachmentRefs: []
      }
    })).rejects.toThrow("canvas down");
    expect(repository.listExecutionLinks(personRef, workRef)).toEqual([]);
  });

  it("revokes Canvas authority before hiding the Family deep link", async () => {
    const canvas = client();
    const service = new WorkExecutionLinkService(repository, attachments, canvas);
    const link = await service.create({
      personRef,
      familyRef,
      agentRef: "agent:personal-assistant",
      workConversationRef: workRef,
      command: {
        protocolVersion: 1,
        idempotencyKey: "work-one-canvas-42",
        messageRefs: [],
        attachmentRefs: []
      }
    });

    const revoked = await service.revoke({
      personRef,
      familyRef,
      agentRef: "agent:personal-assistant",
      workConversationRef: workRef,
      linkRef: link.linkRef
    });

    expect(canvas.revokeFamilyWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "workflow:one",
      actor: expect.objectContaining({ principal: expect.objectContaining({ id: personRef }) })
    }));
    expect(revoked.status).toBe("revoked");
    expect(revoked.deepLink).toBeNull();
    expect(repository.getWorkConversation(personRef, workRef)).not.toBeNull();
  });

  it("keeps the Family link active when Canvas revoke is unavailable", async () => {
    const canvas = client();
    const service = new WorkExecutionLinkService(repository, attachments, canvas);
    const link = await service.create({
      personRef,
      familyRef,
      agentRef: "agent:personal-assistant",
      workConversationRef: workRef,
      command: {
        protocolVersion: 1,
        idempotencyKey: "work-one-canvas-42",
        messageRefs: [],
        attachmentRefs: []
      }
    });
    canvas.revokeFamilyWorkflow.mockRejectedValueOnce(new Error("canvas down"));

    await expect(service.revoke({
      personRef,
      familyRef,
      agentRef: "agent:personal-assistant",
      workConversationRef: workRef,
      linkRef: link.linkRef
    })).rejects.toThrow("canvas down");
    expect(repository.listExecutionLinks(personRef, workRef)[0]?.status).toBe("active");
  });
});
