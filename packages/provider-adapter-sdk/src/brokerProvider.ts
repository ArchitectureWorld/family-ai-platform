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

const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
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

function assertStrictJsonStructure(json: string): void {
  let index = 0;
  const invalid = (): never => {
    throw new BrokerTransportError("invalid");
  };
  const skipWhitespace = () => {
    while (/\s/.test(json[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    if (json[index] !== '"') return invalid();
    const start = index;
    index += 1;
    let escaped = false;
    while (index < json.length) {
      const character = json[index]!;
      index += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        try {
          const value = JSON.parse(json.slice(start, index)) as unknown;
          if (typeof value !== "string") return invalid();
          return value;
        } catch {
          return invalid();
        }
      }
    }
    return invalid();
  };
  const parseValue = (): void => {
    skipWhitespace();
    const character = json[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (json[index] === "}") {
        index += 1;
        return;
      }
      while (index < json.length) {
        const key = parseString();
        if (keys.has(key)) invalid();
        keys.add(key);
        skipWhitespace();
        if (json[index] !== ":") invalid();
        index += 1;
        parseValue();
        skipWhitespace();
        if (json[index] === "}") {
          index += 1;
          return;
        }
        if (json[index] !== ",") invalid();
        index += 1;
        skipWhitespace();
      }
      return invalid();
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (json[index] === "]") {
        index += 1;
        return;
      }
      while (index < json.length) {
        parseValue();
        skipWhitespace();
        if (json[index] === "]") {
          index += 1;
          return;
        }
        if (json[index] !== ",") invalid();
        index += 1;
      }
      return invalid();
    }
    if (character === '"') {
      parseString();
      return;
    }
    const remaining = json.slice(index);
    const primitive = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/
      .exec(remaining)?.[0];
    if (!primitive) return invalid();
    index += primitive.length;
  };

  parseValue();
  skipWhitespace();
  if (index !== json.length) invalid();
}

function exactObjectKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index]);
}

function jsonMediaType(value: string | string[] | undefined): boolean {
  if (typeof value !== "string") return false;
  const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/;
  let index = 0;
  const skipWhitespace = () => {
    while (value[index] === " " || value[index] === "\t") index += 1;
  };
  const readToken = (): string | undefined => {
    const match = token.exec(value.slice(index));
    if (!match?.[0]) return undefined;
    index += match[0].length;
    return match[0];
  };
  const readQuotedString = (): boolean => {
    if (value[index] !== '"') return false;
    index += 1;
    while (index < value.length) {
      const character = value[index]!;
      const code = character.charCodeAt(0);
      if (character === '"') {
        index += 1;
        return true;
      }
      if (character === "\\") {
        index += 1;
        if (index >= value.length || /[\r\n]/.test(value[index]!)) return false;
        index += 1;
        continue;
      }
      if (
        code !== 0x09 &&
        !(code >= 0x20 && code <= 0x21) &&
        !(code >= 0x23 && code <= 0x5b) &&
        !(code >= 0x5d && code <= 0xff)
      ) {
        return false;
      }
      index += 1;
    }
    return false;
  };

  skipWhitespace();
  const type = readToken()?.toLowerCase();
  if (value[index] !== "/") return false;
  index += 1;
  const subtype = readToken()?.toLowerCase();
  if (type !== "application" || subtype !== "json") return false;

  const parameters = new Set<string>();
  while (true) {
    skipWhitespace();
    if (index === value.length) return true;
    if (value[index] !== ";") return false;
    index += 1;
    skipWhitespace();
    const name = readToken()?.toLowerCase();
    if (!name || parameters.has(name)) return false;
    parameters.add(name);
    skipWhitespace();
    if (value[index] !== "=") return false;
    index += 1;
    skipWhitespace();
    if (value[index] === '"') {
      if (!readQuotedString()) return false;
    } else if (!readToken()) {
      return false;
    }
  }
}

function parseStrictJson(body: string): unknown {
  assertStrictJsonStructure(body);
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
        (response.statusCode === 200 || response.statusCode === 503) &&
        jsonMediaType(response.headers["content-type"])
      ) {
        const value = parseStrictJson(response.body);
        const aggregateStatus = (value as { status?: unknown }).status;
        const validAggregate =
          (response.statusCode === 200 && aggregateStatus === "ok") ||
          (response.statusCode === 503 && aggregateStatus === "degraded");
        if (
          validAggregate &&
          exactObjectKeys(value, ["agents", "status"]) &&
          Array.isArray((value as { agents?: unknown }).agents)
        ) {
          const descriptors = (value as { agents: unknown[] }).agents
            .map((descriptor) => agentDescriptorV1Schema.safeParse(descriptor));
          const configured = descriptors.filter(
            (descriptor) => descriptor.success &&
              descriptor.data.agentRef === this.options.targetAgentRef
          );
          const descriptorsValid = descriptors.every(
            (descriptor) => descriptor.success
          );
          const allAvailable = descriptorsValid && descriptors.every(
            (descriptor) =>
              descriptor.success && descriptor.data.status === "available"
          );
          const aggregateConsistent =
            (aggregateStatus === "ok" && allAvailable) ||
            (aggregateStatus === "degraded" && !allAvailable);
          online = descriptorsValid && aggregateConsistent &&
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
    if (!jsonMediaType(response.headers["content-type"])) {
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
