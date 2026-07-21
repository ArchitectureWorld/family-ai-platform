import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type AdapterHealth,
  type ProviderInvocationRequest,
  type ProviderInvocationResult
} from "@family-ai/contracts";

export interface ProviderAdapter {
  invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>;
  health(): Promise<AdapterHealth>;
}

export interface FakeProviderOptions {
  failNext?: boolean;
  clock?: () => Date;
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly calls: ProviderInvocationRequest[] = [];
  readonly results: ProviderInvocationResult[] = [];
  private readonly turns = new Map<string, number>();
  private readonly clock: () => Date;
  private failNext: boolean;

  constructor(options: FakeProviderOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.failNext = options.failNext ?? false;
  }

  async health(): Promise<AdapterHealth> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      adapterRef: "adapter:fake-local",
      status: "online",
      providerProfiles: ["provider-profile:fake-local"],
      checkedAt: this.clock().toISOString()
    };
  }

  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    this.calls.push(structuredClone(request));
    if (this.failNext) {
      this.failNext = false;
      const failed: ProviderInvocationResult = {
        protocolVersion: PROTOCOL_VERSION,
        invocationRef: request.invocationRef,
        correlationRef: request.correlationRef,
        status: "failed",
        completedAt: this.clock().toISOString(),
        error: {
          code: "PROVIDER_UNAVAILABLE",
          category: "availability",
          message: "个人助理暂时不可用，请稍后重试。",
          retryable: true
        }
      };
      this.results.push(failed);
      return failed;
    }

    const externalSessionRef =
      request.externalSessionRef ?? `external-session:fake-${randomUUID()}`;
    const turn = (this.turns.get(externalSessionRef) ?? 0) + 1;
    this.turns.set(externalSessionRef, turn);
    const succeeded: ProviderInvocationResult = {
      protocolVersion: PROTOCOL_VERSION,
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "succeeded",
      completedAt: this.clock().toISOString(),
      output: [{ type: "text", text: `Fake Provider 第 ${turn} 轮回复。` }],
      externalSessionRef
    };
    this.results.push(succeeded);
    return succeeded;
  }
}
