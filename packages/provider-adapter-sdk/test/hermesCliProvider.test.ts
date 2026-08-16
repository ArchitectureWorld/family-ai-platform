import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HermesCliProviderAdapter,
  type HermesCliProviderOptions
} from "../src/hermesCliProvider.js";

const request = {
  protocolVersion: "1.0" as const,
  invocationRef: "invocation:018f47a2-1f10-7a3d-8c2d-61f369284f21",
  correlationRef: "correlation:018f47a2-1f10-7a3d-8c2d-61f369284f22",
  idempotencyKey: "device:test:message:0001",
  requestedAt: "2026-07-21T09:00:00.000Z",
  providerProfileRef: "provider-profile:hermes-local",
  targetAgentRef: "agent:personal-assistant",
  conversationRef: "conversation:018f47a2-1f10-7a3d-8c2d-61f369284f23",
  content: [{ type: "text" as const, text: "PRIVATE_PROMPT_MUST_NOT_SPAWN" }],
  timeoutMs: 2_000,
  attachments: [{
    attachmentRef: "attachment:provider-file-001",
    fileName: "预算\"\n--resume malicious.pdf",
    mediaType: "application/pdf",
    sizeBytes: 123,
    sha256: "a".repeat(64),
    localPath: "/verified/root/aa/safe-file.blob"
  }]
};

let cwd: string;
let script: string;

function options(
  overrides: Partial<HermesCliProviderOptions> = {}
): HermesCliProviderOptions {
  return {
    executable: process.execPath,
    prefixArgs: [script],
    cwd,
    providerProfileRef: "provider-profile:hermes-local",
    clock: () => new Date("2026-07-21T09:00:01.000Z"),
    ...overrides
  };
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-cli-provider-"));
  script = join(cwd, "fake-hermes.mjs");
  await writeFile(
    script,
    `import { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(
      join(cwd, "hermes-spawned")
    )}, "spawned");`,
    "utf8"
  );
});

afterEach(async () => {
  await rm(cwd, { force: true, recursive: true });
});

describe("HermesCliProviderAdapter", () => {
  it.each([
    ["default", undefined],
    ["disabled", "disabled"],
    ["reserved query-stdin-v1", "query-stdin-v1"]
  ] as const)("keeps %s private input mode offline with zero spawn", async (_label, mode) => {
    const adapter = new HermesCliProviderAdapter(options(
      mode === undefined ? {} : { privateInputMode: mode }
    ));

    expect(await adapter.health()).toMatchObject({
      status: "offline",
      providerProfiles: ["provider-profile:hermes-local"]
    });
    const result = await adapter.invoke(request);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_UNAVAILABLE", category: "availability" }
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_PROMPT_MUST_NOT_SPAWN|safe-file|预算|resume malicious/u
    );
    expect(existsSync(join(cwd, "hermes-spawned"))).toBe(false);
  });
});
