import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  PROTOCOL_VERSION,
  messageEnvelopeSchema,
  type MessageEnvelope
} from "@family-ai/contracts";
import {
  FakeProviderAdapter,
  type ProviderAdapter
} from "@family-ai/provider-adapter-sdk";
import {
  GatewayRepository,
  openGatewayDatabase,
  runDevelopmentBootstrap,
  type AuthenticatedDevice,
  type DevelopmentBootstrapInput
} from "./database.js";
import { GatewayDomainError, MessageService } from "./service.js";

export type GatewayMode = "test" | "development" | "production";

export interface BuildGatewayAppOptions {
  databasePath: string;
  deviceToken: string;
  mode: GatewayMode;
  providerAdapter?: ProviderAdapter;
  bootstrap?: Partial<Omit<DevelopmentBootstrapInput, "deviceToken">>;
}

const defaultBootstrap: Omit<DevelopmentBootstrapInput, "deviceToken"> = {
  memberRef: "member:test",
  memberDisplayName: "测试成员",
  deviceRef: "device:test",
  deviceDisplayName: "测试设备",
  agentRef: "agent:personal-assistant",
  agentDisplayName: "个人助理",
  providerProfileRef: "provider-profile:fake-local"
};

const conversationSchema = z
  .object({ title: z.string().trim().min(1).max(80) })
  .strict();

function publicError(reply: FastifyReply, error: unknown) {
  if (error instanceof GatewayDomainError) {
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message
    });
  }
  return reply.code(500).send({
    code: "GATEWAY_INTERNAL_ERROR",
    message: "Family AI 暂时无法完成这个操作，请稍后重试。"
  });
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

function deviceRef(request: FastifyRequest): string | null {
  const value = request.headers["x-device-ref"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function buildGatewayApp(options: BuildGatewayAppOptions) {
  const app = Fastify({ logger: false, disableRequestLogging: true });
  const db = openGatewayDatabase(options.databasePath);
  const bootstrap: DevelopmentBootstrapInput = {
    ...defaultBootstrap,
    ...options.bootstrap,
    deviceToken: options.deviceToken
  };
  runDevelopmentBootstrap(db, bootstrap);
  const repository = new GatewayRepository(db);
  const providerAdapter = options.providerAdapter ?? new FakeProviderAdapter();
  const messageService = new MessageService(repository, providerAdapter);

  app.addHook("onClose", async () => {
    db.close();
  });

  function requireDevice(request: FastifyRequest, reply: FastifyReply): AuthenticatedDevice | null {
    const ref = deviceRef(request);
    const token = bearerToken(request);
    const device = ref && token ? repository.authenticateDevice(ref, token) : null;
    if (!device) {
      reply.code(401).send({
        code: "DEVICE_AUTH_INVALID",
        message: "设备编号或设备令牌不正确。"
      });
      return null;
    }
    return device;
  }

  app.get("/health", async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION }));

  app.get("/api/v1/me", async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    return device;
  });

  app.post("/api/v1/conversations", async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const parsed = conversationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "REQUEST_INVALID",
        message: "会话标题不正确。"
      });
    }
    const conversation = repository.createConversation({
      memberRef: device.memberRef,
      agentRef: device.agentRef,
      title: parsed.data.title
    });
    return reply.code(201).send({ conversation });
  });

  app.get("/api/v1/conversations", async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    return {
      conversations: repository.listConversations(device.memberRef, device.agentRef)
    };
  });

  app.get("/api/v1/conversations/:conversationRef/messages", async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const { conversationRef } = request.params as { conversationRef: string };
    const conversation = repository.getConversationForAccess(
      conversationRef,
      device.memberRef,
      device.agentRef
    );
    if (!conversation) {
      return reply.code(404).send({
        code: "CONVERSATION_NOT_FOUND",
        message: "没有找到这个会话。"
      });
    }
    return { conversation, messages: repository.listMessages(conversationRef) };
  });

  app.post("/api/v1/conversations/:conversationRef/messages", async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const parsed = messageEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "MESSAGE_INVALID",
        message: "消息格式不正确。"
      });
    }
    const { conversationRef } = request.params as { conversationRef: string };
    try {
      const result = await messageService.send({
        device,
        conversationRef,
        envelope: parsed.data as MessageEnvelope
      });
      return reply.code(result.statusCode).send(result.body);
    } catch (error) {
      return publicError(reply, error);
    }
  });

  app.setErrorHandler((error, _request, reply) => publicError(reply, error));

  return app;
}
