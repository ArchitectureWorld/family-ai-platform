import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WEB_ENTRY_PROTOCOL_VERSION,
  WEB_ENTRY_REVOKED_SSE_EVENT_NAME,
  webEntryContextResponseSchema,
  webEntryOperationResponseSchema,
  webEntryRevokedSseDataSchema,
  webGatewayErrorSchema,
  webPairingClaimRequestSchema
} from "../src/index.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(
    fileURLToPath(new URL(`../fixtures/web-entry/${name}`, import.meta.url)),
    "utf8"
  ));
}

describe("Web Entry v2 contracts", () => {
  it("accepts canonical public fixtures", () => {
    expect(WEB_ENTRY_PROTOCOL_VERSION).toBe(2);
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
      { entrySessionRef: "entry-session:other" },
      { entrySessionToken: "B".repeat(43) },
      { assignmentRef: "assignment:other" }
    ]) {
      expect(webPairingClaimRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });

  it("requires a canonical client-generated device credential", () => {
    const request = fixture("claim-request.json") as Record<string, unknown>;
    expect(request).toMatchObject({
      protocolVersion: 2,
      deviceCredential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    });
    expect(webPairingClaimRequestSchema.parse(request)).toMatchObject({
      protocolVersion: 2,
      deviceCredential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    });
    expect(webPairingClaimRequestSchema.safeParse({
      ...request,
      protocolVersion: 1
    }).success).toBe(false);
    expect(webPairingClaimRequestSchema.safeParse({
      ...request,
      deviceCredential: "short"
    }).success).toBe(false);
    expect(webPairingClaimRequestSchema.safeParse({
      ...request,
      deviceCredential: "A".repeat(42) + "B"
    }).success).toBe(false);
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
    expect(context).toMatchObject({
      protocolVersion: 2,
      context: { protocolVersion: 1 }
    });
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

  it("defines the credential-free revoke control and v2 error envelope", () => {
    expect(WEB_ENTRY_REVOKED_SSE_EVENT_NAME).toBe("entry-revoked");
    expect(webEntryRevokedSseDataSchema.parse({
      protocolVersion: 2,
      type: "device_revoked"
    })).toEqual({ protocolVersion: 2, type: "device_revoked" });
    expect(webGatewayErrorSchema.parse(fixture("error-response.json")))
      .toEqual(fixture("error-response.json"));
  });

});
