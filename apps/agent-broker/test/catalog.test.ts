import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_TARGETS,
  agentDescriptors,
  probeAgentTarget,
  resolveAgentTarget,
  type AgentTarget
} from "../src/catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true })
    )
  );
});

describe("fixed Hermes Agent catalog", () => {
  it("maps the three public AgentRefs to their exact fixed Home, Profile, and display name", () => {
    expect(
      AGENT_TARGETS.map(({ agentRef, home, profile, displayName }) => [
        agentRef,
        home,
        profile,
        displayName
      ])
    ).toEqual([
      ["agent:hermes-jarvis", join("/home", "youran", ".hermes"), "default", "Jarvis"],
      [
        "agent:hermes-zzh",
        join("/home", "youran", "hermes-personal-assistants"),
        "zzh",
        "于途"
      ],
      [
        "agent:hermes-nsy",
        join("/home", "youran", "hermes-personal-assistants"),
        "nsy",
        "乔晶晶"
      ]
    ]);
    expect(resolveAgentTarget("agent:unknown")).toBeUndefined();
  });

  it("publishes only Task 1 Agent descriptors and never exposes host runtime paths", () => {
    const descriptors = agentDescriptors(
      new Map([
        ["agent:hermes-jarvis", "available"],
        ["agent:hermes-zzh", "unavailable"],
        ["agent:hermes-nsy", "available"]
      ]),
      new Date("2026-08-28T12:00:00.000Z")
    );

    expect(descriptors).toEqual([
      {
        protocolVersion: 1,
        agentRef: "agent:hermes-jarvis",
        displayName: "Jarvis",
        kind: "agent",
        runtime: "hermes-local",
        status: "available",
        capabilities: ["chat"],
        system: true,
        observedAt: "2026-08-28T12:00:00.000Z"
      },
      {
        protocolVersion: 1,
        agentRef: "agent:hermes-zzh",
        displayName: "于途",
        kind: "agent",
        runtime: "hermes-local",
        status: "unavailable",
        capabilities: ["chat"],
        system: false,
        observedAt: "2026-08-28T12:00:00.000Z"
      },
      {
        protocolVersion: 1,
        agentRef: "agent:hermes-nsy",
        displayName: "乔晶晶",
        kind: "agent",
        runtime: "hermes-local",
        status: "available",
        capabilities: ["chat"],
        system: false,
        observedAt: "2026-08-28T12:00:00.000Z"
      }
    ]);
    expect(JSON.stringify(descriptors)).not.toMatch(
      /\/home\/youran|profile|executable|systemd/i
    );
  });

  it("requires an executable, fixed Home directory, Profile config, and active owner service", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-broker-health-"));
    temporaryDirectories.push(root);
    const executable = join(root, "fake-hermes");
    const home = join(root, "home");
    const profileDirectory = join(home, "profiles", "zzh");
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    await writeFile(join(profileDirectory, "config.yaml"), "schema: 33\n", "utf8");
    const target: AgentTarget = {
      agentRef: "agent:hermes-zzh",
      home,
      profile: "zzh",
      displayName: "于途",
      serviceName: "hermes-personal-assistants.service",
      system: false,
      sessionScope: "zzh"
    };

    await expect(
      probeAgentTarget(target, executable, async () => true)
    ).resolves.toBe(true);
    await expect(
      probeAgentTarget(target, join(root, "missing"), async () => true)
    ).resolves.toBe(false);
    await expect(
      probeAgentTarget(target, executable, async () => false)
    ).resolves.toBe(false);
    await rm(join(profileDirectory, "config.yaml"));
    await expect(
      probeAgentTarget(target, executable, async () => true)
    ).resolves.toBe(false);
  });
});
