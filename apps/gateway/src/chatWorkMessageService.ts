import {
  PROTOCOL_VERSION,
  providerInvocationRequestSchema,
  providerInvocationResultSchema,
  type PublicError,
  type ThreadMessage,
  type ThreadMessageContent
} from "@family-ai/contracts";
import type {
  ProviderAdapter,
  ProviderAdapterResolver
} from "@family-ai/provider-adapter-sdk";
import type { ChatWorkDomainRepository } from "./chatWorkDomain.js";
import { buildProviderContext } from "./chatWorkContext.js";
import type { ChatWorkProviderRepository } from "./chatWorkProvider.js";
import { GatewayDomainError } from "./service.js";

export interface SendChatWorkMessageInput {
  personRef: string;
  deviceRef: string;
  threadRef: string;
  clientMessageId: string;
  content: ThreadMessageContent;
  occurredAt: string;
}

export interface SendChatWorkMessageResult {
  message: ThreadMessage;
  assistantMessageRef: string;
  replayedProviderTurn: boolean;
}

class ThreadLane {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(threadRef: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(threadRef) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(threadRef, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(threadRef) === tail) {
        this.tails.delete(threadRef);
      }
    }
  }
}

function invalidProviderResponse(): PublicError {
  return {
    code: "PROVIDER_RESPONSE_INVALID",
    category: "internal",
    message: "个人助理返回了无法识别的结果。",
    retryable: true
  };
}

function unavailableProvider(): PublicError {
  return {
    code: "PROVIDER_UNAVAILABLE",
    category: "availability",
    message: "个人助理暂时不可用，请稍后重试。",
    retryable: true
  };
}

function unconfiguredProvider(): PublicError {
  return {
    code: "AGENT_RUNTIME_UNAVAILABLE",
    category: "availability",
    message: "Agent 尚未配置。",
    retryable: true
  };
}

function throwProviderError(error: PublicError, statusCode: number): never {
  throw new GatewayDomainError(
    error.code,
    statusCode,
    error.category,
    error.retryable,
    error.message
  );
}

export class ChatWorkMessageService {
  private readonly lanes = new ThreadLane();
  private readonly providerResolver: ProviderAdapterResolver;

  constructor(
    private readonly domainRepository: ChatWorkDomainRepository,
    private readonly providerRepository: ChatWorkProviderRepository,
    providerResolver: ProviderAdapterResolver | ProviderAdapter,
    private readonly now: () => Date = () => new Date()
  ) {
    this.providerResolver = "resolve" in providerResolver
      ? providerResolver
      : { resolve: () => providerResolver };
  }

  async sendPersonMessage(
    input: SendChatWorkMessageInput
  ): Promise<SendChatWorkMessageResult> {
    const agentRef = this.domainRepository.resolveThreadAgent({
      personRef: input.personRef,
      entryAudience: "personal",
      threadRef: input.threadRef
    });
    const message = this.domainRepository.appendThreadMessage({
      personRef: input.personRef,
      agentRef,
      entryAudience: "personal",
      threadRef: input.threadRef,
      clientMessageId: input.clientMessageId,
      actor: { type: "person", personRef: input.personRef },
      origin: {
        deviceRef: input.deviceRef,
        connectionRef: null,
        entryAudience: "personal"
      },
      content: input.content,
      occurredAt: input.occurredAt
    });

    return this.lanes.run(input.threadRef, async () => {
      const turn = this.providerRepository.prepareTurn({
        personRef: input.personRef,
        userMessage: message
      });
      if (turn.status === "succeeded") {
        if (!turn.assistantMessageRef) {
          throw new Error("Successful Provider Turn has no Assistant message");
        }
        return {
          message,
          assistantMessageRef: turn.assistantMessageRef,
          replayedProviderTurn: true
        };
      }

      const contextMessages = turn.rebuildProviderContext
        ? this.domainRepository.listThreadMessages({
            personRef: input.personRef,
            agentRef: turn.agentRef,
            entryAudience: "personal",
            threadRef: input.threadRef,
            limit: 200
          }).messages
        : [message];
      const request = providerInvocationRequestSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        invocationRef: turn.invocationRef,
        correlationRef: turn.correlationRef,
        idempotencyKey: turn.idempotencyKey,
        requestedAt: turn.requestedAt,
        providerProfileRef: turn.providerProfileRef,
        targetAgentRef: turn.agentRef,
        conversationRef: turn.providerConversationRef,
        ...(turn.externalSessionRef
          ? { externalSessionRef: turn.externalSessionRef }
          : {}),
        content: buildProviderContext({
          messages: contextMessages,
          currentMessageRef: message.messageRef,
          externalSessionRef: turn.externalSessionRef
        }),
        timeoutMs: 30000
      });

      let providerAdapter: ProviderAdapter;
      try {
        providerAdapter = this.providerResolver.resolve(turn.providerProfileRef);
      } catch {
        const error = unconfiguredProvider();
        this.providerRepository.markTurnFailed({
          userMessageRef: message.messageRef,
          error,
          completedAt: this.now().toISOString()
        });
        return throwProviderError(error, 503);
      }

      let rawResult: unknown;
      try {
        rawResult = await providerAdapter.invoke(request);
      } catch {
        const error = unavailableProvider();
        this.providerRepository.markTurnFailed({
          userMessageRef: message.messageRef,
          error,
          completedAt: this.now().toISOString()
        });
        return throwProviderError(error, 502);
      }

      const parsed = providerInvocationResultSchema.safeParse(rawResult);
      if (!parsed.success) {
        const error = invalidProviderResponse();
        this.providerRepository.markTurnFailed({
          userMessageRef: message.messageRef,
          error,
          completedAt: this.now().toISOString()
        });
        return throwProviderError(error, 502);
      }

      const result = parsed.data;
      if (
        result.invocationRef !== request.invocationRef ||
        result.correlationRef !== request.correlationRef
      ) {
        const error = invalidProviderResponse();
        this.providerRepository.markTurnFailed({
          userMessageRef: message.messageRef,
          error,
          completedAt: result.completedAt
        });
        return throwProviderError(error, 502);
      }

      if (result.status !== "succeeded") {
        const error = result.error ?? unavailableProvider();
        if (error.code === "PROVIDER_SESSION_NOT_FOUND") {
          this.providerRepository.clearMissingExternalSession({
            turn,
            completedAt: result.completedAt
          });
        }
        this.providerRepository.markTurnFailed({
          userMessageRef: message.messageRef,
          error,
          completedAt: result.completedAt
        });
        return throwProviderError(error, result.status === "timed_out" ? 504 : 502);
      }

      const output = result.output?.[0];
      if (!output || !result.externalSessionRef) {
        const error = invalidProviderResponse();
        this.providerRepository.markTurnFailed({
          userMessageRef: message.messageRef,
          error,
          completedAt: result.completedAt
        });
        return throwProviderError(error, 502);
      }

      const assistantMessageRef = this.providerRepository.commitTurnSucceeded({
        personRef: input.personRef,
        userMessage: message,
        turn,
        output,
        externalSessionRef: result.externalSessionRef,
        completedAt: result.completedAt
      });
      return {
        message,
        assistantMessageRef,
        replayedProviderTurn: false
      };
    });
  }
}
