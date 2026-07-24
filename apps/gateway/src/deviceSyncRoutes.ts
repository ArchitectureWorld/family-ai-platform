import {
  SYNC_PROTOCOL_VERSION,
  syncAckRequestSchema,
  syncAckResponseSchema,
  syncEventsQuerySchema,
  syncEventsResponseSchema
} from "@family-ai/contracts";
import type { FastifyInstance } from "fastify";
import type { DeviceSyncRepository } from "./deviceSync.js";
import type { DomainEventStore } from "./domainEvents.js";
import {
  requireEntryRequest,
  type EntrySessionAuthenticator
} from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";

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
    const requestedAfterSequence = parsed.data.afterSequence ?? state.acknowledgedSequence;
    const page = input.events.listPersonEvents({
      personRef: context.person.personRef,
      afterSequence: requestedAfterSequence,
      limit: parsed.data.limit
    });
    const latestSequence = input.events.getLatestPersonSequence(context.person.personRef);

    return syncEventsResponseSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      sync: {
        deviceRef: context.device.deviceRef,
        personRef: context.person.personRef,
        acknowledgedSequence: state.acknowledgedSequence,
        requestedAfterSequence,
        latestSequence
      },
      events: page.events,
      nextAfterSequence: page.nextAfterSequence
    });
  });

  app.post("/api/v1/sync/ack", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    const parsed = syncAckRequestSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest("同步确认请求不正确。");

    const result = input.repository.acknowledge({
      deviceRef: context.device.deviceRef,
      personRef: context.person.personRef,
      eventSequence: parsed.data.eventSequence,
      eventRef: parsed.data.eventRef
    });
    if (!result) throw syncEventNotFound();

    return syncAckResponseSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      sync: result
    });
  });
}
