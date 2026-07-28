import type { FastifyInstance } from "fastify";
import {
  CHAT_WORK_PROTOCOL_VERSION,
  agentRefSchema,
  createWorkConversationRequestSchema,
  createWorkConversationResponseSchema,
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
import type { AdminWorkspaceRepository } from "./adminWorkspace.js";
import type {
  ChatWorkDomainRepository,
  ThreadAccessContext
} from "./chatWorkDomain.js";
import type { ChatWorkMessageService } from "./chatWorkMessageService.js";
import {
  requireEntryRequest,
  type EntrySessionAuthenticator
} from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";

const agentParamsSchema = z.object({ agentRef: agentRefSchema }).strict();
const threadParamsSchema = z.object({ threadRef: interactionThreadRefSchema }).strict();
const workParamsSchema = z.object({ workRef: workConversationRefSchema }).strict();
const pageSchema = z.object({
  beforeSequence: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
}).strict();
const createWorkSchema = createWorkConversationRequestSchema.omit({
  agentRef: true
});

function invalidRequest(message: string): GatewayDomainError {
  return new GatewayDomainError("REQUEST_INVALID", 400, "validation", false, message);
}

function progressNotFound(): GatewayDomainError {
  return new GatewayDomainError(
    "WORK_PROGRESS_NOT_FOUND",
    404,
    "permission",
    false,
    "没有找到这个 Work 的进度。"
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidRequest(message);
  return result.data;
}

export function registerAdminWorkspaceRoutes(
  app: FastifyInstance,
  input: {
    workspace: AdminWorkspaceRepository;
    repository: ChatWorkDomainRepository;
    messageService: ChatWorkMessageService;
    entryAuthenticator: EntrySessionAuthenticator;
  }
): void {
  function auth(request: Parameters<typeof requireEntryRequest>[0]) {
    return requireEntryRequest(request, input.entryAuthenticator, "family_admin");
  }

  function access(
    context: ReturnType<typeof auth>,
    agentRef: string
  ): ThreadAccessContext {
    input.workspace.requireAgent({
      familyRef: context.family.familyRef,
      personRef: context.person.personRef,
      agentRef
    });
    return {
      familyRef: context.family.familyRef,
      personRef: context.person.personRef,
      entryAudience: "family_admin",
      agentRef
    };
  }

  app.get("/api/v1/admin/system-workspace", async (request) => {
    const context = auth(request);
    return input.workspace.summary({
      familyRef: context.family.familyRef,
      personRef: context.person.personRef
    });
  });

  app.get("/api/v1/admin/system-workspace/agents/:agentRef/chat", async (request) => {
    const context = auth(request);
    const params = parse(agentParamsSchema, request.params, "Agent 编号不正确。");
    const record = input.repository.ensureAdminHomeChat(access(context, params.agentRef));
    return homeChatStreamResponseSchema.parse({
      protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
      ...record
    });
  });

  app.get(
    "/api/v1/admin/system-workspace/agents/:agentRef/work-conversations",
    async (request) => {
      const context = auth(request);
      const params = parse(agentParamsSchema, request.params, "Agent 编号不正确。");
      return workConversationListResponseSchema.parse({
        protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
        conversations: input.repository.listAdminWorkConversations(
          access(context, params.agentRef)
        )
      });
    }
  );

  app.post(
    "/api/v1/admin/system-workspace/agents/:agentRef/work-conversations",
    async (request, reply) => {
      const context = auth(request);
      const params = parse(agentParamsSchema, request.params, "Agent 编号不正确。");
      const command = parse(
        createWorkSchema,
        request.body,
        "Work 标题、目标或协议版本不正确。"
      );
      const conversation = input.repository.createAdminWorkConversation({
        context: access(context, params.agentRef),
        title: command.title,
        goal: command.goal
      });
      return reply.code(201).send(createWorkConversationResponseSchema.parse({
        protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
        conversation
      }));
    }
  );

  app.get(
    "/api/v1/admin/system-workspace/threads/:threadRef/messages",
    async (request) => {
      const context = auth(request);
      const params = parse(threadParamsSchema, request.params, "Thread 编号不正确。");
      const query = parse(pageSchema, request.query, "消息分页参数不正确。");
      const agentRef = input.repository.resolveThreadAgent({
        familyRef: context.family.familyRef,
        personRef: context.person.personRef,
        entryAudience: "family_admin",
        threadRef: params.threadRef
      });
      const page = input.repository.listThreadMessages({
        familyRef: context.family.familyRef,
        personRef: context.person.personRef,
        agentRef,
        entryAudience: "family_admin",
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
    }
  );

  app.post(
    "/api/v1/admin/system-workspace/threads/:threadRef/messages",
    async (request, reply) => {
      const context = auth(request);
      const params = parse(threadParamsSchema, request.params, "Thread 编号不正确。");
      const command = parse(
        sendThreadMessageRequestSchema,
        request.body,
        "消息内容或协议版本不正确。"
      );
      const agentRef = input.repository.resolveThreadAgent({
        familyRef: context.family.familyRef,
        personRef: context.person.personRef,
        entryAudience: "family_admin",
        threadRef: params.threadRef
      });
      const result = await input.messageService.sendAdminMessage({
        familyRef: context.family.familyRef,
        personRef: context.person.personRef,
        deviceRef: context.device.deviceRef,
        agentRef,
        threadRef: params.threadRef,
        clientMessageId: command.clientMessageId,
        content: command.content,
        occurredAt: command.occurredAt
      });
      return reply.code(201).send(sendThreadMessageResponseSchema.parse({
        protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
        message: result.message
      }));
    }
  );

  app.get(
    "/api/v1/admin/system-workspace/work-conversations/:workRef/progress",
    async (request) => {
      const context = auth(request);
      const params = parse(workParamsSchema, request.params, "Work 编号不正确。");
      const agentRef = input.repository.resolveAdminWorkAgent({
        familyRef: context.family.familyRef,
        personRef: context.person.personRef,
        workConversationRef: params.workRef
      });
      const snapshot = input.repository.getAdminWorkProgressSnapshot({
        context: access(context, agentRef),
        workConversationRef: params.workRef
      });
      if (!snapshot) throw progressNotFound();
      return workProgressSnapshotResponseSchema.parse({
        protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
        snapshot
      });
    }
  );
}
