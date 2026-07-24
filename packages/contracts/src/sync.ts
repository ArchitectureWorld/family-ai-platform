import { z } from "zod";
import { workConversationStatusSchema } from "./chatWork.js";

export const SYNC_PROTOCOL_VERSION = 1 as const;
export const SYNC_SSE_EVENT_NAME = "domain-event" as const;

function fixedRef(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}:[a-z0-9][a-z0-9._:-]{1,126}$`));
}

export const syncEventRefSchema = fixedRef("event");
export const syncPersonRefSchema = fixedRef("person");
export const syncDeviceRefSchema = fixedRef("device");
export const syncThreadRefSchema = fixedRef("thread");
export const syncMessageRefSchema = fixedRef("message");
const syncHomeChatStreamRefSchema = fixedRef("home-chat");
const syncDailyEpisodeRefSchema = fixedRef("daily-episode");
const syncWorkConversationRefSchema = fixedRef("work");
const syncChatWorkConversionRefSchema = fixedRef("chat-work-conversion");

export const syncGenericRefSchema = z
  .string()
  .regex(/^[a-z][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._:-]{1,126}$/);
export const syncEventTypeSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/);
export const syncAggregateTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
export const syncEventSequenceSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const syncCursorSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const syncTimestampSchema = z.string().datetime({ offset: true });
export const syncClientMessageIdSchema = z.string().min(8).max(128).regex(/^\S+$/);
export const syncPublicErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
export const syncPublicErrorCategorySchema = z.enum([
  "validation",
  "permission",
  "availability",
  "timeout",
  "conflict",
  "internal"
]);

export type SyncJsonValue =
  | null
  | boolean
  | number
  | string
  | SyncJsonValue[]
  | { [key: string]: SyncJsonValue };
export type SyncJsonObject = { [key: string]: SyncJsonValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSyncJsonValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>()
): value is SyncJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isSyncJsonValue(item, ancestors));
    }
    if (!isPlainObject(value)) return false;
    return Object.values(value).every((item) => isSyncJsonValue(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

export const syncJsonValueSchema = z.custom<SyncJsonValue>(
  (value) => isSyncJsonValue(value),
  { message: "Sync payload must contain JSON-safe values" }
);
export const syncJsonObjectSchema = z.custom<SyncJsonObject>(
  (value) => isPlainObject(value) && isSyncJsonValue(value),
  { message: "Sync payload must be a JSON-safe plain object" }
);

export const KNOWN_SYNC_EVENT_TYPES = [
  "chat.home.created",
  "work.created",
  "thread.message.created",
  "chat.work.created",
  "work.progress.updated",
  "thread.provider_turn.failed",
  "thread.provider_turn.succeeded"
] as const;

export const knownSyncEventTypeSchema = z.enum(KNOWN_SYNC_EVENT_TYPES);

const syncEventEnvelopeSchema = z
  .object({
    eventRef: syncEventRefSchema,
    personRef: syncPersonRefSchema,
    eventSequence: syncEventSequenceSchema,
    eventType: syncEventTypeSchema,
    aggregateType: syncAggregateTypeSchema,
    aggregateRef: syncGenericRefSchema,
    threadRef: syncThreadRefSchema.nullable(),
    payload: z.unknown(),
    occurredAt: syncTimestampSchema,
    createdAt: syncTimestampSchema
  })
  .strict();

const chatHomeCreatedEventShape = syncEventEnvelopeSchema
  .extend({
    eventType: z.literal("chat.home.created"),
    aggregateType: z.literal("home_chat"),
    aggregateRef: syncHomeChatStreamRefSchema,
    threadRef: syncThreadRefSchema,
    payload: z
      .object({
        homeChatStreamRef: syncHomeChatStreamRefSchema,
        dailyEpisodeRef: syncDailyEpisodeRefSchema,
        threadRef: syncThreadRefSchema
      })
      .strict()
  })
  .strict();

const workCreatedEventShape = syncEventEnvelopeSchema
  .extend({
    eventType: z.literal("work.created"),
    aggregateType: z.literal("work"),
    aggregateRef: syncWorkConversationRefSchema,
    threadRef: syncThreadRefSchema,
    payload: z
      .object({
        workConversationRef: syncWorkConversationRefSchema,
        threadRef: syncThreadRefSchema,
        status: workConversationStatusSchema
      })
      .strict()
  })
  .strict();

const threadMessageCreatedEventShape = syncEventEnvelopeSchema
  .extend({
    eventType: z.literal("thread.message.created"),
    aggregateType: z.literal("thread_message"),
    aggregateRef: syncMessageRefSchema,
    threadRef: syncThreadRefSchema,
    payload: z
      .object({
        messageRef: syncMessageRefSchema,
        threadRef: syncThreadRefSchema,
        threadSequence: syncEventSequenceSchema,
        actorType: z.enum(["person", "assistant", "agent", "system"]),
        clientMessageId: syncClientMessageIdSchema
      })
      .strict()
  })
  .strict();

const chatWorkCreatedEventShape = syncEventEnvelopeSchema
  .extend({
    eventType: z.literal("chat.work.created"),
    aggregateType: z.literal("chat_work_conversion"),
    aggregateRef: syncChatWorkConversionRefSchema,
    threadRef: syncThreadRefSchema,
    payload: z
      .object({
        conversionRef: syncChatWorkConversionRefSchema,
        homeChatStreamRef: syncHomeChatStreamRefSchema,
        workConversationRef: syncWorkConversationRefSchema,
        sourceMessageRefs: z.array(syncMessageRefSchema).min(1).max(100)
      })
      .strict()
  })
  .strict();

const workProgressUpdatedEventShape = syncEventEnvelopeSchema
  .extend({
    eventType: z.literal("work.progress.updated"),
    aggregateType: z.literal("work_progress"),
    aggregateRef: syncWorkConversationRefSchema,
    threadRef: syncThreadRefSchema,
    payload: z
      .object({
        workConversationRef: syncWorkConversationRefSchema,
        status: workConversationStatusSchema,
        updatedAt: syncTimestampSchema
      })
      .strict()
  })
  .strict();

const providerTurnFailedEventShape = syncEventEnvelopeSchema
  .extend({
    eventType: z.literal("thread.provider_turn.failed"),
    aggregateType: z.literal("provider_turn"),
    aggregateRef: syncMessageRefSchema,
    threadRef: syncThreadRefSchema,
    payload: z
      .object({
        userMessageRef: syncMessageRefSchema,
        threadRef: syncThreadRefSchema,
        attemptCount: syncEventSequenceSchema,
        error: z
          .object({
            code: syncPublicErrorCodeSchema,
            category: syncPublicErrorCategorySchema,
            retryable: z.boolean()
          })
          .strict()
      })
      .strict()
  })
  .strict();

const providerTurnSucceededEventShape = syncEventEnvelopeSchema
  .extend({
    eventType: z.literal("thread.provider_turn.succeeded"),
    aggregateType: z.literal("provider_turn"),
    aggregateRef: syncMessageRefSchema,
    threadRef: syncThreadRefSchema,
    payload: z
      .object({
        userMessageRef: syncMessageRefSchema,
        assistantMessageRef: syncMessageRefSchema,
        threadRef: syncThreadRefSchema,
        attemptCount: syncEventSequenceSchema
      })
      .strict()
  })
  .strict();

const knownSyncEventShapeSchema = z.discriminatedUnion("eventType", [
  chatHomeCreatedEventShape,
  workCreatedEventShape,
  threadMessageCreatedEventShape,
  chatWorkCreatedEventShape,
  workProgressUpdatedEventShape,
  providerTurnFailedEventShape,
  providerTurnSucceededEventShape
]);

export const knownSyncEventSchema = knownSyncEventShapeSchema.superRefine((event, context) => {
  switch (event.eventType) {
    case "chat.home.created":
      if (event.aggregateRef !== event.payload.homeChatStreamRef) {
        context.addIssue({
          code: "custom",
          path: ["aggregateRef"],
          message: "aggregateRef must match payload.homeChatStreamRef"
        });
      }
      if (event.threadRef !== event.payload.threadRef) {
        context.addIssue({
          code: "custom",
          path: ["threadRef"],
          message: "threadRef must match payload.threadRef"
        });
      }
      break;
    case "work.created":
      if (event.aggregateRef !== event.payload.workConversationRef) {
        context.addIssue({
          code: "custom",
          path: ["aggregateRef"],
          message: "aggregateRef must match payload.workConversationRef"
        });
      }
      if (event.threadRef !== event.payload.threadRef) {
        context.addIssue({
          code: "custom",
          path: ["threadRef"],
          message: "threadRef must match payload.threadRef"
        });
      }
      break;
    case "thread.message.created":
      if (event.aggregateRef !== event.payload.messageRef) {
        context.addIssue({
          code: "custom",
          path: ["aggregateRef"],
          message: "aggregateRef must match payload.messageRef"
        });
      }
      if (event.threadRef !== event.payload.threadRef) {
        context.addIssue({
          code: "custom",
          path: ["threadRef"],
          message: "threadRef must match payload.threadRef"
        });
      }
      break;
    case "chat.work.created":
      if (event.aggregateRef !== event.payload.conversionRef) {
        context.addIssue({
          code: "custom",
          path: ["aggregateRef"],
          message: "aggregateRef must match payload.conversionRef"
        });
      }
      if (new Set(event.payload.sourceMessageRefs).size !== event.payload.sourceMessageRefs.length) {
        context.addIssue({
          code: "custom",
          path: ["payload", "sourceMessageRefs"],
          message: "sourceMessageRefs must be unique"
        });
      }
      break;
    case "work.progress.updated":
      if (event.aggregateRef !== event.payload.workConversationRef) {
        context.addIssue({
          code: "custom",
          path: ["aggregateRef"],
          message: "aggregateRef must match payload.workConversationRef"
        });
      }
      if (event.occurredAt !== event.payload.updatedAt) {
        context.addIssue({
          code: "custom",
          path: ["occurredAt"],
          message: "occurredAt must match payload.updatedAt"
        });
      }
      break;
    case "thread.provider_turn.failed":
      if (event.aggregateRef !== event.payload.userMessageRef) {
        context.addIssue({
          code: "custom",
          path: ["aggregateRef"],
          message: "aggregateRef must match payload.userMessageRef"
        });
      }
      if (event.threadRef !== event.payload.threadRef) {
        context.addIssue({
          code: "custom",
          path: ["threadRef"],
          message: "threadRef must match payload.threadRef"
        });
      }
      break;
    case "thread.provider_turn.succeeded":
      if (event.aggregateRef !== event.payload.userMessageRef) {
        context.addIssue({
          code: "custom",
          path: ["aggregateRef"],
          message: "aggregateRef must match payload.userMessageRef"
        });
      }
      if (event.threadRef !== event.payload.threadRef) {
        context.addIssue({
          code: "custom",
          path: ["threadRef"],
          message: "threadRef must match payload.threadRef"
        });
      }
      if (event.payload.assistantMessageRef === event.payload.userMessageRef) {
        context.addIssue({
          code: "custom",
          path: ["payload", "assistantMessageRef"],
          message: "assistantMessageRef must differ from userMessageRef"
        });
      }
      break;
  }
});

const knownSyncEventTypes = new Set<string>(KNOWN_SYNC_EVENT_TYPES);
const futureSyncEventTypeSchema = syncEventTypeSchema.refine(
  (value) => !knownSyncEventTypes.has(value),
  "Known event types must use their strict event schema"
);

export const opaqueSyncEventSchema = syncEventEnvelopeSchema
  .extend({
    eventType: futureSyncEventTypeSchema,
    aggregateType: syncAggregateTypeSchema,
    aggregateRef: syncGenericRefSchema,
    threadRef: syncThreadRefSchema.nullable(),
    payload: syncJsonObjectSchema
  })
  .strict();

export const syncEventSchema = z.union([knownSyncEventSchema, opaqueSyncEventSchema]);
export const syncSseDataSchema = syncEventSchema;

const syncDecimalStringSchema = z.string().regex(/^\d+$/);

function parseSafeDecimal(value: string, minimum: number, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

export const syncEventsQuerySchema = z
  .object({
    afterSequence: syncDecimalStringSchema.optional(),
    limit: syncDecimalStringSchema.optional()
  })
  .strict()
  .transform((value, context) => {
    const afterSequence = value.afterSequence === undefined
      ? undefined
      : parseSafeDecimal(value.afterSequence, 0, Number.MAX_SAFE_INTEGER);
    const limit = value.limit === undefined ? 100 : parseSafeDecimal(value.limit, 1, 200);
    if (afterSequence === null || limit === null) {
      context.addIssue({ code: "custom", message: "Sync query values are invalid" });
      return z.NEVER;
    }
    return {
      ...(afterSequence === undefined ? {} : { afterSequence }),
      limit
    };
  });

const syncEventsResponseBaseSchema = z
  .object({
    protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
    sync: z
      .object({
        deviceRef: syncDeviceRefSchema,
        personRef: syncPersonRefSchema,
        acknowledgedSequence: syncCursorSchema,
        requestedAfterSequence: syncCursorSchema,
        latestSequence: syncCursorSchema
      })
      .strict(),
    events: z.array(syncEventSchema).max(200),
    nextAfterSequence: syncEventSequenceSchema.nullable()
  })
  .strict();

export const syncEventsResponseSchema = syncEventsResponseBaseSchema.superRefine(
  (value, context) => {
    if (value.sync.acknowledgedSequence > value.sync.latestSequence) {
      context.addIssue({
        code: "custom",
        path: ["sync", "acknowledgedSequence"],
        message: "acknowledgedSequence cannot exceed latestSequence"
      });
    }

    let previousSequence = value.sync.requestedAfterSequence;
    for (const [index, event] of value.events.entries()) {
      if (event.personRef !== value.sync.personRef) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "personRef"],
          message: "event personRef must match sync.personRef"
        });
      }
      if (event.eventSequence <= value.sync.requestedAfterSequence) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "eventSequence"],
          message: "eventSequence must be after requestedAfterSequence"
        });
      }
      if (event.eventSequence > value.sync.latestSequence) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "eventSequence"],
          message: "eventSequence cannot exceed latestSequence"
        });
      }
      if (event.eventSequence <= previousSequence) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "eventSequence"],
          message: "events must be strictly increasing"
        });
      }
      previousSequence = event.eventSequence;
    }

    if (value.events.length === 0) {
      if (value.nextAfterSequence !== null) {
        context.addIssue({
          code: "custom",
          path: ["nextAfterSequence"],
          message: "empty event pages require a null nextAfterSequence"
        });
      }
      return;
    }

    if (
      value.nextAfterSequence !== null &&
      value.nextAfterSequence !== value.events[value.events.length - 1]!.eventSequence
    ) {
      context.addIssue({
        code: "custom",
        path: ["nextAfterSequence"],
        message: "nextAfterSequence must match the last event sequence"
      });
    }
  }
);

export const syncAckRequestSchema = z
  .object({
    protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
    eventSequence: syncEventSequenceSchema,
    eventRef: syncEventRefSchema
  })
  .strict();

const syncAckResponseBaseSchema = z
  .object({
    protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
    sync: z
      .object({
        deviceRef: syncDeviceRefSchema,
        personRef: syncPersonRefSchema,
        previousSequence: syncCursorSchema,
        acknowledgedSequence: syncCursorSchema,
        advanced: z.boolean(),
        updatedAt: syncTimestampSchema
      })
      .strict()
  })
  .strict();

export const syncAckResponseSchema = syncAckResponseBaseSchema.superRefine((value, context) => {
  const { previousSequence, acknowledgedSequence, advanced } = value.sync;
  if (acknowledgedSequence < previousSequence) {
    context.addIssue({
      code: "custom",
      path: ["sync", "acknowledgedSequence"],
      message: "acknowledgedSequence cannot go backwards"
    });
  }
  if (advanced && acknowledgedSequence <= previousSequence) {
    context.addIssue({
      code: "custom",
      path: ["sync", "advanced"],
      message: "advanced requires acknowledgedSequence to increase"
    });
  }
  if (!advanced && acknowledgedSequence !== previousSequence) {
    context.addIssue({
      code: "custom",
      path: ["sync", "advanced"],
      message: "non-advanced ACKs must preserve the previous sequence"
    });
  }
});

export type KnownSyncEventType = z.infer<typeof knownSyncEventTypeSchema>;
export type KnownSyncEvent = z.infer<typeof knownSyncEventSchema>;
export type OpaqueSyncEvent = z.infer<typeof opaqueSyncEventSchema>;
export type SyncEvent = z.infer<typeof syncEventSchema>;
export type SyncSseData = SyncEvent;
export type SyncEventsQueryInput = z.input<typeof syncEventsQuerySchema>;
export type SyncEventsQuery = z.output<typeof syncEventsQuerySchema>;
export type SyncEventsResponse = z.infer<typeof syncEventsResponseSchema>;
export type SyncAckRequest = z.infer<typeof syncAckRequestSchema>;
export type SyncAckResponse = z.infer<typeof syncAckResponseSchema>;
export type ChatHomeCreatedSyncEvent = Extract<
  KnownSyncEvent,
  { eventType: "chat.home.created" }
>;
export type WorkCreatedSyncEvent = Extract<KnownSyncEvent, { eventType: "work.created" }>;
export type ThreadMessageCreatedSyncEvent = Extract<
  KnownSyncEvent,
  { eventType: "thread.message.created" }
>;
export type ChatWorkCreatedSyncEvent = Extract<
  KnownSyncEvent,
  { eventType: "chat.work.created" }
>;
export type WorkProgressUpdatedSyncEvent = Extract<
  KnownSyncEvent,
  { eventType: "work.progress.updated" }
>;
export type ProviderTurnFailedSyncEvent = Extract<
  KnownSyncEvent,
  { eventType: "thread.provider_turn.failed" }
>;
export type ProviderTurnSucceededSyncEvent = Extract<
  KnownSyncEvent,
  { eventType: "thread.provider_turn.succeeded" }
>;
