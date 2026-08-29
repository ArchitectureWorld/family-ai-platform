import { createHash } from "node:crypto";
import {
  agentDescriptorV1Schema,
  federationAgentListV1Schema,
  federationInvocationResponseV1Schema,
  type AgentDescriptorV1,
  type AgentInvocationRequestV1,
  type AgentInvocationResultV1,
  type FederationActorContextV1,
  type FederationAgentListV1,
  type FederationInvocationPostResponseV1,
  type FederationInvocationResponseV1,
  type FederationInvocationStatusV1
} from "@family-ai/contracts";
import {
  BrokerFederationError,
  BrokerProviderAdapter,
  type ProviderAdapterResolver
} from "@family-ai/provider-adapter-sdk";
import {
  FederationRepository,
  type AuthenticatedFederationService,
  type ScopedInvocationStatus
} from "./federationRepository.js";
import { GatewayDomainError } from "./service.js";

class SessionInvocationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function domainError(
  code: string,
  statusCode: number,
  category: "validation" | "permission" | "conflict" | "availability" | "timeout" | "internal",
  retryable: boolean,
  message: string
): GatewayDomainError {
  return new GatewayDomainError(code, statusCode, category, retryable, message);
}

function brokerError(error: BrokerFederationError): GatewayDomainError {
  if (error.code === "BROKER_FEDERATION_TIMEOUT") {
    return domainError(
      "AGENT_INVOCATION_TIMEOUT",
      504,
      "timeout",
      true,
      "Agent 响应超时，请稍后重试。"
    );
  }
  return domainError(
    "AGENT_RUNTIME_UNAVAILABLE",
    503,
    "availability",
    true,
    "Agent 暂时不可用，请稍后重试。"
  );
}

function repositoryError(error: unknown): GatewayDomainError {
  const code = error instanceof Error ? error.message : "";
  if (code === "FEDERATION_AGENT_FORBIDDEN") {
    return domainError(
      "AGENT_NOT_ASSIGNED",
      403,
      "permission",
      false,
      "当前成员没有使用这个 Agent 的权限。"
    );
  }
  if (code === "FEDERATION_SESSION_REQUIRED") {
    return domainError(
      "AGENT_SESSION_REQUIRED",
      409,
      "conflict",
      false,
      "当前产品会话需要继续使用原 Agent 会话。"
    );
  }
  if (
    code === "FEDERATION_SESSION_MISMATCH" ||
    code === "FEDERATION_SESSION_SCOPE_CONFLICT" ||
    code === "FEDERATION_SESSION_UNBOUND"
  ) {
    return domainError(
      "AGENT_SESSION_SCOPE_MISMATCH",
      409,
      "conflict",
      false,
      "Agent 会话与当前产品会话不匹配。"
    );
  }
  if (code === "FEDERATION_INVOCATION_DUPLICATE") {
    return domainError(
      "AGENT_INVOCATION_CONFLICT",
      409,
      "conflict",
      false,
      "这次 Agent 请求已经处理过。"
    );
  }
  if (code === "FEDERATION_INVOCATION_BUSY") {
    return domainError(
      "AGENT_INVOCATION_BUSY",
      409,
      "conflict",
      true,
      "这个 Agent 会话正在处理另一项请求，请稍后重试。"
    );
  }
  if (code === "FEDERATION_SERVICE_INACTIVE") {
    return domainError(
      "FEDERATION_SERVICE_UNAUTHORIZED",
      401,
      "permission",
      false,
      "产品服务身份无效。"
    );
  }
  return domainError(
    "FEDERATION_REQUEST_REJECTED",
    409,
    "conflict",
    false,
    "Family AI 无法接受这次 Agent 请求。"
  );
}

