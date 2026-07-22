import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const bootstrapToken = "browser-pairing-bootstrap-token-with-enough-length";
const bootstrapHeaders = {
  authorization: `Bearer ${bootstrapToken}`,
  "x-device-ref": "device:test"
};
const directories: string[] = [];

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-browser-pairing-"));
  directories.push(directory);
  return join(directory, "gateway.sqlite");
}

function entryHeaders(entry: { entrySessionRef: string; token: string }) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("development browser pairing", () => {
  it("permits the local acceptance page to generate contract-safe QR material", async () => {
    const app = await buildGatewayApp({
      databasePath: databasePath(),
      deviceToken: bootstrapToken,
      mode: "development"
    });

    const initializedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "浏览器验收家庭",
        ownerName: "浏览器管理员",
        deviceName: "浏览器管理电脑"
      }
    });
    expect(initializedResponse.statusCode).toBe(201);
    const admin = initializedResponse.json().entries.admin as {
      entrySessionRef: string;
      token: string;
    };

    const memberResponse = await app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: entryHeaders(admin),
      payload: { displayName: "移动成员", familyRole: "adult" }
    });
    expect(memberResponse.statusCode).toBe(201);
    const personRef = memberResponse.json().member.personRef as string;

    const pairingResponse = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/pairing-codes`,
      headers: {
        ...entryHeaders(admin),
        host: "127.0.0.1:8790"
      }
    });

    expect(pairingResponse.statusCode).toBe(201);
    expect(pairingResponse.json().qr.payload.gateway).toBe("https://127.0.0.1:8790");
    await app.close();
  });

  it("does not relax HTTPS generation outside development mode", async () => {
    const app = await buildGatewayApp({
      databasePath: databasePath(),
      deviceToken: bootstrapToken,
      mode: "test"
    });

    const initializedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "测试管理员",
        deviceName: "测试电脑"
      }
    });
    const admin = initializedResponse.json().entries.admin as {
      entrySessionRef: string;
      token: string;
    };
    const memberResponse = await app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: entryHeaders(admin),
      payload: { displayName: "移动成员", familyRole: "adult" }
    });
    const personRef = memberResponse.json().member.personRef as string;

    const pairingResponse = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/pairing-codes`,
      headers: {
        ...entryHeaders(admin),
        host: "127.0.0.1:8790"
      }
    });

    expect(pairingResponse.statusCode).toBe(400);
    expect(pairingResponse.json().error.code).toBe("PAIRING_INVALID");
    await app.close();
  });
});
