import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type MessageEnvelope,
  type ProviderInvocationRequest
} from "@family-ai/contracts";
import type { ProviderAdapter } from "@family-ai/provider-adapter-sdk";
import {
  GatewayRepository,
  sha256,
  type AuthenticatedDevice
} from "./database.js";

export class GatewayDomainError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "GatewayDomainError";
  }
}

export interface SendResult {
  statusCode: number;
  body: {
    replayed: boolean;
    response: MessageEnvelope;
  };
}

class ConversationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(conversationRef: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(conversationRef) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(conversationRef, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(conversationRef) === tail) {
        this.tails.delete(conversationRef);
      }
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function requestHash(envelope: MessageEnvelope): string {
  return sha256(canonicalJson(envelope));
}

function assertFixedRoute(device: AuthenticatedDevice, envelope: MessageEnvelope): void {
  if (
    envelope.source.kind !== "device" ||
    envelope.source.ref !== device.deviceRef ||
    envelope.target.kind !== "agent" ||
    envelope.target.ref !== device.agentRef
  ) {
    throw new GatewayDomainError(
      "FIXED_ROUTE_REQUIRED",
      403,
      "消息来源或目标不属于当前设备的固定个人助理。"
    );
  }
}

export class MessageService {
  private readonly queue = new ConversationQueue();

  constructor(
    private readonly repository: GatewayRepository,
    private readonly providerAdapter: ProviderAdapter
  ) {}

  private replayOrConflict(input: {
    device: AuthenticatedDevice;
    conversationRef: string;
    envelope: MessageEnvelope;
    hash: string;
  }): SendResult | null {
    const existing = this.repository.findIdempotency({
      deviceRef: input.device.deviceRef,
      conversationRef: input.conversationRef,
      agentRef: input.device.agentRef,
      idempotencyKey: input.envelope.idempotencyKey
    });
    if (!existing) return null;
    if (existing.requestHash !== input.hash) {
      throw new GatewayDomainError(
        "IDEMPOTENCY_CONFLICT",
        409,
        "同一个幂等键已用于不同的请求内容。"
      );
    }
    return {
      statusCode: existing.httpStatus,
      body: {
        replayed: true,
        response: existing.response as MessageEnvelope
      }
    };
  }

  async send(input: {
    device: AuthenticatedDevice;
    conversationRef: string;
    envelope: MessageEnvelope;
  }): Promise<SendResult> {
    const conversation = this.repository.getConversationForAccess(
      input.conversationRef,
      input.device.memberRef,
      input.device.agentRef
    );
    if (!conversation) {
      throw new GatewayDomainError(
        "CONVERSATION_NOT_FOUND",
        404,
        "没有找到这个会话。"
      );
    }
    assertFixedRoute(input.device, input.envelope);
    const hash = requestHash(input.envelope);
    const immediate = this.replayOrConflict({ ...input, hash });
    if (immediate) return immediate;

    return this.queue.run(input.conversationRef, async () => {
      const afterWait = this.replayOrConflict({ ...input, hash });
      if (afterWait) return afterWait;

      const externalSessionRef = this.repository.getExternalSession({
        conversationRef: input.conversationRef,
        agentRef: input.device.agentRef,
        providerProfileRef: input.device.providerProfileRef
      });
      const providerRequestBase = {
        protocolVersion: PROTOCOL_VERSION,
        invocationRef: `invocation:${randomUUID()}`,
        correlationRef: input.envelope.correlationRef,
        idempotencyKey: input.envelope.idempotencyKey,
        requestedAt: new Date().toISOString(),
        providerProfileRef: input.device.providerProfileRef,
        targetAgentRef: input.device.agentRef,
        conversationRef: input.conversationRef,
        content: [input.envelope.payload],
        timeoutMs: 30000
      } satisfies Omit<ProviderInvocationRequest, "externalSessionRef">;
      const providerRequest: ProviderInvocationRequest = externalSessionRef
        ? { ...providerRequestBase, externalSessionRef }
        : providerRequestBase;
      const providerResult = await this.providerAdapter.invoke(providerRequest);
      if (
        providerResult.status !== "succeeded" ||
        !providerResult.output?.[0] ||
        !providerResult.externalSessionRef
      ) {
        const statusCode = providerResult.status === "timed_out" ? 504 : 502;
        throw new GatewayDomainError(
          providerResult.error?.code ?? "PROVIDER_UNAVAILABLE",
          statusCode,
          providerResult.error?.message ?? "个人助理暂时不可用，请稍后重试。"
        );
      }

      const response: MessageEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        messageRef: `message:${randomUUID()}`,
        correlationRef: input.envelope.correlationRef,
        idempotencyKey: `assistant:${sha256(input.envelope.idempotencyKey).slice(0, 32)}`,
        occurredAt: providerResult.completedAt,
        source: { kind: "agent", ref: input.device.agentRef },
        target: { kind: "device", ref: input.device.deviceRef },
        payload: providerResult.output[0]
      };

      this.repository.persistSuccessfulExchange({
        device: input.device,
        conversationRef: input.conversationRef,
        request: input.envelope,
        response,
        requestHash: hash,
        httpStatus: 200,
        externalSessionRef: providerResult.externalSessionRef
      });
      return {
        statusCode: 200,
        body: { replayed: false, response }
      };
    });
  }
}
