import type { FastifyInstance } from "fastify";
import {
  CHAT_WORK_PROTOCOL_VERSION,
  createWorkConversationRequestSchema,
  createWorkConversationResponseSchema,
  createWorkFromChatRequestSchema,
  createWorkFromChatResponseSchema,
  homeChatStreamResponseSchema,
  interactionThreadRefSchema,
  sendThreadMessageRequestSchema,
  sendThreadMessageResponseSchema,
  threadMessageListResponseSchema,
  workConversationListResponseSchema,
  workConversationRefSchema,
  workProgressSnapshotResponseSchema
} from "@family-ai/contracts";
import { z } from "zod";
import type { ChatWorkDomainRepository } from "./chatWorkDomain.js";
import type { ChatWorkMessageService } from "./chatWorkMessageService.js";
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

const threadParamsSchema = z
  .object({ threadRef: interactionThreadRefSchema })
  .strict();

const threadMessagesQuerySchema = z
  .object({
    beforeSequence: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
  })
  .strict();

const workProgressParamsSchema = z
  .object({ workConversationRef: workConversationRefSchema })
  .strict();

function invalidRequest(message: string): GatewayDomainError {
  return new GatewayDomainError("REQUEST_INVALID", 400, "validation", false, message);
}

function workProgressNotFound(): GatewayDomainError {
  return new GatewayDomainError(
    "WORK_PROGRESS_NOT_FOUND",
    404,
    "permission",
    false,
    "没有找到这个 Work 的进度。"
  );
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
    messageService: ChatWorkMessageService;
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

  app.get("/api/v1/work-conversations", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    return workConversationListResponseSchema.parse({
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      conversations: input.repository.listWorkConversations(context.person.personRef)
    });
  });

  app.post("/api/v1/work-conversations", async (request, reply) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    const command = parseRequest(
      createWorkConversationRequestSchema,
      request.body,
      "Work 标题、目标或协议版本不正确。"
    );
    const conversation = input.repository.createWorkConversation({
      personRef: context.person.personRef,
      title: command.title,
      goal: command.goal
    });
    return reply.code(201).send(createWorkConversationResponseSchema.parse({
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      conversation
    }));
  });

  app.get("/api/v1/threads/:threadRef/messages", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    const params = parseRequest(
      threadParamsSchema,
      request.params,
      "Thread 编号不正确。"
    );
    const query = parseRequest(
      threadMessagesQuerySchema,
      request.query,
      "消息分页参数不正确。"
    );
    const page = input.repository.listThreadMessages({
      personRef: context.person.personRef,
      threadRef: params.threadRef,
      ...(query.beforeSequence === undefined
        ? {}
        : { beforeSequence: query.beforeSequence }),
      ...(query.limit === undefined ? {} : { limit: query.limit })
    });
    return threadMessageListResponseSchema.parse({
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      ...page
    });
  });

  app.post("/api/v1/threads/:threadRef/messages", async (request, reply) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    const params = parseRequest(
      threadParamsSchema,
      request.params,
      "Thread 编号不正确。"
    );
    const command = parseRequest(
      sendThreadMessageRequestSchema,
      request.body,
      "消息内容或协议版本不正确。"
    );
    const result = await input.messageService.sendPersonMessage({
      personRef: context.person.personRef,
      deviceRef: context.device.deviceRef,
      threadRef: params.threadRef,
      clientMessageId: command.clientMessageId,
      content: command.content,
      occurredAt: command.occurredAt
    });
    return reply.code(201).send(sendThreadMessageResponseSchema.parse({
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      message: result.message
    }));
  });

  app.post("/api/v1/chat/work-conversions", async (request, reply) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    const command = parseRequest(
      createWorkFromChatRequestSchema,
      request.body,
      "Chat 转 Work 请求或协议版本不正确。"
    );
    const result = input.repository.createWorkFromChat({
      personRef: context.person.personRef,
      title: command.title,
      goal: command.goal,
      source: command.source,
      decisions: command.decisions,
      openQuestions: command.openQuestions
    });
    return reply.code(201).send(createWorkFromChatResponseSchema.parse({
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      ...result
    }));
  });

  app.get(
    "/api/v1/work-conversations/:workConversationRef/progress",
    async (request) => {
      const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
      const params = parseRequest(
        workProgressParamsSchema,
        request.params,
        "Work 编号不正确。"
      );
      const snapshot = input.repository.getWorkProgressSnapshot(
        context.person.personRef,
        params.workConversationRef
      );
      if (!snapshot) throw workProgressNotFound();
      return workProgressSnapshotResponseSchema.parse({
        protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
        snapshot
      });
    }
  );
}
