import { CHAT_WORK_PROTOCOL_VERSION } from "@family-ai/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeviceSyncRepository } from "./deviceSync.js";
import type { DomainEventStore } from "./domainEvents.js";
import {
  requireEntryRequest,
  type EntrySessionAuthenticator
} from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";

const decimalSchema = z.string().regex(/^\d+$/);
const syncEventsQuerySchema = z
  .object({
    afterSequence: decimalSchema.optional(),
    limit: decimalSchema.optional()
  })
  .strict();

const eventRefSchema = z.string().regex(/^event:[a-z0-9][a-z0-9._:-]{1,126}$/);
const syncAckSchema = z
  .object({
    protocolVersion: z.literal(CHAT_WORK_PROTOCOL_VERSION),
    eventSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    eventRef: eventRefSchema
  })
  .strict();

function invalidRequest(message: string): GatewayDomainError {
  return new GatewayDomainError(
    "REQUEST_INVALID",
    400,
    "validation",
    false,
    message
  );
}

function syncEventNotFound(): GatewayDomainError {
  return new GatewayDomainError(
    "SYNC_EVENT_NOT_FOUND",
    404,
    "permission",
    false,
    "没有找到可以确认的同步事件。"
  );
}

function safeInteger(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidRequest("同步参数不正确。");
  }
  return parsed;
}

export function registerDeviceSyncRoutes(
  app: FastifyInstance,
  input: {
    repository: DeviceSyncRepository;
    events: DomainEventStore;
    entryAuthenticator: EntrySessionAuthenticator;
  }
): void {
  app.get("/api/v1/sync/events", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    const parsed = syncEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) throw invalidRequest("同步参数不正确。");

    const state = input.repository.readCursor({
      deviceRef: context.device.deviceRef,
      personRef: context.person.personRef
    });
    const requestedAfterSequence = parsed.data.afterSequence === undefined
      ? state.acknowledgedSequence
      : safeInteger(parsed.data.afterSequence, 0, Number.MAX_SAFE_INTEGER);
    const limit = parsed.data.limit === undefined
      ? 100
      : safeInteger(parsed.data.limit, 1, 200);
    const page = input.events.listPersonEvents({
      personRef: context.person.personRef,
      afterSequence: requestedAfterSequence,
      limit
    });

    return {
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      sync: {
        deviceRef: context.device.deviceRef,
        personRef: context.person.personRef,
        acknowledgedSequence: state.acknowledgedSequence,
        requestedAfterSequence,
        latestSequence: state.latestSequence
      },
      events: page.events,
      nextAfterSequence: page.nextAfterSequence
    };
  });

  app.post("/api/v1/sync/ack", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    const parsed = syncAckSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest("同步确认请求不正确。");

    const result = input.repository.acknowledge({
      deviceRef: context.device.deviceRef,
      personRef: context.person.personRef,
      eventSequence: parsed.data.eventSequence,
      eventRef: parsed.data.eventRef
    });
    if (!result) throw syncEventNotFound();

    return {
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      sync: result
    };
  });
}
