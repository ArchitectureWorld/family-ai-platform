import { z } from "zod";

export const CHAT_WORK_PROTOCOL_VERSION = 1 as const;

const protocolVersionSchema = z.literal(CHAT_WORK_PROTOCOL_VERSION);
const timestampSchema = z.string().datetime({ offset: true });
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timezoneSchema = z.string().trim().min(1).max(80);
const clientMessageIdSchema = z.string().min(8).max(128).regex(/^\S+$/);
const titleSchema = z.string().trim().min(1).max(120);
const goalSchema = z.string().trim().min(1).max(4000);
const summarySchema = z.string().trim().max(8000);
const workListItemSchema = z.string().trim().min(1).max(1000);

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

const dailyEpisodeBaseSchema = z
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

export const dailyEpisodeSchema = dailyEpisodeBaseSchema.superRefine((value, context) => {
  if (value.archiveStatus === "open" && value.endedAt !== null) {
    context.addIssue({
      code: "custom",
      path: ["endedAt"],
      message: "open DailyEpisode must not have endedAt"
    });
  }

  if (value.archiveStatus === "archived") {
    if (value.endedAt === null) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "archived DailyEpisode requires endedAt"
      });
    }
    if (value.archiveVersion < 1) {
      context.addIssue({
        code: "custom",
        path: ["archiveVersion"],
        message: "archived DailyEpisode requires archiveVersion >= 1"
      });
    }
  }
});

export const workConversationStatusSchema = z.enum([
  "active",
  "paused",
  "waiting_confirmation",
  "completed",
  "archived"
]);

const workConversationBaseSchema = interactionThreadSchema
  .extend({
    threadKind: z.literal("work"),
    workConversationRef: workConversationRefSchema,
    title: titleSchema,
    goal: goalSchema,
    summary: summarySchema,
    status: workConversationStatusSchema,
    archivedAt: timestampSchema.nullable()
  })
  .strict();

export const workConversationSchema = workConversationBaseSchema.superRefine((value, context) => {
  if (value.status === "archived" && value.archivedAt === null) {
    context.addIssue({
      code: "custom",
      path: ["archivedAt"],
      message: "archived WorkConversation requires archivedAt"
    });
  }
  if (value.status !== "archived" && value.archivedAt !== null) {
    context.addIssue({
      code: "custom",
      path: ["archivedAt"],
      message: "non-archived WorkConversation must not have archivedAt"
    });
  }
});

export const threadMessageContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1).max(12000),
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

const threadMessageBaseSchema = z
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

export const threadMessageSchema = threadMessageBaseSchema.superRefine((value, context) => {
  if (value.actor.type === "person" && value.origin.deviceRef === null) {
    context.addIssue({
      code: "custom",
      path: ["origin", "deviceRef"],
      message: "Person message requires a device origin"
    });
  }
  if (value.actor.type === "system" && value.origin.entryAudience !== "system") {
    context.addIssue({
      code: "custom",
      path: ["origin", "entryAudience"],
      message: "System message requires the system audience"
    });
  }
});

export const homeChatStreamResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    chat: homeChatStreamSchema,
    currentEpisode: dailyEpisodeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.currentEpisode === null) {
      if (value.chat.currentEpisodeRef !== null) {
        context.addIssue({
          code: "custom",
          path: ["chat", "currentEpisodeRef"],
          message: "Chat without a current Episode must have a null currentEpisodeRef"
        });
      }
      return;
    }

    if (value.currentEpisode.threadRef !== value.chat.threadRef) {
      context.addIssue({
        code: "custom",
        path: ["currentEpisode", "threadRef"],
        message: "current Episode must belong to the Home Chat thread"
      });
    }
    if (value.currentEpisode.homeChatStreamRef !== value.chat.homeChatStreamRef) {
      context.addIssue({
        code: "custom",
        path: ["currentEpisode", "homeChatStreamRef"],
        message: "current Episode must belong to the Home Chat stream"
      });
    }
    if (value.currentEpisode.dailyEpisodeRef !== value.chat.currentEpisodeRef) {
      context.addIssue({
        code: "custom",
        path: ["chat", "currentEpisodeRef"],
        message: "currentEpisodeRef must match the returned Episode"
      });
    }
  });

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
  .strict()
  .superRefine((value, context) => {
    let previousSequence = 0;
    for (const [index, message] of value.messages.entries()) {
      if (message.threadRef !== value.threadRef) {
        context.addIssue({
          code: "custom",
          path: ["messages", index, "threadRef"],
          message: "message must belong to the response thread"
        });
      }
      if (message.threadSequence <= previousSequence) {
        context.addIssue({
          code: "custom",
          path: ["messages", index, "threadSequence"],
          message: "message threadSequence must be strictly increasing"
        });
      }
      previousSequence = message.threadSequence;
    }
  });

