import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  agentDescriptorV1Schema,
  type AgentDescriptorV1
} from "@family-ai/contracts/federation";

export interface AgentTarget {
  readonly agentRef: string;
  readonly home: string;
  readonly profile: string;
  readonly displayName: string;
  readonly serviceName: string;
  readonly system: boolean;
  readonly sessionScope: string;
}

const YOURAN_HOME = join("/home", "youran");

export const AGENT_TARGETS = [
  {
    agentRef: "agent:hermes-jarvis",
    home: join(YOURAN_HOME, ".hermes"),
    profile: "default",
    displayName: "Jarvis",
    serviceName: "hermes-gateway.service",
    system: true,
    sessionScope: "jarvis"
  },
  {
    agentRef: "agent:hermes-zzh",
    home: join(YOURAN_HOME, "hermes-personal-assistants"),
    profile: "zzh",
    displayName: "于途",
    serviceName: "hermes-personal-assistants.service",
    system: false,
    sessionScope: "zzh"
  },
  {
    agentRef: "agent:hermes-nsy",
    home: join(YOURAN_HOME, "hermes-personal-assistants"),
    profile: "nsy",
    displayName: "乔晶晶",
    serviceName: "hermes-personal-assistants.service",
    system: false,
    sessionScope: "nsy"
  }
] as const satisfies readonly AgentTarget[];

export type AgentAvailability = AgentDescriptorV1["status"];
export type ServiceStateProbe = (serviceName: string) => Promise<boolean>;

export function resolveAgentTarget(agentRef: string): AgentTarget | undefined {
  return AGENT_TARGETS.find((target) => target.agentRef === agentRef);
}

export function agentDescriptors(
  statuses: ReadonlyMap<string, AgentAvailability>,
  observedAt: Date
): AgentDescriptorV1[] {
  return AGENT_TARGETS.map((target) =>
    agentDescriptorV1Schema.parse({
      protocolVersion: 1,
      agentRef: target.agentRef,
      displayName: target.displayName,
      kind: "agent",
      runtime: "hermes-local",
      status: statuses.get(target.agentRef) ?? "unavailable",
      capabilities: ["chat"],
      system: target.system,
      observedAt: observedAt.toISOString()
    })
  );
}

function profileConfigPath(target: AgentTarget): string {
  return target.profile === "default"
    ? join(target.home, "config.yaml")
    : join(target.home, "profiles", target.profile, "config.yaml");
}

export async function probeAgentTarget(
  target: AgentTarget,
  executable: string,
  serviceIsActive: ServiceStateProbe
): Promise<boolean> {
  try {
    const home = await stat(target.home);
    if (!home.isDirectory()) return false;
    await access(executable, constants.X_OK);
    await access(profileConfigPath(target), constants.R_OK);
    return await serviceIsActive(target.serviceName);
  } catch {
    return false;
  }
}
