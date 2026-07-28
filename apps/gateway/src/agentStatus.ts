import type { ProviderAdapterResolver } from "@family-ai/provider-adapter-sdk";
import { ChatWorkProviderRepository } from "./chatWorkProvider.js";
import type { GatewayDatabase } from "./database.js";

type RuntimeStatus = "active" | "disabled" | "missing";
type HealthStatus = "online" | "degraded" | "offline";

export interface AgentStatusInput {
  runtime: RuntimeStatus;
  health: HealthStatus;
  pending: number;
  stalePending: number;
  latestFailedAt: string | null;
  latestSucceededAt: string | null;
  checkedAt: string;
  privateError?: unknown;
}

export interface AgentStatusSnapshot {
  status: "idle" | "working" | "problem";
  statusLabel: "空闲" | "工作中" | "有问题";
  activeTurnCount: number;
  lastCheckedAt: string;
  publicProblem: string | null;
}

const PUBLIC_PROBLEMS = {
  runtime_missing: "Agent 尚未配置。",
  health_failed: "Agent 当前无法连接。",
  turn_stalled: "Agent 任务执行超时。",
  invocation_failed: "Agent 最近一次调用失败。"
} as const;

function failedAfterSuccess(input: AgentStatusInput): boolean {
  return input.latestFailedAt !== null &&
    (
      input.latestSucceededAt === null ||
      Date.parse(input.latestFailedAt) > Date.parse(input.latestSucceededAt)
    );
}

export function statusFor(input: AgentStatusInput): AgentStatusSnapshot {
  let problem: keyof typeof PUBLIC_PROBLEMS | null = null;
  if (input.runtime !== "active") problem = "runtime_missing";
  else if (input.health !== "online") problem = "health_failed";
  else if (input.stalePending > 0) problem = "turn_stalled";
  else if (failedAfterSuccess(input)) problem = "invocation_failed";

  if (problem !== null) {
    return {
      status: "problem",
      statusLabel: "有问题",
      activeTurnCount: input.pending,
      lastCheckedAt: input.checkedAt,
      publicProblem: PUBLIC_PROBLEMS[problem]
    };
  }
  if (input.pending > 0) {
    return {
      status: "working",
      statusLabel: "工作中",
      activeTurnCount: input.pending,
      lastCheckedAt: input.checkedAt,
      publicProblem: null
    };
  }
  return {
    status: "idle",
    statusLabel: "空闲",
    activeTurnCount: 0,
    lastCheckedAt: input.checkedAt,
    publicProblem: null
  };
}

interface CachedHealth {
  status: HealthStatus;
  cachedAtMs: number;
}

export interface AgentStatusServiceOptions {
  now?: () => Date;
  healthCacheMs?: number;
  timeoutMs?: number;
  graceMs?: number;
}

export class AgentStatusService {
  private readonly now: () => Date;
  private readonly healthCacheMs: number;
  private readonly timeoutMs: number;
  private readonly graceMs: number;
  private readonly healthCache = new Map<string, CachedHealth>();
  private readonly turns: ChatWorkProviderRepository;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly providers: ProviderAdapterResolver,
    options: AgentStatusServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.healthCacheMs = options.healthCacheMs ?? 5000;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.graceMs = options.graceMs ?? 5000;
    this.turns = new ChatWorkProviderRepository(db, this.now);
  }

  async snapshot(agentRef: string): Promise<AgentStatusSnapshot> {
    const checkedAt = this.now();
    const runtime = this.db.prepare(
      `SELECT provider_profile_ref, status
       FROM agent_runtime_bindings
       WHERE agent_ref = ?`
    ).get(agentRef) as
      | { provider_profile_ref: string; status: "active" | "disabled" }
      | undefined;
    const turns = this.turns.statusFacts(
      agentRef,
      new Date(
        checkedAt.getTime() - this.timeoutMs - this.graceMs
      ).toISOString()
    );

    return statusFor({
      runtime: runtime?.status ?? "missing",
      health: runtime?.status === "active"
        ? await this.healthFor(runtime.provider_profile_ref, checkedAt.getTime())
        : "offline",
      pending: turns.pending,
      stalePending: turns.stalePending,
      latestFailedAt: turns.latestFailedAt,
      latestSucceededAt: turns.latestSucceededAt,
      checkedAt: checkedAt.toISOString()
    });
  }

  async allSnapshots(): Promise<ReadonlyMap<string, AgentStatusSnapshot>> {
    const rows = this.db.prepare(
      "SELECT agent_ref FROM agents ORDER BY agent_ref"
    ).all() as Array<{ agent_ref: string }>;
    const snapshots = await Promise.all(rows.map(async (row) => [
      String(row.agent_ref),
      await this.snapshot(String(row.agent_ref))
    ] as const));
    return new Map(snapshots);
  }

  private async healthFor(
    providerProfileRef: string,
    checkedAtMs: number
  ): Promise<HealthStatus> {
    const cached = this.healthCache.get(providerProfileRef);
    if (
      cached !== undefined &&
      checkedAtMs - cached.cachedAtMs < this.healthCacheMs
    ) {
      return cached.status;
    }

    let status: HealthStatus = "offline";
    try {
      const health = await this.providers.resolve(providerProfileRef).health();
      if (health.providerProfiles.includes(providerProfileRef)) {
        status = health.status;
      }
    } catch {
      status = "offline";
    }
    this.healthCache.set(providerProfileRef, { status, cachedAtMs: checkedAtMs });
    return status;
  }
}
