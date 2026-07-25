import {
  PROTOCOL_VERSION,
  type AdapterHealth,
  type ProviderInvocationRequest,
  type ProviderInvocationResult
} from "@family-ai/contracts";
import type { ProviderAdapter } from "./index.js";

export interface ProviderAdapterRoute {
  providerProfileRefs: string[];
  adapter: ProviderAdapter;
}

export class ProviderAdapterRouter implements ProviderAdapter {
  private readonly routes = new Map<string, ProviderAdapter>();
  private readonly adapters: ProviderAdapter[];

  constructor(
    definitions: ProviderAdapterRoute[],
    private readonly clock: () => Date = () => new Date()
  ) {
    if (!Array.isArray(definitions) || definitions.length === 0) {
      throw new Error("ProviderAdapterRouter requires at least one route");
    }
    const adapters = new Set<ProviderAdapter>();
    for (const definition of definitions) {
      if (!Array.isArray(definition.providerProfileRefs) || definition.providerProfileRefs.length === 0) {
        throw new Error("Provider Adapter route requires at least one Provider Profile");
      }
      adapters.add(definition.adapter);
      for (const providerProfileRef of definition.providerProfileRefs) {
        if (this.routes.has(providerProfileRef)) {
          throw new Error(`Duplicate Provider Profile route: ${providerProfileRef}`);
        }
        this.routes.set(providerProfileRef, definition.adapter);
      }
    }
    this.adapters = [...adapters];
  }

  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    const adapter = this.routes.get(request.providerProfileRef);
    if (adapter) return adapter.invoke(request);
    return {
      protocolVersion: PROTOCOL_VERSION,
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "failed",
      completedAt: this.clock().toISOString(),
      error: {
        code: "PROVIDER_PROFILE_UNAVAILABLE",
        category: "availability",
        message: "当前 Provider Profile 暂时不可用。",
        retryable: true
      }
    };
  }

  async health(): Promise<AdapterHealth> {
    const results = await Promise.all(this.adapters.map((adapter) => adapter.health()));
    const status = results.some((result) => result.status === "offline")
      ? "offline"
      : results.some((result) => result.status === "degraded")
        ? "degraded"
        : "online";
    return {
      protocolVersion: PROTOCOL_VERSION,
      adapterRef: "adapter:provider-router",
      status,
      providerProfiles: [...new Set(this.routes.keys())].sort(),
      checkedAt: this.clock().toISOString()
    };
  }
}
