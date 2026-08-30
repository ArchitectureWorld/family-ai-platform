import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  openGatewayDatabase,
  runDevelopmentBootstrap,
  type GatewayDatabase
} from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

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
  { version: 5 },
  { version: 6 },
  { version: 7 },
  { version: 8 },
  { version: 9 },
  { version: 10 },
  { version: 11 },
  { version: 12 },
  { version: 13 },
  { version: 14 },
  { version: 15 }
];

const openAtVersion = openGatewayDatabase as unknown as (
  databasePath: string,
  options: { migrationLimit: number }
) => GatewayDatabase;

const mobilePairingColumnNames = [
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
  "revoked_at",
  "web_claim_session_ref",
  "web_replay_count"
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
    expect(pairingColumns).toEqual(mobilePairingColumnNames);

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

  it("adds bounded Web Claim replay metadata", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-web-replay-schema-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const columns = db
      .prepare("PRAGMA table_info(mobile_pairing_codes)")
      .all()
      .map((row) => String((row as { name: unknown }).name));
    expect(columns).toEqual(expect.arrayContaining([
      "web_claim_session_ref",
      "web_replay_count"
    ]));
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("upgrades V5 pairing rows with bounded Web Claim replay metadata", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-web-replay-upgrade-"));
    const databasePath = join(directory, "gateway.sqlite");
    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at) VALUES
        (1, '2026-07-25T00:00:00.000Z'),
        (2, '2026-07-25T00:00:00.000Z'),
        (3, '2026-07-25T00:00:00.000Z'),
        (4, '2026-07-25T00:00:00.000Z'),
        (5, '2026-07-25T00:00:00.000Z');
      CREATE TABLE families (family_ref TEXT PRIMARY KEY);
      CREATE TABLE persons (person_ref TEXT PRIMARY KEY);
      CREATE TABLE entry_bindings (entry_binding_ref TEXT PRIMARY KEY);
      CREATE TABLE managed_devices (device_ref TEXT PRIMARY KEY);
      CREATE TABLE entry_sessions (entry_session_ref TEXT PRIMARY KEY);
      CREATE TABLE agents (agent_ref TEXT PRIMARY KEY);
      CREATE TABLE provider_profiles (provider_profile_ref TEXT PRIMARY KEY);
      CREATE TABLE assistant_assignments (
        assignment_ref TEXT PRIMARY KEY,
        person_ref TEXT NOT NULL REFERENCES persons(person_ref),
        agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
        provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
        status TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to TEXT
      );
      CREATE UNIQUE INDEX person_active_assistant_assignment_idx
        ON assistant_assignments(person_ref) WHERE status = 'active';
      CREATE TABLE interaction_threads (
        thread_ref TEXT PRIMARY KEY,
        person_ref TEXT NOT NULL REFERENCES persons(person_ref),
        thread_kind TEXT NOT NULL,
        last_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );
      CREATE TABLE home_chat_streams (
        home_chat_stream_ref TEXT PRIMARY KEY,
        thread_ref TEXT NOT NULL UNIQUE REFERENCES interaction_threads(thread_ref),
        person_ref TEXT NOT NULL REFERENCES persons(person_ref),
        status TEXT NOT NULL
      );
      CREATE TABLE work_conversations (
        work_conversation_ref TEXT PRIMARY KEY,
        thread_ref TEXT NOT NULL UNIQUE REFERENCES interaction_threads(thread_ref),
        person_ref TEXT NOT NULL REFERENCES persons(person_ref),
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE TABLE thread_messages (
        message_ref TEXT PRIMARY KEY,
        thread_ref TEXT NOT NULL REFERENCES interaction_threads(thread_ref)
      );
      CREATE TABLE thread_provider_contexts (
        thread_ref TEXT PRIMARY KEY REFERENCES interaction_threads(thread_ref),
        person_ref TEXT NOT NULL REFERENCES persons(person_ref),
        provider_conversation_ref TEXT NOT NULL,
        assignment_ref TEXT NOT NULL REFERENCES assistant_assignments(assignment_ref),
        agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
        provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
        external_session_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE thread_provider_turns (
        user_message_ref TEXT PRIMARY KEY REFERENCES thread_messages(message_ref),
        thread_ref TEXT NOT NULL REFERENCES interaction_threads(thread_ref),
        invocation_ref TEXT NOT NULL,
        correlation_ref TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        assignment_ref TEXT NOT NULL REFERENCES assistant_assignments(assignment_ref),
        agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
        provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        assistant_message_ref TEXT,
        error_json TEXT,
        requested_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE mobile_pairing_codes (
        pairing_ref TEXT PRIMARY KEY,
        family_ref TEXT NOT NULL REFERENCES families(family_ref) ON DELETE CASCADE,
        person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'revoked', 'expired')),
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        expires_at TEXT NOT NULL,
        created_by_entry_binding_ref TEXT NOT NULL REFERENCES entry_bindings(entry_binding_ref),
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_device_ref TEXT REFERENCES managed_devices(device_ref),
        revoked_at TEXT
      );
      INSERT INTO families VALUES ('family:one');
      INSERT INTO persons VALUES ('person:one');
      INSERT INTO entry_bindings VALUES ('binding:one');
      INSERT INTO managed_devices VALUES ('device:one');
      INSERT INTO mobile_pairing_codes VALUES
        ('pairing:active', 'family:one', 'person:one', 'hash:active', 'active', 0, 3,
         '2026-07-26T00:00:00.000Z', 'binding:one', '2026-07-25T00:00:00.000Z', NULL, NULL, NULL),
        ('pairing:consumed', 'family:one', 'person:one', 'hash:consumed', 'consumed', 0, 3,
         '2026-07-26T00:00:00.000Z', 'binding:one', '2026-07-25T00:00:00.000Z',
         '2026-07-25T01:00:00.000Z', 'device:one', NULL);
    `);
    legacy.close();

    db = openGatewayDatabase(databasePath, { migrationLimit: 7 });
    expect(
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    ).toEqual(migrationVersions.slice(0, 7));
    expect(
      db.prepare(
        `SELECT pairing_ref, status, web_claim_session_ref, web_replay_count
         FROM mobile_pairing_codes ORDER BY pairing_ref`
      ).all()
    ).toEqual([
      {
        pairing_ref: "pairing:active",
        status: "active",
        web_claim_session_ref: null,
        web_replay_count: 0
      },
      {
        pairing_ref: "pairing:consumed",
        status: "consumed",
        web_claim_session_ref: null,
        web_replay_count: 0
      }
    ]);
    const upgradedPairingColumns = db
      .prepare("PRAGMA table_info(mobile_pairing_codes)")
      .all()
      .map((column) => String((column as { name: unknown }).name));
    expect(upgradedPairingColumns).toEqual(mobilePairingColumnNames);

    expect(
      db.prepare("PRAGMA table_info(mobile_pairing_codes)").all()
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "web_replay_count",
        notnull: 1,
        dflt_value: "0"
      })
    ]));
    expect(
      db.prepare("PRAGMA foreign_key_list(mobile_pairing_codes)").all()
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "entry_sessions",
        from: "web_claim_session_ref",
        to: "entry_session_ref"
      })
    ]));
    expect(() => {
      db!.prepare(
        "UPDATE mobile_pairing_codes SET web_replay_count = -1 WHERE pairing_ref = ?"
      ).run("pairing:active");
    }).toThrow(/CHECK constraint failed/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  }, 15_000);

  it("rejects unknown newer Gateway schema versions", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-unknown-schema-"));
    const databasePath = join(directory, "gateway.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at)
      VALUES(16, '2026-07-25T00:00:00.000Z');
    `);
    legacy.close();

    expect(() => openGatewayDatabase(databasePath)).toThrow(
      "Unsupported Gateway schema version: 16"
    );
  });

  it("keeps federation authority tables limited to bounded metadata columns", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-federation-schema-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));

    const expectedColumns = {
      federation_services: [
        "service_ref",
        "product",
        "token_hash",
        "status",
        "created_at",
        "revoked_at"
      ],
      agent_discovery_observations: [
        "agent_ref",
        "kind",
        "runtime",
        "status",
        "capabilities_json",
        "observed_at"
      ],
      federation_actor_contexts: [
        "context_ref",
        "product",
        "family_ref",
        "person_ref",
        "device_ref",
        "entry_session_ref",
        "person_display_name",
        "family_display_name",
        "assignment_version",
        "context_version",
        "expires_at",
        "created_at",
        "service_ref",
        "roles_json"
      ],
      agent_invocation_audit: [
        "invocation_ref",
        "correlation_ref",
        "product",
        "person_ref",
        "agent_ref",
        "local_session_ref",
        "request_sha256",
        "service_ref",
        "family_ref",
        "actor_context_ref",
        "requested_external_session_ref",
        "timeout_ms",
        "status",
        "error_code",
        "started_at",
        "completed_at"
      ]
    } as const;

    expect(db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'federation_services',
           'agent_discovery_observations',
           'federation_actor_contexts',
           'agent_invocation_audit'
         )
       ORDER BY name`
    ).all()).toEqual([
      { name: "agent_discovery_observations" },
      { name: "agent_invocation_audit" },
      { name: "federation_actor_contexts" },
      { name: "federation_services" }
    ]);
    for (const [table, columns] of Object.entries(expectedColumns)) {
      expect(db.prepare(`PRAGMA table_info(${table})`).all().map(
        (column) => String((column as { name: unknown }).name)
      )).toEqual(columns);
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("upgrades V10 to V11 once and reopens V11 idempotently", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-federation-v10-upgrade-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openAtVersion(databasePath, { migrationLimit: 10 });
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 10 });
    db.close();

    db = openGatewayDatabase(databasePath);
    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual(migrationVersions);
    const first = db.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'federation_%'
       ORDER BY name`
    ).all();
    db.close();

    db = openGatewayDatabase(databasePath);
    expect(db.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'federation_%'
       ORDER BY name`
    ).all()).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 11").get())
      .toEqual({ count: 1 });
  });

  it("adds only opaque durable external-session bindings in V12", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-federation-session-schema-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openAtVersion(databasePath, { migrationLimit: 11 });
    db.close();

    db = openGatewayDatabase(databasePath);
    expect(db.prepare("PRAGMA table_info(federation_session_bindings)").all().map(
      (column) => String((column as { name: unknown }).name)
    )).toEqual([
      "product",
      "family_ref",
      "person_ref",
      "agent_ref",
      "local_session_ref",
      "external_session_ref",
      "created_at",
      "updated_at"
    ]);
    expect(db.prepare("PRAGMA table_info(person_agent_assignment_versions)").all().map(
      (column) => String((column as { name: unknown }).name)
    )).toEqual([
      "person_ref",
      "assignment_version",
      "updated_at"
    ]);
    expect(db.prepare("PRAGMA table_info(federation_session_invocation_claims)").all().map(
      (column) => String((column as { name: unknown }).name)
    )).toEqual([
      "product",
      "family_ref",
      "person_ref",
      "agent_ref",
      "local_session_ref",
      "invocation_ref",
      "service_ref",
      "claimed_at",
      "lease_expires_at"
    ]);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 12"
    ).get()).toEqual({ count: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps Domain Event schema installation compatible from V11 through latest V15", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-domain-event-version-compat-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openAtVersion(databasePath, { migrationLimit: 11 });
    expect(() => new DomainEventStore(db!)).not.toThrow();
    db.close();
    db = openGatewayDatabase(databasePath);
    expect(() => new DomainEventStore(db!)).not.toThrow();
  });

  it("adds durable Family identity context snapshots in V13", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-federation-identity-v13-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openAtVersion(databasePath, { migrationLimit: 12 });
    const initialized = new FamilyDomainRepository(db).initializeFamily({
      familyName: "V13 家庭",
      ownerName: "V13 成员",
      deviceName: "V13 设备",
      deviceCredential: "v13-device-credential-with-enough-length"
    });
    db.close();

    db = openGatewayDatabase(databasePath);
    expect(db.prepare("PRAGMA table_info(person_federation_context_versions)").all().map(
      (column) => String((column as { name: unknown }).name)
    )).toEqual(["person_ref", "context_version", "updated_at"]);
    expect(db.prepare("PRAGMA table_info(federation_actor_contexts)").all().map(
      (column) => String((column as { name: unknown }).name)
    )).toEqual([
      "context_ref", "product", "family_ref", "person_ref", "device_ref",
      "entry_session_ref", "person_display_name", "family_display_name",
      "assignment_version", "context_version", "expires_at", "created_at",
      "service_ref", "roles_json"
    ]);
    expect(db.prepare(
      "SELECT context_version FROM person_federation_context_versions"
    ).get()).toEqual({ context_version: 1 });
    db.prepare(
      "UPDATE persons SET display_name = 'V13 新成员名', updated_at = ? WHERE person_ref = ?"
    ).run("2026-08-29T01:00:00.000Z", initialized.owner.personRef);
    db.prepare(
      `UPDATE family_memberships SET family_role = 'adult', updated_at = ?
       WHERE family_ref = ? AND person_ref = ?`
    ).run(
      "2026-08-29T01:00:01.000Z",
      initialized.family.familyRef,
      initialized.owner.personRef
    );
    db.prepare(
      "UPDATE families SET display_name = 'V13 新家庭名', updated_at = ? WHERE family_ref = ?"
    ).run("2026-08-29T01:00:02.000Z", initialized.family.familyRef);
    expect(db.prepare(
      `SELECT context_version FROM person_federation_context_versions
       WHERE person_ref = ?`
    ).get(initialized.owner.personRef)).toEqual({ context_version: 4 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("upgrades V13 invocation audits to bounded legacy-compatible V14 scope", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-federation-v14-upgrade-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openAtVersion(databasePath, { migrationLimit: 13 });
    const onboarding = new FamilyDomainRepository(db).initializeFamily({
      familyName: "V14 家庭",
      ownerName: "V14 成员",
      deviceName: "V14 设备",
      deviceCredential: "v14-device-credential-with-enough-length"
    });
    db.prepare(
      `INSERT INTO agent_invocation_audit(
         invocation_ref, correlation_ref, product, person_ref, agent_ref,
         local_session_ref, status, error_code, started_at, completed_at
       ) VALUES(?, ?, 'canvas', ?, 'agent:hermes-jarvis', ?, 'failed', ?, ?, ?)`
    ).run(
      "invocation:v13-legacy",
      "correlation:v13-legacy",
      onboarding.owner.personRef,
      "local-session:v13-legacy",
      "AGENT_RUNTIME_UNAVAILABLE",
      "2026-08-29T00:00:00.000Z",
      "2026-08-29T00:00:01.000Z"
    );
    db.close();

    db = openGatewayDatabase(databasePath);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 15 });
    expect(db.prepare(
      `SELECT request_sha256, service_ref, family_ref, actor_context_ref,
              requested_external_session_ref, timeout_ms
       FROM agent_invocation_audit WHERE invocation_ref = ?`
    ).get("invocation:v13-legacy")).toEqual({
      request_sha256: null,
      service_ref: null,
      family_ref: null,
      actor_context_ref: null,
      requested_external_session_ref: null,
      timeout_ms: null
    });
    expect(() => db!.prepare(
      `INSERT INTO agent_invocation_audit(
         invocation_ref, correlation_ref, product, person_ref, agent_ref,
         local_session_ref, request_sha256, service_ref, family_ref,
         actor_context_ref, timeout_ms, status, started_at
       ) VALUES(?, ?, 'canvas', ?, 'agent:hermes-jarvis', ?, ?, NULL, ?, ?,
                1000, 'accepted', ?)`
    ).run(
      "invocation:v14-partial",
      "correlation:v14-partial",
      onboarding.owner.personRef,
      "local-session:v14-partial",
      "a".repeat(64),
      onboarding.family.familyRef,
      "actor-context:v14-partial",
      "2026-08-29T00:00:02.000Z"
    )).toThrow(/CHECK constraint failed/);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    db.close();
    db = openGatewayDatabase(databasePath);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 14"
    ).get()).toEqual({ count: 1 });
  });

  it("upgrades V14 Actor contexts to the exact legacy-compatible V15 schema", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-federation-v15-upgrade-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openAtVersion(databasePath, { migrationLimit: 14 });
    const insert = db.prepare(
      `INSERT INTO federation_actor_contexts(
         context_ref, product, family_ref, person_ref, device_ref,
         entry_session_ref, person_display_name, family_display_name,
         assignment_version, context_version, expires_at, created_at
       ) VALUES(?, 'canvas', 'family:v15', 'person:v15', 'device:v15',
         'entry-session:v15', 'V15 成员', 'V15 家庭', 1, 1, ?, ?)`
    );
    insert.run(
      "actor-context:v15-expired",
      "2000-01-01T00:00:00.000Z",
      "1999-01-01T00:00:00.000Z"
    );
    insert.run(
      "actor-context:v15-live",
      "2999-01-01T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z"
    );
    db.close();

    db = openGatewayDatabase(databasePath);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 15 });
    expect(db.prepare("PRAGMA table_info(federation_actor_contexts)").all().map(
      (column) => String((column as { name: unknown }).name)
    )).toEqual([
      "context_ref", "product", "family_ref", "person_ref", "device_ref",
      "entry_session_ref", "person_display_name", "family_display_name",
      "assignment_version", "context_version", "expires_at", "created_at",
      "service_ref", "roles_json"
    ]);
    expect(db.prepare(
      `SELECT context_ref, service_ref, roles_json
       FROM federation_actor_contexts ORDER BY context_ref`
    ).all()).toEqual([{
      context_ref: "actor-context:v15-live",
      service_ref: null,
      roles_json: null
    }]);
    expect(db.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name IN (
         'federation_actor_contexts_expiry_idx',
         'federation_actor_contexts_reuse_idx',
         'federation_actor_context_roles_insert',
         'federation_actor_context_roles_update'
       ) ORDER BY name`
    ).all()).toEqual([
      { type: "trigger", name: "federation_actor_context_roles_insert" },
      { type: "trigger", name: "federation_actor_context_roles_update" },
      { type: "index", name: "federation_actor_contexts_expiry_idx" },
      { type: "index", name: "federation_actor_contexts_reuse_idx" }
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    db.close();
    db = openGatewayDatabase(databasePath);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15"
    ).get()).toEqual({ count: 1 });
  });

  it("enforces V15 service and canonical role constraints for every new shape", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-federation-v15-constraints-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const minimumServiceRef = "service:aa";
    const maximumServiceRef = `service:${"a".repeat(127)}`;
    const invalidShortServiceRef = "service:a";
    const invalidLongServiceRef = `service:${"a".repeat(128)}`;
    const services = [
      minimumServiceRef,
      maximumServiceRef,
      invalidShortServiceRef,
      invalidLongServiceRef
    ];
    const insertService = db.prepare(
      `INSERT INTO federation_services(
         service_ref, product, token_hash, status, created_at, revoked_at
       ) VALUES(?, 'canvas', ?, 'active', '2026-08-30T00:00:00.000Z', NULL)`
    );
    services.forEach((serviceRef, index) => {
      insertService.run(serviceRef, `token-hash-v15-${index}`);
    });
    let nextContext = 1;
    const insertContext = (
      serviceRef: string | null,
      rolesJson: string | null,
    ) => db!.prepare(
      `INSERT INTO federation_actor_contexts(
         context_ref, product, family_ref, person_ref, device_ref,
         entry_session_ref, person_display_name, family_display_name,
         assignment_version, context_version, expires_at, created_at,
         service_ref, roles_json
       ) VALUES(?, 'canvas', 'family:v15', 'person:v15', 'device:v15',
         'entry-session:v15', 'V15 成员', 'V15 家庭', 1, 1,
         '2999-01-01T00:00:00.000Z', '2026-08-30T00:00:00.000Z', ?, ?)`
    ).run(`actor-context:v15-${nextContext++}`, serviceRef, rolesJson);

    insertContext(null, null);
    for (const rolesJson of [
      '["owner"]', '["owner","family_admin"]',
      '["adult"]', '["adult","family_admin"]',
      '["child"]', '["child","family_admin"]',
      '["elder"]', '["elder","family_admin"]'
    ]) {
      insertContext(minimumServiceRef, rolesJson);
    }
    insertContext(maximumServiceRef, '["owner"]');

    for (const [serviceRef, rolesJson] of [
      [minimumServiceRef, null],
      [null, '["owner"]'],
      [invalidShortServiceRef, '["owner"]'],
      [invalidLongServiceRef, '["owner"]'],
      ['service:missing', '["owner"]'],
      [minimumServiceRef, 'not-json'],
      [minimumServiceRef, '{}'],
      [minimumServiceRef, '["owner","owner"]'],
      [minimumServiceRef, '["family_admin","owner"]'],
      [minimumServiceRef, '["root"]']
    ] as const) {
      expect(() => insertContext(serviceRef, rolesJson)).toThrow();
    }
    const updateTarget = `actor-context:v15-${nextContext}`;
    insertContext(minimumServiceRef, '["owner"]');
    expect(() => db!.prepare(
      "UPDATE federation_actor_contexts SET roles_json = ? WHERE context_ref = ?"
    ).run('["owner","owner"]', updateTarget)).toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("removes 100000 expired Actor contexts once during the V15 migration", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-federation-v15-history-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openAtVersion(databasePath, { migrationLimit: 14 });
    const insert = db.prepare(
      `INSERT INTO federation_actor_contexts(
         context_ref, product, family_ref, person_ref, device_ref,
         entry_session_ref, person_display_name, family_display_name,
         assignment_version, context_version, expires_at, created_at
       ) VALUES(?, 'canvas', 'family:history', 'person:history', 'device:history',
         'entry-session:history', '历史成员', '历史家庭', 1, 1, ?,
         '1999-01-01T00:00:00.000Z')`
    );
    db.transaction(() => {
      for (let index = 0; index < 100_000; index += 1) {
        insert.run(`actor-context:expired-${index}`, "2000-01-01T00:00:00.000Z");
      }
      insert.run("actor-context:future", "2999-01-01T00:00:00.000Z");
    })();
    db.close();

    const started = Date.now();
    db = openGatewayDatabase(databasePath);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(db.prepare("SELECT COUNT(*) AS count FROM federation_actor_contexts").get())
      .toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT context_ref FROM federation_actor_contexts"
    ).get()).toEqual({ context_ref: "actor-context:future" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  }, 40_000);

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
      "entry_audience",
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
      "entry_audience",
      "status",
      "attempt_count",
      "assistant_message_ref",
      "error_json",
      "requested_at",
      "completed_at"
    ]);

    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("installs the versioned Person event, Device Sync and transactional outbox subsystem", () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-domain-event-schema-"));
    const databasePath = join(directory, "gateway.sqlite");
    db = openGatewayDatabase(databasePath);
    new DomainEventStore(db, () => new Date("2026-07-23T18:00:00.000Z"));

    expect(db.prepare(
      "SELECT version FROM domain_event_schema_migrations ORDER BY version"
    ).all()).toEqual([{ version: 1 }, { version: 2 }]);

    const tables = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'person_event_sequences',
           'domain_events',
           'outbox_events',
           'device_sync_cursors'
         )
       ORDER BY name`
    ).all();
    expect(tables).toEqual([
      { name: "device_sync_cursors" },
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

    const cursorColumns = db.prepare("PRAGMA table_info(device_sync_cursors)")
      .all()
      .map((column) => String((column as { name: unknown }).name));
    expect(cursorColumns).toEqual([
      "device_ref",
      "person_ref",
      "acknowledged_sequence",
      "created_at",
      "updated_at"
    ]);

    const indexes = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name IN (
           'domain_events_person_sequence_idx',
           'outbox_events_dispatch_idx',
           'device_sync_cursors_person_sequence_idx'
         )
       ORDER BY name`
    ).all();
    expect(indexes).toEqual([
      { name: "device_sync_cursors_person_sequence_idx" },
      { name: "domain_events_person_sequence_idx" },
      { name: "outbox_events_dispatch_idx" }
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    db.close();
    db = openGatewayDatabase(databasePath);
    new DomainEventStore(db, () => new Date("2026-07-23T18:01:00.000Z"));
    expect(db.prepare(
      "SELECT version FROM domain_event_schema_migrations ORDER BY version"
    ).all()).toEqual([{ version: 1 }, { version: 2 }]);
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
