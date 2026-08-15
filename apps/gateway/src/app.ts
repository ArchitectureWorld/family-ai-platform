import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  MOBILE_ENTRY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  WEB_ENTRY_PROTOCOL_VERSION,
  messageEnvelopeSchema,
  mobileGatewayErrorCodeSchema,
  mobileGatewayErrorSchema,
  webGatewayErrorSchema,
  type MessageEnvelope,
  type PublicError
} from "@family-ai/contracts";
import {
  AgentManagementRepository,
  type ConfiguredAgentRuntime
} from "./agentManagement.js";
import {
  FakeProviderAdapter,
  ProviderAdapterRouter,
  type ProviderAdapterResolver,
  type ProviderAdapter
} from "@family-ai/provider-adapter-sdk";
import { AgentStatusService } from "./agentStatus.js";
import { AttachmentRepository } from "./attachmentRepository.js";
import { registerAttachmentRoutes } from "./attachmentRoutes.js";
import { AttachmentStorage } from "./attachmentStorage.js";
import { AdminWorkspaceRepository } from "./adminWorkspace.js";
import { registerAdminWorkspaceRoutes } from "./adminWorkspaceRoutes.js";
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
import { registerAgentRoutes, type AgentStatusLookup } from "./agentRoutes.js";
import { registerAdminWeb } from "./adminWeb.js";
import { registerAdminPreviewAccess } from "./adminPreviewAccess.js";
import { registerAdminPreviewPersistence } from "./adminPreviewPersistence.js";
import { registerMemberWeb } from "./memberWeb.js";
import { MobileDeviceSummaryRepository } from "./mobileDeviceSummary.js";
import { MobilePairingRepository } from "./mobilePairing.js";
import { registerMobileRoutes } from "./mobileRoutes.js";
import { GatewayDomainError, MessageService } from "./service.js";
import { WebEntryRepository } from "./webEntry.js";
import {
  registerWebEntryCookieBridge,
  registerWebEntryRoutes
} from "./webEntryRoutes.js";
import {
  webAuthenticationSource,
  webErrorCookieHeaders
} from "./webEntryCookies.js";

export type GatewayMode = "test" | "development" | "production";

export interface BuildGatewayAppOptions {
  databasePath: string;
  attachmentRoot?: string;
  attachmentQuotaBytes?: number;
  deviceToken: string;
  mode: GatewayMode;
  configuredAgentRuntimes?: readonly ConfiguredAgentRuntime[];
  providerAdapter?: ProviderAdapter;
  providerRouter?: ProviderAdapterResolver;
  authoritativeAgentRuntimeCatalog?: boolean;
  bootstrap?: Partial<Omit<DevelopmentBootstrapInput, "deviceToken">>;
  previewAdminEntryPath?: string;
  previewAdminOrigin?: string;
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
    path.startsWith("/api/v1/attachments/") ||
    path === "/api/v1/events/stream" ||
    path.startsWith("/api/v1/sync/") ||
    path.startsWith("/api/v1/web-entry/");
  const deviceAuthorization = request.headers.authorization?.startsWith("Device ") ?? false;
  return (!chatWorkPath && deviceAuthorization) ||
    path.startsWith("/api/v1/mobile/") ||
    path === "/api/v1/portal/context" ||
    path.startsWith("/api/v1/admin/pairing-codes/") ||
    path.startsWith("/api/v1/admin/devices/") ||
    /^\/api\/v1\/admin\/members\/[^/]+\/pairing-codes$/.test(path);
}

function webErrorRoute(request: FastifyRequest): boolean {
  const path = request.url.split("?", 1)[0] ?? request.url;
  return path.startsWith("/api/v1/web-entry/");
}

