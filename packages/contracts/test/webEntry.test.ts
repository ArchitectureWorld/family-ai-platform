import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WEB_ENTRY_PROTOCOL_VERSION,
  webEntryContextResponseSchema,
  webEntryOperationResponseSchema,
  webPairingClaimRequestSchema
} from "../src/index.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(
    fileURLToPath(new URL(`../fixtures/web-entry/${name}`, import.meta.url)),
    "utf8"
  ));
}

describe("Web Entry v1 contracts", () => {
  it("accepts canonical public fixtures", () => {
    expect(WEB_ENTRY_PROTOCOL_VERSION).toBe(1);
    expect(webPairingClaimRequestSchema.parse(fixture("claim-request.json")))
      .toEqual(fixture("claim-request.json"));
    expect(webEntryContextResponseSchema.parse(fixture("context-response.json")))
      .toEqual(fixture("context-response.json"));
    expect(webEntryOperationResponseSchema.parse(fixture("operation-response.json")))
      .toEqual(fixture("operation-response.json"));
  });

  it("rejects client-declared identity and secret fields", () => {
    const request = fixture("claim-request.json") as Record<string, unknown>;
    for (const extra of [
      { personRef: "person:other" },
      { familyRef: "family:other" },
      { deviceRef: "device:other" },
      { deviceCredential: "A".repeat(43) },
      { entrySessionRef: "entry-session:other" },
      { entrySessionToken: "B".repeat(43) },
      { assignmentRef: "assignment:other" }
    ]) {
      expect(webPairingClaimRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });

  it("requires a UUID installation and strict browser descriptor", () => {
    const request = fixture("claim-request.json") as {
      installationId: string;
      device: Record<string, unknown>;
    };
    expect(webPairingClaimRequestSchema.safeParse({
      ...request,
      installationId: "not-a-uuid"
    }).success).toBe(false);
    expect(webPairingClaimRequestSchema.safeParse({
      ...request,
      device: { ...request.device, terminalType: "web" }
    }).success).toBe(false);
    expect(webPairingClaimRequestSchema.safeParse({
      ...request,
      device: { ...request.device, browser: "" }
    }).success).toBe(false);
  });

  it("keeps public responses credential-free and strict", () => {
    const context = fixture("context-response.json") as Record<string, unknown>;
    expect(webEntryContextResponseSchema.safeParse({
      ...context,
      deviceCredential: "A".repeat(43)
    }).success).toBe(false);
    expect(webEntryContextResponseSchema.safeParse({
      ...context,
      entrySessionToken: "B".repeat(43)
    }).success).toBe(false);

    const serialized = JSON.stringify(context).toLowerCase();
    for (const forbidden of [
      "devicecredential",
      "entrysessiontoken",
      "authorization",
      "bearer "
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