export function invocationRequestSha256(
  service: AuthenticatedFederationService,
  actor: FederationActorContextV1,
  request: AgentInvocationRequestV1
): string {
  const intent = {
    protocolVersion: 1 as const,
    invocationRef: request.invocationRef,
    correlationRef: request.correlationRef,
    serviceRef: service.serviceRef,
    product: service.product,
    familyRef: actor.familyRef,
    personRef: actor.personRef,
    agentRef: request.agentRef,
    localSessionRef: request.localSessionRef,
    ...(request.externalSessionRef === undefined
      ? {}
      : { externalSessionRef: request.externalSessionRef }),
    prompt: request.prompt,
    timeoutMs: request.timeoutMs
  };
  return createHash("sha256").update(JSON.stringify(intent), "utf8").digest("hex");
}

export class FederationService {
  private readonly queue = new SessionInvocationQueue();

  constructor(
    private readonly repository: FederationRepository,
    private readonly providers: ProviderAdapterResolver,
    private readonly now: () => Date = () => new Date()
  ) {}

  authenticateService(token: string): AuthenticatedFederationService {
    const service = this.repository.authenticateService(token);
    if (!service) {
      throw domainError(
        "FEDERATION_SERVICE_UNAUTHORIZED",
        401,
        "permission",
        false,
        "产品服务身份无效。"
      );
    }
    return service;
  }

  issueActorContext(
    service: AuthenticatedFederationService,
    entrySessionRef: string
  ): FederationActorContextV1 {
    try {
      return this.repository.issueActorContext({
        product: service.product,
        entrySessionRef,
        lifetimeSeconds: 60
      });
    } catch {
      throw domainError(
        "FEDERATION_CONTEXT_INVALID",
        403,
        "permission",
        false,
        "当前 Family 身份已经失效。"
      );
    }
  }

  async listAgents(
    service: AuthenticatedFederationService,
    contextRef: string
  ): Promise<FederationAgentListV1> {
    const live = this.liveActorForContext(service, contextRef);
    const authorized = this.repository.listAuthorizedAgents(live);
    const agents = await Promise.all(authorized.map(async (agent) => {
      let status: AgentDescriptorV1["status"] = "unavailable";
      try {
        const adapter = this.providers.resolve(agent.providerProfileRef);
        if (adapter instanceof BrokerProviderAdapter) {
          status = (await adapter.health()).status === "online"
            ? "available"
            : "unavailable";
        }
      } catch {
        status = "unavailable";
      }
      const observedAt = this.now().toISOString();
      this.repository.recordDiscoveryObservation({
        agentRef: agent.agentRef,
        kind: "agent",
        runtime: "hermes-local",
        status,
        capabilities: ["chat", "session-resume"],
        observedAt
      });
      return agentDescriptorV1Schema.parse({
        protocolVersion: 1,
        agentRef: agent.agentRef,
        displayName: agent.displayName,
        kind: "agent",
        runtime: "hermes-local",
        status,
        capabilities: ["chat", "session-resume"],
        system: agent.system,
        observedAt
      });
    }));
    return federationAgentListV1Schema.parse({
      protocolVersion: 1,
      scope: {
        serviceRef: service.serviceRef,
        product: service.product,
        actorContextRef: live.contextRef,
        familyRef: live.familyRef,
        personRef: live.personRef,
        assignmentVersion: live.assignmentVersion,
        contextVersion: live.contextVersion
      },
      agents
    });
  }