function publicError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  mode: GatewayMode
) {
  if (error instanceof GatewayDomainError) {
    const cookieHeaders = webErrorCookieHeaders({
      source: webAuthenticationSource(request),
      errorCode: error.code,
      mode
    });
    if (cookieHeaders.length > 0) reply.header("Set-Cookie", cookieHeaders);
    if (webErrorRoute(request)) {
      return reply.code(error.statusCode).send(webGatewayErrorSchema.parse({
        protocolVersion: WEB_ENTRY_PROTOCOL_VERSION,
        error: {
          code: error.code,
          category: error.category,
          message: error.message,
          retryable: error.retryable,
          requestId: `request:${String(request.id)}`
        }
      }));
    }
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
  if (webErrorRoute(request)) {
    return reply.code(500).send(webGatewayErrorSchema.parse({
      protocolVersion: WEB_ENTRY_PROTOCOL_VERSION,
      error: {
        code: "GATEWAY_INTERNAL_ERROR",
        category: "internal",
        message: "Family AI 暂时无法完成这个操作，请稍后重试。",
        retryable: true,
        requestId: `request:${String(request.id)}`
      }
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
  if (
    options.mode === "production" &&
    !options.providerAdapter &&
    !options.providerRouter
  ) {
    throw new Error("production requires an explicit provider adapter or router");
  }
  if (
    (options.previewAdminEntryPath === undefined) !==
    (options.previewAdminOrigin === undefined)
  ) {
    throw new Error("Admin Preview persistence requires both path and origin");
  }

  const app = Fastify({ logger: false });
  const attachmentStorage = new AttachmentStorage(
    options.attachmentRoot ??
      join(dirname(options.databasePath), "attachments")
  );
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
  const agentManagementRepository = new AgentManagementRepository(db, now);
  const configuredAgentRuntimes = options.configuredAgentRuntimes ?? [];
  agentManagementRepository.reconcileRuntimeCatalog(configuredAgentRuntimes, {
    authoritative: options.authoritativeAgentRuntimeCatalog ?? false
  });
  const configuredAgentRefs = new Set(
    configuredAgentRuntimes.map(runtime => runtime.agentRef)
  );
  if (
    configuredAgentRefs.has("agent:hermes-jarvis") &&
    configuredAgentRefs.has("agent:codex-cli")
  ) {
    const owners = db.prepare(
      `SELECT fm.family_ref, fm.person_ref
       FROM family_memberships fm
       JOIN persons p ON p.person_ref = fm.person_ref
       WHERE fm.family_role = 'owner'
         AND fm.status = 'active'
         AND p.status = 'active'`
    ).all() as Array<{ family_ref: string; person_ref: string }>;
    for (const owner of owners) {
      agentManagementRepository.ensureOwnerAdminAssignments({
        familyRef: owner.family_ref,
        personRef: owner.person_ref,
        agentRefs: ["agent:hermes-jarvis", "agent:codex-cli"]
      });
    }
  }
  const familyRepository = new FamilyDomainRepository(db, {
    repository: agentManagementRepository,
    configuredRuntimes: configuredAgentRuntimes,
    authoritativeRuntimeCatalog:
      options.authoritativeAgentRuntimeCatalog ?? false
  });
  const entryAuthenticator = new EntrySessionAuthenticator(db, familyRepository, now);
  const attachmentRepository = new AttachmentRepository(db, {
    now,
    ...(options.attachmentQuotaBytes === undefined
      ? {}
      : { quotaBytes: options.attachmentQuotaBytes })
  });
  const cleanupExpiredAttachments = () => {
    const expired = attachmentRepository.expireIncompleteUploads();
    for (const attachment of expired) {
      attachmentStorage.removeStorageKeys(attachment.storageKeys);
    }
  };
  cleanupExpiredAttachments();
  const attachmentCleanupTimer = setInterval(() => {
    try {
      cleanupExpiredAttachments();
    } catch {
      // A later cleanup pass can retry without making the Gateway unavailable.
    }
  }, 15 * 60 * 1000);
  attachmentCleanupTimer.unref();
  const deviceSyncRepository = new DeviceSyncRepository(db, domainEventStore, now);
  const eventStreamHub = new PersonEventStreamHub(
    domainEventStore,
    entryAuthenticator,
    { now }
  );
  const chatWorkRepository = new ChatWorkDomainRepository(
    db,
    now,
    agentManagementRepository
  );
  const mobileDeviceSummaryRepository = new MobileDeviceSummaryRepository(db);
  const mobileRepository = new MobilePairingRepository(db, { now });
  const webEntryRepository = new WebEntryRepository(db, now);
  const providerAdapter = options.providerAdapter ??
    (options.mode === "production" ? null : new FakeProviderAdapter());
  const providerRouter = options.providerRouter ??
    ProviderAdapterRouter.single("provider-profile:fake-local", providerAdapter!);
  const agentStatus: AgentStatusLookup = new AgentStatusService(
    db,
    providerRouter,
    { now }
  );
  const messageService = new MessageService(repository, providerRouter);
  const chatWorkProviderRepository = new ChatWorkProviderRepository(
    db,
    now,
    agentManagementRepository
  );
  const chatWorkMessageService = new ChatWorkMessageService(
    chatWorkRepository,
    chatWorkProviderRepository,
    providerRouter,
    now,
    {
      repository: attachmentRepository,
      storage: attachmentStorage
    }
  );
  const adminWorkspaceRepository = new AdminWorkspaceRepository(db);

  app.addHook("preClose", async () => {
    await eventStreamHub.close();
  });

  app.addHook("onClose", async () => {
    clearInterval(attachmentCleanupTimer);
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

  registerWebEntryCookieBridge(app);
  registerMemberWeb(app);
  registerAdminWeb(app, options.mode);
  registerFamilyRoutes(app, {
    familyRepository,
    gatewayRepository: repository,
    entryAuthenticator,
    mobileDeviceSummaryRepository,
    agentRepository: agentManagementRepository,
    agentStatus
  });
  registerAgentRoutes(app, {
    repository: agentManagementRepository,
    entryAuthenticator,
    agentStatus
  });
  registerAdminPreviewPersistence(app, {
    mode: options.mode,
    entryAuthenticator,
    ...(options.previewAdminEntryPath === undefined
      ? {}
      : {
          adminEntryPath: options.previewAdminEntryPath,
          origin: options.previewAdminOrigin!
        })
  });
  registerAdminPreviewAccess(app, {
    mode: options.mode,
    entryAuthenticator,
    ...(options.previewAdminEntryPath === undefined
      ? {}
      : {
          adminEntryPath: options.previewAdminEntryPath,
          origin: options.previewAdminOrigin!
        })
  });
  registerMobileRoutes(app, {
    mobileRepository,
    entryAuthenticator,
    mode: options.mode
  });
  registerWebEntryRoutes(app, {
    repository: webEntryRepository,
    entryAuthenticator,
    agentRepository: agentManagementRepository,
    agentStatus,
    mode: options.mode
  });
  registerAttachmentRoutes(app, {
    repository: attachmentRepository,
    storage: attachmentStorage,
    entryAuthenticator
  });
  registerChatWorkRoutes(app, {
    repository: chatWorkRepository,
    messageService: chatWorkMessageService,
    entryAuthenticator,
    now
  });
  registerAdminWorkspaceRoutes(app, {
    workspace: adminWorkspaceRepository,
    repository: chatWorkRepository,
    messageService: chatWorkMessageService,
    entryAuthenticator
  });
  registerEventStreamRoutes(app, {
    hub: eventStreamHub,
    entryAuthenticator,
    webAuthenticationSource
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
      return publicError(request, reply, error, options.mode);
    }
  });

  app.setErrorHandler((error, request, reply) =>
    publicError(request, reply, error, options.mode)
  );

  return app;
}
