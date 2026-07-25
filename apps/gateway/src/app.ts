import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  MOBILE_ENTRY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  messageEnvelopeSchema,
  mobileGatewayErrorCodeSchema,
  mobileGatewayErrorSchema,
  type MessageEnvelope,
  type PublicError
} from "@family-ai/contracts";
import {
  FakeProviderAdapter,
  type ProviderAdapter
} from "@family-ai/provider-adapter-sdk";
import { ChatWorkDomainRepository } from "./chatWorkDomain.js";
import { ChatWorkMessageService } from "./chatWorkMessageService.js";
import { ChatWorkProviderRepository } from "./chatWorkProvider.js";
import { registerChatWorkRoutes } from "./chatWorkRoutes.js";
import {
  GatewayRepository,
  openGatewayDatabase,
  runDevelopmentBootstrap,
  type AuthenticatedDevice,
  type DevelopmentBootstrapInput
} from "./database.js";
import { registerDevelopmentConsole } from "./developmentConsole.js";
import { DeviceSyncRepository } from "./deviceSync.js";
import { registerDeviceSyncRoutes } from "./deviceSyncRoutes.js";
import { DomainEventStore } from "./domainEvents.js";
import { EntrySessionAuthenticator } from "./entrySessionAuth.js";
import {
  PersonEventStreamHub,
  registerEventStreamRoutes
} from "./eventStream.js";
import { FamilyDomainRepository } from "./familyDomain.js";
import { registerFamilyRoutes } from "./familyRoutes.js";
import { MobileDeviceSummaryRepository } from "./mobileDeviceSummary.js";
import { MobilePairingRepository } from "./mobilePairing.js";
import { registerMobileRoutes } from "./mobileRoutes.js";
import { GatewayDomainError, MessageService } from "./service.js";

export type GatewayMode = "test" | "development" | "production";

export interface BuildGatewayAppOptions {
  databasePath: string;
  deviceToken: string;
  mode: GatewayMode;
  providerAdapter?: ProviderAdapter;
  bootstrap?: Partial<Omit<DevelopmentBootstrapInput, "deviceToken">>;
  now?: () => Date;
}

const SERVICE_ID = "family-ai-gateway-foundation";

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

function errorBody(input: PublicError): PublicError {
  return input;
}

function mobileErrorRoute(request: FastifyRequest): boolean {
  const path = request.url.split("?", 1)[0] ?? request.url;
  const chatWorkPath = path === "/api/v1/chat" ||
    path.startsWith("/api/v1/chat/") ||
    path === "/api/v1/work-conversations" ||
    path.startsWith("/api/v1/work-conversations/") ||
    path.startsWith("/api/v1/threads/") ||
    path === "/api/v1/events/stream" ||
    path.startsWith("/api/v1/sync/");
  const deviceAuthorization = request.headers.authorization?.startsWith("Device ") ?? false;
  return (!chatWorkPath && deviceAuthorization) ||
    path.startsWith("/api/v1/mobile/") ||
    path === "/api/v1/portal/context" ||
    path.startsWith("/api/v1/admin/pairing-codes/") ||
    path.startsWith("/api/v1/admin/devices/") ||
    /^\/api\/v1\/admin\/members\/[^/]+\/pairing-codes$/.test(path);
}

