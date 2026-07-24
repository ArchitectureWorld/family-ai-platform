import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import type { DomainEvent } from "../src/domainEvents.js";

export const bootstrapToken = "device-sync-security-bootstrap-token-with-enough-length";
const bootstrapHeaders = {
  authorization: `Bearer ${bootstrapToken}`,
  "x-device-ref": "device:test"
};

export interface EntryCredential {
  entryBindingRef: string;
  entrySessionRef: string;
  token: string;
  audience: "family_admin" | "personal";
  agentRef: string;
}

export interface InitializedFamily {
  family: { familyRef: string };
  owner: { personRef: string };
  device: { deviceRef: string };
  entries: { admin: EntryCredential; personal: EntryCredential };
}

export interface ClaimedDevice {
  device: { deviceRef: string; displayName: string };
  entry: EntryCredential;
}

export function entryHeaders(entry: EntryCredential): Record<string, string> {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

export function deviceHeaders(deviceRef: string, credential: string): Record<string, string> {
  return {
    authorization: `Device ${credential}`,
    "x-device-ref": deviceRef
  };
}

export class DeviceSyncHarness {
  directory = "";
  databasePath = "";
  app!: Awaited<ReturnType<typeof buildGatewayApp>>;
  initialized!: InitializedFamily;
  appClosed = true;

  async start(): Promise<void> {
    this.directory = mkdtempSync(join(tmpdir(), "family-ai-device-sync-security-"));
    this.databasePath = join(this.directory, "gateway.sqlite");
    await this.openApp();
    const response = await this.app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    expect(response.statusCode).toBe(201);
    this.initialized = response.json() as InitializedFamily;
  }

  async openApp(): Promise<void> {
    this.app = await buildGatewayApp({
      databasePath: this.databasePath,
      deviceToken: bootstrapToken,
      mode: "test",
      now: () => new Date("2026-07-24T17:30:00.000Z")
    });
    this.appClosed = false;
  }

  async restart(): Promise<void> {
    await this.closeApp();
    await this.openApp();
  }

  async closeApp(): Promise<void> {
    if (this.appClosed) return;
    await this.app.close();
    this.appClosed = true;
  }

  async dispose(): Promise<void> {
    await this.closeApp();
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
  }

  async openChat(entry: EntryCredential): Promise<void> {
    const response = await this.app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(entry)
    });
    expect(response.statusCode).toBe(200);
  }

  async syncEvents(entry: EntryCredential): Promise<{
    sync: {
      deviceRef: string;
      personRef: string;
      acknowledgedSequence: number;
      latestSequence: number;
    };
    events: DomainEvent[];
  }> {
    const response = await this.app.inject({
      method: "GET",
      url: "/api/v1/sync/events",
      headers: entryHeaders(entry)
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      sync: {
        deviceRef: string;
        personRef: string;
        acknowledgedSequence: number;
        latestSequence: number;
      };
      events: DomainEvent[];
    };
  }

  async acknowledge(entry: EntryCredential, event: DomainEvent): Promise<void> {
    const response = await this.app.inject({
      method: "POST",
      url: "/api/v1/sync/ack",
      headers: entryHeaders(entry),
      payload: {
        protocolVersion: 1,
        eventSequence: event.eventSequence,
        eventRef: event.eventRef
      }
    });
    expect(response.statusCode).toBe(200);
  }

  async createMember(): Promise<string> {
    const response = await this.app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: entryHeaders(this.initialized.entries.admin),
      payload: { displayName: "另一位成人", familyRole: "adult" }
    });
    expect(response.statusCode).toBe(201);
    return String(response.json().member.personRef);
  }

  async pairDevice(input: {
    personRef: string;
    installationId: string;
    credential: string;
    displayName: string;
  }): Promise<ClaimedDevice> {
    const pairing = await this.app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(input.personRef)}/pairing-codes`,
      headers: {
        ...entryHeaders(this.initialized.entries.admin),
        host: "family-ai-gateway.example.test",
        "x-forwarded-proto": "https"
      }
    });
    expect(pairing.statusCode).toBe(201);
    const material = pairing.json() as {
      pairing: { pairingRef: string; code: string };
    };

    const claim = await this.app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/claim",
      headers: { host: "family-ai-gateway.example.test" },
      payload: {
        protocolVersion: 1,
        pairingRef: material.pairing.pairingRef,
        code: material.pairing.code,
        installationId: input.installationId,
        deviceCredential: input.credential,
        device: {
          displayName: input.displayName,
          terminalType: "mobile",
          platform: "ios",
          systemVersion: "26.0",
          appVersion: "1.0.0",
          model: "iPhone"
        }
      }
    });
    expect(claim.statusCode).toBe(201);
    return claim.json() as ClaimedDevice;
  }
}
