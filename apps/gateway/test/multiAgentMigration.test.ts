import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";

const appliedAt = "2026-07-28T00:00:00.000Z";

function createV6Database(databasePath: string, options?: { ambiguousAssignments?: boolean }) {
  const legacy = new Database(databasePath);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations(version, applied_at) VALUES
      (1, '${appliedAt}'), (2, '${appliedAt}'), (3, '${appliedAt}'),
      (4, '${appliedAt}'), (5, '${appliedAt}'), (6, '${appliedAt}');
    CREATE TABLE families (family_ref TEXT PRIMARY KEY);
    CREATE TABLE persons (person_ref TEXT PRIMARY KEY);
    CREATE TABLE agents (agent_ref TEXT PRIMARY KEY);
    CREATE TABLE provider_profiles (provider_profile_ref TEXT PRIMARY KEY);
    CREATE TABLE assistant_assignments (
      assignment_ref TEXT PRIMARY KEY,
      person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
      agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
      provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
      status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
      effective_from TEXT NOT NULL,
      effective_to TEXT
    );
    CREATE UNIQUE INDEX person_active_assistant_assignment_idx
      ON assistant_assignments(person_ref) WHERE status = 'active';
    CREATE TABLE interaction_threads (
      thread_ref TEXT PRIMARY KEY,
      person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
      thread_kind TEXT NOT NULL CHECK (thread_kind IN ('home_chat', 'work')),
      last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL
    );
    CREATE INDEX interaction_threads_person_kind_active_idx
      ON interaction_threads(person_ref, thread_kind, last_active_at DESC);
    CREATE TABLE home_chat_streams (
      home_chat_stream_ref TEXT PRIMARY KEY,
      thread_ref TEXT NOT NULL UNIQUE REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
      person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended'))
    );
    CREATE UNIQUE INDEX person_active_home_chat_idx
      ON home_chat_streams(person_ref) WHERE status = 'active';
    CREATE TABLE daily_episodes (
      daily_episode_ref TEXT PRIMARY KEY,
      home_chat_stream_ref TEXT NOT NULL,
      thread_ref TEXT NOT NULL,
      local_date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      boundary_reason TEXT NOT NULL,
      archive_status TEXT NOT NULL,
      archive_version INTEGER NOT NULL,
      last_message_sequence INTEGER NOT NULL
    );
    CREATE TABLE work_conversations (
      work_conversation_ref TEXT PRIMARY KEY,
      thread_ref TEXT NOT NULL UNIQUE REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
      person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (
        status IN ('active', 'paused', 'waiting_confirmation', 'completed', 'archived')
      ),
      archived_at TEXT,
      CHECK (
        (status = 'archived' AND archived_at IS NOT NULL) OR
        (status <> 'archived' AND archived_at IS NULL)
      )
    );
    CREATE INDEX work_conversations_person_status_idx
      ON work_conversations(person_ref, status, work_conversation_ref);
    CREATE TABLE chat_work_conversions (
      conversion_ref TEXT PRIMARY KEY,
      person_ref TEXT NOT NULL,
      home_chat_stream_ref TEXT NOT NULL,
      daily_episode_ref TEXT,
      work_conversation_ref TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      open_questions_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE chat_work_conversion_messages (
      conversion_ref TEXT NOT NULL,
      message_ref TEXT NOT NULL,
      source_order INTEGER NOT NULL
    );
    CREATE TABLE work_progress_snapshots (
      work_conversation_ref TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      phase_summary TEXT NOT NULL,
      incomplete_tasks_json TEXT NOT NULL,
      risks_json TEXT NOT NULL,
      pending_confirmations_json TEXT NOT NULL,
      deadlines_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE thread_messages (
      message_ref TEXT PRIMARY KEY,
      thread_ref TEXT NOT NULL REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
      thread_sequence INTEGER NOT NULL CHECK (thread_sequence > 0)
    );
    CREATE TABLE thread_provider_contexts (
      thread_ref TEXT PRIMARY KEY REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
      person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
      provider_conversation_ref TEXT NOT NULL UNIQUE,
      assignment_ref TEXT NOT NULL REFERENCES assistant_assignments(assignment_ref),
      agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
      provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
      external_session_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX thread_provider_context_person_idx
      ON thread_provider_contexts(person_ref, thread_ref);
    CREATE TABLE thread_provider_turns (
      user_message_ref TEXT PRIMARY KEY REFERENCES thread_messages(message_ref) ON DELETE CASCADE,
      thread_ref TEXT NOT NULL REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
      invocation_ref TEXT NOT NULL UNIQUE,
      correlation_ref TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      assignment_ref TEXT NOT NULL REFERENCES assistant_assignments(assignment_ref),
      agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
      provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
      attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
      assistant_message_ref TEXT UNIQUE REFERENCES thread_messages(message_ref),
      error_json TEXT,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK (
        (status = 'pending' AND assistant_message_ref IS NULL AND error_json IS NULL
          AND completed_at IS NULL) OR
        (status = 'succeeded' AND assistant_message_ref IS NOT NULL AND error_json IS NULL
          AND completed_at IS NOT NULL) OR
        (status = 'failed' AND assistant_message_ref IS NULL AND error_json IS NOT NULL
          AND completed_at IS NOT NULL)
      )
    );
    CREATE INDEX thread_provider_turns_thread_status_idx
      ON thread_provider_turns(thread_ref, status, requested_at);
    INSERT INTO persons VALUES ('person:one');
    INSERT INTO agents VALUES ('agent:personal-assistant'), ('agent:second');
    INSERT INTO provider_profiles VALUES ('provider-profile:one');
    INSERT INTO assistant_assignments VALUES
      ('assignment:personal', 'person:one', 'agent:personal-assistant',
       'provider-profile:one', 'active', '${appliedAt}', NULL);
    INSERT INTO interaction_threads VALUES
      ('thread:chat', 'person:one', 'home_chat', 1, '${appliedAt}', '${appliedAt}'),
      ('thread:work', 'person:one', 'work', 1, '${appliedAt}', '${appliedAt}');
    INSERT INTO home_chat_streams VALUES ('home-chat:one', 'thread:chat', 'person:one', 'active');
    INSERT INTO work_conversations VALUES
      ('work:one', 'thread:work', 'person:one', '保留标题', '保留目标', '', 'active', NULL);
    INSERT INTO thread_messages VALUES
      ('message:chat', 'thread:chat', 1), ('message:work', 'thread:work', 1);
    INSERT INTO thread_provider_contexts VALUES
      ('thread:chat', 'person:one', 'conversation:chat', 'assignment:personal',
       'agent:personal-assistant', 'provider-profile:one', 'external:chat', '${appliedAt}', '${appliedAt}');
    INSERT INTO thread_provider_turns VALUES
      ('message:chat', 'thread:chat', 'invocation:chat', 'correlation:chat', 'idempotency:chat',
       'assignment:personal', 'agent:personal-assistant', 'provider-profile:one', 'succeeded', 1,
       'message:work', NULL, '${appliedAt}', '${appliedAt}');
  `);
  if (options?.ambiguousAssignments) {
    legacy.exec(`
      DROP INDEX person_active_assistant_assignment_idx;
      INSERT INTO assistant_assignments VALUES
        ('assignment:second', 'person:one', 'agent:second',
         'provider-profile:one', 'active', '${appliedAt}', NULL);
      DELETE FROM thread_provider_contexts;
    `);
  }
  legacy.close();
}

function latestMigration(db: GatewayDatabase): number {
  return (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
    version: number;
  }).version;
}

function insertAssignment(db: GatewayDatabase, agentRef: string): void {
  db.prepare(
    `INSERT INTO assistant_assignments
     (assignment_ref, person_ref, agent_ref, provider_profile_ref, status, effective_from, effective_to)
     VALUES(?, 'person:one', ?, 'provider-profile:one', 'active', ?, NULL)`
  ).run(`assignment:${agentRef}`, agentRef, appliedAt);
}

describe("Gateway V7 multi-Agent migration", () => {
  let directory = "";
  let db: GatewayDatabase | null = null;

  afterEach(() => {
    db?.close();
    db = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("backfills existing personal threads and permits two active Agents", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-v7-"));
    const databasePath = join(directory, "gateway.sqlite");
    createV6Database(databasePath);

    db = openGatewayDatabase(databasePath);
    const chat = db.prepare(
      "SELECT agent_ref, entry_audience FROM interaction_threads WHERE thread_kind='home_chat'"
    ).get() as { agent_ref: string; entry_audience: string };
    expect(chat).toEqual({
      agent_ref: "agent:personal-assistant",
      entry_audience: "personal"
    });
    expect(db.prepare(
      `SELECT message_ref, thread_ref, thread_sequence FROM thread_messages ORDER BY message_ref`
    ).all()).toEqual([
      { message_ref: "message:chat", thread_ref: "thread:chat", thread_sequence: 1 },
      { message_ref: "message:work", thread_ref: "thread:work", thread_sequence: 1 }
    ]);
    expect(db.prepare(
      `SELECT assignment_ref, agent_ref, external_session_ref
       FROM thread_provider_contexts WHERE thread_ref = 'thread:chat'`
    ).get()).toEqual({
      assignment_ref: "assignment:personal",
      agent_ref: "agent:personal-assistant",
      external_session_ref: "external:chat"
    });
    expect(db.prepare(
      `SELECT invocation_ref, correlation_ref, idempotency_key
       FROM thread_provider_turns WHERE user_message_ref = 'message:chat'`
    ).get()).toEqual({
      invocation_ref: "invocation:chat",
      correlation_ref: "correlation:chat",
      idempotency_key: "idempotency:chat"
    });

    expect(() => insertAssignment(db!, "agent:second")).not.toThrow();
    expect(() => insertAssignment(db!, "agent:second")).toThrow(/UNIQUE constraint failed/);
    expect(latestMigration(db)).toBe(7);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
    db = openGatewayDatabase(databasePath);
    expect(latestMigration(db)).toBe(7);
  }, 15_000);

  it("rolls back rather than choosing one of multiple active Agents", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-v7-ambiguous-"));
    const databasePath = join(directory, "gateway.sqlite");
    createV6Database(databasePath, { ambiguousAssignments: true });

    expect(() => openGatewayDatabase(databasePath)).toThrow("Cannot backfill Agent for thread:chat");
    const legacy = new Database(databasePath);
    expect(latestMigration(legacy)).toBe(6);
    expect(legacy.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'interaction_threads_v7'"
    ).get()).toBeUndefined();
    legacy.close();
  }, 15_000);

  it("reinstalls the dropped Work trigger without losing existing domain events", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-v7-domain-events-"));
    const databasePath = join(directory, "gateway.sqlite");
    createV6Database(databasePath);
    const legacy = new Database(databasePath);
    legacy.exec("INSERT INTO schema_migrations(version, applied_at) VALUES(7, 'temporary')");
    new DomainEventStore(legacy, () => new Date(appliedAt));
    legacy.exec(`
      INSERT INTO interaction_threads VALUES
        ('thread:work-before-v7', 'person:one', 'work', 0, '${appliedAt}', '${appliedAt}');
      INSERT INTO work_conversations VALUES
        ('work:before-v7', 'thread:work-before-v7', 'person:one', '旧工作', '旧目标', '', 'active', NULL);
      DELETE FROM schema_migrations WHERE version = 7;
    `);
    const before = legacy.prepare("SELECT COUNT(*) AS count FROM domain_events").get() as {
      count: number;
    };
    expect(before.count).toBe(1);
    expect(legacy.prepare("SELECT COUNT(*) AS count FROM outbox_events").get()).toEqual({ count: 1 });
    legacy.close();

    db = openGatewayDatabase(databasePath);
    new DomainEventStore(db, () => new Date("2026-07-28T00:01:00.000Z"));
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'domain_event_work_created'"
    ).get()).toEqual({ name: "domain_event_work_created" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_events").get()).toEqual({ count: 1 });

    db.exec(`
      INSERT INTO interaction_threads
        (thread_ref, person_ref, thread_kind, last_sequence, created_at, last_active_at)
      VALUES ('thread:work-after-v7', 'person:one', 'work', 0, '${appliedAt}', '${appliedAt}');
      INSERT INTO work_conversations
        (work_conversation_ref, thread_ref, person_ref, title, goal, summary, status, archived_at)
      VALUES ('work:after-v7', 'thread:work-after-v7', 'person:one', '新工作', '新目标', '', 'active', NULL);
    `);
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_events").get()).toEqual({ count: 2 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  }, 15_000);
});