  async invoke(
    service: AuthenticatedFederationService,
    request: AgentInvocationRequestV1
  ): Promise<FederationInvocationPostResponseV1> {
    const initialActor = this.liveActor(service, request);
    const key = [
      service.product,
      initialActor.familyRef,
      initialActor.personRef,
      request.agentRef,
      request.localSessionRef
    ].join("\u0000");
    return this.queue.run(key, async () => {
      try {
        this.repository.requireActiveService(service);
      } catch (error) {
        throw repositoryError(error);
      }
      const actor = this.liveActor(service, request);
      let authorized;
      try {
        authorized = this.repository.requireAuthorizedAgent(actor, request.agentRef);
      } catch (error) {
        throw repositoryError(error);
      }

      let claim;
      try {
        claim = this.repository.claimInvocation({
          serviceRef: service.serviceRef,
          invocationRef: request.invocationRef,
          correlationRef: request.correlationRef,
          product: service.product,
          familyRef: actor.familyRef,
          personRef: actor.personRef,
          actorContextRef: actor.contextRef,
          agentRef: request.agentRef,
          localSessionRef: request.localSessionRef,
          ...(request.externalSessionRef === undefined
            ? {}
            : { externalSessionRef: request.externalSessionRef }),
          requestSha256: invocationRequestSha256(service, actor, request),
          timeoutMs: request.timeoutMs
        });
      } catch (error) {
        throw repositoryError(error);
      }
      if (claim.kind !== "acquired") {
        return this.statusEnvelope(service, actor, claim.status);
      }

      let adapter: BrokerProviderAdapter;
      try {
        const resolved = this.providers.resolve(authorized.providerProfileRef);
        if (!(resolved instanceof BrokerProviderAdapter)) throw new Error();
        adapter = resolved;
      } catch {
        this.repository.finalizeInvocationFailure({
          invocationRef: request.invocationRef,
          errorCode: "AGENT_RUNTIME_UNAVAILABLE"
        });
        throw domainError(
          "AGENT_RUNTIME_UNAVAILABLE",
          503,
          "availability",
          true,
          "Agent 暂时不可用，请稍后重试。"
        );
      }

      const finalizeFailure = (errorCode: string) => {
        try {
          this.repository.finalizeInvocationFailure({
            invocationRef: request.invocationRef,
            errorCode
          });
        } catch {
          throw domainError(
            "FEDERATION_PERSISTENCE_UNAVAILABLE",
            503,
            "internal",
            true,
            "Family AI 暂时无法保存 Agent 调用状态。"
          );
        }
      };

      try {
        const resolved = this.providers.resolve(authorized.providerProfileRef);
        if (!(resolved instanceof BrokerProviderAdapter) || resolved !== adapter) {
          throw domainError(
            "AGENT_RUNTIME_UNAVAILABLE",
            503,
            "availability",
            true,
            "Agent 暂时不可用，请稍后重试。"
          );
        }
        this.repository.requireActiveService(service);
        const currentActor = this.liveActor(service, request);
        this.repository.requireAuthorizedAgent(currentActor, request.agentRef);
      } catch (error) {
        const mapped = error instanceof GatewayDomainError
          ? error
          : repositoryError(error);
        finalizeFailure(
          mapped.code === "FEDERATION_SERVICE_UNAUTHORIZED"
            ? "FEDERATION_SERVICE_REVOKED"
            : "FEDERATION_AUTHORIZATION_REVOKED"
        );
        throw mapped;
      }

      let result: AgentInvocationResultV1;
      try {
        result = await adapter.invokeFederated(request);
      } catch (error) {
        const federationError = error instanceof BrokerFederationError
          ? error
          : new BrokerFederationError("BROKER_FEDERATION_UNAVAILABLE");
        finalizeFailure(
          federationError.code === "BROKER_FEDERATION_TIMEOUT"
            ? "AGENT_INVOCATION_TIMEOUT"
            : "AGENT_RUNTIME_UNAVAILABLE"
        );
        throw brokerError(federationError);
      }

      if (result.status === "succeeded") {
        try {
          this.repository.finalizeInvocationSuccess({
            invocationRef: request.invocationRef,
            externalSessionRef: result.externalSessionRef
          });
        } catch {
          throw domainError(
            "FEDERATION_PERSISTENCE_UNAVAILABLE",
            503,
            "internal",
            true,
            "Family AI 暂时无法保存 Agent 调用状态。"
          );
        }
      } else {
        finalizeFailure(
          result.status === "timed_out"
            ? "AGENT_INVOCATION_TIMEOUT"
            : result.status === "cancelled"
              ? "AGENT_INVOCATION_CANCELLED"
              : "AGENT_INVOCATION_FAILED"
        );
      }
      return federationInvocationResponseV1Schema.parse({
        protocolVersion: 1,
        scope: {
          serviceRef: service.serviceRef,
          product: service.product,
          actorContextRef: actor.contextRef,
          familyRef: actor.familyRef,
          personRef: actor.personRef,
          agentRef: request.agentRef,
          localSessionRef: request.localSessionRef
        },
        correlationRef: request.correlationRef,
        result
      } satisfies FederationInvocationResponseV1);
    });
  }

