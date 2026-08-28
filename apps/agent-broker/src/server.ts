import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import net from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import {
  agentInvocationRequestV1Schema,
  agentInvocationResultV1Schema,
  type AgentInvocationRequestV1,
  type AgentInvocationResultV1
} from "@family-ai/contracts/federation";
import {
  ControlledProcessError,
  runControlledProcess
} from "@family-ai/provider-adapter-sdk";
import {
  AGENT_TARGETS,
  agentDescriptors,
  probeAgentTarget,
  resolveAgentTarget,
  type AgentAvailability,
  type AgentTarget
} from "./catalog.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const RUNTIME_DIRECTORY_MODE = 0o700n;
const SOCKET_MODE = 0o660n;
const HERMES_SESSION_LINE = /^session_id:\s*([a-z0-9][a-z0-9_-]{1,99})$/gm;
const HERMES_SESSION_NOT_FOUND =
  /\bsession(?:\s+id)?\s+(?:was\s+)?not\s+found\b/i;
const HERMES_FATAL_DIAGNOSTIC =
  /(?:\b(?:authentication|credential|api\s+key)\b[^\n]{0,80}\b(?:failed|invalid|missing|required)\b|\b(?:failed|unable)\s+to\s+(?:initialize|start|resume)\b)/i;
const HERMES_UPSTREAM_FAILURE =
  /(?:^|\n)\s*api\s+call\s+failed(?:\s+after\s+\d+\s+retries)?\s*:\s*http\s+[45]\d{2}\b/i;

type InvocationFailureCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_CANCELLED"
  | "PROVIDER_SESSION_NOT_FOUND"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_UNAVAILABLE";

const PUBLIC_FAILURE_OUTPUT: Record<InvocationFailureCode, string> = {
  PROVIDER_TIMEOUT: "个人助理响应超时，请稍后重试。",
  PROVIDER_CANCELLED: "个人助理请求已取消。",
  PROVIDER_SESSION_NOT_FOUND: "原个人助理会话已失效，请重新开始会话。",
  PROVIDER_RESPONSE_INVALID: "个人助理返回了无效响应，请稍后重试。",
  PROVIDER_UNAVAILABLE: "个人助理暂时不可用，请稍后重试。"
};

export interface AgentBrokerLogEntry {
  readonly event:
    | "broker_started"
    | "broker_stopped"
    | "invocation_completed"
    | "request_rejected";
  readonly agentRef?: string;
  readonly status?: AgentInvocationResultV1["status"];
  readonly code?: string;
}

export interface AgentBrokerOptions {
  readonly runtimeDirectory: string;
  readonly socketPath: string;
  readonly executable: string;
  readonly prefixArgs?: readonly string[];
  readonly processCwd?: (target: AgentTarget) => string;
  readonly runtimeProbe?: (target: AgentTarget, executable: string) => Promise<boolean>;
  readonly clock?: () => Date;
  readonly logger?: (entry: AgentBrokerLogEntry) => void;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxConcurrency?: number;
  readonly terminationGraceMs?: number;
}

export interface AgentBroker {
  readonly server: Server;
  start(): Promise<void>;
  close(): Promise<void>;
}

interface OwnedSocket {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface PreservedReplacement {
  readonly directory: string;
  readonly path: string;
}

interface ConnectorOptions {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly processCwd: (target: AgentTarget) => string;
  readonly clock: () => Date;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxConcurrency: number;
  readonly terminationGraceMs: number;
}

function scopedExternalSessionRef(target: AgentTarget, rawSessionId: string): string {
  return `external-session:hermes-${target.sessionScope}-${rawSessionId}`;
}

function rawSessionId(
  target: AgentTarget,
  externalSessionRef: string
): string | undefined {
  const prefix = `external-session:hermes-${target.sessionScope}-`;
  if (!externalSessionRef.startsWith(prefix)) return undefined;
  const raw = externalSessionRef.slice(prefix.length);
  return /^[a-z0-9][a-z0-9_-]{1,99}$/.test(raw) ? raw : undefined;
}

function placeholderSessionRef(
  target: AgentTarget,
  request: AgentInvocationRequestV1
): string {
  return (
    request.externalSessionRef ??
    scopedExternalSessionRef(target, "unavailable")
  );
}

function failedInvocation(
  target: AgentTarget,
  request: AgentInvocationRequestV1,
  clock: () => Date,
  code: InvocationFailureCode
): AgentInvocationResultV1 {
  return agentInvocationResultV1Schema.parse({
    protocolVersion: 1,
    invocationRef: request.invocationRef,
    correlationRef: request.correlationRef,
    status:
      code === "PROVIDER_TIMEOUT"
        ? "timed_out"
        : code === "PROVIDER_CANCELLED"
          ? "cancelled"
          : "failed",
    output: PUBLIC_FAILURE_OUTPUT[code],
    completedAt: clock().toISOString(),
    externalSessionRef: placeholderSessionRef(target, request)
  });
}

export class HermesStdinConnector {
  private readonly options: ConnectorOptions;

