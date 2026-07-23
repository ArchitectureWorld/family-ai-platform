import { z } from "zod";

export const CHAT_WORK_PROTOCOL_VERSION = 1 as const;

const protocolVersionSchema = z.literal(CHAT_WORK_PROTOCOL_VERSION);
const timestampSchema = z.string().datetime({ offset: true });
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timezoneSchema = z.string().trim().min(1).max(80);
const clientMessageIdSchema = z.string().trim().min(8).max(128);

function refSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}:[a-z0-9][a-z0-9._:-]{1,126}$`));
}

const personRefSchema = refSchema("person");
const assignmentRefSchema = refSchema("assignment");
const agentRefSchema = refSchema("agent");
const deviceRefSchema = refSchema("device");
const connectionRefSchema = refSchema("connection");
const systemRefSchema = refSchema("system");
const messageRefSchema = refSchema("message");

export const interactionThreadRefSchema = refSchema("thread");
export const homeChatStreamRefSchema = refSchema("home-chat");
export const dailyEpisodeRefSchema = refSchema("daily-episode");
export const workConversationRefSchema = refSchema("work");
export const chatWorkConversionRefSchema = refSchema("chat-work-conversion");

export const interactionThreadSchema = z
  .object({
    threadRef: interactionThreadRefSchema,
    threadKind: z.enum(["home_chat", "work"]),
    personRef: personRefSchema,
    lastSequence: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    lastActiveAt: timestampSchema
  })
  .strict();

export const homeChatStreamSchema = interactionThreadSchema
  .extend({
    threadKind: z.literal("home_chat"),
    homeChatStreamRef: homeChatStreamRefSchema,
    status: z.enum(["active", "suspended"]),
    currentEpisodeRef: dailyEpisodeRefSchema.nullable()
  })
  .strict();

export const dailyEpisodeSchema = z
  .object({
    dailyEpisodeRef: dailyEpisodeRefSchema,
    homeChatStreamRef: homeChatStreamRefSchema,
    threadRef: interactionThreadRefSchema,
    localDate: localDateSchema,
    timezone: timezoneSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
    boundaryReason: z.enum(["initial", "local_day", "inactive_gap", "manual_correction"]),
    archiveStatus: z.enum(["open", "pending", "archived", "failed"]),
    archiveVersion: z.number().int().nonnegative(),
    lastMessageSequence: z.number().int().nonnegative()
  })
  .strict();

export const workConversationStatusSchema = z.enum([
  "active",
  "paused",
  "waiting_confirmation",
  "completed",
  "archived"
]);

export const workConversationSchema = interactionThreadSchema
  .extend({
    threadKind: z.literal("work"),
    workConversationRef: workConversationRefSchema,
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(4000),
    summary: z.string().trim().max(8000),
    status: workConversationStatusSchema,
    archivedAt: timestampSchema.nullable()
  })
  .strict();

export const threadMessageContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().trim().min(1).max(12000),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/).optional()
  })
  .strict();

export const threadActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("person"), personRef: personRefSchema }).strict(),
  z
    .object({
      type: z.literal("assistant"),
      assignmentRef: assignmentRefSchema,
      agentRef: agentRefSchema
    })
    .strict(),
  z.object({ type: z.literal("agent"), agentRef: agentRefSchema }).strict(),
  z.object({ type: z.literal("system"), systemRef: systemRefSchema }).strict()
]);

export const threadMessageOriginSchema = z
  .object({
    deviceRef: deviceRefSchema.nullable(),
    connectionRef: connectionRefSchema.nullable(),
    entryAudience: z.enum(["personal", "family_admin", "system"])
  })
  .strict();

export const threadMessageSchema = z
  .object({
    messageRef: messageRefSchema,
    threadRef: interactionThreadRefSchema,
    threadSequence: z.number().int().positive(),
    clientMessageId: clientMessageIdSchema,
    actor: threadActorSchema,
    origin: threadMessageOriginSchema,
    content: threadMessageContentSchema,
    occurredAt: timestampSchema,
    createdAt: timestampSchema
  })
  .strict();

export const homeChatStreamResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    chat: homeChatStreamSchema,
    currentEpisode: dailyEpisodeSchema.nullable()
  })
  .strict();

export const workConversationListResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    conversations: z.array(workConversationSchema).max(500)
  })
  .strict();

export const threadMessageListResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    threadRef: interactionThreadRefSchema,
    messages: z.array(threadMessageSchema).max(200),
    nextBeforeSequence: z.number().int().positive().nullable()
  })
  .strict();

export type InteractionThread = z.infer<typeof interactionThreadSchema>;
export type HomeChatStream = z.infer<typeof homeChatStreamSchema>;
export type DailyEpisode = z.infer<typeof dailyEpisodeSchema>;
export type WorkConversationStatus = z.infer<typeof workConversationStatusSchema>;
export type WorkConversation = z.infer<typeof workConversationSchema>;
export type ThreadMessageContent = z.infer<typeof threadMessageContentSchema>;
export type ThreadActor = z.infer<typeof threadActorSchema>;
export type ThreadMessageOrigin = z.infer<typeof threadMessageOriginSchema>;
export type ThreadMessage = z.infer<typeof threadMessageSchema>;
export type HomeChatStreamResponse = z.infer<typeof homeChatStreamResponseSchema>;
export type WorkConversationListResponse = z.infer<typeof workConversationListResponseSchema>;
export type ThreadMessageListResponse = z.infer<typeof threadMessageListResponseSchema>;
