import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const adminPublic = fileURLToPath(new URL("../admin-public/", import.meta.url));
const entryModuleUrl = pathToFileURL(join(adminPublic, "admin-entry.js")).href;
const apiModuleUrl = pathToFileURL(join(adminPublic, "admin-api.js")).href;
const pairingModuleUrl = pathToFileURL(join(adminPublic, "admin-pairing.js")).href;
const token = `${"A".repeat(42)}A`;

async function entryModule() {
  return import(`${entryModuleUrl}?test=${Date.now()}-${Math.random()}`);
}

async function apiModule() {
  return import(`${apiModuleUrl}?test=${Date.now()}-${Math.random()}`);
}

async function pairingModule() {
  return import(`${pairingModuleUrl}?test=${Date.now()}-${Math.random()}`);
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
}

describe("Admin Web entry boundary", () => {
  it("captures exact entry and bootstrap fragments and rejects ambiguous material", async () => {
    const { captureAdminHandoff } = await entryModule();

    expect(
      captureAdminHandoff(
        `#entrySessionRef=entry-session%3Apreview-admin&token=${token}`
      )
    ).toEqual({
      kind: "entry",
      entrySessionRef: "entry-session:preview-admin",
      token
    });
    expect(
      captureAdminHandoff(
        `#deviceRef=device%3Atest&bootstrapToken=${token}`
      )
    ).toEqual({
      kind: "bootstrap",
      deviceRef: "device:test",
      token
    });

    for (const value of [
      "",
      `?entrySessionRef=entry-session%3Apreview-admin&token=${token}`,
      `#entrySessionRef=entry-session%3Apreview-admin&token=${token}&extra=1`,
      `#entrySessionRef=entry-session%3Apreview-admin&token=${token}&token=${token}`,
      `#deviceRef=device%3Atest&bootstrapToken=${token}&token=${token}`,
      "#entrySessionRef=entry-session%3Apreview-admin&token=short",
      `#entrySessionRef=person%3Awrong-kind&token=${token}`
    ]) {
      expect(() => captureAdminHandoff(value), value).toThrow("ADMIN_HANDOFF_INVALID");
    }
  });

  it("stores only validated credentials and emits the formal authentication headers", async () => {
    const {
      adminHeaders,
      readStoredAdminCredential,
      writeStoredAdminCredential
    } = await entryModule();
    const storage = memoryStorage();
    const credential = {
      kind: "entry",
      entrySessionRef: "entry-session:preview-admin",
      token
    };

    writeStoredAdminCredential(storage, credential);
    expect(readStoredAdminCredential(storage)).toEqual(credential);
    expect(adminHeaders(credential)).toEqual({
      Authorization: `Bearer ${token}`,
      "X-Entry-Session-Ref": "entry-session:preview-admin"
    });
    expect(adminHeaders({
      kind: "bootstrap",
      deviceRef: "device:test",
      token
    })).toEqual({
      Authorization: `Bearer ${token}`,
      "X-Device-Ref": "device:test"
    });

    storage.setItem("family-ai.admin.credential", '{"kind":"entry","token":"bad"}');
    expect(readStoredAdminCredential(storage)).toBeNull();
    expect(storage.getItem("family-ai.admin.credential")).toBeNull();
  });
});

