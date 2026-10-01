import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pairingClaimRequestSchema } from "../src/index.js";

function harmonyClaimFixture(): Record<string, unknown> {
  const path = fileURLToPath(
    new URL(
      "../fixtures/mobile-entry/pairing-claim-harmonyos-request.json",
      import.meta.url
    )
  );
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("Mobile Entry platform descriptors", () => {
  it("accepts a canonical HarmonyOS phone claim without changing protocol v1", () => {
    const parsed = pairingClaimRequestSchema.parse(harmonyClaimFixture());
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.device).toMatchObject({
      terminalType: "mobile",
      platform: "harmonyos",
      displayName: "测试鸿蒙手机"
    });
  });

  it.each(["android", "windows", "unknown"])(
    "rejects an unsupported mobile platform: %s",
    (platform) => {
      const claim = harmonyClaimFixture();
      const device = claim.device as Record<string, unknown>;
      expect(
        pairingClaimRequestSchema.safeParse({
          ...claim,
          device: { ...device, platform }
        }).success
      ).toBe(false);
    }
  );

  it("keeps terminal type and descriptor shape strict", () => {
    const claim = harmonyClaimFixture();
    const device = claim.device as Record<string, unknown>;
    expect(
      pairingClaimRequestSchema.safeParse({
        ...claim,
        device: { ...device, terminalType: "harmony" }
      }).success
    ).toBe(false);
    expect(
      pairingClaimRequestSchema.safeParse({
        ...claim,
        device: { ...device, distributionType: "phone" }
      }).success
    ).toBe(false);
  });
});
