import { createHash } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type AdapterHealth,
  type ProviderInvocationRequest,
  type ProviderInvocationResult,
  type PublicError
} from "@family-ai/contracts";

export interface HermesProviderProfileConfig {
  providerProfileRef: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  sessionKey: string;
}

export interface HermesProviderAdapterOptions {
  profiles: HermesProviderProfileConfig[];
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

interface NormalizedHermesProviderProfileConfig extends HermesProviderProfileConfig {
  baseUrl: string;
}

const providerProfileRefPattern = /^provider-profile:[a-z0-9][a-z0-9._:-]{1,126}$/;
const safeHeaderValuePattern = /^[^\r\n\0]{1,256}$/;

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Hermes baseUrl must be an absolute HTTP(S) URL");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) {
    throw new Error("Hermes baseUrl must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Hermes baseUrl must not contain credentials, query or fragment");
  }
  const serialized = url.toString().replace(/\/$/, "");
  return serialized;
}

function normalizeProfile(input: HermesProviderProfileConfig): NormalizedHermesProviderProfileConfig {
  if (!providerProfileRefPattern.test(input.providerProfileRef)) {
    throw new Error("Hermes providerProfileRef is invalid");
  }
  if (
    typeof input.apiKey !== "string" ||
    input.apiKey.length < 16 ||
    input.apiKey.length > 4096 ||
    /[\r\n\0]/.test(input.apiKey)
  ) {
    throw new Error("Hermes apiKey is invalid");
  }
  if (!safeHeaderValuePattern.test(input.model)) {
    throw new Error("Hermes model is invalid");
  }
  if (!safeHeaderValuePattern.test(input.sessionKey)) {
    throw new Error("Hermes sessionKey is invalid");
  }
  return {
    ...input,
    baseUrl: normalizeBaseUrl(input.baseUrl)
  };
}

export function hermesExternalSessionRef(
  providerProfileRef: string,
  conversationRef: string
): string {
  const digest = createHash("sha256")
    .update(`${providerProfileRef}\n${conversationRef}`)
    .digest("hex")
    .slice(0, 48);
  return `external-session:hermes-${digest}`;
}

function providerError(
  request: ProviderInvocationRequest,
  completedAt: string,
  status: "failed" | "timed_out",
  error: PublicError
): ProviderInvocationResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    invocationRef: request.invocationRef,
    correlationRef: request.correlationRef,
    status,
    completedAt,
    error
  };
}

function httpFailure(status: number): PublicError {
  if (status === 401 || status === 403) {
    return {
      code: "HERMES_AUTH_FAILED",
      category: "permission",
      message: "Hermes 身份验证失败，请检查运行时配置。",
      retryable: false
    };
  }
  if (status === 408 || status === 429) {
    return {
      code: "HERMES_BUSY",
      category: "availability",
      message: "Hermes 当前繁忙，请稍后重试。",
      retryable: true
    };
  }
  if (status >= 500) {
    return {
      code: "HERMES_UNAVAILABLE",
      category: "availability",
      message: "Hermes 暂时不可用，请稍后重试。",
      retryable: true
    };
  }
  return {
    code: "HERMES_REQUEST_REJECTED",
    category: "validation",
    message: "Hermes 拒绝了这次请求。",
    retryable: false
  };
}

function responseInvalid(): PublicError {
  return {
    code: "HERMES_RESPONSE_INVALID",
    category: "internal",
    message: "Hermes 返回了无法识别的结果。",
    retryable: true
  };
}

function unavailable(): PublicError {
  return {
    code: "HERMES_UNAVAILABLE",
    category: "availability",
    message: "Hermes 暂时不可用，请稍后重试。",
    retryable: true
  };
}

function timeout(): PublicError {
  return {
    code: "HERMES_TIMEOUT",
    category: "timeout",
    message: "Hermes 本次处理超时，请重试。",
    retryable: true
  };
}

function assistantText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.trim().length === 0) return null;
  return content;
}

function advertisedModels(value: unknown): string[] | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids = data
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" ? id : null;
    })
    .filter((id): id is string => id !== null);
  return ids;
}

export class HermesProviderAdapter {
  private readonly profiles = new Map<string, NormalizedHermesProviderProfileConfig>();
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;

  constructor(options: HermesProviderAdapterOptions) {
    if (!Array.isArray(options.profiles) || options.profiles.length === 0) {
      throw new Error("HermesProviderAdapter requires at least one profile");
    }
    for (const raw of options.profiles) {
      const profile = normalizeProfile(raw);
      if (this.profiles.has(profile.providerProfileRef)) {
        throw new Error(`Duplicate Hermes provider profile: ${profile.providerProfileRef}`);
      }
      this.profiles.set(profile.providerProfileRef, profile);
    }
    const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== "function") throw new Error("HermesProviderAdapter requires fetch");
    this.fetchImpl = fetchImpl;
    this.clock = options.clock ?? (() => new Date());
  }

  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    const profile = this.profiles.get(request.providerProfileRef);
    const completedAt = () => this.clock().toISOString();
    if (!profile) {
      return providerError(request, completedAt(), "failed", {
        code: "PROVIDER_PROFILE_UNAVAILABLE",
        category: "availability",
        message: "当前 Provider Profile 暂时不可用。",
        retryable: true
      });
    }

    const externalSessionRef = request.externalSessionRef ?? hermesExternalSessionRef(
      request.providerProfileRef,
      request.conversationRef
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${profile.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${profile.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": request.idempotencyKey,
          "x-hermes-session-id": externalSessionRef,
          "x-hermes-session-key": profile.sessionKey
        },
        body: JSON.stringify({
          model: profile.model,
          messages: request.content.map((content) => ({
            role: "user",
            content: content.text
          })),
          stream: false
        }),
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted || (error as { name?: unknown })?.name === "AbortError") {
        return providerError(request, completedAt(), "timed_out", timeout());
      }
      return providerError(request, completedAt(), "failed", unavailable());
    }
    clearTimeout(timer);

    if (!response.ok) {
      return providerError(request, completedAt(), "failed", httpFailure(response.status));
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return providerError(request, completedAt(), "failed", responseInvalid());
    }
    const text = assistantText(raw);
    if (text === null) {
      return providerError(request, completedAt(), "failed", responseInvalid());
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "succeeded",
      completedAt: completedAt(),
      output: [{ type: "text", text }],
      externalSessionRef
    };
  }

  async health(): Promise<AdapterHealth> {
    const profiles = [...this.profiles.values()];
    const checks = await Promise.all(profiles.map(async (profile) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await this.fetchImpl(`${profile.baseUrl}/v1/models`, {
          method: "GET",
          headers: { authorization: `Bearer ${profile.apiKey}` },
          redirect: "error",
          signal: controller.signal
        });
        if (!response.ok) return false;
        const raw = await response.json();
        const models = advertisedModels(raw);
        return models?.includes(profile.model) ?? false;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    }));
    const healthy = checks.filter(Boolean).length;
    const status = healthy === checks.length
      ? "online"
      : healthy === 0
        ? "offline"
        : "degraded";
    return {
      protocolVersion: PROTOCOL_VERSION,
      adapterRef: "adapter:hermes-profiles",
      status,
      providerProfiles: profiles.map((profile) => profile.providerProfileRef),
      checkedAt: this.clock().toISOString()
    };
  }
}