function publicError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof GatewayDomainError) {
    if (
      mobileErrorRoute(request) &&
      mobileGatewayErrorCodeSchema.safeParse(error.code).success
    ) {
      return reply.code(error.statusCode).send(mobileGatewayErrorSchema.parse({
        protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
        error: {
          code: error.code,
          category: error.category,
          message: error.message,
          retryable: error.retryable,
          requestId: `request:${String(request.id)}`
        }
      }));
    }
    return reply.code(error.statusCode).send(errorBody({
      code: error.code,
      category: error.category,
      message: error.message,
      retryable: error.retryable
    }));
  }
  if (mobileErrorRoute(request)) {
    return reply.code(500).send(mobileGatewayErrorSchema.parse({
      protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
      error: {
        code: "PAIRING_INVALID",
        category: "internal",
        message: "Family AI 暂时无法完成这个操作，请稍后重试。",
        retryable: true,
        requestId: `request:${String(request.id)}`
      }
    }));
  }
  return reply.code(500).send(errorBody({
    code: "GATEWAY_INTERNAL_ERROR",
    category: "internal",
    message: "Family AI 暂时无法完成这个操作，请稍后重试。",
    retryable: true
  }));
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
  if (options.mode === "production" && !options.providerAdapter) {
    throw new Error("production requires an explicit provider adapter");
  }

  const app = Fastify({ logger: false });
  const db = openGatewayDatabase(options.databasePath);
  const now = options.now ?? (() => new Date());
  const domainEventStore = new DomainEventStore(db, now);
  if (options.mode !== "production") {
    const bootstrap: DevelopmentBootstrapInput = {
      ...defaultBootstrap,
      ...options.bootstrap,
      deviceToken: options.deviceToken
    };
    runDevelopmentBootstrap(db, bootstrap);
  }

  const repository = new GatewayRepository(db);
  const familyRepository = new FamilyDomainRepository(db);
  const entryAuthenticator = new EntrySessionAuthenticator(db, familyRepository, now);
  const deviceSyncRepository = new DeviceSyncRepository(db, domainEventStore, now);
  const eventStreamHub = new PersonEventStreamHub(
    domainEventStore,
    entryAuthenticator,
    { now }
  );
  const chatWorkRepository = new ChatWorkDomainRepository(db, now);
  const mobileDeviceSummaryRepository = new MobileDeviceSummaryRepository(db);
  const mobileRepository = new MobilePairingRepository(db);
  const providerAdapter = options.providerAdapter ?? new FakeProviderAdapter();
  const messageService = new MessageService(repository, providerAdapter);
  const chatWorkProviderRepository = new ChatWorkProviderRepository(db, now);
  const chatWorkMessageService = new ChatWorkMessageService(
    chatWorkRepository,
    chatWorkProviderRepository,
    providerAdapter,
    now
  );

  app.addHook("onClose", async () => {
    await eventStreamHub.close();
    db.close();
  });

  function requireDevice(request: FastifyRequest, reply: FastifyReply): AuthenticatedDevice | null {
    const ref = deviceRef(request);
    const token = bearerToken(request);
    const device = ref && token ? repository.authenticateDevice(ref, token) : null;
    if (!device) {
      reply.code(401).send(errorBody({
        code: "DEVICE_AUTH_INVALID",
        category: "permission",
        message: "设备编号或设备令牌不正确。",
        retryable: false
      }));
      return null;
    }
    return device;
  }

  registerDevelopmentConsole(app, options.mode);
  registerFamilyRoutes(app, {
    familyRepository,
    gatewayRepository: repository,
    entryAuthenticator,
    mobileDeviceSummaryRepository
  });
  registerMobileRoutes(app, {
    mobileRepository,
    entryAuthenticator,
    mode: options.mode
  });
  registerChatWorkRoutes(app, {
    repository: chatWorkRepository,
    messageService: chatWorkMessageService,
    entryAuthenticator,
    now
  });
  registerEventStreamRoutes(app, {
    hub: eventStreamHub,
    entryAuthenticator
  });
  registerDeviceSyncRoutes(app, {
    repository: deviceSyncRepository,
    events: domainEventStore,
    entryAuthenticator
  });

  app.get("/health", async () => ({
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    service: SERVICE_ID
  }));

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
      return reply.code(400).send(errorBody({
        code: "REQUEST_INVALID",
        category: "validation",
        message: "会话标题不正确。",
        retryable: false
      }));
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
      return reply.code(404).send(errorBody({
        code: "CONVERSATION_NOT_FOUND",
        category: "permission",
        message: "没有找到这个会话。",
        retryable: false
      }));
    }
    return { conversation, messages: repository.listMessages(conversationRef) };
  });

  app.post("/api/v1/conversations/:conversationRef/messages", async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const parsed = messageEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(errorBody({
        code: "MESSAGE_INVALID",
        category: "validation",
        message: "消息格式不正确。",
        retryable: false
      }));
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
      return publicError(request, reply, error);
    }
  });

  app.setErrorHandler((error, request, reply) => publicError(request, reply, error));

  return app;
}
