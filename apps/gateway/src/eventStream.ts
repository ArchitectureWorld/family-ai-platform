import { z } from "zod";
import type { DomainEvent } from "./domainEvents.js";
import { GatewayDomainError } from "./service.js";

const eventStreamQuerySchema = z
  .object({
    afterSequence: z.string().regex(/^\d+$/).optional()
  })
  .strict();

function invalidCursor(): GatewayDomainError {
  return new GatewayDomainError(
    "REQUEST_INVALID",
    400,
    "validation",
    false,
    "事件 Cursor 不正确。"
  );
}

function parseDecimalCursor(value: string): number {
  if (!/^\d+$/.test(value)) throw invalidCursor();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidCursor();
  return parsed;
}

export function parseEventStreamCursor(
  query: unknown,
  lastEventId: string | string[] | undefined
): number {
  const parsedQuery = eventStreamQuerySchema.safeParse(query);
  if (!parsedQuery.success) throw invalidCursor();
  if (Array.isArray(lastEventId)) throw invalidCursor();

  const queryCursor = parsedQuery.data.afterSequence === undefined
    ? null
    : parseDecimalCursor(parsedQuery.data.afterSequence);
  const headerCursor = lastEventId === undefined
    ? null
    : parseDecimalCursor(lastEventId);

  if (queryCursor !== null && headerCursor !== null && queryCursor !== headerCursor) {
    throw invalidCursor();
  }
  return queryCursor ?? headerCursor ?? 0;
}

export function formatConnectedFrame(reconnectMs: number): string {
  return `retry: ${reconnectMs}\n: connected\n\n`;
}

export function formatDomainEventFrame(event: DomainEvent): string {
  return `id: ${event.eventSequence}\nevent: domain-event\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatHeartbeatFrame(timestamp: string): string {
  return `: heartbeat ${timestamp}\n\n`;
}
