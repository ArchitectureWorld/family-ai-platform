import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "web-entry-route-bootstrap-device-token-with-enough-length";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

type EntryCredential = { entrySessionRef: string; token: string };

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef,
    host: "family.example",
    "x-forwarded-proto": "https"
  };
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

function cookiesByName(setCookie: string | string[] | undefined): Record<string, string> {
  return Object.fromEntries(cookieHeader(setCookie).split("; ").filter(Boolean).map((pair) => {
    const separator = pair.indexOf("=");
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

describe("Web Entry HTTP routes", () => {
  let directory = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let admin: EntryCredential;
  let personRef = "";
  let pairingRef = "";
  let code = "";

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-web-entry-routes-"));
    app = await buildGatewayApp({
      databasePath: join(directory, "gateway.sqlite"),
      deviceToken,
      mode: "test",
      now: () => new Date("2026-07-25T09:00:00.000Z")
    });
    const onboarding = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "Alice",
        deviceName: "测试电脑"
      }
    });
    expect(onboarding.statusCode).toBe(201);
    const body = onboarding.json() as {
      owner: { personRef: string };
      entries: { admin: EntryCredential };
    };
    personRef = body.owner.personRef;
    admin = body.entries.admin;

    const pairing = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/pairing-codes`,
      headers: entryHeaders(admin)
    });
    expect(pairing.statusCode).toBe(201);
    const pairingBody = pairing.json() as {
      pairing: { pairingRef: string; code: string };
    };
    pairingRef = pairingBody.pairing.pairingRef;
    code = pairingBody.pairing.code;
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function claim() {
    return app.inject({
      method: "POST",
      url: "/api/v1/web-entry/pairing/claim",
      headers: {
        "x-family-ai-web-request": "1",
        host: "family.example"
      },
      payload: {
        protocolVersion: 1,
        pairingRef,
        code,
        installationId: "b53f0490-99f1-4d6c-9a95-921a3d76a8c3",
        device: {
          displayName: "Alice 的浏览器",
          browser: "Chrome 140",
          operatingSystem: "macOS 15",
          appVersion: "0.1.0"
        }
      }
    });
  }

  it("claims through public JSON while secrets stay in HttpOnly cookies", async () => {
    const response = await claim();
    expect(response.statusCode).toBe(201);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      protocolVersion: 1,
      context: {
        audience: "personal",
        person: { personRef },
        device: { terminalType: "web", platform: "browser" }
      }
    });
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("entrytoken");

    const setCookie = response.headers["set-cookie"];
    const values = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    expect(values).toHaveLength(4);
    expect(values.every((value) =>
      value.includes("HttpOnly") && value.includes("SameSite=Strict") && value.includes("Path=/")
    )).toBe(true);
    expect(values.every((value) => !value.includes("Secure"))).toBe(true);
  });

  it("restores context, logs out, renews from Device cookies and permanently revokes", async () => {
    const claimed = await claim();
    const cookies = cookieHeader(claimed.headers["set-cookie"]);
    const named = cookiesByName(claimed.headers["set-cookie"]);
    const deviceOnly = [
      `family_ai_web_device_ref=${named.family_ai_web_device_ref}`,
      `family_ai_web_device_credential=${named.family_ai_web_device_credential}`
    ].join("; ");

    const context = await app.inject({
      method: "GET",
      url: "/api/v1/web-entry/context",
      headers: { cookie: cookies }
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({ context: { person: { personRef } } });

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/logout",
      headers: { cookie: cookies, "x-family-ai-web-request": "1" }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ protocolVersion: 1, status: "logged_out" });
    const logoutCookies = Array.isArray(logout.headers["set-cookie"])
      ? logout.headers["set-cookie"]
      : [String(logout.headers["set-cookie"])];
    expect(logoutCookies).toHaveLength(2);
    expect(logoutCookies.every((value) => value.includes("Max-Age=0"))).toBe(true);

    const expiredContext = await app.inject({
      method: "GET",
      url: "/api/v1/web-entry/context",
      headers: { cookie: cookies }
    });
    expect(expiredContext.statusCode).toBe(401);

    const renew = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/session/renew",
      headers: { cookie: deviceOnly, "x-family-ai-web-request": "1" }
    });
    expect(renew.statusCode).toBe(200);
    const renewedCookies = cookieHeader(renew.headers["set-cookie"]);
    expect(renew.json()).toMatchObject({ context: { person: { personRef } } });

    const revoke = await app.inject({
      method: "DELETE",
      url: "/api/v1/web-entry/device",
      headers: { cookie: renewedCookies, "x-family-ai-web-request": "1" }
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ protocolVersion: 1, status: "revoked" });
    const revokeCookies = Array.isArray(revoke.headers["set-cookie"])
      ? revoke.headers["set-cookie"]
      : [String(revoke.headers["set-cookie"])];
    expect(revokeCookies).toHaveLength(4);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/session/renew",
      headers: { cookie: deviceOnly, "x-family-ai-web-request": "1" }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ code: "DEVICE_REVOKED" });
  });

  it("rejects unsafe browser writes without the same-origin custom header", async () => {
    const claimed = await claim();
    const cookies = cookieHeader(claimed.headers["set-cookie"]);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/logout",
      headers: { cookie: cookies }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "WEB_REQUEST_FORBIDDEN",
      category: "permission",
      retryable: false
    });
  });
});
