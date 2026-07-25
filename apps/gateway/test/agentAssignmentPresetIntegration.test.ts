import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HERMES_JARVIS_YUTU_DEFAULTS
} from "../src/agentAssignments.js";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const directories: string[] = [];
const bootstrapToken = "assignment-preset-bootstrap-token-with-safe-length";

type EntryCredential = { entrySessionRef: string; token: string };

function entryHeaders(entry: EntryCredential) {
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

describe("Family Agent defaults", () => {
  it("creates a new Family with Jarvis for Admin and Yutu for the Owner", () => {
    const directory = mkdtempSync(join(tmpdir(), "family-ai-hermes-defaults-"));
    directories.push(directory);
    const database = openGatewayDatabase(join(directory, "gateway.sqlite"));
    try {
      const repository = new FamilyDomainRepository(database, {
        defaults: HERMES_JARVIS_YUTU_DEFAULTS
      });
      const initialized = repository.initializeFamily({
        familyName: "Hermes 家庭",
        ownerName: "Owner",
        deviceName: "家庭服务器",
        deviceCredential: "hermes-default-device-credential-with-safe-length"
      });

      expect(repository.authenticateEntrySession(
        initialized.entries.admin.entrySessionRef,
        initialized.entries.admin.token
      )).toMatchObject({
        audience: "family_admin",
        agent: {
          assignmentType: "family_manager",
          agentRef: "agent:jarvis",
          displayName: "Jarvis",
          providerProfileRef: "provider-profile:hermes-jarvis"
        }
      });
      expect(repository.authenticateEntrySession(
        initialized.entries.personal.entrySessionRef,
        initialized.entries.personal.token
      )).toMatchObject({
        audience: "personal",
        agent: {
          assignmentType: "personal_assistant",
          agentRef: "agent:yutu",
          displayName: "于途",
          providerProfileRef: "provider-profile:hermes-zzh"
        }
      });
    } finally {
      database.close();
    }
  });

  it("keeps a new non-owner member on the controlled default Personal Assistant", () => {
    const directory = mkdtempSync(join(tmpdir(), "family-ai-member-defaults-"));
    directories.push(directory);
    const database = openGatewayDatabase(join(directory, "gateway.sqlite"));
    try {
      const repository = new FamilyDomainRepository(database, {
        defaults: HERMES_JARVIS_YUTU_DEFAULTS
      });
      const initialized = repository.initializeFamily({
        familyName: "Hermes 家庭",
        ownerName: "Owner",
        deviceName: "家庭服务器",
        deviceCredential: "hermes-member-device-credential-with-safe-length"
      });
      const member = repository.createMember({
        familyRef: initialized.family.familyRef,
        displayName: "Adult",
        familyRole: "adult"
      });

      expect(member.personalAssistant).toMatchObject({
        agentRef: "agent:personal-assistant",
        displayName: "个人助理",
        providerProfileRef: "provider-profile:fake-local"
      });
      expect(repository.listMembers(initialized.family.familyRef)[0]?.personalAssistant)
        .toMatchObject({
          agentRef: "agent:yutu",
          displayName: "于途"
        });
    } finally {
      database.close();
    }
  });

  it("migrates an existing Family during Gateway startup and remains idempotent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "family-ai-preset-startup-"));
    directories.push(directory);
    const databasePath = join(directory, "gateway.sqlite");
    const first = await buildGatewayApp({
      databasePath,
      deviceToken: bootstrapToken,
      mode: "test"
    });
    const onboarding = await first.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: {
        authorization: `Bearer ${bootstrapToken}`,
        "x-device-ref": "device:test"
      },
      payload: {
        familyName: "既有家庭",
        ownerName: "Owner",
        deviceName: "家庭服务器"
      }
    });
    expect(onboarding.statusCode).toBe(201);
    const initialized = onboarding.json() as {
      entries: { admin: EntryCredential; personal: EntryCredential };
    };
    await first.close();

    for (let restart = 0; restart < 2; restart += 1) {
      const migrated = await buildGatewayApp({
        databasePath,
        deviceToken: bootstrapToken,
        mode: "test",
        assignmentPreset: "hermes-jarvis-yutu-v1",
        now: () => new Date("2026-07-25T14:30:00.000Z")
      });
      try {
        const adminContext = await migrated.inject({
          method: "GET",
          url: "/api/v1/portal/context",
          headers: entryHeaders(initialized.entries.admin)
        });
        expect(adminContext.statusCode).toBe(200);
        expect(adminContext.json()).toMatchObject({
          audience: "family_admin",
          agent: {
            agentRef: "agent:jarvis",
            displayName: "Jarvis",
            providerProfileRef: "provider-profile:hermes-jarvis"
          }
        });

        const personalContext = await migrated.inject({
          method: "GET",
          url: "/api/v1/portal/context",
          headers: entryHeaders(initialized.entries.personal)
        });
        expect(personalContext.statusCode).toBe(200);
        expect(personalContext.json()).toMatchObject({
          audience: "personal",
          agent: {
            agentRef: "agent:yutu",
            displayName: "于途",
            providerProfileRef: "provider-profile:hermes-zzh"
          }
        });
      } finally {
        await migrated.close();
      }
    }

    const verification = openGatewayDatabase(databasePath);
    try {
      expect((verification.prepare(
        "SELECT COUNT(*) AS count FROM family_manager_assignments"
      ).get() as { count: number }).count).toBe(2);
      expect((verification.prepare(
        "SELECT COUNT(*) AS count FROM assistant_assignments"
      ).get() as { count: number }).count).toBe(2);
    } finally {
      verification.close();
    }
  });
});
