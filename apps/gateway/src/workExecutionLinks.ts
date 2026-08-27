import { randomUUID } from "node:crypto";
import {
  actorContextSchema,
  canvasWorkflowIntegrationResponseSchema,
  familyWorkToCanvasSchema,
  type ActorContext,
  type CanvasWorkflowIntegrationResponse,
  type CreateExecutionLinkRequest,
  type ExecutionLink,
  type FamilyWorkToCanvas
} from "@family-ai/contracts";
import type { AttachmentRepository } from "./attachmentRepository.js";
import type { ChatWorkDomainRepository } from "./chatWorkDomain.js";
import { GatewayDomainError } from "./service.js";


export interface CanvasWorkflowClient {
  createFamilyWorkflow(input: {
    actor: ActorContext;
    work: FamilyWorkToCanvas;
  }): Promise<CanvasWorkflowIntegrationResponse>;
  revokeFamilyWorkflow(input: {
    actor: ActorContext;
    workflowId: string;
  }): Promise<void>;
}


export class HttpCanvasWorkflowClient implements CanvasWorkflowClient {
  private readonly baseUrl: URL;

  constructor(baseUrl: string, options: { allowContainerService?: boolean } = {}) {
    const base = new URL(baseUrl);
    const allowedHost = ["127.0.0.1", "localhost", "::1"].includes(base.hostname) ||
      (options.allowContainerService === true && base.hostname === "canvas");
    if (
      base.protocol !== "http:" ||
      !allowedHost ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      throw new Error("FAMILY_AI_CANVAS_BASE_URL must be a trusted internal HTTP origin");
    }
    this.baseUrl = base;
  }

  async createFamilyWorkflow(input: {
    actor: ActorContext;
    work: FamilyWorkToCanvas;
  }): Promise<CanvasWorkflowIntegrationResponse> {
    let response: Response;
    try {
      response = await fetch(new URL("/api/v1/integrations/family-workflows", this.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new GatewayDomainError(
        "CANVAS_INTEGRATION_UNAVAILABLE",
        503,
        "availability",
        true,
        "超级画板暂时不可用，请稍后重试。"
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new GatewayDomainError(
        "CANVAS_INTEGRATION_UNAVAILABLE",
        response.status >= 500 ? 503 : 409,
        response.status >= 500 ? "availability" : "conflict",
        response.status >= 500,
        "超级画板没有完成执行链接，请稍后重试。"
      );
    }
    const parsed = canvasWorkflowIntegrationResponseSchema.safeParse(
      payload && typeof payload === "object" && "ok" in payload
        ? (payload as { data?: unknown }).data
        : payload
    );
    if (!parsed.success) {
      throw new GatewayDomainError(
        "CANVAS_INTEGRATION_RESPONSE_INVALID",
        502,
        "availability",
        true,
        "超级画板返回了无法识别的结果。"
      );
    }
    return parsed.data;
  }

  async revokeFamilyWorkflow(input: {
    actor: ActorContext;
    workflowId: string;
  }): Promise<void> {
    let response: Response;
    try {
      response = await fetch(
        new URL(
          `/api/v1/integrations/family-workflows/${encodeURIComponent(input.workflowId)}`,
          this.baseUrl
        ),
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.actor),
          signal: AbortSignal.timeout(10_000)
        }
      );
    } catch {
      throw new GatewayDomainError(
        "CANVAS_INTEGRATION_UNAVAILABLE",
        503,
        "availability",
        true,
        "超级画板暂时不可用，关联尚未解除，请稍后重试。"
      );
    }
    if (!response.ok) {
      throw new GatewayDomainError(
        "CANVAS_INTEGRATION_UNAVAILABLE",
        response.status >= 500 ? 503 : 409,
        response.status >= 500 ? "availability" : "conflict",
        response.status >= 500,
        "超级画板没有确认解除关联，请稍后重试。"
      );
    }
  }
}


export class WorkExecutionLinkService {
  constructor(
    private readonly repository: ChatWorkDomainRepository,
    private readonly attachments: AttachmentRepository,
    private readonly canvas: CanvasWorkflowClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  private actorContext(input: {
    personRef: string;
    familyRef: string;
  }): ActorContext {
    const issuedAt = this.now();
    return actorContextSchema.parse({
      schemaVersion: "actor-context/1.0",
      actorKind: "person",
      principal: {
        schemaVersion: "resource-ref/1.0",
        system: "family-ai",
        kind: "person",
        id: input.personRef,
        uri: `ai://family-ai/person/${input.personRef}`
      },
      family: {
        schemaVersion: "resource-ref/1.0",
        system: "family-ai",
        kind: "family",
        id: input.familyRef,
        uri: `ai://family-ai/family/${input.familyRef}`
      },
      entryAudience: "personal",
      authStrength: "session",
      scopes: ["canvas:session:write"],
      requestId: `request:${randomUUID()}`,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 5 * 60 * 1000).toISOString()
    });
  }

