import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";

const bootstrapToken = "harmony-platform-bootstrap-token-with-enough-length";
const bootstrapHeaders = {
  authorization: `Bearer ${bootstrapToken}`,
  "x-device-ref": "device:test"
};

type EntryCredential = {
  entrySessionRef: string;
  token: string;
};

type Onboarding = {
  owner: { personRef: string };
  entries: { admin: EntryCredential };
};

function entryHeaders(entry: EntryCredential): Record<string, string> {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

describe("HarmonyOS Mobile Entry pairing", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-harmony-pairing-"));
    databasePath = join(directory, "gateway.sqlite");
    app = await buildGatewayApp({
      databasePath,
      deviceToken: bootstrapToken,
      mode: "test",
      now: () => new Date("2026-07-25T02:30:00.000Z")
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("accepts and persists the validated mobile + harmonyos descriptor", async () => {
    const initializedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "测试成员",
        deviceName: "测试管理电脑"
      }
    });
    expect(initializedResponse.statusCode).toBe(201);
    const initialized = initializedResponse.json() as Onboarding;

    const pairingResponse = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(initialized.owner.personRef)}/pairing-codes`,
      headers: {
        ...entryHeaders(initialized.entries.admin),
        host: "family-ai-gateway.example.test",
        "x-forwarded-proto": "https"
      }
    });
    expect(pairingResponse.statusCode).toBe(201);
    const pairing = pairingResponse.json() as {
      pairing: { pairingRef: string; code: string };
    };

    const claimResponse = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/claim",
      headers: { host: "family-ai-gateway.example.test" },
      payload: {
        protocolVersion: 1,
        pairingRef: pairing.pairing.pairingRef,
        code: pairing.pairing.code,
        installationId: "41e0d7fa-3698-445c-89d7-a5e960957a1a",
        deviceCredential: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        device: {
          displayName: "测试鸿蒙手机",
          terminalType: "mobile",
          platform: "harmonyos",
          systemVersion: "HarmonyOS 7",
          appVersion: "0.1.0",
          model: "HarmonyOS Phone"
        }
      }
    });
    expect(claimResponse.statusCode).toBe(201);
    const claim = claimResponse.json() as {
      device: { deviceRef: string; displayName: string; status: "active" };
    };

    const database = openGatewayDatabase(databasePath);
    try {
      const stored = database.prepare(
        `SELECT display_name, terminal_type, platform, system_version,
                app_version, device_model
         FROM managed_devices WHERE device_ref = ?`
      ).get(claim.device.deviceRef);
      expect(stored).toEqual({
        display_name: "测试鸿蒙手机",
        terminal_type: "mobile",
        platform: "harmonyos",
        system_version: "HarmonyOS 7",
        app_version: "0.1.0",
        device_model: "HarmonyOS Phone"
      });
    } finally {
      database.close();
    }
  });
});
