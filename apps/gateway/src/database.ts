import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { MessageEnvelope } from "@family-ai/contracts";

export type GatewayDatabase = Database.Database;

const MIGRATION_V1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE members (
  member_ref TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE devices (
  device_ref TEXT PRIMARY KEY,
  member_ref TEXT NOT NULL REFERENCES members(member_ref) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX devices_member_status_idx ON devices(member_ref, status);
CREATE TABLE agents (
  agent_ref TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE provider_profiles (
  provider_profile_ref TEXT PRIMARY KEY,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('fake', 'hermes', 'codex')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE member_agent_bindings (
  member_ref TEXT NOT NULL REFERENCES members(member_ref) ON DELETE CASCADE,
  agent_ref TEXT NOT NULL REFERENCES agents(agent_ref) ON DELETE CASCADE,
  provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
  is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_ref, agent_ref)
);
CREATE UNIQUE INDEX member_default_agent_idx
  ON member_agent_bindings(member_ref) WHERE is_default = 1;
CREATE TABLE conversations (
  conversation_ref TEXT PRIMARY KEY,
  member_ref TEXT NOT NULL REFERENCES members(member_ref) ON DELETE CASCADE,
  agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX conversations_access_idx
  ON conversations(conversation_ref, member_ref, agent_ref);
CREATE INDEX conversations_member_agent_updated_idx
  ON conversations(member_ref, agent_ref, updated_at DESC);
CREATE TABLE messages (
  message_ref TEXT PRIMARY KEY,
  conversation_ref TEXT NOT NULL REFERENCES conversations(conversation_ref) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  correlation_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_conversation_created_idx
  ON messages(conversation_ref, created_at);
CREATE TABLE provider_sessions (
  conversation_ref TEXT NOT NULL REFERENCES conversations(conversation_ref) ON DELETE CASCADE,
  agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
  provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
  external_session_ref TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_ref, agent_ref, provider_profile_ref)
);
CREATE TABLE idempotency_records (
  device_ref TEXT NOT NULL REFERENCES devices(device_ref) ON DELETE CASCADE,
  conversation_ref TEXT NOT NULL REFERENCES conversations(conversation_ref) ON DELETE CASCADE,
  agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_ref, conversation_ref, agent_ref, idempotency_key)
);
`;

function applyMigrations(db: GatewayDatabase): void {
  const ledgerExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (!ledgerExists) {
    db.transaction(() => {
      db.exec(MIGRATION_V1);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)").run(
        new Date().toISOString()
      );
    })();
    return;
  }
  const versions = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  if ((versions.at(-1)?.version ?? 0) !== 1) {
    throw new Error(`Unsupported Gateway schema version: ${versions.at(-1)?.version ?? 0}`);
  }
}

export function openGatewayDatabase(databasePath: string): GatewayDatabase {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  applyMigrations(db);
  return db;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DevelopmentBootstrapInput {
  memberRef: string;
  memberDisplayName: string;
  deviceRef: string;
  deviceDisplayName: string;
  deviceToken: string;
  agentRef: string;
  agentDisplayName: string;
  providerProfileRef: string;
}

export function runDevelopmentBootstrap(
  db: GatewayDatabase,
  input: DevelopmentBootstrapInput
): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO members VALUES(?, ?, ?)").run(
      input.memberRef,
      input.memberDisplayName,
      now
    );
    db.prepare("INSERT OR IGNORE INTO agents VALUES(?, ?, ?)").run(
      input.agentRef,
      input.agentDisplayName,
      now
    );
    db.prepare(
      `INSERT OR IGNORE INTO provider_profiles
       (provider_profile_ref, provider_kind, display_name, created_at)
       VALUES(?, 'fake', 'Local Fake Provider', ?)`
    ).run(input.providerProfileRef, now);
    db.prepare(
      `INSERT OR IGNORE INTO member_agent_bindings
       (member_ref, agent_ref, provider_profile_ref, is_default, created_at)
       VALUES(?, ?, ?, 1, ?)`
    ).run(input.memberRef, input.agentRef, input.providerProfileRef, now);
    db.prepare(
      `INSERT OR IGNORE INTO devices
       (device_ref, member_ref, display_name, status, token_hash, created_at, updated_at, revoked_at)
       VALUES(?, ?, ?, 'active', ?, ?, ?, NULL)`
    ).run(
      input.deviceRef,
      input.memberRef,
      input.deviceDisplayName,
      sha256(input.deviceToken),
      now,
      now
    );
  })();
}

export interface AuthenticatedDevice {
  deviceRef: string;
  deviceDisplayName: string;
  memberRef: string;
  memberDisplayName: string;
  agentRef: string;
  agentDisplayName: string;
  providerProfileRef: string;
}

export interface GatewayConversation {
  conversationRef: string;
  memberRef: string;
  agentRef: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  messageRef: string;
  conversationRef: string;
  role: "user" | "assistant";
  correlationRef: string;
  payload: { type: "text"; text: string; language?: string };
  occurredAt: string;
  createdAt: string;
}

export interface StoredIdempotency {
  requestHash: string;
  httpStatus: number;
  response: unknown;
}

function mapConversation(row: Record<string, unknown>): GatewayConversation {
  return {
    conversationRef: String(row.conversation_ref),
    memberRef: String(row.member_ref),
    agentRef: String(row.agent_ref),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class GatewayRepository {
  constructor(private readonly db: GatewayDatabase) {}

  authenticateDevice(deviceRef: string, token: string): AuthenticatedDevice | null {
    const row = this.db.prepare(
      `SELECT d.device_ref, d.display_name AS device_display_name, d.token_hash,
              m.member_ref, m.display_name AS member_display_name,
              a.agent_ref, a.display_name AS agent_display_name,
              b.provider_profile_ref
       FROM devices d
       JOIN members m ON m.member_ref = d.member_ref
       JOIN member_agent_bindings b ON b.member_ref = m.member_ref AND b.is_default = 1
       JOIN agents a ON a.agent_ref = b.agent_ref
       WHERE d.device_ref = ? AND d.status = 'active'`
    ).get(deviceRef) as Record<string, unknown> | undefined;
    if (!row || typeof row.token_hash !== "string") return null;
    if (!safeHashEqual(sha256(token), row.token_hash)) return null;
    return {
      deviceRef: String(row.device_ref),
      deviceDisplayName: String(row.device_display_name),
      memberRef: String(row.member_ref),
      memberDisplayName: String(row.member_display_name),
      agentRef: String(row.agent_ref),
      agentDisplayName: String(row.agent_display_name),
      providerProfileRef: String(row.provider_profile_ref)
    };
  }

  createConversation(input: {
    memberRef: string;
    agentRef: string;
    title: string;
  }): GatewayConversation {
    const now = new Date().toISOString();
    const conversationRef = `conversation:${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO conversations
       (conversation_ref, member_ref, agent_ref, title, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?)`
    ).run(conversationRef, input.memberRef, input.agentRef, input.title.trim().slice(0, 80), now, now);
    return this.getConversationForAccess(conversationRef, input.memberRef, input.agentRef)!;
  }

  getConversationForAccess(
    conversationRef: string,
    memberRef: string,
    agentRef: string
  ): GatewayConversation | null {
    const row = this.db.prepare(
      `SELECT conversation_ref, member_ref, agent_ref, title, created_at, updated_at
       FROM conversations
       WHERE conversation_ref = ? AND member_ref = ? AND agent_ref = ?`
    ).get(conversationRef, memberRef, agentRef) as Record<string, unknown> | undefined;
    return row ? mapConversation(row) : null;
  }

  listConversations(memberRef: string, agentRef: string): GatewayConversation[] {
    const rows = this.db.prepare(
      `SELECT conversation_ref, member_ref, agent_ref, title, created_at, updated_at
       FROM conversations
       WHERE member_ref = ? AND agent_ref = ?
       ORDER BY updated_at DESC, conversation_ref`
    ).all(memberRef, agentRef) as Array<Record<string, unknown>>;
    return rows.map(mapConversation);
  }

  listMessages(conversationRef: string): StoredMessage[] {
    const rows = this.db.prepare(
      `SELECT message_ref, conversation_ref, role, correlation_ref,
              payload_json, occurred_at, created_at
       FROM messages WHERE conversation_ref = ? ORDER BY created_at, rowid`
    ).all(conversationRef) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      messageRef: String(row.message_ref),
      conversationRef: String(row.conversation_ref),
      role: row.role as "user" | "assistant",
      correlationRef: String(row.correlation_ref),
      payload: JSON.parse(String(row.payload_json)) as StoredMessage["payload"],
      occurredAt: String(row.occurred_at),
      createdAt: String(row.created_at)
    }));
  }

  findIdempotency(input: {
    deviceRef: string;
    conversationRef: string;
    agentRef: string;
    idempotencyKey: string;
  }): StoredIdempotency | null {
    const row = this.db.prepare(
      `SELECT request_hash, http_status, response_json FROM idempotency_records
       WHERE device_ref = ? AND conversation_ref = ? AND agent_ref = ? AND idempotency_key = ?`
    ).get(
      input.deviceRef,
      input.conversationRef,
      input.agentRef,
      input.idempotencyKey
    ) as Record<string, unknown> | undefined;
    return row ? {
      requestHash: String(row.request_hash),
      httpStatus: Number(row.http_status),
      response: JSON.parse(String(row.response_json))
    } : null;
  }

  getExternalSession(input: {
    conversationRef: string;
    agentRef: string;
    providerProfileRef: string;
  }): string | null {
    const row = this.db.prepare(
      `SELECT external_session_ref FROM provider_sessions
       WHERE conversation_ref = ? AND agent_ref = ? AND provider_profile_ref = ?`
    ).get(
      input.conversationRef,
      input.agentRef,
      input.providerProfileRef
    ) as { external_session_ref: string } | undefined;
    return row?.external_session_ref ?? null;
  }

  persistSuccessfulExchange(input: {
    device: AuthenticatedDevice;
    conversationRef: string;
    request: MessageEnvelope;
    response: MessageEnvelope;
    requestHash: string;
    httpStatus: number;
    externalSessionRef: string;
  }): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO messages
         (message_ref, conversation_ref, role, correlation_ref, payload_json, occurred_at, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`
      );
      insert.run(
        input.request.messageRef,
        input.conversationRef,
        "user",
        input.request.correlationRef,
        JSON.stringify(input.request.payload),
        input.request.occurredAt,
        now
      );
      insert.run(
        input.response.messageRef,
        input.conversationRef,
        "assistant",
        input.response.correlationRef,
        JSON.stringify(input.response.payload),
        input.response.occurredAt,
        now
      );
      this.db.prepare(
        `INSERT INTO provider_sessions
         (conversation_ref, agent_ref, provider_profile_ref, external_session_ref, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(conversation_ref, agent_ref, provider_profile_ref)
         DO UPDATE SET external_session_ref=excluded.external_session_ref, updated_at=excluded.updated_at`
      ).run(
        input.conversationRef,
        input.device.agentRef,
        input.device.providerProfileRef,
        input.externalSessionRef,
        now
      );
      this.db.prepare(
        `INSERT INTO idempotency_records
         (device_ref, conversation_ref, agent_ref, idempotency_key,
          request_hash, http_status, response_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.device.deviceRef,
        input.conversationRef,
        input.device.agentRef,
        input.request.idempotencyKey,
        input.requestHash,
        input.httpStatus,
        JSON.stringify(input.response),
        now
      );
      this.db.prepare("UPDATE conversations SET updated_at = ? WHERE conversation_ref = ?")
        .run(now, input.conversationRef);
    })();
  }
}
