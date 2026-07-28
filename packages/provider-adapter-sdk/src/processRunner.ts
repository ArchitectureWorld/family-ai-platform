import { spawn } from "node:child_process";

export type ControlledProcessErrorCode =
  | "INVALID_OPTIONS"
  | "SPAWN_FAILED"
  | "STDOUT_LIMIT_EXCEEDED"
  | "STDERR_LIMIT_EXCEEDED";

export class ControlledProcessError extends Error {
  readonly code: ControlledProcessErrorCode;

  constructor(code: ControlledProcessErrorCode) {
    super("受控进程执行失败。");
    this.name = "ControlledProcessError";
    this.code = code;
  }
}

export interface ControlledProcessOptions {
  executable: string;
  prefixArgs?: readonly string[];
  args: readonly string[];
  cwd: string;
  allowedEnvironment: ReadonlyArray<readonly [string, string]>;
  stdin?: string;
  abortSignal?: AbortSignal;
  timeoutMs: number;
  terminationGraceMs?: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxStdinBytes?: number;
  maxConcurrency?: number;
}

export interface ControlledProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

interface QueueEntry {
  limit: number;
  signal: AbortSignal | undefined;
  resolve: (acquired: boolean) => void;
  abortListener?: () => void;
}

const MAX_CONFIGURED_CONCURRENCY = 16;
const MAX_CONFIGURED_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDIN_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 250;
let activeProcesses = 0;
const processQueue: QueueEntry[] = [];

function isPositiveBoundedInteger(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= maximum;
}

function containsNul(value: string): boolean {
  return value.includes("\u0000");
}

function validateOptions(options: ControlledProcessOptions): void {
  const prefixArgs = options.prefixArgs ?? [];
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const maxStdinBytes = options.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES;
  const maxConcurrency = options.maxConcurrency ?? 4;
  if (
    options.executable.trim().length === 0 ||
    options.cwd.trim().length === 0 ||
    containsNul(options.executable) ||
    containsNul(options.cwd) ||
    [...prefixArgs, ...options.args].some(containsNul) ||
    (options.stdin !== undefined && containsNul(options.stdin)) ||
    !isPositiveBoundedInteger(options.timeoutMs, 300_000) ||
    !Number.isInteger(terminationGraceMs) ||
    terminationGraceMs < 0 ||
    terminationGraceMs > 5_000 ||
    !isPositiveBoundedInteger(options.maxStdoutBytes, MAX_CONFIGURED_OUTPUT_BYTES) ||
    !isPositiveBoundedInteger(options.maxStderrBytes, MAX_CONFIGURED_OUTPUT_BYTES) ||
    !isPositiveBoundedInteger(maxStdinBytes, MAX_CONFIGURED_OUTPUT_BYTES) ||
    !isPositiveBoundedInteger(maxConcurrency, MAX_CONFIGURED_CONCURRENCY)
  ) {
    throw new ControlledProcessError("INVALID_OPTIONS");
  }
  if (
    options.stdin !== undefined &&
    Buffer.byteLength(options.stdin, "utf8") > maxStdinBytes
  ) {
    throw new ControlledProcessError("INVALID_OPTIONS");
  }

  const environmentKeys = new Set<string>();
  for (const [key, value] of options.allowedEnvironment) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      containsNul(key) ||
      containsNul(value) ||
      environmentKeys.has(key)
    ) {
      throw new ControlledProcessError("INVALID_OPTIONS");
    }
    environmentKeys.add(key);
  }
}

function dispatchQueue(): void {
  for (let index = 0; index < processQueue.length; index += 1) {
    const entry = processQueue[index];
    if (!entry || activeProcesses >= entry.limit) continue;
    processQueue.splice(index, 1);
    index -= 1;
    if (entry.abortListener) {
      entry.signal?.removeEventListener("abort", entry.abortListener);
    }
    if (entry.signal?.aborted) {
      entry.resolve(false);
      continue;
    }
    activeProcesses += 1;
    entry.resolve(true);
  }
}

function acquireProcessSlot(limit: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (activeProcesses < limit) {
    activeProcesses += 1;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const entry: QueueEntry = { limit, signal, resolve };
    if (signal) {
      entry.abortListener = () => {
        const index = processQueue.indexOf(entry);
        if (index >= 0) processQueue.splice(index, 1);
        resolve(false);
      };
      signal.addEventListener("abort", entry.abortListener, { once: true });
    }
    processQueue.push(entry);
  });
}

function releaseProcessSlot(): void {
  activeProcesses = Math.max(0, activeProcesses - 1);
  dispatchQueue();
}

function signalProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch {
    // The bounded cleanup path is idempotent when the process already exited.
  }
}

export async function runControlledProcess(
  options: ControlledProcessOptions
): Promise<ControlledProcessResult> {
  validateOptions(options);
  const maxConcurrency = options.maxConcurrency ?? 4;
  const acquired = await acquireProcessSlot(maxConcurrency, options.abortSignal);
  if (!acquired) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: true
    };
  }

  try {
    return await new Promise<ControlledProcessResult>((resolve, reject) => {
      const prefixArgs = options.prefixArgs ?? [];
      const terminationGraceMs =
        options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let aborted = false;
      let limitError: ControlledProcessError | undefined;
      let settled = false;
      let terminationPromise: Promise<void> | undefined;

      const child = spawn(options.executable, [...prefixArgs, ...options.args], {
        cwd: options.cwd,
        env: Object.fromEntries(options.allowedEnvironment),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });

      const terminate = (): Promise<void> => {
        if (terminationPromise) return terminationPromise;
        signalProcessGroup(child, "SIGTERM");
        terminationPromise = new Promise((done) => {
          setTimeout(() => {
            signalProcessGroup(child, "SIGKILL");
            done();
          }, terminationGraceMs);
        });
        return terminationPromise;
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        void terminate();
      }, options.timeoutMs);

      const abortListener = () => {
        aborted = true;
        void terminate();
      };
      options.abortSignal?.addEventListener("abort", abortListener, { once: true });

      const settle = async (exitCode: number | null): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.abortSignal?.removeEventListener("abort", abortListener);
        if (terminationPromise) await terminationPromise;
        if (limitError) {
          reject(limitError);
          return;
        }
        resolve({
          exitCode: timedOut || aborted ? null : exitCode,
          stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
          stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
          timedOut,
          aborted
        });
      };

      child.once("error", () => {
        clearTimeout(timeout);
        options.abortSignal?.removeEventListener("abort", abortListener);
        if (!settled) {
          settled = true;
          reject(new ControlledProcessError("SPAWN_FAILED"));
        }
      });
      child.once("close", (exitCode) => {
        void settle(exitCode);
      });

      child.stdout.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stdoutBytes + buffer.byteLength > options.maxStdoutBytes) {
          limitError ??= new ControlledProcessError("STDOUT_LIMIT_EXCEEDED");
          void terminate();
          return;
        }
        stdoutBytes += buffer.byteLength;
        stdoutChunks.push(buffer);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stderrBytes + buffer.byteLength > options.maxStderrBytes) {
          limitError ??= new ControlledProcessError("STDERR_LIMIT_EXCEEDED");
          void terminate();
          return;
        }
        stderrBytes += buffer.byteLength;
        stderrChunks.push(buffer);
      });

      child.stdin.on("error", () => {
        // EPIPE is expected when a child exits before consuming all input.
      });
      child.stdin.end(options.stdin ?? "");
    });
  } finally {
    releaseProcessSlot();
  }
}
