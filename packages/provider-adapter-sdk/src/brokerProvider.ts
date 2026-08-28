import http, { type IncomingHttpHeaders } from "node:http";
import {
  PROTOCOL_VERSION,
  agentDescriptorV1Schema,
  agentInvocationRequestV1Schema,
  agentInvocationResultV1Schema,
  type AdapterHealth,
  type AgentInvocationRequestV1,
  type AgentInvocationResultV1,
  type ProviderInvocationRequest,
  type ProviderInvocationResult,
  type PublicError
} from "@family-ai/contracts";
import type { ProviderAdapter } from "./index.js";
import { providerPromptFrom } from "./providerPrompt.js";

const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_MAX_DEADLINE_MS = 300_000;
const DEFAULT_HEALTH_DEADLINE_MS = 3_000;

type BrokerFailureCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_CANCELLED"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_UNAVAILABLE";

const PUBLIC_ERRORS: Record<BrokerFailureCode, PublicError> = {
  PROVIDER_TIMEOUT: {
    code: "PROVIDER_TIMEOUT",
    category: "timeout",
    message: "个人助理响应超时，请稍后重试。",
    retryable: true
  },
  PROVIDER_CANCELLED: {
    code: "PROVIDER_CANCELLED",
    category: "availability",
    message: "个人助理请求已取消。",
    retryable: true
  },
  PROVIDER_RESPONSE_INVALID: {
    code: "PROVIDER_RESPONSE_INVALID",
    category: "internal",
    message: "个人助理返回了无效响应，请稍后重试。",
    retryable: true
  },
  PROVIDER_UNAVAILABLE: {
    code: "PROVIDER_UNAVAILABLE",
    category: "availability",
    message: "个人助理暂时不可用，请稍后重试。",
    retryable: true
  }
};

const SESSION_PREFIXES = new Map<string, string>([
  ["agent:hermes-jarvis", "external-session:hermes-jarvis-"],
  ["agent:hermes-zzh", "external-session:hermes-zzh-"],
  ["agent:hermes-nsy", "external-session:hermes-nsy-"]
]);

export interface BrokerProviderOptions {
  socketPath: string;
  targetAgentRef: string;
  providerProfileRef: string;
  clock?: () => Date;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxDeadlineMs?: number;
  healthDeadlineMs?: number;
}

type TransportFailure = "timeout" | "invalid" | "unavailable";

class BrokerTransportError extends Error {
  constructor(readonly kind: TransportFailure) {
    super(kind);
    this.name = "BrokerTransportError";
  }
}

interface BrokerHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function positiveBound(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

function failure(
  request: ProviderInvocationRequest,
  clock: () => Date,
  code: BrokerFailureCode
): ProviderInvocationResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    invocationRef: request.invocationRef,
    correlationRef: request.correlationRef,
    status:
      code === "PROVIDER_TIMEOUT"
        ? "timed_out"
        : code === "PROVIDER_CANCELLED"
          ? "cancelled"
          : "failed",
    completedAt: clock().toISOString(),
    error: { ...PUBLIC_ERRORS[code] }
  };
}

function refSuffix(value: string, prefix: string): string | undefined {
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function validExternalSessionRef(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) return false;
  return /^[a-z0-9][a-z0-9_-]{1,99}$/.test(value.slice(prefix.length));
}

