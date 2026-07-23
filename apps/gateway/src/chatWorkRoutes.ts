import type { FastifyInstance } from "fastify";
import {
  CHAT_WORK_PROTOCOL_VERSION,
  homeChatStreamResponseSchema
} from "@family-ai/contracts";
import { z } from "zod";
import type { ChatWorkDomainRepository } from "./chatWorkDomain.js";
import {
  requireEntryRequest,
  type EntrySessionAuthenticator
} from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";

const homeChatQuerySchema = z
  .object({
    timezone: z.string().trim().min(1).max(80).optional()
  })
  .strict();

function invalidRequest(message: string): GatewayDomainError {
  return new GatewayDomainError("REQUEST_INVALID", 400, "validation", false, message);
}

function parseRequest<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidRequest(message);
  return parsed.data;
}

function validatedTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    throw invalidRequest("时区不正确。");
  }
}

export function localDateForTimeZone(date: Date, timeZone: string): string {
  const values: Partial<Record<"year" | "month" | "day", string>> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date)) {
    if (part.type === "year" || part.type === "month" || part.type === "day") {
      values[part.type] = part.value;
    }
  }
  if (!values.year || !values.month || !values.day) {
    throw new Error("Unable to derive local date from timezone");
  }
  return `${values.year}-${values.month}-${values.day}`;
}

export function registerChatWorkRoutes(
  app: FastifyInstance,
  input: {
    repository: ChatWorkDomainRepository;
    entryAuthenticator: EntrySessionAuthenticator;
    now?: () => Date;
  }
): void {
  const now = input.now ?? (() => new Date());

  app.get("/api/v1/chat", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    const query = parseRequest(
      homeChatQuerySchema,
      request.query,
      "Chat 查询参数不正确。"
    );
    const timeZone = query.timezone ? validatedTimeZone(query.timezone) : null;
    let record = input.repository.getHomeChat(context.person.personRef);
    if (!record) {
      if (!timeZone) {
        throw invalidRequest("首次打开 Chat 需要提供有效时区。");
      }
      record = input.repository.ensureHomeChat({
        personRef: context.person.personRef,
        timezone: timeZone,
        localDate: localDateForTimeZone(now(), timeZone)
      });
    }
    return homeChatStreamResponseSchema.parse({
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      ...record
    });
  });
}
