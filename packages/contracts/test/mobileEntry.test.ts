import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deviceCredentialSchema,
  mobileGatewayErrorSchema,
  pairingClaimRequestSchema,
  pairingClaimResponseSchema,
  pairingPreviewRequestSchema,
  pairingPreviewResponseSchema,
  pairingQrPayloadSchema,
  personalPortalContextSchema,
  sessionRenewResponseSchema
} from "../src/index.js";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/mobile-entry/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("mobile entry protocol v1", () => {
  it("accepts canonical success fixtures", () => {
    pairingPreviewRequestSchema.parse(fixture("pairing-preview-request.json"));
    pairingPreviewResponseSchema.parse(fixture("pairing-preview-success.json"));
    pairingClaimRequestSchema.parse(fixture("pairing-claim-request.json"));
    pairingClaimResponseSchema.parse(fixture("pairing-claim-success.json"));
    sessionRenewResponseSchema.parse(fixture("session-renew-success.json"));
    personalPortalContextSchema.parse(fixture("portal-context-personal.json"));
  });

  it("accepts canonical public error fixtures", () => {
    mobileGatewayErrorSchema.parse(fixture("pairing-expired-error.json"));
    mobileGatewayErrorSchema.parse(fixture("device-revoked-error.json"));
    mobileGatewayErrorSchema.parse(fixture("session-expired-error.json"));
  });

  it.each([
    "http://family-ai-gateway.example.ts.net",
    "https://user:password@family-ai-gateway.example.ts.net",
    "https://family-ai-gateway.example.ts.net?token=test",
    "https://family-ai-gateway.example.ts.net/#secret",
    "https://family-ai-gateway.example.ts.net/api"
  ])("rejects an unsafe Gateway URL: %s", (gateway) => {
    const candidate = {
      version: 1,
      gateway,
      pairingRef: "pairing:test-mobile-1",
      code: "ABCD-EFGH",
      expiresAt: "2026-07-22T12:05:00.000Z"
    };
    expect(pairingQrPayloadSchema.safeParse(candidate).success).toBe(false);
  });

  it.each(["ABO0-EFGH", "ABCI-EFG1", "abcd-efgh", "ABCDE-FGHI"])(
    "rejects an ambiguous or malformed pairing code: %s",
    (code) => {
      const request = fixture("pairing-preview-request.json") as Record<string, unknown>;
      expect(pairingPreviewRequestSchema.safeParse({ ...request, code }).success).toBe(false);
    }
  );

  it("rejects an unsupported protocol version and unknown fields", () => {
    const request = fixture("pairing-preview-request.json") as Record<string, unknown>;
    expect(pairingPreviewRequestSchema.safeParse({ ...request, protocolVersion: 2 }).success).toBe(
      false
    );
    expect(pairingPreviewRequestSchema.safeParse({ ...request, databaseId: 42 }).success).toBe(
      false
    );
  });

  it("rejects family-admin portal context", () => {
    const context = fixture("portal-context-personal.json") as Record<string, unknown>;
    expect(personalPortalContextSchema.safeParse({ ...context, audience: "family_admin" }).success).toBe(
      false
    );
  });

  it("requires exactly 32 base64url credential bytes", () => {
    expect(deviceCredentialSchema.safeParse("too-short").success).toBe(false);
    expect(deviceCredentialSchema.safeParse("A".repeat(43)).success).toBe(true);
    expect(deviceCredentialSchema.safeParse("A".repeat(44)).success).toBe(false);
  });
});
