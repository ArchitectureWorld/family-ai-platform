import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManagementRepository } from "../src/agentManagement.js";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";

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
  db.exec(`
    INSERT INTO provider_profiles
      (provider_profile_ref, provider_kind, display_name, created_at)
    VALUES
      ('provider-profile:fake-local', 'fake', 'V6 Provider', '${appliedAt}');
    INSERT INTO agents(agent_ref, display_name, created_at)
    VALUES
      ('agent:family-manager', 'V6 家庭管家', '${appliedAt}'),
      ('agent:personal-assistant', 'V6 个人助理', '${appliedAt}');
    INSERT INTO families
      (family_ref, display_name, status, created_at, updated_at)
    VALUES
      ('family:v6', 'V6 家庭', 'active', '${appliedAt}', '${appliedAt}');
    INSERT INTO persons
      (person_ref, display_name, status, created_at, updated_at)
    VALUES
      ('person:v6', 'V6 成员', 'active', '${appliedAt}', '${appliedAt}');
    INSERT INTO family_memberships
      (family_ref, person_ref, family_role, status, joined_at, updated_at)
    VALUES
      ('family:v6', 'person:v6', 'owner', 'active', '${appliedAt}', '${appliedAt}');
    INSERT INTO managed_devices
      (device_ref, display_name, terminal_type, platform, status, credential_hash,
       created_at, updated_at, revoked_at)
    VALUES
      ('device:v6', 'V6 设备', 'computer', 'linux', 'active',
       'v6-credential-hash', '${appliedAt}', '${appliedAt}', NULL);
    INSERT INTO device_bindings
      (device_binding_ref, device_ref, owner_scope, family_ref, person_ref,
       status, bound_at, revoked_at)
    VALUES
      ('device-binding:v6', 'device:v6', 'person', 'family:v6', 'person:v6',
       'active', '${appliedAt}', NULL);
    INSERT INTO family_manager_assignments
      (assignment_ref, family_ref, agent_ref, provider_profile_ref, status,
       effective_from, effective_to)
    VALUES
      ('assignment:v6-manager', 'family:v6', 'agent:family-manager',
       'provider-profile:fake-local', 'active', '${appliedAt}', NULL);
    INSERT INTO assistant_assignments
      (assignment_ref, person_ref, agent_ref, provider_profile_ref, status,
       effective_from, effective_to)
    VALUES
      ('assignment:v6-assistant', 'person:v6', 'agent:personal-assistant',
       'provider-profile:fake-local', 'active', '${appliedAt}', NULL);

    INSERT INTO interaction_threads
      (thread_ref, person_ref, thread_kind, last_sequence, created_at, last_active_at)
    VALUES
      ('thread:v6-home', 'person:v6', 'home_chat', 0, '${appliedAt}', '${appliedAt}');
    INSERT INTO home_chat_streams
      (home_chat_stream_ref, thread_ref, person_ref, status)
    VALUES
      ('home-chat:v6', 'thread:v6-home', 'person:v6', 'active');
    INSERT INTO daily_episodes
      (daily_episode_ref, home_chat_stream_ref, thread_ref, local_date, timezone,
       started_at, ended_at, boundary_reason, archive_status, archive_version,
       last_message_sequence)
    VALUES
      ('daily-episode:v6', 'home-chat:v6', 'thread:v6-home', '2026-07-28', 'UTC',
       '${appliedAt}', NULL, 'initial', 'open', 0, 0);
    INSERT INTO thread_messages
      (message_ref, thread_ref, thread_sequence, client_message_id, actor_type,
       actor_person_ref, actor_assignment_ref, actor_agent_ref,
       actor_provider_profile_ref, actor_system_ref, origin_device_ref,
       origin_connection_ref, entry_audience, content_type, content_text,
       content_language, occurred_at, created_at)
    VALUES
      ('message:v6-user', 'thread:v6-home', 1, 'v6-migration-message-0001',
       'person', 'person:v6', NULL, NULL, NULL, NULL, 'device:v6', 'v6',
       'personal', 'text', '保留 V6 消息。', NULL, '${appliedAt}', '${appliedAt}'),
      ('message:v6-assistant', 'thread:v6-home', 2, 'v6-provider-message-0001',
       'assistant', NULL, 'assignment:v6-assistant', 'agent:personal-assistant',
       'provider-profile:fake-local', NULL, NULL, NULL, 'personal', 'text',
       '保留 V6 Provider 状态。', NULL, '2026-07-28T00:00:01.000Z',
       '2026-07-28T00:00:01.000Z');
    UPDATE interaction_threads
      SET last_sequence = 2, last_active_at = '2026-07-28T00:00:01.000Z'
      WHERE thread_ref = 'thread:v6-home';
    UPDATE daily_episodes SET last_message_sequence = 2
      WHERE daily_episode_ref = 'daily-episode:v6';
    INSERT INTO thread_provider_contexts
      (thread_ref, person_ref, provider_conversation_ref, assignment_ref,
       agent_ref, provider_profile_ref, external_session_ref, created_at, updated_at)
    VALUES
      ('thread:v6-home', 'person:v6', 'provider-conversation:v6',
       'assignment:v6-assistant', 'agent:personal-assistant',
       'provider-profile:fake-local', 'external:v6-preserved',
       '${appliedAt}', '2026-07-28T00:00:01.000Z');
    INSERT INTO thread_provider_turns
      (user_message_ref, thread_ref, invocation_ref, correlation_ref,
       idempotency_key, assignment_ref, agent_ref, provider_profile_ref, status,
       attempt_count, assistant_message_ref, error_json, requested_at, completed_at)
    VALUES
      ('message:v6-user', 'thread:v6-home', 'invocation:v6', 'correlation:v6',
       'idempotency:v6', 'assignment:v6-assistant', 'agent:personal-assistant',
       'provider-profile:fake-local', 'pending', 1, NULL, NULL, '${appliedAt}', NULL);
    UPDATE thread_provider_turns
      SET status = 'succeeded', assistant_message_ref = 'message:v6-assistant',
          completed_at = '2026-07-28T00:00:01.000Z'
      WHERE user_message_ref = 'message:v6-user';

    INSERT INTO interaction_threads
      (thread_ref, person_ref, thread_kind, last_sequence, created_at, last_active_at)
    VALUES
      ('thread:v6-work', 'person:v6', 'work', 0, '${appliedAt}', '${appliedAt}');
    INSERT INTO work_conversations
      (work_conversation_ref, thread_ref, person_ref, title, goal, summary,
       status, archived_at)
    VALUES
      ('work:v6', 'thread:v6-work', 'person:v6', 'V6 Work',
       '验证真实 V6 迁移', '', 'active', NULL);
  `);
  const family = {
    owner: { personRef: "person:v6" },
    device: { deviceRef: "device:v6" }
  };
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
    new AgentManagementRepository(db, () => new Date(appliedAt))
      .reconcileRuntimeCatalog([{
        agentRef: "agent:personal-assistant",
        displayName: "V6 个人助理",
        providerProfileRef: "provider-profile:fake-local",
        providerKind: "fake"
      }]);
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
    expect(() => db!.prepare(
      `INSERT INTO assistant_assignments
       (assignment_ref, person_ref, agent_ref, provider_profile_ref, status, effective_from, effective_to)
       SELECT 'assignment:second-duplicate', ?, 'agent:second', provider_profile_ref, 'active', ?, NULL
       FROM assistant_assignments WHERE person_ref = ? LIMIT 1`
    ).run(family.owner.personRef, appliedAt, family.owner.personRef)).toThrow(/UNIQUE constraint failed/);
    const v7State = {
      migration: db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
      snapshot: snapshotMigrationState(db),
      mounts: db.prepare(
        `SELECT assignment_ref, person_ref, agent_ref, provider_profile_ref, status,
                effective_from, effective_to, is_default
         FROM assistant_assignments ORDER BY assignment_ref`
      ).all()
    };
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
    db = openGatewayDatabase(databasePath);
    expect({
      migration: db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
      snapshot: snapshotMigrationState(db),
      mounts: db.prepare(
        `SELECT assignment_ref, person_ref, agent_ref, provider_profile_ref, status,
                effective_from, effective_to, is_default
         FROM assistant_assignments ORDER BY assignment_ref`
      ).all()
    }).toEqual(v7State);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    new DomainEventStore(db, () => new Date("2026-07-28T00:01:00.000Z"));
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'domain_event_work_created'"
    ).get()).toEqual({ name: "domain_event_work_created" });
    new ChatWorkDomainRepository(db, () => new Date("2026-07-28T00:01:00.000Z"))
      .createWorkConversation({
        personRef: family.owner.personRef,
        title: "V7 触发器恢复",
        goal: "验证新的 Work 事件和 Outbox"
      });
    const recovered = snapshotMigrationState(db);
    expect(recovered.events.slice(0, snapshot.events.length)).toEqual(snapshot.events);
    expect(recovered.events).toHaveLength(snapshot.events.length + 1);
    expect(recovered.outbox).toHaveLength(snapshot.outbox.length + 1);
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