export const createWorkConversationRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    title: titleSchema,
    goal: goalSchema
  })
  .strict();

export const createWorkConversationResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    conversation: workConversationSchema
  })
  .strict();

export const sendThreadMessageRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    clientMessageId: clientMessageIdSchema,
    occurredAt: timestampSchema,
    content: threadMessageContentSchema
  })
  .strict();

export const sendThreadMessageResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    message: threadMessageSchema
  })
  .strict();

const createWorkFromChatBaseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    title: titleSchema,
    goal: goalSchema,
    source: z
      .object({
        homeChatStreamRef: homeChatStreamRefSchema,
        dailyEpisodeRef: dailyEpisodeRefSchema.nullable(),
        messageRefs: z.array(messageRefSchema).min(1).max(100)
      })
      .strict(),
    decisions: z.array(workListItemSchema).max(50),
    openQuestions: z.array(workListItemSchema).max(50)
  })
  .strict();

export const createWorkFromChatRequestSchema = createWorkFromChatBaseSchema.superRefine(
  (value, context) => {
    if (new Set(value.source.messageRefs).size !== value.source.messageRefs.length) {
      context.addIssue({
        code: "custom",
        path: ["source", "messageRefs"],
        message: "source messageRefs must be unique"
      });
    }
  }
);

export const chatWorkConversionSchema = z
  .object({
    conversionRef: chatWorkConversionRefSchema,
    homeChatStreamRef: homeChatStreamRefSchema,
    dailyEpisodeRef: dailyEpisodeRefSchema.nullable(),
    sourceMessageRefs: z.array(messageRefSchema).min(1).max(100),
    workConversationRef: workConversationRefSchema,
    createdAt: timestampSchema
  })
  .strict();

export const createWorkFromChatResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    conversation: workConversationSchema,
    conversion: chatWorkConversionSchema
  })
  .strict();

export const workProgressSnapshotSchema = z
  .object({
    workConversationRef: workConversationRefSchema,
    status: workConversationStatusSchema,
    phaseSummary: z.string().trim().min(1).max(4000),
    incompleteTasks: z.array(workListItemSchema).max(100),
    risks: z.array(workListItemSchema).max(100),
    pendingConfirmations: z.array(workListItemSchema).max(100),
    deadlines: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(200),
            dueAt: timestampSchema
          })
          .strict()
      )
      .max(100),
    updatedAt: timestampSchema
  })
  .strict();

export const workProgressSnapshotResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    snapshot: workProgressSnapshotSchema
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
export type CreateWorkConversationRequest = z.infer<typeof createWorkConversationRequestSchema>;
export type CreateWorkConversationResponse = z.infer<typeof createWorkConversationResponseSchema>;
export type SendThreadMessageRequest = z.infer<typeof sendThreadMessageRequestSchema>;
export type SendThreadMessageResponse = z.infer<typeof sendThreadMessageResponseSchema>;
export type CreateWorkFromChatRequest = z.infer<typeof createWorkFromChatRequestSchema>;
export type ChatWorkConversion = z.infer<typeof chatWorkConversionSchema>;
export type CreateWorkFromChatResponse = z.infer<typeof createWorkFromChatResponseSchema>;
export type WorkProgressSnapshot = z.infer<typeof workProgressSnapshotSchema>;
export type WorkProgressSnapshotResponse = z.infer<typeof workProgressSnapshotResponseSchema>;
