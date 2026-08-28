import {
  agentDescriptorV1Schema,
  type AgentDescriptorV1,
  type AgentInvocationRequestV1,
  type AgentInvocationResultV1,
  type FederationActorContextV1
} from "@family-ai/contracts";
import {
  BrokerFederationError,
  BrokerProviderAdapter,
  type ProviderAdapterResolver
} from "@family-ai/provider-adapter-sdk";
import {
  FederationRepository,
  type AuthenticatedFederationService
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
    code === "FEDERATION_SESSION_SCOPE_CONFLICT"
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
  return domainError(
    "FEDERATION_REQUEST_REJECTED",
    409,
    "conflict",
    false,
    "Family AI 无法接受这次 Agent 请求。"
  );
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
    actor: FederationActorContextV1
  ): Promise<AgentDescriptorV1[]> {
    const live = this.repository.getActorContext(actor.contextRef);
    if (!live || live.product !== actor.product) {
      throw domainError(
        "FEDERATION_CONTEXT_INVALID",
        403,
        "permission",
        false,
        "当前 Family 身份已经失效。"
      );
    }
    const authorized = this.repository.listAuthorizedAgents(live);
    return Promise.all(authorized.map(async (agent) => {
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
  }

  async invoke(
    service: AuthenticatedFederationService,
    request: AgentInvocationRequestV1
  ): Promise<AgentInvocationResultV1> {
    const initialActor = this.liveActor(service, request);
    const key = [
      service.product,
      initialActor.familyRef,
      initialActor.personRef,
      request.agentRef,
      request.localSessionRef
    ].join("\u0000");
    return this.queue.run(key, async () => {
      const actor = this.liveActor(service, request);
      let authorized;
      try {
        authorized = this.repository.requireAuthorizedAgent(actor, request.agentRef);
        this.repository.validateExternalSessionBinding({
          product: service.product,
          familyRef: actor.familyRef,
          personRef: actor.personRef,
          agentRef: request.agentRef,
          localSessionRef: request.localSessionRef,
          ...(request.externalSessionRef === undefined
            ? {}
            : { externalSessionRef: request.externalSessionRef })
        });
      } catch (error) {
        throw repositoryError(error);
      }

      let adapter: BrokerProviderAdapter;
      try {
        const resolved = this.providers.resolve(authorized.providerProfileRef);
        if (!(resolved instanceof BrokerProviderAdapter)) throw new Error();
        adapter = resolved;
      } catch {
        throw domainError(
          "AGENT_RUNTIME_UNAVAILABLE",
          503,
          "availability",
          true,
          "Agent 暂时不可用，请稍后重试。"
        );
      }

      try {
        this.repository.acceptInvocation({
          invocationRef: request.invocationRef,
          correlationRef: request.correlationRef,
          product: service.product,
          personRef: actor.personRef,
          agentRef: request.agentRef,
          localSessionRef: request.localSessionRef
        });
      } catch (error) {
        throw repositoryError(error);
      }

      let completed = false;
      const failAudit = (errorCode: string) => {
        if (completed) return;
        completed = true;
        this.repository.completeInvocation({
          invocationRef: request.invocationRef,
          status: "failed",
          errorCode
        });
      };
      try {
        const result = await adapter.invokeFederated(request);
        if (result.status === "succeeded") {
          try {
            this.repository.bindExternalSession({
              product: service.product,
              familyRef: actor.familyRef,
              personRef: actor.personRef,
              agentRef: request.agentRef,
              localSessionRef: request.localSessionRef,
              externalSessionRef: result.externalSessionRef
            });
          } catch (error) {
            failAudit("AGENT_SESSION_CONFLICT");
            throw repositoryError(error);
          }
          completed = true;
          this.repository.completeInvocation({
            invocationRef: request.invocationRef,
            status: "succeeded"
          });
        } else {
          failAudit(
            result.status === "timed_out"
              ? "AGENT_INVOCATION_TIMEOUT"
              : result.status === "cancelled"
                ? "AGENT_INVOCATION_CANCELLED"
                : "AGENT_INVOCATION_FAILED"
          );
        }
        return result;
      } catch (error) {
        if (error instanceof GatewayDomainError) throw error;
        const federationError = error instanceof BrokerFederationError
          ? error
          : new BrokerFederationError("BROKER_FEDERATION_UNAVAILABLE");
        failAudit(
          federationError.code === "BROKER_FEDERATION_TIMEOUT"
            ? "AGENT_INVOCATION_TIMEOUT"
            : "AGENT_RUNTIME_UNAVAILABLE"
        );
        throw brokerError(federationError);
      }
    });
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
