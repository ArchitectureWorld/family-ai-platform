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

const CODEX_EXTERNAL_SESSION = /^external-session:codex-([a-z0-9][a-z0-9_-]{1,120})$/;
const CODEX_SESSION_ID = /^[a-z0-9][a-z0-9_-]{1,120}$/;
const CODEX_SESSION_NOT_FOUND =
  /(?:no rollout found with session id|\bsession(?:\s+id)?\s+(?:was\s+)?not\s+found\b)/i;

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

export interface CodexCliProviderOptions {
  executable: string;
  prefixArgs?: readonly string[];
  cwd: string;
  allowedEnvironment?: ReadonlyArray<readonly [string, string]>;
  providerProfileRef: string;
  clock?: () => Date;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxConcurrency?: number;
  terminationGraceMs?: number;
}

interface CodexEvent {
  type?: unknown;
  thread_id?: unknown;
  item?: {
    type?: unknown;
    text?: unknown;
  };
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
  return CODEX_EXTERNAL_SESSION.exec(externalSessionRef)?.[1];
}

function externalSessionRef(raw: string): string | undefined {
  if (!CODEX_SESSION_ID.test(raw)) return undefined;
  const value = `external-session:codex-${raw}`;
  return CODEX_EXTERNAL_SESSION.test(value) ? value : undefined;
}

function parseJsonLines(stdout: string): {
  sessionId: string;
  finalText: string;
} | undefined {
  let sessionId: string | undefined;
  let finalText: string | undefined;
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;
  try {
    for (const line of lines) {
      const event = JSON.parse(line) as CodexEvent;
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        return undefined;
      }
      if (event.type === "thread.started") {
        if (typeof event.thread_id !== "string" || sessionId !== undefined) {
          return undefined;
        }
        sessionId = event.thread_id;
      }
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message"
      ) {
        if (typeof event.item.text !== "string") return undefined;
        finalText = event.item.text;
      }
    }
  } catch {
    return undefined;
  }
  if (
    !sessionId ||
    !finalText ||
    finalText.length > 12_000 ||
    !externalSessionRef(sessionId)
  ) {
    return undefined;
  }
  return { sessionId, finalText };
}

export class CodexCliProviderAdapter implements ProviderAdapter {
  private readonly options: CodexCliProviderOptions;
  private readonly clock: () => Date;

  constructor(options: CodexCliProviderOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
  }

  async health(): Promise<AdapterHealth> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      adapterRef: "adapter:codex-cli",
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

    const globalArgs = [
      "-s",
      "workspace-write",
      "-a",
      "never",
      "-C",
      this.options.cwd,
      "exec"
    ];
    const args = continuationSession
      ? [...globalArgs, "resume", continuationSession, "--json"]
      : [...globalArgs, "--json"];

    try {
      const result = await runControlledProcess({
        executable: this.options.executable,
        prefixArgs: this.options.prefixArgs ?? [],
        args,
        cwd: this.options.cwd,
        allowedEnvironment: this.options.allowedEnvironment ?? defaultEnvironment(),
        stdin: prompt,
        timeoutMs: request.timeoutMs,
        terminationGraceMs: this.options.terminationGraceMs ?? 250,
        maxStdoutBytes: this.options.maxStdoutBytes ?? 1024 * 1024,
        maxStderrBytes: this.options.maxStderrBytes ?? 64 * 1024,
        maxConcurrency: this.options.maxConcurrency ?? 2
      });
      if (result.timedOut || result.aborted) {
        return failure(request, this.clock, "PROVIDER_TIMEOUT");
      }
      if (result.exitCode !== 0) {
        if (continuationSession && CODEX_SESSION_NOT_FOUND.test(result.stderr)) {
          return failure(request, this.clock, "PROVIDER_SESSION_NOT_FOUND");
        }
        return failure(request, this.clock, "PROVIDER_UNAVAILABLE");
      }
      const parsed = parseJsonLines(result.stdout);
      if (
        !parsed ||
        (continuationSession !== undefined &&
          parsed.sessionId !== continuationSession)
      ) {
        return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
      }
      const safeExternalSessionRef = externalSessionRef(parsed.sessionId);
      if (!safeExternalSessionRef) {
        return failure(request, this.clock, "PROVIDER_RESPONSE_INVALID");
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        invocationRef: request.invocationRef,
        correlationRef: request.correlationRef,
        status: "succeeded",
        completedAt: this.clock().toISOString(),
        output: [{ type: "text", text: parsed.finalText }],
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
