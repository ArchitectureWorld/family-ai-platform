import { z } from "zod";

export const PROTOCOL_VERSION = "1.0" as const;

const protocolVersionSchema = z.literal(PROTOCOL_VERSION);
const timestampSchema = z.string().datetime({ offset: true });
const idempotencyKeySchema = z.string().min(8).max(128);

function refSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}:[a-z0-9][a-z0-9._:-]{1,126}$`));
}

export const memberRefSchema = refSchema("member");
export const deviceRefSchema = refSchema("device");
export const agentRefSchema = refSchema("agent");
export const conversationRefSchema = refSchema("conversation");
export const messageRefSchema = refSchema("message");
export const correlationRefSchema = refSchema("correlation");
export const invocationRefSchema = refSchema("invocation");
export const providerProfileRefSchema = refSchema("provider-profile");
export const externalSessionRefSchema = refSchema("external-session");

const deviceEndpointSchema = z
  .object({ kind: z.literal("device"), ref: deviceRefSchema })
  .strict();
const agentEndpointSchema = z
  .object({ kind: z.literal("agent"), ref: agentRefSchema })
  .strict();

export const endpointSchema = z.discriminatedUnion("kind", [
  deviceEndpointSchema,
  agentEndpointSchema
]);

export const textPayloadSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1).max(12000),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/).optional()
  })
  .strict();

export const messageEnvelopeSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    messageRef: messageRefSchema,
    correlationRef: correlationRefSchema,
    idempotencyKey: idempotencyKeySchema,
    occurredAt: timestampSchema,
    source: endpointSchema,
    target: endpointSchema,
    payload: textPayloadSchema
  })
  .strict();

export const publicErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    category: z.enum(["validation", "permission", "availability", "timeout", "conflict", "internal"]),
    message: z.string().min(1).max(500),
    retryable: z.boolean()
  })
  .strict();

export const providerInvocationRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    invocationRef: invocationRefSchema,
    correlationRef: correlationRefSchema,
    idempotencyKey: idempotencyKeySchema,
    requestedAt: timestampSchema,
    providerProfileRef: providerProfileRefSchema,
    targetAgentRef: agentRefSchema,
    conversationRef: conversationRefSchema,
    externalSessionRef: externalSessionRefSchema.optional(),
    content: z.array(textPayloadSchema).min(1).max(20),
    timeoutMs: z.number().int().min(1000).max(300000)
  })
  .strict();

export const providerInvocationResultSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    invocationRef: invocationRefSchema,
    correlationRef: correlationRefSchema,
    status: z.enum(["succeeded", "failed", "cancelled", "timed_out"]),
    completedAt: timestampSchema,
    output: z.array(textPayloadSchema).min(1).max(20).optional(),
    error: publicErrorSchema.optional(),
    externalSessionRef: externalSessionRefSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded") {
      if (!value.output || value.error) {
        context.addIssue({
          code: "custom",
          message: "successful results require output and no error"
        });
      }
      return;
    }
    if (!value.error || value.output) {
      context.addIssue({
        code: "custom",
        message: "non-success results require an error and no output"
      });
    }
  });

export const adapterHealthSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    adapterRef: refSchema("adapter"),
    status: z.enum(["online", "degraded", "offline"]),
    providerProfiles: z.array(providerProfileRefSchema).min(1),
    checkedAt: timestampSchema
  })
  .strict();

export type Endpoint = z.infer<typeof endpointSchema>;
export type TextPayload = z.infer<typeof textPayloadSchema>;
export type MessageEnvelope = z.infer<typeof messageEnvelopeSchema>;
export type PublicError = z.infer<typeof publicErrorSchema>;
export type ProviderInvocationRequest = z.infer<typeof providerInvocationRequestSchema>;
export type ProviderInvocationResult = z.infer<typeof providerInvocationResultSchema>;
export type AdapterHealth = z.infer<typeof adapterHealthSchema>;

export * from "./mobileEntry.js";
