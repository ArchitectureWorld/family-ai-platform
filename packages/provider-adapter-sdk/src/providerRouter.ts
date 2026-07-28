import type { ProviderAdapter } from "./index.js";

export interface ProviderAdapterResolver {
  resolve(providerProfileRef: string): ProviderAdapter;
}

export class ProviderAdapterNotConfiguredError extends Error {
  readonly code = "PROVIDER_ADAPTER_NOT_CONFIGURED";

  constructor() {
    super("PROVIDER_ADAPTER_NOT_CONFIGURED");
    this.name = "ProviderAdapterNotConfiguredError";
  }
}

export class ProviderAdapterRouter implements ProviderAdapterResolver {
  private readonly routes: ReadonlyMap<string, ProviderAdapter>;

  constructor(routes: Iterable<readonly [string, ProviderAdapter]>) {
    const configured = new Map<string, ProviderAdapter>();
    for (const [providerProfileRef, adapter] of routes) {
      if (configured.has(providerProfileRef)) {
        throw new Error("PROVIDER_ADAPTER_ROUTE_DUPLICATE");
      }
      configured.set(providerProfileRef, adapter);
    }
    this.routes = configured;
  }

  static single(
    providerProfileRef: string,
    adapter: ProviderAdapter
  ): ProviderAdapterRouter {
    return new ProviderAdapterRouter([[providerProfileRef, adapter]]);
  }

  resolve(providerProfileRef: string): ProviderAdapter {
    const adapter = this.routes.get(providerProfileRef);
    if (!adapter) throw new ProviderAdapterNotConfiguredError();
    return adapter;
  }
}