describe("Admin Web API client", () => {
  it("uses public status plus strict bootstrap and family-admin requests", async () => {
    const { createAdminApi, normalizeDisplayName, normalizeFamilyRole } = await apiModule();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "/api/v1/onboarding/status") {
        return Response.json({ initialized: false });
      }
      if (url === "/api/v1/onboarding/family") {
        return Response.json({
          family: { familyRef: "family:preview", displayName: "我的家庭" },
          owner: { personRef: "person:owner", displayName: "管理员" },
          device: { deviceRef: "device:preview-admin", displayName: "管理电脑" },
          entries: {
            admin: {
              entrySessionRef: "entry-session:preview-admin",
              token
            },
            personal: {
              entrySessionRef: "entry-session:preview-personal",
              token: `${"B".repeat(42)}A`
            }
          }
        }, { status: 201 });
      }
      if (url === "/api/v1/portal/context") {
        return Response.json({
          protocolVersion: 1,
          audience: "family_admin",
          entrySessionRef: "entry-session:preview-admin",
          family: { familyRef: "family:preview", displayName: "我的家庭" },
          person: { personRef: "person:owner", displayName: "管理员" },
          membership: { familyRole: "owner" },
          device: { deviceRef: "device:preview-admin", displayName: "管理电脑" }
        });
      }
      if (url === "/api/v1/admin/members" && (init.method ?? "GET") === "GET") {
        return Response.json({
          members: [{
            personRef: "person:owner",
            displayName: "管理员",
            familyRole: "owner",
            status: "active",
            entryStatus: "active",
            activePersonalDeviceCount: 1
          }]
        });
      }
      if (url === "/api/v1/admin/members" && init.method === "POST") {
        return Response.json({
          member: {
            personRef: "person:child",
            displayName: "小明",
            familyRole: "child",
            status: "active",
            entryStatus: "unclaimed",
            activePersonalDeviceCount: 0
          }
        }, { status: 201 });
      }
      return Response.json({ code: "UNEXPECTED" }, { status: 500 });
    });

    expect(normalizeDisplayName("  小明  ")).toBe("小明");
    expect(normalizeFamilyRole("child")).toBe("child");
    expect(() => normalizeDisplayName("   ")).toThrow("ADMIN_DISPLAY_NAME_INVALID");
    expect(() => normalizeFamilyRole("owner")).toThrow("ADMIN_FAMILY_ROLE_INVALID");

    const bootstrapApi = createAdminApi({
      fetchImpl,
      credential: { kind: "bootstrap", deviceRef: "device:test", token }
    });
    expect(await bootstrapApi.onboardingStatus()).toEqual({ initialized: false });
    const initialized = await bootstrapApi.createFamily({
      familyName: "我的家庭",
      ownerName: "管理员",
      deviceName: "管理电脑"
    });
    expect(initialized.adminCredential).toEqual({
      kind: "entry",
      entrySessionRef: "entry-session:preview-admin",
      token
    });

    const entryApi = createAdminApi({
      fetchImpl,
      credential: initialized.adminCredential
    });
    expect((await entryApi.context()).audience).toBe("family_admin");
    expect((await entryApi.members()).members).toHaveLength(1);
    expect((await entryApi.addMember({
      displayName: " 小明 ",
      familyRole: "child"
    })).member.personRef).toBe("person:child");

    expect(requests[0]).toMatchObject({
      url: "/api/v1/onboarding/status",
      init: { method: "GET" }
    });
    expect(requests[0]!.init.headers).toBeUndefined();
    expect(requests[1]!.init.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      "X-Device-Ref": "device:test",
      "Content-Type": "application/json"
    });
    for (const request of requests.slice(2)) {
      expect(request.init.headers).toMatchObject({
        Authorization: `Bearer ${token}`,
        "X-Entry-Session-Ref": "entry-session:preview-admin"
      });
    }
  });

  it("creates and revokes pairing material only through the selected member", async () => {
    const { createAdminApi } = await apiModule();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (
        url === "/api/v1/admin/members/person%3Achild/pairing-codes" &&
        init.method === "POST"
      ) {
        return Response.json({
          protocolVersion: 1,
          pairing: {
            pairingRef: "pairing:preview",
            code: "ABCD-EFGH",
            expiresAt: "2030-01-01T00:05:00.000Z",
            status: "active"
          },
          family: { displayName: "我的家庭" },
          person: { displayName: "小明" },
          qr: {
            payload: {
              version: 1,
              gateway: "https://192.168.110.84:9443",
              pairingRef: "pairing:preview",
              code: "ABCD-EFGH",
              expiresAt: "2030-01-01T00:05:00.000Z"
            },
            url: "familyai://pair#redacted"
          }
        }, { status: 201 });
      }
      if (
        url === "/api/v1/admin/pairing-codes/pairing%3Apreview" &&
        init.method === "DELETE"
      ) {
        return Response.json({
          protocolVersion: 1,
          pairingRef: "pairing:preview",
          status: "revoked"
        });
      }
      return Response.json({ code: "UNEXPECTED" }, { status: 500 });
    });
    const api = createAdminApi({
      fetchImpl,
      credential: {
        kind: "entry",
        entrySessionRef: "entry-session:preview-admin",
        token
      }
    });

    expect((await api.createPairing("person:child")).pairing.code).toBe("ABCD-EFGH");
    expect((await api.revokePairing("pairing:preview")).status).toBe("revoked");
    expect(requests.map(request => [request.url, request.init.method])).toEqual([
      ["/api/v1/admin/members/person%3Achild/pairing-codes", "POST"],
      ["/api/v1/admin/pairing-codes/pairing%3Apreview", "DELETE"]
    ]);
    for (const request of requests) {
      expect(request.init.headers).toMatchObject({
        Authorization: `Bearer ${token}`,
        "X-Entry-Session-Ref": "entry-session:preview-admin"
      });
    }
  });
});

describe("Admin Web pairing presentation", () => {
  it("builds a same-origin fragment handoff, QR, and deterministic expiry", async () => {
    const {
      memberHandoffUrl,
      pairingCountdown,
      pairingQrSvg
    } = await pairingModule();
    const pairing = {
      pairingRef: "pairing:preview",
      code: "ABCD-EFGH",
      expiresAt: "2030-01-01T00:05:00.000Z"
    };
    const url = memberHandoffUrl("https://192.168.110.84:9443", pairing);

    expect(url).toBe(
      "https://192.168.110.84:9443/member/#pairingRef=pairing%3Apreview&code=ABCD-EFGH"
    );
    expect(new URL(url).search).toBe("");
    expect(() => memberHandoffUrl("http://192.168.110.84:9443", pairing))
      .toThrow("ADMIN_PAIRING_ORIGIN_INVALID");
    expect(() => memberHandoffUrl("https://example.com", pairing))
      .toThrow("ADMIN_PAIRING_ORIGIN_INVALID");

    expect(pairingCountdown(
      pairing.expiresAt,
      Date.parse("2030-01-01T00:03:59.000Z")
    )).toEqual({
      expired: false,
      remainingSeconds: 61,
      label: "1:01"
    });
    expect(pairingCountdown(
      pairing.expiresAt,
      Date.parse("2030-01-01T00:05:00.000Z")
    )).toEqual({
      expired: true,
      remainingSeconds: 0,
      label: "已过期"
    });

    const svg = pairingQrSvg(
      url,
      (_value: string, options: { title: string }) =>
        `<svg><title>${options.title}</title><path d="M0 0"></path></svg>`
    );
    expect(svg).toContain("<svg");
    expect(svg).toContain("Family AI Member Web pairing");
    expect(svg).not.toContain("ABCD-EFGH");
  });
});
