import { z } from "zod";

export type ProductId = "family" | "canvas" | "me";

export interface AgentDescriptorV1 {
  protocolVersion: 1;
  agentRef: string;
  displayName: string;
  kind: "agent";
  runtime: "hermes-local";
  status: "available" | "unavailable" | "disabled";
  capabilities: readonly string[];
  system: boolean;
  observedAt: string;
}

export interface FederationActorContextV1 {
  protocolVersion: 1;
  contextRef: string;
  product: ProductId;
  familyRef: string;
  personRef: string;
  deviceRef: string;
  entrySessionRef: string;
  personDisplayName: string;
  familyDisplayName: string;
  roles: readonly string[];
  assignmentVersion: number;
  contextVersion: number;
  expiresAt: string;
}

export interface AgentInvocationRequestV1 {
  protocolVersion: 1;
  invocationRef: string;
  correlationRef: string;
  product: ProductId;
  actorContextRef: string;
  agentRef: string;
  localSessionRef: string;
  externalSessionRef?: string;
  prompt: string;
  timeoutMs: number;
}

export interface AgentInvocationResultV1 {
  protocolVersion: 1;
  invocationRef: string;
  correlationRef: string;
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  output: string;
  completedAt: string;
  externalSessionRef: string;
}

const protocolVersionSchema = z.literal(1);
const timestampSchema = z.string().datetime({ offset: true });
const productIdSchema = z.enum(["family", "canvas", "me"]);
const boundedTextSchema = z.string().trim().min(1).max(12000);
const invocationPromptSchema = z.string().max(12000).refine(
  (value) => value.trim().length > 0,
  { message: "Invocation prompt must contain non-whitespace content" }
);
const capabilitySchema = z.string().trim().min(1).max(100);
const roleSchema = z.string().regex(/^[a-z][a-z0-9_:-]{0,63}$/);
const displayNameSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u)
  .refine((value) => !/[\uD800-\uDFFF]/u.test(value));

function refSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}:[a-z0-9][a-z0-9._:-]{1,126}$`));
}

const actorContextRefSchema = refSchema("actor-context");
const familyRefSchema = refSchema("family");
const personRefSchema = refSchema("person");
const deviceRefSchema = refSchema("device");
const entrySessionRefSchema = refSchema("entry-session");
const invocationRefSchema = refSchema("invocation");
const correlationRefSchema = refSchema("correlation");
const agentRefSchema = refSchema("agent");
const localSessionRefSchema = refSchema("local-session");
const externalSessionRefSchema = refSchema("external-session");
const serviceRefSchema = refSchema("service");

export const productIdV1Schema = productIdSchema;

export const agentDescriptorV1Schema = z
  .object({
    protocolVersion: protocolVersionSchema,
    agentRef: agentRefSchema,
    displayName: z.string().trim().min(1).max(80),
    kind: z.literal("agent"),
    runtime: z.literal("hermes-local"),
    status: z.enum(["available", "unavailable", "disabled"]),
    capabilities: z.array(capabilitySchema).min(1).max(100),
    system: z.boolean(),
    observedAt: timestampSchema
  })
  .strict();

export const federationActorContextV1Schema = z
  .object({
    protocolVersion: protocolVersionSchema,
    contextRef: actorContextRefSchema,
    product: productIdSchema,
    familyRef: familyRefSchema,
    personRef: personRefSchema,
    deviceRef: deviceRefSchema,
    entrySessionRef: entrySessionRefSchema,
    personDisplayName: displayNameSchema,
    familyDisplayName: displayNameSchema,
    roles: z.array(roleSchema).min(1).max(100),
    assignmentVersion: z.number().int().positive(),
    contextVersion: z.number().int().positive(),
    expiresAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.now()) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Actor context must not be expired"
      });
    }
  });

export const agentInvocationRequestV1Schema = z
  .object({
    protocolVersion: protocolVersionSchema,
    invocationRef: invocationRefSchema,
    correlationRef: correlationRefSchema,
    product: productIdSchema,
    actorContextRef: actorContextRefSchema,
    agentRef: agentRefSchema,
    localSessionRef: localSessionRefSchema,
    externalSessionRef: externalSessionRefSchema.optional(),
    prompt: invocationPromptSchema,
    timeoutMs: z.number().int().min(1000).max(300000)
  })
  .strict();

export const agentInvocationResultV1Schema = z
  .object({
    protocolVersion: protocolVersionSchema,
    invocationRef: invocationRefSchema,
    correlationRef: correlationRefSchema,
    status: z.enum(["succeeded", "failed", "cancelled", "timed_out"]),
    output: boundedTextSchema,
    completedAt: timestampSchema,
    externalSessionRef: externalSessionRefSchema
  })
  .strict();

const federationAgentListScopeV1Schema = z.object({
  serviceRef: serviceRefSchema,
  product: z.enum(["canvas", "me"]),
  actorContextRef: actorContextRefSchema,
  familyRef: familyRefSchema,
  personRef: personRefSchema,
  assignmentVersion: z.number().int().positive(),
  contextVersion: z.number().int().positive()
}).strict();

export const federationAgentListV1Schema = z.object({
  protocolVersion: protocolVersionSchema,
  scope: federationAgentListScopeV1Schema,
  agents: z.array(agentDescriptorV1Schema).max(100)
}).strict();

const federationInvocationScopeV1Schema = z.object({
  serviceRef: serviceRefSchema,
  product: z.enum(["canvas", "me"]),
  actorContextRef: actorContextRefSchema,
  familyRef: familyRefSchema,
  personRef: personRefSchema,
  agentRef: agentRefSchema,
  localSessionRef: localSessionRefSchema
}).strict();

export const federationInvocationResponseV1Schema = z.object({
  protocolVersion: protocolVersionSchema,
  scope: federationInvocationScopeV1Schema,
  correlationRef: correlationRefSchema,
  result: agentInvocationResultV1Schema
}).strict().superRefine((value, context) => {
  if (value.correlationRef !== value.result.correlationRef) {
    context.addIssue({
      code: "custom",
      path: ["correlationRef"],
      message: "Invocation response correlation scope mismatch"
    });
  }
});

const federationInvocationStatusBaseShape = {
  protocolVersion: protocolVersionSchema,
  invocationRef: invocationRefSchema,
  correlationRef: correlationRefSchema,
  scope: federationInvocationScopeV1Schema
};

const federationInvocationAcceptedV1Schema = z.object({
  ...federationInvocationStatusBaseShape,
  status: z.literal("accepted"),
  leaseExpiresAt: timestampSchema,
  retryAfter: z.number().int().positive()
}).strict();

const federationInvocationSucceededV1Schema = z.object({
  ...federationInvocationStatusBaseShape,
  status: z.literal("succeeded"),
  externalSessionRef: externalSessionRefSchema,
  completedAt: timestampSchema,
  outputAvailable: z.literal(false)
}).strict();

const federationInvocationFailedV1Schema = z.object({
  ...federationInvocationStatusBaseShape,
  status: z.literal("failed"),
  completedAt: timestampSchema,
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/)
}).strict();

export const federationInvocationStatusV1Schema = z.discriminatedUnion(
  "status",
  [
    federationInvocationAcceptedV1Schema,
    federationInvocationSucceededV1Schema,
    federationInvocationFailedV1Schema
  ]
);

export const federationInvocationPostResponseV1Schema = z.union([
  federationInvocationResponseV1Schema,
  federationInvocationStatusV1Schema
]);

export type FederationAgentListV1 = z.infer<typeof federationAgentListV1Schema>;
export type FederationInvocationResponseV1 = z.infer<
  typeof federationInvocationResponseV1Schema
>;
export type FederationInvocationStatusV1 = z.infer<
  typeof federationInvocationStatusV1Schema
>;
export type FederationInvocationPostResponseV1 = z.infer<
  typeof federationInvocationPostResponseV1Schema
>;
