import { z } from "zod";

const kindPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const idPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const refPattern = (prefix: string) => new RegExp(`^${prefix}:[a-z0-9][a-z0-9._:-]{1,126}$`);

export const resourceRefSchema = z
  .object({
    schemaVersion: z.literal("resource-ref/1.0"),
    system: z.enum(["family-ai", "super-canvas", "me-system"]),
    kind: z.string().regex(kindPattern).max(64),
    id: z.string().regex(idPattern),
    uri: z.string().url()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.uri !== `ai://${value.system}/${value.kind}/${value.id}`) {
      context.addIssue({
        code: "custom",
        path: ["uri"],
        message: "ResourceRef uri must match system/kind/id"
      });
    }
  });

export const actorContextSchema = z
  .object({
    schemaVersion: z.literal("actor-context/1.0"),
    actorKind: z.enum(["person", "service"]),
    principal: resourceRefSchema,
    family: resourceRefSchema.optional(),
    entryAudience: z.enum(["personal", "family", "system"]),
    authStrength: z.enum(["session", "device", "service"]),
    scopes: z.array(z.string().regex(/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*){2,4}$/)).min(1),
    requestId: z.string().regex(/^request:[A-Za-z0-9_-]{8,128}$/),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actorKind === "person") {
      if (
        value.principal.system !== "family-ai" ||
        value.principal.kind !== "person" ||
        value.family?.system !== "family-ai" ||
        value.family.kind !== "family"
      ) {
        context.addIssue({ code: "custom", message: "Person ActorContext requires Family Person/Family refs" });
      }
    } else if (value.principal.kind !== "service") {
      context.addIssue({ code: "custom", message: "Service ActorContext cannot impersonate a Person" });
    }
    const issuedAt = Date.parse(value.issuedAt);
    const expiresAt = Date.parse(value.expiresAt);
    if (expiresAt <= issuedAt || expiresAt - issuedAt > 5 * 60 * 1000) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "ActorContext lifetime exceeds five minutes" });
    }
  });

export const assetRefSchema = z
  .object({
    schemaVersion: z.literal("asset-ref/1.0"),
    asset: resourceRefSchema,
    fileName: z.string().min(1).max(255).regex(/^[^/\\]+$/),
    mediaType: z.string().min(3).max(127).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
    sizeBytes: z.number().int().nonnegative().max(1_099_511_627_776),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sensitivity: z.enum(["public", "family-private", "project-private", "highly-sensitive"]),
    retrievalMode: z.literal("capability")
  })
  .strict();

export const familyWorkToCanvasSchema = z
  .object({
    schemaVersion: z.literal("family-work-to-canvas/1.1"),
    agentRef: z.string().regex(refPattern("agent")),
    sourceWork: resourceRefSchema,
    title: z.string().trim().min(1).max(160),
    goal: z.string().trim().min(1).max(4000),
    summary: z.string().max(12000),
    messageRefs: z.array(resourceRefSchema).max(100),
    assets: z.array(assetRefSchema).max(20),
    sourceSequence: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(8).max(160)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceWork.system !== "family-ai" || value.sourceWork.kind !== "work") {
      context.addIssue({ code: "custom", path: ["sourceWork"], message: "sourceWork must be a Family Work" });
    }
    value.messageRefs.forEach((ref, index) => {
      if (ref.system !== "family-ai" || ref.kind !== "message") {
        context.addIssue({ code: "custom", path: ["messageRefs", index], message: "messageRefs must be Family messages" });
      }
    });
  });

export const createExecutionLinkRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    idempotencyKey: z.string().min(8).max(160),
    messageRefs: z.array(z.string().regex(refPattern("message"))).max(100).default([]),
    attachmentRefs: z.array(z.string().regex(refPattern("attachment"))).max(20).default([])
  })
  .strict();

export const executionLinkSchema = z
  .object({
    linkRef: z.string().regex(refPattern("execution-link")),
    workConversationRef: z.string().regex(refPattern("work")),
    externalResource: resourceRefSchema,
    rootSession: resourceRefSchema,
    status: z.enum(["active", "revoked"]),
    deepLink: z.string().url().nullable(),
    sourceSequence: z.number().int().nonnegative(),
    createdByPersonRef: z.string().regex(refPattern("person")),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.externalResource.system !== "super-canvas" || value.externalResource.kind !== "workflow") {
      context.addIssue({ code: "custom", path: ["externalResource"], message: "link target must be a Canvas Workflow" });
    }
    if (value.rootSession.system !== "super-canvas" || value.rootSession.kind !== "session") {
      context.addIssue({ code: "custom", path: ["rootSession"], message: "rootSession must be a Canvas Session" });
    }
    if ((value.status === "active") !== (value.revokedAt === null)) {
      context.addIssue({ code: "custom", path: ["revokedAt"], message: "revocation state is inconsistent" });
    }
    if ((value.status === "active") !== (value.deepLink !== null)) {
      context.addIssue({ code: "custom", path: ["deepLink"], message: "revoked links must not expose a deep link" });
    }
  });

export const executionLinkListResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    links: z.array(executionLinkSchema)
  })
  .strict();

export const createExecutionLinkResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    link: executionLinkSchema
  })
  .strict();

export const canvasWorkflowIntegrationResponseSchema = z
  .object({
    schemaVersion: z.literal("family-workflow-result/1.0"),
    workflow: resourceRefSchema,
    rootSession: resourceRefSchema,
    deepLink: z.string().url()
  })
  .strict();

export type ResourceRef = z.infer<typeof resourceRefSchema>;
export type ActorContext = z.infer<typeof actorContextSchema>;
export type AssetRef = z.infer<typeof assetRefSchema>;
export type FamilyWorkToCanvas = z.infer<typeof familyWorkToCanvasSchema>;
export type CreateExecutionLinkRequest = z.infer<typeof createExecutionLinkRequestSchema>;
export type ExecutionLink = z.infer<typeof executionLinkSchema>;
export type CanvasWorkflowIntegrationResponse = z.infer<typeof canvasWorkflowIntegrationResponseSchema>;
