import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openGatewayDatabase,
  runDevelopmentBootstrap,
  type GatewayDatabase
} from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";

const bootstrap = {
  memberRef: "member:test",
  memberDisplayName: "测试成员",
  deviceRef: "device:test",
  deviceDisplayName: "测试设备",
  deviceToken: "initial-device-token-with-enough-length",
  agentRef: "agent:personal-assistant",
  agentDisplayName: "个人助理",
  providerProfileRef: "provider-profile:fake-local"
};

const migrationVersions = [
  { version: 1 },
  { version: 2 },
  { version: 3 },
  { version: 4 },
  { version: 5 }
];

describe("gateway database", () => {
  let directory = "";
  let db: GatewayDatabase | null = null;

  afterEach(() => {
    db?.close();
    db = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("applies numbered migrations once and starts the formal Family domain empty", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-db-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openGatewayDatabase(databasePath);
    expect(
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    ).toEqual(migrationVersions);
    expect(db.prepare("SELECT COUNT(*) AS count FROM families").get()).toEqual({ count: 0 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
    db = openGatewayDatabase(databasePath);
    expect(
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    ).toEqual(migrationVersions);
    expect(db.prepare("SELECT COUNT(*) AS count FROM families").get()).toEqual({ count: 0 });
  });

  it("creates the mobile pairing schema without weakening the V2 identity model", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-mobile-schema-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));

    const pairingTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("mobile_pairing_codes");
    expect(pairingTable).toEqual({ name: "mobile_pairing_codes" });

    const pairingColumns = db
      .prepare("PRAGMA table_info(mobile_pairing_codes)")
      .all()
      .map((column) => String((column as { name: unknown }).name));
    expect(pairingColumns).toEqual([
      "pairing_ref",
      "family_ref",
      "person_ref",
      "code_hash",
      "status",
      "failed_attempts",
      "max_attempts",
      "expires_at",
      "created_by_entry_binding_ref",
      "created_at",
      "consumed_at",
      "consumed_device_ref",
      "revoked_at"
    ]);

    const mobileColumns = db
      .prepare("PRAGMA table_info(managed_devices)")
      .all()
      .map((column) => String((column as { name: unknown }).name));
    expect(mobileColumns).toEqual(
      expect.arrayContaining([
        "installation_ref",
        "system_version",
        "app_version",
        "device_model",
        "last_seen_at"
      ])
    );

    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("creates the formal Chat Work domain schema with thread-scoped uniqueness", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-chat-work-schema-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'interaction_threads',
           'home_chat_streams',
           'daily_episodes',
           'work_conversations',
           'thread_messages',
           'chat_work_conversions',
           'chat_work_conversion_messages',
           'work_progress_snapshots'
         ) ORDER BY name`
      )
      .all()
      .map((row) => String((row as { name: unknown }).name));

    expect(tables).toEqual([
      "chat_work_conversion_messages",
      "chat_work_conversions",
      "daily_episodes",
      "home_chat_streams",
      "interaction_threads",
      "thread_messages",
      "work_conversations",
      "work_progress_snapshots"
    ]);

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'person_active_home_chat_idx',
           'home_chat_open_episode_idx',
           'thread_messages_sequence_idx',
           'thread_messages_client_id_idx'
         ) ORDER BY name`
      )
      .all()
      .map((row) => String((row as { name: unknown }).name));

    expect(indexes).toEqual([
      "home_chat_open_episode_idx",
      "person_active_home_chat_idx",
      "thread_messages_client_id_idx",
      "thread_messages_sequence_idx"
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("creates durable Thread Provider contexts and turns", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-provider-turn-schema-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('thread_provider_contexts', 'thread_provider_turns')
         ORDER BY name`
      )
      .all();
    expect(tables).toEqual([
      { name: "thread_provider_contexts" },
      { name: "thread_provider_turns" }
    ]);

    const contextColumns = db
      .prepare("PRAGMA table_info(thread_provider_contexts)")
      .all()
      .map((column) => String((column as { name: unknown }).name));
    expect(contextColumns).toEqual([
      "thread_ref",
      "person_ref",
      "provider_conversation_ref",
      "assignment_ref",
      "agent_ref",
      "provider_profile_ref",
      "external_session_ref",
      "created_at",
      "updated_at"
    ]);

    const turnColumns = db
      .prepare("PRAGMA table_info(thread_provider_turns)")
      .all()
      .map((column) => String((column as { name: unknown }).name));
    expect(turnColumns).toEqual([
      "user_message_ref",
      "thread_ref",
      "invocation_ref",
      "correlation_ref",
      "idempotency_key",
      "assignment_ref",
      "agent_ref",
      "provider_profile_ref",
      "status",
      "attempt_count",
      "assistant_message_ref",
      "error_json",
      "requested_at",
      "completed_at"
    ]);

    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("installs the versioned Person event and transactional outbox subsystem", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-domain-event-schema-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openGatewayDatabase(databasePath);
    new DomainEventStore(db, () => new Date("2026-07-23T18:00:00.000Z"));

    expect(db.prepare(
      "SELECT version FROM domain_event_schema_migrations ORDER BY version"
    ).all()).toEqual([{ version: 1 }]);

    const tables = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('person_event_sequences', 'domain_events', 'outbox_events')
       ORDER BY name`
    ).all();
    expect(tables).toEqual([
      { name: "domain_events" },
      { name: "outbox_events" },
      { name: "person_event_sequences" }
    ]);

    const eventColumns = db.prepare("PRAGMA table_info(domain_events)")
      .all()
      .map((column) => String((column as { name: unknown }).name));
    expect(eventColumns).toEqual([
      "event_ref",
      "person_ref",
      "event_sequence",
      "event_type",
      "aggregate_type",
      "aggregate_ref",
      "thread_ref",
      "payload_json",
      "occurred_at",
      "created_at"
    ]);

    const outboxColumns = db.prepare("PRAGMA table_info(outbox_events)")
      .all()
      .map((column) => String((column as { name: unknown }).name));
    expect(outboxColumns).toEqual([
      "event_ref",
      "status",
      "attempt_count",
      "available_at",
      "claimed_by",
      "claimed_until",
      "published_at",
      "last_error_json",
      "updated_at"
    ]);

    const indexes = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name IN ('domain_events_person_sequence_idx', 'outbox_events_dispatch_idx')
       ORDER BY name`
    ).all();
    expect(indexes).toEqual([
      { name: "domain_events_person_sequence_idx" },
      { name: "outbox_events_dispatch_idx" }
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    db.close();
    db = openGatewayDatabase(databasePath);
    new DomainEventStore(db, () => new Date("2026-07-23T18:01:00.000Z"));
    expect(db.prepare(
      "SELECT version FROM domain_event_schema_migrations ORDER BY version"
    ).all()).toEqual([{ version: 1 }]);
  });

  it("bootstraps missing development records without overwriting operational state", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-bootstrap-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    runDevelopmentBootstrap(db, bootstrap);

    const original = db
      .prepare("SELECT token_hash, status FROM devices WHERE device_ref = ?")
      .get(bootstrap.deviceRef) as { token_hash: string; status: string };
    db.prepare("UPDATE devices SET status = 'revoked', revoked_at = ? WHERE device_ref = ?").run(
      new Date().toISOString(),
      bootstrap.deviceRef
    );

    runDevelopmentBootstrap(db, {
      ...bootstrap,
      deviceToken: "different-device-token-with-enough-length",
      deviceDisplayName: "不应覆盖的名称"
    });

    const after = db
      .prepare("SELECT token_hash, status, display_name FROM devices WHERE device_ref = ?")
      .get(bootstrap.deviceRef) as {
      token_hash: string;
      status: string;
      display_name: string;
    };
    expect(after.token_hash).toBe(original.token_hash);
    expect(after.status).toBe("revoked");
    expect(after.display_name).toBe(bootstrap.deviceDisplayName);
  });
});