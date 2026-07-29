import {
  PROTOCOL_VERSION,
  type AdapterHealth,
  type ProviderInvocationRequest,
  type ProviderInvocationResult,
  type PublicError
} from "@family-ai/contracts";
import type { ProviderAdapter } from "./index.js";
import {
  ControlledProcessError,
  runControlledProcess
} from "./processRunner.js";

const HERMES_SESSION_LINE = /^session_id:\s*([a-z0-9][a-z0-9_-]{1,126})$/gm;
const HERMES_EXTERNAL_SESSION = /^external-session:hermes-([a-z0-9][a-z0-9_-]{1,119})$/;
const HERMES_SESSION_NOT_FOUND =
  /\bsession(?:\s+id)?\s+(?:was\s+)?not\s+found\b/i;
const HERMES_FATAL_DIAGNOSTIC =
  /(?:\b(?:authentication|credential|api\s+key)\b[^\n]{0,80}\b(?:failed|invalid|missing|required)\b|\b(?:failed|unable)\s+to\s+(?:initialize|start|resume)\b)/i;
const HERMES_UPSTREAM_FAILURE =
  /(?:^|\n)\s*api\s+call\s+failed(?:\s+after\s+\d+\s+retries)?\s*:\s*http\s+[45]\d{2}\b/i;

type ProviderFailureCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_SESSION_NOT_FOUND"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_UNAVAILABLE";

const PUBLIC_ERRORS: Record<ProviderFailureCode, PublicError> = {
  PROVIDER_TIMEOUT: {
    code: "PROVIDER_TIMEOUT",
    category: "timeout",
    message: "个人助理响应超时，请稍后重试。",
    retryable: true
  },
  PROVIDER_SESSION_NOT_FOUND: {
    code: "PROVIDER_SESSION_NOT_FOUND",
    category: "conflict",
    message: "原个人助理会话已失效，请重新开始会话。",
    retryable: false
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

export interface HermesCliProviderOptions {
  executable: string;
  prefixArgs?: readonly string[];
  cwd: string;
  allowedEnvironment?: ReadonlyArray<readonly [string, string]>;
  profileName?: string;
  model?: string;
  provider?: string;
  providerProfileRef: string;
  clock?: () => Date;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxConcurrency?: number;
  terminationGraceMs?: number;
}

function defaultEnvironment(): Array<readonly [string, string]> {
  const home = process.env.HOME ?? "/tmp";
  return [
    ["CODEX_HOME", process.env.CODEX_HOME ?? `${home}/.codex`],
    ["HOME", home],
    ["LANG", process.env.LANG ?? "C.UTF-8"],
    ["PATH", process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"],
    ["TERM", process.env.TERM ?? "dumb"]
  ];
}

function failure(
  request: ProviderInvocationRequest,
  clock: () => Date,
  code: ProviderFailureCode
): ProviderInvocationResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    invocationRef: request.invocationRef,
    correlationRef: request.correlationRef,
    status: code === "PROVIDER_TIMEOUT" ? "timed_out" : "failed",
    completedAt: clock().toISOString(),
    error: { ...PUBLIC_ERRORS[code] }
  };
}

function promptFrom(request: ProviderInvocationRequest): string | undefined {
  const prompt = request.content.map((part) => part.text).join("\n\n");
  if (
    prompt.length === 0 ||
    prompt.length > 240_000 ||
    prompt.includes("\u0000")
  ) {
    return undefined;
  }
  return prompt;
}

function rawSessionId(externalSessionRef: string): string | undefined {
  return HERMES_EXTERNAL_SESSION.exec(externalSessionRef)?.[1];
}

function externalSessionRef(raw: string): string | undefined {
  const value = `external-session:hermes-${raw}`;
  return HERMES_EXTERNAL_SESSION.test(value) ? value : undefined;
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
      status: "online",
      providerProfiles: [this.options.providerProfileRef],
      checkedAt: this.clock().toISOString()
    };
  }

  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    const prompt = promptFrom(request);
    if (!prompt) {
      return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
    }
    const continuationSession = request.externalSessionRef
      ? rawSessionId(request.externalSessionRef)
      : undefined;
    if (request.externalSessionRef && !continuationSession) {
      return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
    }

    const args = ["chat", "-q", prompt];
    if (this.options.model) {
      args.push("-m", this.options.model);
    }
    if (this.options.provider) {
      args.push("--provider", this.options.provider);
    }
    args.push("--quiet", "--source", "tool");
    if (this.options.profileName && this.options.profileName !== "default") {
      args.push("-p", this.options.profileName);
    }
    if (continuationSession) {
      args.push("--resume", continuationSession);
    }

    try {
      const result = await runControlledProcess({
        executable: this.options.executable,
        prefixArgs: this.options.prefixArgs ?? [],
        args,
        cwd: this.options.cwd,
        allowedEnvironment: this.options.allowedEnvironment ?? defaultEnvironment(),
        timeoutMs: request.timeoutMs,
        terminationGraceMs: this.options.terminationGraceMs ?? 250,
        maxStdoutBytes: this.options.maxStdoutBytes ?? 1024 * 1024,
        maxStderrBytes: this.options.maxStderrBytes ?? 64 * 1024,
        maxConcurrency: this.options.maxConcurrency ?? 2
      });
      if (result.timedOut || result.aborted) {
        return failure(request, this.clock, "PROVIDER_TIMEOUT");
      }
      const matches = [...result.stderr.matchAll(HERMES_SESSION_LINE)];
      const sessionId = matches.length === 1 ? matches[0]?.[1] : undefined;
      const safeExternalSessionRef = sessionId
        ? externalSessionRef(sessionId)
        : undefined;
      const validResponse =
        (continuationSession === undefined || sessionId === continuationSession) &&
        safeExternalSessionRef !== undefined &&
        result.stdout.trim().length > 0 &&
        result.stdout.length <= 12_000 &&
        !HERMES_FATAL_DIAGNOSTIC.test(result.stderr) &&
        !HERMES_UPSTREAM_FAILURE.test(`${result.stdout}\n${result.stderr}`);
      if (
        result.exitCode !== 0 &&
        continuationSession &&
        HERMES_SESSION_NOT_FOUND.test(result.stderr)
      ) {
        return failure(request, this.clock, "PROVIDER_SESSION_NOT_FOUND");
      }
      if (result.exitCode !== 0 && (result.exitCode !== 1 || !validResponse)) {
        return failure(request, this.clock, "PROVIDER_UNAVAILABLE");
      }
      if (!validResponse) {
        return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        invocationRef: request.invocationRef,
        correlationRef: request.correlationRef,
        status: "succeeded",
        completedAt: this.clock().toISOString(),
        output: [{ type: "text", text: result.stdout }],
        externalSessionRef: safeExternalSessionRef
      };
    } catch (error) {
      if (error instanceof ControlledProcessError) {
        const code =
          error.code === "STDOUT_LIMIT_EXCEEDED" ||
          error.code === "STDERR_LIMIT_EXCEEDED"
            ? "PROVIDER_RESPONSE_INVALID"
            : "PROVIDER_UNAVAILABLE";
        return failure(request, this.clock, code);
      }
      return failure(request, this.clock, "PROVIDER_UNAVAILABLE");
    }
  }
}
