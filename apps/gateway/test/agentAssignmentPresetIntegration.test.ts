import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HERMES_JARVIS_YUTU_DEFAULTS
} from "../src/agentAssignments.js";
import { openGatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const directories: string[] = [];

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
});