  getInvocationStatus(
    service: AuthenticatedFederationService,
    input: {
      contextRef: string;
      agentRef: string;
      localSessionRef: string;
      invocationRef: string;
    }
  ): FederationInvocationStatusV1 {
    const actor = this.liveActorForContext(service, input.contextRef);
    try {
      this.repository.requireAuthorizedAgent(actor, input.agentRef);
    } catch {
      throw this.invocationNotFound();
    }
    const status = this.repository.getScopedInvocationStatus({
      serviceRef: service.serviceRef,
      product: service.product,
      familyRef: actor.familyRef,
      personRef: actor.personRef,
      agentRef: input.agentRef,
      localSessionRef: input.localSessionRef,
      invocationRef: input.invocationRef
    });
    if (!status) throw this.invocationNotFound();
    return this.statusEnvelope(service, actor, status);
  }

  private statusEnvelope(
    service: AuthenticatedFederationService,
    actor: FederationActorContextV1,
    status: ScopedInvocationStatus
  ): FederationInvocationStatusV1 {
    const scope = {
      serviceRef: service.serviceRef,
      product: service.product,
      actorContextRef: actor.contextRef,
      familyRef: actor.familyRef,
      personRef: actor.personRef,
      agentRef: status.agentRef,
      localSessionRef: status.localSessionRef
    };
    const base = {
      protocolVersion: 1 as const,
      invocationRef: status.invocationRef,
      correlationRef: status.correlationRef,
      scope
    };
    if (status.status === "accepted") {
      return {
        ...base,
        status: "accepted",
        leaseExpiresAt: status.leaseExpiresAt,
        retryAfter: status.retryAfter
      };
    }
    if (status.status === "succeeded") {
      return {
        ...base,
        status: "succeeded",
        externalSessionRef: status.externalSessionRef,
        completedAt: status.completedAt,
        outputAvailable: false
      };
    }
    return {
      ...base,
      status: "failed",
      completedAt: status.completedAt,
      errorCode: status.errorCode
    };
  }

  private invocationNotFound(): GatewayDomainError {
    return domainError(
      "FEDERATION_INVOCATION_NOT_FOUND",
      404,
      "permission",
      false,
      "没有找到这次 Agent 请求。"
    );
  }

  private liveActorForContext(
    service: AuthenticatedFederationService,
    contextRef: string
  ): FederationActorContextV1 {
    try {
      this.repository.requireActiveService(service);
    } catch (error) {
      throw repositoryError(error);
    }
    const actor = this.repository.getActorContext(contextRef);
    if (!actor) {
      throw domainError(
        "FEDERATION_CONTEXT_INVALID",
        403,
        "permission",
        false,
        "当前 Family 身份已经失效。"
      );
    }
    if (actor.product !== service.product) {
      throw domainError(
        "FEDERATION_PRODUCT_MISMATCH",
        403,
        "permission",
        false,
        "产品身份与 Family 身份不匹配。"
      );
    }
    return actor;
  }

  private liveActor(
    service: AuthenticatedFederationService,
    request: AgentInvocationRequestV1
  ): FederationActorContextV1 {
    const actor = this.repository.getActorContext(request.actorContextRef);
    if (!actor) {
      throw domainError(
        "FEDERATION_CONTEXT_INVALID",
        403,
        "permission",
        false,
        "当前 Family 身份已经失效。"
      );
    }
    if (
      service.product !== request.product ||
      actor.product !== service.product
    ) {
      throw domainError(
        "FEDERATION_PRODUCT_MISMATCH",
        403,
        "permission",
        false,
        "产品身份与 Family 身份不匹配。"
      );
    }
    return actor;
  }
}