  constructor(options: ConnectorOptions) {
    this.options = options;
  }

  async invoke(
    target: AgentTarget,
    request: AgentInvocationRequestV1,
    abortSignal?: AbortSignal
  ): Promise<AgentInvocationResultV1> {
    const continuationSession = request.externalSessionRef
      ? rawSessionId(target, request.externalSessionRef)
      : undefined;
    if (request.externalSessionRef && !continuationSession) {
      return failedInvocation(
        target,
        request,
        this.options.clock,
        "PROVIDER_RESPONSE_INVALID"
      );
    }

    const frame = {
      protocolVersion: 1,
      profile: target.profile,
      query: request.prompt,
      ...(continuationSession === undefined
        ? {}
        : { resume: continuationSession })
    };
    const processAbort = new AbortController();
    let abortCause: "deadline" | "cancelled" | undefined;
    const cancel = () => {
      abortCause ??= "cancelled";
      processAbort.abort();
    };
    if (abortSignal?.aborted) cancel();
    else abortSignal?.addEventListener("abort", cancel, { once: true });
    const deadline = setTimeout(() => {
      abortCause ??= "deadline";
      processAbort.abort();
    }, request.timeoutMs);

    try {
      const result = await runControlledProcess({
        executable: this.options.executable,
        prefixArgs: this.options.prefixArgs,
        args: [],
        cwd: this.options.processCwd(target),
        allowedEnvironment: [["HERMES_HOME", target.home]],
        stdin: `${JSON.stringify(frame)}\n`,
        abortSignal: processAbort.signal,
        timeoutMs: request.timeoutMs,
        terminationGraceMs: this.options.terminationGraceMs,
        maxStdoutBytes: this.options.maxStdoutBytes,
        maxStderrBytes: this.options.maxStderrBytes,
        maxStdinBytes: MAX_REQUEST_BYTES,
        maxConcurrency: this.options.maxConcurrency
      });
      if (result.timedOut || result.aborted) {
        return failedInvocation(
          target,
          request,
          this.options.clock,
          result.timedOut || abortCause === "deadline"
            ? "PROVIDER_TIMEOUT"
            : "PROVIDER_CANCELLED"
        );
      }

      const sessionMatches = [...result.stderr.matchAll(HERMES_SESSION_LINE)];
      const sessionId =
        sessionMatches.length === 1 ? sessionMatches[0]?.[1] : undefined;
      const output = result.stdout.trim();
      const validResponse =
        sessionId !== undefined &&
        (continuationSession === undefined || sessionId === continuationSession) &&
        output.length > 0 &&
        output.length <= 12_000 &&
        !HERMES_FATAL_DIAGNOSTIC.test(result.stderr) &&
        !HERMES_UPSTREAM_FAILURE.test(`${result.stdout}\n${result.stderr}`);

      if (
        result.exitCode !== 0 &&
        continuationSession &&
        HERMES_SESSION_NOT_FOUND.test(result.stderr)
      ) {
        return failedInvocation(
          target,
          request,
          this.options.clock,
          "PROVIDER_SESSION_NOT_FOUND"
        );
      }
      if (result.exitCode !== 0) {
        return failedInvocation(
          target,
          request,
          this.options.clock,
          "PROVIDER_UNAVAILABLE"
        );
      }
      if (!validResponse || !sessionId) {
        return failedInvocation(
          target,
          request,
          this.options.clock,
          "PROVIDER_RESPONSE_INVALID"
        );
      }

      return agentInvocationResultV1Schema.parse({
        protocolVersion: 1,
        invocationRef: request.invocationRef,
        correlationRef: request.correlationRef,
        status: "succeeded",
        output,
        completedAt: this.options.clock().toISOString(),
        externalSessionRef: scopedExternalSessionRef(target, sessionId)
      });
    } catch (error) {
      const code: InvocationFailureCode =
        error instanceof ControlledProcessError &&
        (error.code === "STDOUT_LIMIT_EXCEEDED" ||
          error.code === "STDERR_LIMIT_EXCEEDED")
          ? "PROVIDER_RESPONSE_INVALID"
          : "PROVIDER_UNAVAILABLE";
      return failedInvocation(target, request, this.options.clock, code);
    } finally {
      clearTimeout(deadline);
      abortSignal?.removeEventListener("abort", cancel);
    }
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  response.end(payload);
}

function publicRequestError(
  code: string,
  message: string,
  category: "validation" | "conflict" | "internal" = "validation",
  retryable = false
): object {
  return {
    error: {
      code,
      category,
      message,
      retryable
    }
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("EMPTY_REQUEST");
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

function safeLog(
  logger: ((entry: AgentBrokerLogEntry) => void) | undefined,
  entry: AgentBrokerLogEntry
): void {
  try {
    logger?.(entry);
  } catch {
    // Logging must never change the Broker response or expose private process data.
  }
}

async function socketIsActive(socketPath: string): Promise<boolean> {
  return await new Promise((resolveSocket) => {
    const client = net.createConnection({ path: socketPath });
    const settle = (active: boolean) => {
      client.destroy();
      resolveSocket(active);
    };
    client.setTimeout(500, () => settle(true));
    client.once("connect", () => settle(true));
    client.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code !== "ECONNREFUSED" && error.code !== "ENOENT");
    });
  });
}

function processUid(): bigint {
  if (typeof process.getuid !== "function") {
    throw new Error("RuntimeDirectory UID validation is unavailable");
  }
  return BigInt(process.getuid());
}

async function validateRuntimeDirectory(runtimeDirectory: string): Promise<void> {
  const runtime = await lstat(runtimeDirectory, { bigint: true });
  if (!runtime.isDirectory() || runtime.isSymbolicLink()) {
    throw new Error("RuntimeDirectory must be a real directory");
  }
  if (runtime.uid !== processUid()) {
    throw new Error("RuntimeDirectory owner UID does not match Broker UID");
  }
  if ((runtime.mode & 0o777n) !== RUNTIME_DIRECTORY_MODE) {
    throw new Error("RuntimeDirectory mode must be 0700");
  }
}

function validateSocketMetadata(
  socket: Awaited<ReturnType<typeof lstat>>,
  label: string
): void {
  if (!socket.isSocket()) throw new Error(`${label} is not an owned socket`);
  if (BigInt(socket.uid) !== processUid()) {
    throw new Error(`${label} owner UID does not match Broker UID`);
  }
  if ((BigInt(socket.mode) & 0o777n) !== SOCKET_MODE) {
    throw new Error(`${label} mode must be 0660`);
  }
}

async function prepareSocketPath(
  runtimeDirectory: string,
  socketPath: string
): Promise<void> {
  if (!resolve(socketPath).startsWith(`${resolve(runtimeDirectory)}/`)) {
    throw new Error("socket path must be inside RuntimeDirectory");
  }
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await validateRuntimeDirectory(runtimeDirectory);
  const [runtimeRealPath, parentRealPath] = await Promise.all([
    realpath(runtimeDirectory),
    realpath(dirname(socketPath))
  ]);
  if (runtimeRealPath !== parentRealPath) {
    throw new Error("socket path must be directly owned by RuntimeDirectory");
  }

  try {
    const existing = await lstat(socketPath, { bigint: true });
    validateSocketMetadata(existing, "socket path");
    if (await socketIsActive(socketPath)) {
      throw new Error("socket path is already active");
    }
    const current = await lstat(socketPath, { bigint: true });
    validateSocketMetadata(current, "socket path");
    if (
      current.dev !== existing.dev ||
      current.ino !== existing.ino
    ) {
      throw new Error("socket path ownership changed during stale cleanup");
    }
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function preserveForeignReplacement(
  runtimeDirectory: string,
  socketPath: string,
  ownedSocket: OwnedSocket | undefined
): Promise<PreservedReplacement | undefined> {
  if (!ownedSocket) return undefined;
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(socketPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    current.isSocket() &&
    current.dev === ownedSocket.dev &&
    current.ino === ownedSocket.ino
  ) {
    return undefined;
  }

  const directory = await mkdtemp(
    join(runtimeDirectory, `.${basename(socketPath)}.preserved-`)
  );
  const preservedPath = join(directory, "replacement");
  try {
    await rename(socketPath, preservedPath);
    const preserved = await lstat(preservedPath, { bigint: true });
    if (preserved.dev !== current.dev || preserved.ino !== current.ino) {
      throw new Error("socket replacement changed during close protection");
    }
    return { directory, path: preservedPath };
  } catch (error) {
    try {
      await link(preservedPath, socketPath);
      await unlink(preservedPath);
    } catch {
      // Keep the replacement in its private preservation directory.
    }
    try {
      await rmdir(directory);
    } catch {
      // A non-empty directory is retained rather than deleting foreign data.
    }
    throw error;
  }
}

async function restoreForeignReplacement(
  socketPath: string,
  preserved: PreservedReplacement | undefined
): Promise<void> {
  if (!preserved) return;
  await link(preserved.path, socketPath);
  await unlink(preserved.path);
  await rmdir(preserved.directory);
}

async function defaultServiceProbe(
  serviceName: string,
  runtimeDirectory: string
): Promise<boolean> {
  const allowedEnvironment: Array<readonly [string, string]> = [];
  for (const key of ["HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const) {
    const value = process.env[key];
    if (value !== undefined) allowedEnvironment.push([key, value]);
  }
  try {
    const result = await runControlledProcess({
      executable: "/usr/bin/systemctl",
      args: ["--user", "is-active", "--quiet", serviceName],
      cwd: runtimeDirectory,
      allowedEnvironment,
      timeoutMs: 2_000,
      terminationGraceMs: 100,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxConcurrency: 2
    });
    return result.exitCode === 0 && !result.timedOut && !result.aborted;
  } catch {
    return false;
  }
}

export function createAgentBroker(options: AgentBrokerOptions): AgentBroker {
  const clock = options.clock ?? (() => new Date());
  const connector = new HermesStdinConnector({
    executable: options.executable,
    prefixArgs: options.prefixArgs ?? [],
    processCwd: options.processCwd ?? ((target) => target.home),
    clock,
    maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
    maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    maxConcurrency: options.maxConcurrency ?? 2,
    terminationGraceMs:
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS
  });
  const runtimeProbe =
    options.runtimeProbe ??
    ((target: AgentTarget, executable: string) =>
      probeAgentTarget(target, executable, (serviceName) =>
        defaultServiceProbe(serviceName, options.runtimeDirectory)
      ));

  const statuses = async (): Promise<Map<string, AgentAvailability>> => {
    const results = await Promise.all(
      AGENT_TARGETS.map(async (target) => [
        target.agentRef,
        (await runtimeProbe(target, options.executable))
          ? "available"
          : "unavailable"
      ] as const)
    );
    return new Map(results);
  };

  const activeInvocations = new Set<AbortController>();
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/v1/health") {
        const descriptors = agentDescriptors(await statuses(), clock());
        const healthy = descriptors.every(
          (descriptor) => descriptor.status === "available"
        );
        sendJson(response, healthy ? 200 : 503, {
          status: healthy ? "ok" : "degraded",
          agents: descriptors
        });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/agents") {
        sendJson(response, 200, {
          agents: agentDescriptors(await statuses(), clock())
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/invocations") {
        let candidate: unknown;
        try {
          candidate = await readJson(request);
        } catch {
          safeLog(options.logger, {
            event: "request_rejected",
            code: "INVALID_REQUEST"
          });
          sendJson(
            response,
            400,
            publicRequestError("INVALID_REQUEST", "请求格式无效。")
          );
          return;
        }
        const parsed = agentInvocationRequestV1Schema.safeParse(candidate);
        if (!parsed.success) {
          safeLog(options.logger, {
            event: "request_rejected",
            code: "INVALID_REQUEST"
          });
          sendJson(
            response,
            400,
            publicRequestError("INVALID_REQUEST", "请求格式无效。")
          );
          return;
        }
        const { externalSessionRef, ...requiredInvocation } = parsed.data;
        const invocation: AgentInvocationRequestV1 =
          externalSessionRef === undefined
            ? requiredInvocation
            : { ...requiredInvocation, externalSessionRef };
        const target = resolveAgentTarget(invocation.agentRef);
        if (!target) {
          safeLog(options.logger, {
            event: "request_rejected",
            agentRef: invocation.agentRef,
            code: "AGENT_NOT_FOUND"
          });
          sendJson(
            response,
            404,
            publicRequestError("AGENT_NOT_FOUND", "未找到指定个人助理。")
          );
          return;
        }
        if (
          invocation.externalSessionRef &&
          !rawSessionId(target, invocation.externalSessionRef)
        ) {
          safeLog(options.logger, {
            event: "request_rejected",
            agentRef: target.agentRef,
            code: "SESSION_SCOPE_MISMATCH"
          });
          sendJson(
            response,
            409,
            publicRequestError(
              "SESSION_SCOPE_MISMATCH",
              "个人助理会话范围不匹配。",
              "conflict"
            )
          );
          return;
        }

        const invocationAbort = new AbortController();
        activeInvocations.add(invocationAbort);
        const abortInvocation = () => invocationAbort.abort();
        const abortDisconnectedResponse = () => {
          if (!response.writableEnded) abortInvocation();
        };
        request.once("aborted", abortInvocation);
        response.once("close", abortDisconnectedResponse);
        try {
          const result = await connector.invoke(
            target,
            invocation,
            invocationAbort.signal
          );
          safeLog(options.logger, {
            event: "invocation_completed",
            agentRef: target.agentRef,
            status: result.status
          });
          if (!response.destroyed) sendJson(response, 200, result);
        } finally {
          activeInvocations.delete(invocationAbort);
          request.off("aborted", abortInvocation);
          response.off("close", abortDisconnectedResponse);
        }
        return;
      }

      sendJson(response, 404, publicRequestError("NOT_FOUND", "接口不存在。"));
    } catch {
      if (!response.destroyed) {
        sendJson(
          response,
          500,
          publicRequestError(
            "BROKER_INTERNAL",
            "本机个人助理服务暂时不可用。",
            "internal",
            true
          )
        );
      }
    }
  });

  let ownedSocket: OwnedSocket | undefined;
  let started = false;
  let closing: Promise<void> | undefined;

  return {
    server,
    async start(): Promise<void> {
      if (started) return;
      await prepareSocketPath(options.runtimeDirectory, options.socketPath);
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          rejectListen(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolveListen();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ path: options.socketPath });
      });
      await chmod(options.socketPath, 0o660);
      const socket = await lstat(options.socketPath, { bigint: true });
      try {
        validateSocketMetadata(socket, "socket path");
      } catch (error) {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        throw error;
      }
      ownedSocket = { dev: socket.dev, ino: socket.ino };
      started = true;
      safeLog(options.logger, { event: "broker_started" });
    },
    async close(): Promise<void> {
      if (closing) return closing;
      if (!started) return;
      for (const invocation of activeInvocations) invocation.abort();
      closing = (async () => {
        const preserved = await preserveForeignReplacement(
          options.runtimeDirectory,
          options.socketPath,
          ownedSocket
        );
        try {
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) rejectClose(error);
              else resolveClose();
            });
            server.closeAllConnections();
          });
          started = false;
          if (!preserved && ownedSocket) {
            try {
              const socket = await lstat(options.socketPath, { bigint: true });
              if (
                socket.isSocket() &&
                socket.dev === ownedSocket.dev &&
                socket.ino === ownedSocket.ino
              ) {
                await unlink(options.socketPath);
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        } finally {
          await restoreForeignReplacement(options.socketPath, preserved);
        }
        ownedSocket = undefined;
        safeLog(options.logger, { event: "broker_stopped" });
      })();
      try {
        await closing;
      } finally {
        closing = undefined;
      }
    }
  };
}