  async create(input: {
    personRef: string;
    familyRef: string;
    agentRef: string;
    workConversationRef: string;
    command: CreateExecutionLinkRequest;
  }): Promise<ExecutionLink> {
    const work = this.repository.getWorkConversation(
      input.personRef,
      input.agentRef,
      input.workConversationRef
    );
    if (!work) {
      throw new GatewayDomainError(
        "WORK_NOT_FOUND",
        404,
        "permission",
        false,
        "没有找到这个 Work。"
      );
    }
    const messageRefs = this.repository.selectedWorkMessageRefs({
      personRef: input.personRef,
      agentRef: input.agentRef,
      workConversationRef: input.workConversationRef,
      messageRefs: input.command.messageRefs
    });
    const assets = input.command.attachmentRefs.map((attachmentRef) =>
      this.attachments.integrationAssetRef({
        familyRef: input.familyRef,
        personRef: input.personRef,
        attachmentRef
      })
    );
    const packagePayload = familyWorkToCanvasSchema.parse({
      schemaVersion: "family-work-to-canvas/1.0",
      sourceWork: {
        schemaVersion: "resource-ref/1.0",
        system: "family-ai",
        kind: "work",
        id: work.workConversationRef,
        uri: `ai://family-ai/work/${work.workConversationRef}`
      },
      title: work.title,
      goal: work.goal,
      summary: work.summary,
      messageRefs,
      assets,
      sourceSequence: work.lastSequence,
      idempotencyKey: input.command.idempotencyKey
    });
    const result = await this.canvas.createFamilyWorkflow({
      actor: this.actorContext(input),
      work: packagePayload
    });
    return this.repository.createExecutionLink({
      personRef: input.personRef,
      agentRef: input.agentRef,
      workConversationRef: input.workConversationRef,
      idempotencyKey: input.command.idempotencyKey,
      externalResource: result.workflow,
      rootSession: result.rootSession,
      deepLink: result.deepLink,
      sourceSequence: work.lastSequence
    });
  }

  list(input: {
    personRef: string;
    agentRef: string;
    workConversationRef: string;
  }): ExecutionLink[] {
    return this.repository.listExecutionLinks(
      input.personRef,
      input.workConversationRef,
      input.agentRef
    );
  }

  async revoke(input: {
    personRef: string;
    familyRef: string;
    agentRef: string;
    workConversationRef: string;
    linkRef: string;
  }): Promise<ExecutionLink> {
    const link = this.repository.listExecutionLinks(
      input.personRef,
      input.workConversationRef,
      input.agentRef
    ).find((candidate) => candidate.linkRef === input.linkRef);
    if (!link) {
      throw new GatewayDomainError(
        "WORK_NOT_FOUND",
        404,
        "permission",
        false,
        "没有找到这个执行链接。"
      );
    }
    if (link.status === "revoked") return link;
    await this.canvas.revokeFamilyWorkflow({
      actor: this.actorContext(input),
      workflowId: link.externalResource.id
    });
    return this.repository.revokeExecutionLink(input);
  }
}
