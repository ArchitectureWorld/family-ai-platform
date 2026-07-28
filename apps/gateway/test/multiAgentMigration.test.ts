import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { ChatWorkProviderRepository } from "../src/chatWorkProvider.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const appliedAt = "2026-07-28T00:00:00.000Z";
const openAtVersion = openGatewayDatabase as unknown as (
  databasePath: string,
  options: { migrationLimit: number }
) => GatewayDatabase;

type MigrationSnapshot = {
  messages: unknown[];
  contexts: unknown[];
  turns: unknown[];
  events: unknown[];
  outbox: unknown[];
  eventLedger: unknown[];
};

function snapshotMigrationState(db: GatewayDatabase): MigrationSnapshot {
  return {
    messages: db.prepare(
      `SELECT message_ref, thread_ref, thread_sequence
       FROM thread_messages ORDER BY message_ref`
    ).all(),
    contexts: db.prepare(
      `SELECT thread_ref, person_ref, provider_conversation_ref, assignment_ref, agent_ref,
              provider_profile_ref, external_session_ref, created_at, updated_at
       FROM thread_provider_contexts ORDER BY thread_ref`
    ).all(),
    turns: db.prepare(
      `SELECT user_message_ref, thread_ref, invocation_ref, correlation_ref, idempotency_key,
              assignment_ref, agent_ref, provider_profile_ref, status, attempt_count,
              assistant_message_ref, error_json, requested_at, completed_at
       FROM thread_provider_turns ORDER BY user_message_ref`
    ).all(),
    events: db.prepare(
      `SELECT event_ref, person_ref, event_sequence, event_type, aggregate_type, aggregate_ref,
              thread_ref, payload_json, occurred_at, created_at
       FROM domain_events ORDER BY person_ref, event_sequence`
    ).all(),
    outbox: db.prepare(
      `SELECT event_ref, status, attempt_count, available_at, claimed_by, claimed_until,
              published_at, last_error_json, updated_at
       FROM outbox_events ORDER BY event_ref`
    ).all(),
    eventLedger: db.prepare(
      "SELECT version, applied_at FROM domain_event_schema_migrations ORDER BY version"
    ).all()
  };
}

function createRealV6Database(databasePath: string) {
  const db = openAtVersion(databasePath, { migrationLimit: 6 });
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
    .toEqual({ version: 6 });
  const now = new Date(appliedAt);
  new DomainEventStore(db, () => now);
  const family = new FamilyDomainRepository(db).initializeFamily({
    familyName: "V6 家庭",
    ownerName: "V6 成员",
    deviceName: "V6 设备",
    deviceCredential: "v6-migration-device-credential"
  });
  const domain = new ChatWorkDomainRepository(db, () => now);
  const chat = domain.ensureHomeChat({
    personRef: family.owner.personRef,
    timezone: "UTC",
    localDate: "2026-07-28"
  });
  const message = domain.appendThreadMessage({
    personRef: family.owner.personRef,
    threadRef: chat.chat.threadRef,
    clientMessageId: "v6-migration-message-0001",
    actor: { type: "person", personRef: family.owner.personRef },
    origin: { deviceRef: family.device.deviceRef, connectionRef: "v6", entryAudience: "personal" },
    content: { type: "text", text: "保留 V6 消息。" },
    occurredAt: appliedAt
  });
  const provider = new ChatWorkProviderRepository(db, () => now);
  const turn = provider.prepareTurn({ personRef: family.owner.personRef, userMessage: message });
  provider.commitTurnSucceeded({
    personRef: family.owner.personRef,
    userMessage: message,
    turn,
    output: { type: "text", text: "保留 V6 Provider 状态。" },
    externalSessionRef: "external:v6-preserved",
    completedAt: "2026-07-28T00:00:01.000Z"
  });
  domain.createWorkConversation({
    personRef: family.owner.personRef,
    title: "V6 Work",
    goal: "验证真实 V6 迁移"
  });
  const snapshot = snapshotMigrationState(db);
  db.close();
  return { family, snapshot };
}

describe("Gateway V7 multi-Agent migration", () => {
  let directory = "";
  let db: GatewayDatabase | null = null;

  afterEach(() => {
    db?.close();
    db = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("upgrades a production V6 database without changing durable Thread or event state", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-v7-real-v6-"));
    const databasePath = join(directory, "gateway.sqlite");
    const { family, snapshot } = createRealV6Database(databasePath);

    db = openGatewayDatabase(databasePath);
    expect(snapshotMigrationState(db)).toEqual(snapshot);
    expect(db.prepare(
      "SELECT agent_ref, entry_audience FROM interaction_threads WHERE thread_kind = 'home_chat'"
    ).get()).toEqual({ agent_ref: "agent:personal-assistant", entry_audience: "personal" });
    db.prepare("INSERT INTO agents(agent_ref, display_name, created_at) VALUES(?, ?, ?)")
      .run("agent:second", "第二助理", appliedAt);
    expect(() => db!.prepare(
      `INSERT INTO assistant_assignments
       (assignment_ref, person_ref, agent_ref, provider_profile_ref, status, effective_from, effective_to)
       SELECT 'assignment:second', ?, 'agent:second', provider_profile_ref, 'active', ?, NULL
       FROM assistant_assignments WHERE person_ref = ? LIMIT 1`
    ).run(family.owner.personRef, appliedAt, family.owner.personRef)).not.toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  }, 30_000);

  it("rolls back a real V6 database with ambiguous active Agent backfill", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-v7-real-ambiguous-"));
    const databasePath = join(directory, "gateway.sqlite");
    const { family } = createRealV6Database(databasePath);
    const legacy = openAtVersion(databasePath, { migrationLimit: 6 });
    legacy.exec("DROP INDEX person_active_assistant_assignment_idx");
    legacy.prepare("INSERT INTO agents(agent_ref, display_name, created_at) VALUES(?, ?, ?)")
      .run("agent:second", "第二助理", appliedAt);
    legacy.prepare(
      `INSERT INTO assistant_assignments
       (assignment_ref, person_ref, agent_ref, provider_profile_ref, status, effective_from, effective_to)
       SELECT 'assignment:second', ?, 'agent:second', provider_profile_ref, 'active', ?, NULL
       FROM assistant_assignments WHERE person_ref = ? LIMIT 1`
    ).run(family.owner.personRef, appliedAt, family.owner.personRef);
    legacy.close();

    expect(() => openGatewayDatabase(databasePath)).toThrow(/Cannot backfill Agent/);
    const rolledBack = openAtVersion(databasePath, { migrationLimit: 6 });
    expect(rolledBack.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 6 });
    rolledBack.close();
  }, 30_000);
});
