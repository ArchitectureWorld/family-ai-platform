import {
  PROTOCOL_VERSION,
  type AdapterHealth,
  type ProviderInvocationRequest,
  type ProviderInvocationResult,
  type PublicError
} from "@family-ai/contracts";
import type { ProviderAdapter } from "./index.js";

export type HermesPrivateInputMode = "disabled" | "query-stdin-v1";

const PROVIDER_UNAVAILABLE: PublicError = {
  code: "PROVIDER_UNAVAILABLE",
  category: "availability",
  message: "个人助理暂时不可用，请稍后重试。",
  retryable: true
};

export interface HermesCliProviderOptions {
  executable: string;
  prefixArgs?: readonly string[];
  cwd: string;
  allowedEnvironment?: ReadonlyArray<readonly [string, string]>;
  profileName?: string;
  model?: string;
  provider?: string;
  providerProfileRef: string;
  privateInputMode?: HermesPrivateInputMode;
  clock?: () => Date;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxConcurrency?: number;
  terminationGraceMs?: number;
}

export class HermesCliProviderAdapter implements ProviderAdapter {
  private readonly options: HermesCliProviderOptions;
  private readonly clock: () => Date;

  constructor(options: HermesCliProviderOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
  }

  async health(): Promise<AdapterHealth> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      adapterRef: "adapter:hermes-cli",
      status: "offline",
      providerProfiles: [this.options.providerProfileRef],
      checkedAt: this.clock().toISOString()
    };
  }

  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    // B1a intentionally keeps every Hermes private-input mode fail-closed.
    // query-stdin-v1 is only a reserved capability label until B1b supplies and
    // verifies a Hermes transport that cannot serialize private input into argv.
    return {
      protocolVersion: PROTOCOL_VERSION,
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "failed",
      completedAt: this.clock().toISOString(),
      error: { ...PROVIDER_UNAVAILABLE }
    };
  }
}