function topLevelObjectHasDuplicateKeys(json: string): boolean {
  const keys = new Set<string>();
  let depth = 0;
  let index = 0;
  while (index < json.length) {
    const character = json[index];
    if (character === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (character !== '"') {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    let escaped = false;
    while (index < json.length) {
      const current = json[index];
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        index += 1;
        break;
      }
      index += 1;
    }
    if (depth !== 1) continue;
    let cursor = index;
    while (/\s/.test(json[cursor] ?? "")) cursor += 1;
    if (json[cursor] !== ":") continue;
    let key: unknown;
    try {
      key = JSON.parse(json.slice(start, index));
    } catch {
      return true;
    }
    if (typeof key !== "string" || keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

function exactObjectKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index]);
}

function parseStrictJson(body: string): unknown {
  if (topLevelObjectHasDuplicateKeys(body)) {
    throw new BrokerTransportError("invalid");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new BrokerTransportError("invalid");
  }
}

function requestJson(options: {
  socketPath: string;
  method: "GET" | "POST";
  path: string;
  body?: string;
  deadlineMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}): Promise<BrokerHttpResponse> {
  if (
    options.body !== undefined &&
    Buffer.byteLength(options.body) > options.maxRequestBytes
  ) {
    return Promise.reject(new BrokerTransportError("invalid"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (
      error: BrokerTransportError | undefined,
      value?: BrokerHttpResponse
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value!);
    };
    const request = http.request(
      {
        socketPath: options.socketPath,
        method: options.method,
        path: options.path,
        agent: false,
        headers: {
          accept: "application/json",
          connection: "close",
          ...(options.body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(options.body)
              })
        }
      },
      (response) => {
        const declaredLength = Number(response.headers["content-length"]);
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > options.maxResponseBytes
        ) {
          response.destroy();
          settle(new BrokerTransportError("invalid"));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > options.maxResponseBytes) {
            response.destroy();
            settle(new BrokerTransportError("invalid"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("aborted", () => {
          settle(new BrokerTransportError("invalid"));
        });
        response.once("end", () => {
          if (!response.complete) {
            settle(new BrokerTransportError("invalid"));
            return;
          }
          settle(undefined, {
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks, bytes).toString("utf8")
          });
        });
      }
    );
    const deadline = setTimeout(() => {
      request.destroy();
      settle(new BrokerTransportError("timeout"));
    }, options.deadlineMs);
    request.once("error", () => {
      settle(new BrokerTransportError("unavailable"));
    });
    request.end(options.body);
  });
}

export class BrokerProviderAdapter implements ProviderAdapter {
  private readonly options: BrokerProviderOptions;
  private readonly clock: () => Date;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly maxDeadlineMs: number;
  private readonly healthDeadlineMs: number;
  private readonly externalSessionPrefix: string;

  constructor(options: BrokerProviderOptions) {
    const externalSessionPrefix = SESSION_PREFIXES.get(options.targetAgentRef);
    if (!externalSessionPrefix) throw new Error("BROKER_AGENT_NOT_CONFIGURED");
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.maxRequestBytes = positiveBound(
      options.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES
    );
    this.maxResponseBytes = positiveBound(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES
    );
    this.maxDeadlineMs = positiveBound(
      options.maxDeadlineMs,
      DEFAULT_MAX_DEADLINE_MS
    );
    this.healthDeadlineMs = positiveBound(
      options.healthDeadlineMs,
      DEFAULT_HEALTH_DEADLINE_MS
    );
    this.externalSessionPrefix = externalSessionPrefix;
  }

  async health(): Promise<AdapterHealth> {
    let online = false;
    try {
      const response = await requestJson({
        socketPath: this.options.socketPath,
        method: "GET",
        path: "/v1/health",
        deadlineMs: Math.min(this.healthDeadlineMs, this.maxDeadlineMs),
        maxRequestBytes: this.maxRequestBytes,
        maxResponseBytes: this.maxResponseBytes
      });
      if (
        response.statusCode === 200 &&
        response.headers["content-type"]?.startsWith("application/json")
      ) {
        const value = parseStrictJson(response.body);
        if (
          exactObjectKeys(value, ["agents", "status"]) &&
          (value as { status?: unknown }).status === "ok" &&
          Array.isArray((value as { agents?: unknown }).agents)
        ) {
          const descriptors = (value as { agents: unknown[] }).agents
            .map((descriptor) => agentDescriptorV1Schema.safeParse(descriptor));
          const configured = descriptors.filter(
            (descriptor) => descriptor.success &&
              descriptor.data.agentRef === this.options.targetAgentRef
          );
          online = descriptors.every((descriptor) => descriptor.success) &&
            configured.length === 1 &&
            configured[0]?.success === true &&
            configured[0].data.status === "available";
        }
      }
    } catch {
      online = false;
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      adapterRef: "adapter:agent-broker",
      status: online ? "online" : "offline",
      providerProfiles: [this.options.providerProfileRef],
      checkedAt: this.clock().toISOString()
    };
  }

  async invoke(
    request: ProviderInvocationRequest
  ): Promise<ProviderInvocationResult> {
    if (
      request.targetAgentRef !== this.options.targetAgentRef ||
      request.providerProfileRef !== this.options.providerProfileRef ||
      (request.externalSessionRef !== undefined &&
        !validExternalSessionRef(
          request.externalSessionRef,
          this.externalSessionPrefix
        ))
    ) {
      return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
    }
    const prompt = providerPromptFrom(request);
    const actorSuffix = refSuffix(request.correlationRef, "correlation:");
    const sessionSuffix = refSuffix(request.conversationRef, "conversation:");
    if (!prompt || !actorSuffix || !sessionSuffix) {
      return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
    }
    const candidate = {
      protocolVersion: 1,
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      product: "family",
      actorContextRef: `actor-context:${actorSuffix}`,
      agentRef: request.targetAgentRef,
      localSessionRef: `local-session:${sessionSuffix}`,
      ...(request.externalSessionRef === undefined
        ? {}
        : { externalSessionRef: request.externalSessionRef }),
      prompt,
      timeoutMs: request.timeoutMs
    };
    const parsedRequest = agentInvocationRequestV1Schema.safeParse(candidate);
    if (!parsedRequest.success) {
      return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
    }

    let response: BrokerHttpResponse;
    try {
      response = await requestJson({
        socketPath: this.options.socketPath,
        method: "POST",
        path: "/v1/invocations",
        body: JSON.stringify(parsedRequest.data),
        deadlineMs: Math.min(request.timeoutMs, this.maxDeadlineMs),
        maxRequestBytes: this.maxRequestBytes,
        maxResponseBytes: this.maxResponseBytes
      });
    } catch (error) {
      const kind = error instanceof BrokerTransportError
        ? error.kind
        : "unavailable";
      return failure(
        request,
        this.clock,
        kind === "timeout"
          ? "PROVIDER_TIMEOUT"
          : kind === "invalid"
            ? "PROVIDER_RESPONSE_INVALID"
            : "PROVIDER_UNAVAILABLE"
      );
    }
    if (response.statusCode !== 200) {
      return failure(request, this.clock, "PROVIDER_UNAVAILABLE");
    }
    if (!response.headers["content-type"]?.startsWith("application/json")) {
      return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
    }

    let brokerResult: AgentInvocationResultV1;
    try {
      const parsedResult = agentInvocationResultV1Schema.safeParse(
        parseStrictJson(response.body)
      );
      if (!parsedResult.success) {
        return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
      }
      brokerResult = parsedResult.data;
    } catch {
      return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
    }
    if (
      brokerResult.invocationRef !== request.invocationRef ||
      brokerResult.correlationRef !== request.correlationRef ||
      !validExternalSessionRef(
        brokerResult.externalSessionRef,
        this.externalSessionPrefix
      ) ||
      (request.externalSessionRef !== undefined &&
        brokerResult.externalSessionRef !== request.externalSessionRef)
    ) {
      return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
    }

    if (brokerResult.status !== "succeeded") {
      const code: BrokerFailureCode =
        brokerResult.status === "timed_out"
          ? "PROVIDER_TIMEOUT"
          : brokerResult.status === "cancelled"
            ? "PROVIDER_CANCELLED"
            : "PROVIDER_UNAVAILABLE";
      return {
        ...failure(request, this.clock, code),
        completedAt: brokerResult.completedAt
      };
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "succeeded",
      completedAt: brokerResult.completedAt,
      output: [{ type: "text", text: brokerResult.output }],
      externalSessionRef: brokerResult.externalSessionRef
    };
  }
}
