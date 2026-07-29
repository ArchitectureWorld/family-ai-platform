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

const MIGRATION_V2 = `
CREATE TABLE families (
  family_ref TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE persons (
  person_ref TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE family_memberships (
  family_ref TEXT NOT NULL REFERENCES families(family_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  family_role TEXT NOT NULL CHECK (family_role IN ('owner', 'adult', 'child', 'elder')),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (family_ref, person_ref)
);
CREATE UNIQUE INDEX family_active_owner_idx
  ON family_memberships(family_ref)
  WHERE family_role = 'owner' AND status = 'active';
CREATE INDEX family_memberships_family_status_idx
  ON family_memberships(family_ref, status, joined_at);
CREATE TABLE managed_devices (
  device_ref TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  terminal_type TEXT NOT NULL CHECK (terminal_type IN ('computer', 'mobile', 'harmony', 'diy', 'web')),
  platform TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  credential_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE device_bindings (
  device_binding_ref TEXT PRIMARY KEY,
  device_ref TEXT NOT NULL REFERENCES managed_devices(device_ref) ON DELETE CASCADE,
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('family', 'person')),
  family_ref TEXT NOT NULL REFERENCES families(family_ref) ON DELETE CASCADE,
  person_ref TEXT REFERENCES persons(person_ref) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  bound_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (
    (owner_scope = 'person' AND person_ref IS NOT NULL) OR
    (owner_scope = 'family' AND person_ref IS NULL)
  )
);
CREATE UNIQUE INDEX managed_device_active_binding_idx
  ON device_bindings(device_ref)
  WHERE status = 'active';
CREATE TABLE family_manager_assignments (
  assignment_ref TEXT PRIMARY KEY,
  family_ref TEXT NOT NULL REFERENCES families(family_ref) ON DELETE CASCADE,
  agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
  provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  effective_from TEXT NOT NULL,
  effective_to TEXT
);
CREATE UNIQUE INDEX family_active_manager_assignment_idx
  ON family_manager_assignments(family_ref)
  WHERE status = 'active';
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
  ON assistant_assignments(person_ref)
  WHERE status = 'active';
CREATE TABLE entry_bindings (
  entry_binding_ref TEXT PRIMARY KEY,
  device_ref TEXT NOT NULL REFERENCES managed_devices(device_ref) ON DELETE CASCADE,
  family_ref TEXT NOT NULL REFERENCES families(family_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  audience TEXT NOT NULL CHECK (audience IN ('family_admin', 'personal')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  bound_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE UNIQUE INDEX active_entry_binding_idx
  ON entry_bindings(device_ref, person_ref, audience)
  WHERE status = 'active';
CREATE TABLE entry_sessions (
  entry_session_ref TEXT PRIMARY KEY,
  entry_binding_ref TEXT NOT NULL REFERENCES entry_bindings(entry_binding_ref) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX entry_sessions_binding_status_idx
  ON entry_sessions(entry_binding_ref, status, expires_at);
`;

const MIGRATION_V3 = `
ALTER TABLE managed_devices ADD COLUMN installation_ref TEXT;
ALTER TABLE managed_devices ADD COLUMN system_version TEXT;
ALTER TABLE managed_devices ADD COLUMN app_version TEXT;
ALTER TABLE managed_devices ADD COLUMN device_model TEXT;
ALTER TABLE managed_devices ADD COLUMN last_seen_at TEXT;
CREATE UNIQUE INDEX managed_device_installation_idx
  ON managed_devices(installation_ref)
  WHERE installation_ref IS NOT NULL;
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
CREATE INDEX mobile_pairing_target_status_idx
  ON mobile_pairing_codes(family_ref, person_ref, status, expires_at);
CREATE INDEX mobile_pairing_expiry_idx
  ON mobile_pairing_codes(status, expires_at);
`;

const MIGRATION_V4 = `
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
  home_chat_stream_ref TEXT NOT NULL REFERENCES home_chat_streams(home_chat_stream_ref) ON DELETE CASCADE,
  thread_ref TEXT NOT NULL REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  boundary_reason TEXT NOT NULL CHECK (
    boundary_reason IN ('initial', 'local_day', 'inactive_gap', 'manual_correction')
  ),
  archive_status TEXT NOT NULL CHECK (archive_status IN ('open', 'pending', 'archived', 'failed')),
  archive_version INTEGER NOT NULL CHECK (archive_version >= 0),
  last_message_sequence INTEGER NOT NULL CHECK (last_message_sequence >= 0),
  CHECK (archive_status <> 'open' OR ended_at IS NULL),
  CHECK (archive_status <> 'archived' OR (ended_at IS NOT NULL AND archive_version >= 1))
);
CREATE UNIQUE INDEX home_chat_open_episode_idx
  ON daily_episodes(home_chat_stream_ref) WHERE archive_status = 'open';
CREATE INDEX daily_episodes_thread_sequence_idx
  ON daily_episodes(thread_ref, last_message_sequence);

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

CREATE TABLE thread_messages (
  message_ref TEXT PRIMARY KEY,
  thread_ref TEXT NOT NULL REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  thread_sequence INTEGER NOT NULL CHECK (thread_sequence > 0),
  client_message_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('person', 'assistant', 'agent', 'system')),
  actor_person_ref TEXT REFERENCES persons(person_ref),
  actor_assignment_ref TEXT,
  actor_agent_ref TEXT REFERENCES agents(agent_ref),
  actor_provider_profile_ref TEXT REFERENCES provider_profiles(provider_profile_ref),
  actor_system_ref TEXT,
  origin_device_ref TEXT REFERENCES managed_devices(device_ref),
  origin_connection_ref TEXT,
  entry_audience TEXT NOT NULL CHECK (entry_audience IN ('personal', 'family_admin', 'system')),
  content_type TEXT NOT NULL CHECK (content_type = 'text'),
  content_text TEXT NOT NULL CHECK (length(content_text) > 0),
  content_language TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (actor_type = 'person' AND actor_person_ref IS NOT NULL AND origin_device_ref IS NOT NULL
      AND actor_assignment_ref IS NULL AND actor_agent_ref IS NULL
      AND actor_provider_profile_ref IS NULL AND actor_system_ref IS NULL) OR
    (actor_type = 'assistant' AND actor_person_ref IS NULL AND actor_assignment_ref IS NOT NULL
      AND actor_agent_ref IS NOT NULL AND actor_provider_profile_ref IS NOT NULL
      AND actor_system_ref IS NULL) OR
    (actor_type = 'agent' AND actor_person_ref IS NULL AND actor_assignment_ref IS NULL
      AND actor_agent_ref IS NOT NULL AND actor_provider_profile_ref IS NOT NULL
      AND actor_system_ref IS NULL) OR
    (actor_type = 'system' AND actor_person_ref IS NULL AND actor_assignment_ref IS NULL
      AND actor_agent_ref IS NULL AND actor_provider_profile_ref IS NULL
      AND actor_system_ref IS NOT NULL AND entry_audience = 'system')
  )
);
CREATE UNIQUE INDEX thread_messages_sequence_idx
  ON thread_messages(thread_ref, thread_sequence);
CREATE UNIQUE INDEX thread_messages_client_id_idx
  ON thread_messages(thread_ref, client_message_id);
CREATE INDEX thread_messages_page_idx
  ON thread_messages(thread_ref, thread_sequence DESC);

CREATE TABLE chat_work_conversions (
  conversion_ref TEXT PRIMARY KEY,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  home_chat_stream_ref TEXT NOT NULL REFERENCES home_chat_streams(home_chat_stream_ref),
  daily_episode_ref TEXT REFERENCES daily_episodes(daily_episode_ref),
  work_conversation_ref TEXT NOT NULL UNIQUE REFERENCES work_conversations(work_conversation_ref) ON DELETE CASCADE,
  decisions_json TEXT NOT NULL,
  open_questions_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE chat_work_conversion_messages (
  conversion_ref TEXT NOT NULL REFERENCES chat_work_conversions(conversion_ref) ON DELETE CASCADE,
  message_ref TEXT NOT NULL REFERENCES thread_messages(message_ref),
  source_order INTEGER NOT NULL CHECK (source_order >= 0),
  PRIMARY KEY (conversion_ref, message_ref),
  UNIQUE (conversion_ref, source_order)
);

CREATE TABLE work_progress_snapshots (
  work_conversation_ref TEXT PRIMARY KEY REFERENCES work_conversations(work_conversation_ref) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'paused', 'waiting_confirmation', 'completed', 'archived')
  ),
  phase_summary TEXT NOT NULL,
  incomplete_tasks_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  pending_confirmations_json TEXT NOT NULL,
  deadlines_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const MIGRATION_V5 = `
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
`;

const MIGRATION_V6 = `
ALTER TABLE mobile_pairing_codes
  ADD COLUMN web_claim_session_ref TEXT REFERENCES entry_sessions(entry_session_ref);
ALTER TABLE mobile_pairing_codes
  ADD COLUMN web_replay_count INTEGER NOT NULL DEFAULT 0
  CHECK (web_replay_count >= 0);
`;

const MIGRATION_V7 = `
ALTER TABLE assistant_assignments
  ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));
UPDATE assistant_assignments SET is_default = 1 WHERE status = 'active';
DROP INDEX person_active_assistant_assignment_idx;
CREATE UNIQUE INDEX person_agent_active_assistant_assignment_idx
  ON assistant_assignments(person_ref, agent_ref) WHERE status = 'active';
CREATE UNIQUE INDEX person_default_assistant_assignment_idx
  ON assistant_assignments(person_ref)
  WHERE status = 'active' AND is_default = 1;

CREATE TABLE agent_runtime_bindings (
  agent_ref TEXT PRIMARY KEY REFERENCES agents(agent_ref),
  provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE admin_agent_assignments (
  assignment_ref TEXT PRIMARY KEY,
  family_ref TEXT NOT NULL REFERENCES families(family_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
  provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  effective_from TEXT NOT NULL,
  effective_to TEXT
);
CREATE UNIQUE INDEX admin_person_agent_active_assignment_idx
  ON admin_agent_assignments(family_ref, person_ref, agent_ref)
  WHERE status = 'active';

CREATE TABLE interaction_threads_v7 (
  thread_ref TEXT PRIMARY KEY,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  family_ref TEXT REFERENCES families(family_ref) ON DELETE CASCADE,
  agent_ref TEXT NOT NULL DEFAULT 'agent:personal-assistant' REFERENCES agents(agent_ref),
  entry_audience TEXT NOT NULL DEFAULT 'personal'
    CHECK (entry_audience IN ('personal', 'family_admin')),
  thread_kind TEXT NOT NULL CHECK (thread_kind IN ('home_chat', 'work')),
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  CHECK (
    (entry_audience = 'personal' AND family_ref IS NULL) OR
    (entry_audience = 'family_admin' AND family_ref IS NOT NULL)
  )
);

CREATE TABLE home_chat_streams_v7 (
  home_chat_stream_ref TEXT PRIMARY KEY,
  thread_ref TEXT NOT NULL UNIQUE REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  agent_ref TEXT NOT NULL DEFAULT 'agent:personal-assistant' REFERENCES agents(agent_ref),
  entry_audience TEXT NOT NULL DEFAULT 'personal'
    CHECK (entry_audience IN ('personal', 'family_admin')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended'))
);

CREATE TABLE work_conversations_v7 (
  work_conversation_ref TEXT PRIMARY KEY,
  thread_ref TEXT NOT NULL UNIQUE REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  agent_ref TEXT NOT NULL DEFAULT 'agent:personal-assistant' REFERENCES agents(agent_ref),
  entry_audience TEXT NOT NULL DEFAULT 'personal'
    CHECK (entry_audience IN ('personal', 'family_admin')),
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

CREATE TABLE thread_provider_contexts_v7 (
  thread_ref TEXT PRIMARY KEY REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  provider_conversation_ref TEXT NOT NULL UNIQUE,
  assignment_ref TEXT REFERENCES assistant_assignments(assignment_ref),
  agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
  provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
  entry_audience TEXT NOT NULL DEFAULT 'personal'
    CHECK (entry_audience IN ('personal', 'family_admin')),
  external_session_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (entry_audience = 'personal' AND assignment_ref IS NOT NULL) OR
    (entry_audience = 'family_admin' AND assignment_ref IS NULL)
  )
);

CREATE TABLE thread_provider_turns_v7 (
  user_message_ref TEXT PRIMARY KEY REFERENCES thread_messages(message_ref) ON DELETE CASCADE,
  thread_ref TEXT NOT NULL REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  invocation_ref TEXT NOT NULL UNIQUE,
  correlation_ref TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  assignment_ref TEXT REFERENCES assistant_assignments(assignment_ref),
  agent_ref TEXT NOT NULL REFERENCES agents(agent_ref),
  provider_profile_ref TEXT NOT NULL REFERENCES provider_profiles(provider_profile_ref),
  entry_audience TEXT NOT NULL DEFAULT 'personal'
    CHECK (entry_audience IN ('personal', 'family_admin')),
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
  ),
  CHECK (
    (entry_audience = 'personal' AND assignment_ref IS NOT NULL) OR
    (entry_audience = 'family_admin' AND assignment_ref IS NULL)
  )
);
`;

const MIGRATION_V7_RENAME_AND_INDEXES = `
DROP TRIGGER IF EXISTS domain_event_home_chat_created;
DROP TRIGGER IF EXISTS domain_event_work_created;
DROP TRIGGER IF EXISTS domain_event_thread_message_created;
DROP TRIGGER IF EXISTS domain_event_chat_work_created;
DROP TRIGGER IF EXISTS domain_event_chat_work_source_message_added;
DROP TRIGGER IF EXISTS domain_event_work_progress_inserted;
DROP TRIGGER IF EXISTS domain_event_work_progress_updated;
DROP TRIGGER IF EXISTS domain_event_provider_turn_failed;
DROP TRIGGER IF EXISTS domain_event_provider_turn_succeeded;

DROP TABLE thread_provider_turns;
DROP TABLE thread_provider_contexts;
DROP TABLE home_chat_streams;
DROP TABLE work_conversations;
DROP TABLE interaction_threads;

ALTER TABLE interaction_threads_v7 RENAME TO interaction_threads;
ALTER TABLE home_chat_streams_v7 RENAME TO home_chat_streams;
ALTER TABLE work_conversations_v7 RENAME TO work_conversations;
ALTER TABLE thread_provider_contexts_v7 RENAME TO thread_provider_contexts;
ALTER TABLE thread_provider_turns_v7 RENAME TO thread_provider_turns;

CREATE INDEX interaction_threads_person_kind_active_idx
  ON interaction_threads(person_ref, thread_kind, last_active_at DESC);
CREATE UNIQUE INDEX person_active_home_chat_idx
  ON home_chat_streams(person_ref, agent_ref)
  WHERE status = 'active' AND entry_audience = 'personal';
CREATE INDEX work_conversations_person_status_idx
  ON work_conversations(person_ref, status, work_conversation_ref);
CREATE INDEX thread_provider_context_person_idx
  ON thread_provider_contexts(person_ref, thread_ref);
CREATE INDEX thread_provider_turns_thread_status_idx
  ON thread_provider_turns(thread_ref, status, requested_at);
`;

interface ThreadAgentBackfill {
  threadRef: string;
  agentRef: string;
}

function resolveThreadAgentBackfills(db: GatewayDatabase): ThreadAgentBackfill[] {
  const threads = db.prepare(
    "SELECT thread_ref FROM interaction_threads ORDER BY thread_ref"
  ).all() as Array<{ thread_ref: string }>;
  const contextAgents = db.prepare(
    "SELECT agent_ref FROM thread_provider_contexts WHERE thread_ref = ?"
  );
  const assignmentAgents = db.prepare(
    `SELECT aa.agent_ref
     FROM assistant_assignments aa
     JOIN interaction_threads it ON it.person_ref = aa.person_ref
     WHERE it.thread_ref = ? AND aa.status = 'active'`
  );

  return threads.map(({ thread_ref: threadRef }) => {
    const fromContext = contextAgents.all(threadRef) as Array<{ agent_ref: string }>;
    const candidates = fromContext.length > 0
      ? fromContext
      : assignmentAgents.all(threadRef) as Array<{ agent_ref: string }>;
    if (candidates.length !== 1) {
      throw new Error(`Cannot backfill Agent for ${threadRef}`);
    }
    return { threadRef, agentRef: candidates[0]!.agent_ref };
  });
}

function applyMigrationV7(db: GatewayDatabase): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      const threadAgents = resolveThreadAgentBackfills(db);
      db.exec(MIGRATION_V7);
      const insertThread = db.prepare(
        `INSERT INTO interaction_threads_v7
         (thread_ref, person_ref, family_ref, agent_ref, entry_audience, thread_kind,
          last_sequence, created_at, last_active_at)
         SELECT thread_ref, person_ref, NULL, ?, 'personal', thread_kind,
                last_sequence, created_at, last_active_at
         FROM interaction_threads WHERE thread_ref = ?`
      );
      for (const thread of threadAgents) {
        insertThread.run(thread.agentRef, thread.threadRef);
      }
      db.exec(`
        INSERT INTO home_chat_streams_v7
          (home_chat_stream_ref, thread_ref, person_ref, agent_ref, entry_audience, status)
        SELECT h.home_chat_stream_ref, h.thread_ref, h.person_ref, t.agent_ref,
               t.entry_audience, h.status
        FROM home_chat_streams h
        JOIN interaction_threads_v7 t ON t.thread_ref = h.thread_ref;
        INSERT INTO work_conversations_v7
          (work_conversation_ref, thread_ref, person_ref, agent_ref, entry_audience,
           title, goal, summary, status, archived_at)
        SELECT w.work_conversation_ref, w.thread_ref, w.person_ref, t.agent_ref,
               t.entry_audience, w.title, w.goal, w.summary, w.status, w.archived_at
        FROM work_conversations w
        JOIN interaction_threads_v7 t ON t.thread_ref = w.thread_ref;
        INSERT INTO thread_provider_contexts_v7
          (thread_ref, person_ref, provider_conversation_ref, assignment_ref, agent_ref,
           provider_profile_ref, entry_audience, external_session_ref, created_at, updated_at)
        SELECT c.thread_ref, c.person_ref, c.provider_conversation_ref, c.assignment_ref,
               c.agent_ref, c.provider_profile_ref, t.entry_audience,
               c.external_session_ref, c.created_at, c.updated_at
        FROM thread_provider_contexts c
        JOIN interaction_threads_v7 t ON t.thread_ref = c.thread_ref;
        INSERT INTO thread_provider_turns_v7
          (user_message_ref, thread_ref, invocation_ref, correlation_ref, idempotency_key,
           assignment_ref, agent_ref, provider_profile_ref, entry_audience, status,
           attempt_count, assistant_message_ref, error_json, requested_at, completed_at)
        SELECT p.user_message_ref, p.thread_ref, p.invocation_ref, p.correlation_ref,
               p.idempotency_key, p.assignment_ref, p.agent_ref, p.provider_profile_ref,
               t.entry_audience, p.status, p.attempt_count, p.assistant_message_ref,
               p.error_json, p.requested_at, p.completed_at
        FROM thread_provider_turns p
        JOIN interaction_threads_v7 t ON t.thread_ref = p.thread_ref;
      `);
      db.exec(MIGRATION_V7_RENAME_AND_INDEXES);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(7, ?)").run(
        new Date().toISOString()
      );
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

const MIGRATION_V8 = `
DROP TRIGGER IF EXISTS domain_event_thread_message_created;

CREATE TABLE thread_messages_v8 (
  message_ref TEXT PRIMARY KEY,
  thread_ref TEXT NOT NULL REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  thread_sequence INTEGER NOT NULL CHECK (thread_sequence > 0),
  client_message_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('person', 'assistant', 'agent', 'system')),
  actor_person_ref TEXT REFERENCES persons(person_ref),
  actor_assignment_ref TEXT,
  actor_agent_ref TEXT REFERENCES agents(agent_ref),
  actor_provider_profile_ref TEXT REFERENCES provider_profiles(provider_profile_ref),
  actor_system_ref TEXT,
  origin_device_ref TEXT REFERENCES managed_devices(device_ref),
  origin_connection_ref TEXT,
  entry_audience TEXT NOT NULL CHECK (entry_audience IN ('personal', 'family_admin', 'system')),
  content_type TEXT NOT NULL CHECK (content_type = 'text'),
  content_text TEXT NOT NULL CHECK (length(content_text) <= 12000),
  content_language TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (actor_type = 'person' AND actor_person_ref IS NOT NULL AND origin_device_ref IS NOT NULL
      AND actor_assignment_ref IS NULL AND actor_agent_ref IS NULL
      AND actor_provider_profile_ref IS NULL AND actor_system_ref IS NULL) OR
    (actor_type = 'assistant' AND actor_person_ref IS NULL AND actor_assignment_ref IS NOT NULL
      AND actor_agent_ref IS NOT NULL AND actor_provider_profile_ref IS NOT NULL
      AND actor_system_ref IS NULL) OR
    (actor_type = 'agent' AND actor_person_ref IS NULL AND actor_assignment_ref IS NULL
      AND actor_agent_ref IS NOT NULL AND actor_provider_profile_ref IS NOT NULL
      AND actor_system_ref IS NULL) OR
    (actor_type = 'system' AND actor_person_ref IS NULL AND actor_assignment_ref IS NULL
      AND actor_agent_ref IS NULL AND actor_provider_profile_ref IS NULL
      AND actor_system_ref IS NOT NULL AND entry_audience = 'system')
  )
);

INSERT INTO thread_messages_v8
  (message_ref, thread_ref, thread_sequence, client_message_id, actor_type,
   actor_person_ref, actor_assignment_ref, actor_agent_ref,
   actor_provider_profile_ref, actor_system_ref, origin_device_ref,
   origin_connection_ref, entry_audience, content_type, content_text,
   content_language, occurred_at, created_at)
SELECT
   message_ref, thread_ref, thread_sequence, client_message_id, actor_type,
   actor_person_ref, actor_assignment_ref, actor_agent_ref,
   actor_provider_profile_ref, actor_system_ref, origin_device_ref,
   origin_connection_ref, entry_audience, content_type, content_text,
   content_language, occurred_at, created_at
FROM thread_messages;

DROP INDEX thread_messages_sequence_idx;
DROP INDEX thread_messages_client_id_idx;
DROP INDEX thread_messages_page_idx;
DROP TABLE thread_messages;
ALTER TABLE thread_messages_v8 RENAME TO thread_messages;

CREATE UNIQUE INDEX thread_messages_sequence_idx
  ON thread_messages(thread_ref, thread_sequence);
CREATE UNIQUE INDEX thread_messages_client_id_idx
  ON thread_messages(thread_ref, client_message_id);
CREATE INDEX thread_messages_page_idx
  ON thread_messages(thread_ref, thread_sequence DESC);

CREATE TABLE attachments (
  attachment_ref TEXT PRIMARY KEY,
  family_ref TEXT NOT NULL REFERENCES families(family_ref) ON DELETE CASCADE,
  owner_person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  declared_media_type TEXT NOT NULL CHECK (length(declared_media_type) BETWEEN 3 AND 127),
  detected_media_type TEXT CHECK (
    detected_media_type IS NULL OR length(detected_media_type) BETWEEN 3 AND 127
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
  reserved_bytes INTEGER NOT NULL CHECK (
    reserved_bytes >= 0 AND reserved_bytes <= size_bytes
  ),
  sha256 TEXT CHECK (
    sha256 IS NULL OR
    (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  storage_key TEXT UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN ('uploading', 'ready', 'attached', 'expired', 'deleted')
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  completed_at TEXT,
  attached_at TEXT,
  CHECK (
    (state = 'uploading' AND reserved_bytes = size_bytes AND sha256 IS NULL
      AND storage_key IS NULL AND expires_at IS NOT NULL
      AND completed_at IS NULL AND attached_at IS NULL) OR
    (state = 'ready' AND reserved_bytes = size_bytes AND sha256 IS NOT NULL
      AND storage_key IS NOT NULL AND expires_at IS NULL
      AND completed_at IS NOT NULL AND attached_at IS NULL) OR
    (state = 'attached' AND reserved_bytes = size_bytes AND sha256 IS NOT NULL
      AND storage_key IS NOT NULL AND expires_at IS NULL
      AND completed_at IS NOT NULL AND attached_at IS NOT NULL) OR
    (state IN ('expired', 'deleted') AND reserved_bytes = 0)
  )
);
CREATE INDEX attachments_family_quota_state_idx
  ON attachments(family_ref, state, reserved_bytes);
CREATE INDEX attachments_owner_state_idx
  ON attachments(owner_person_ref, state, created_at);
CREATE INDEX attachments_expiry_idx
  ON attachments(state, expires_at) WHERE state = 'uploading';

CREATE TABLE attachment_chunks (
  attachment_ref TEXT NOT NULL REFERENCES attachments(attachment_ref) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 25),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  storage_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attachment_ref, chunk_index)
);

CREATE TABLE message_attachments (
  message_ref TEXT NOT NULL REFERENCES thread_messages(message_ref) ON DELETE CASCADE,
  attachment_ref TEXT NOT NULL UNIQUE REFERENCES attachments(attachment_ref),
  attachment_order INTEGER NOT NULL CHECK (
    attachment_order >= 0 AND attachment_order < 10
  ),
  PRIMARY KEY (message_ref, attachment_ref),
  UNIQUE (message_ref, attachment_order)
);
CREATE INDEX message_attachments_message_order_idx
  ON message_attachments(message_ref, attachment_order);
`;

function applyMigrationV8(db: GatewayDatabase): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(MIGRATION_V8);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(8, ?)"
      ).run(new Date().toISOString());
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Gateway V8 migration produced foreign key violations");
  }
}

function latestMigrationVersion(db: GatewayDatabase): number {
  const row = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;
  return row?.version ?? 0;
}

function applyMigrations(db: GatewayDatabase, migrationLimit: 6 | 7 | 8): void {
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
  }

  let latest = latestMigrationVersion(db);
  if (latest > migrationLimit || latest < 1) {
    throw new Error(`Unsupported Gateway schema version: ${latest}`);
  }
  if (latest === 1) {
    db.transaction(() => {
      db.exec(MIGRATION_V2);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(2, ?)").run(
        new Date().toISOString()
      );
    })();
    latest = 2;
  }
  if (latest === 2) {
    db.transaction(() => {
      db.exec(MIGRATION_V3);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?)").run(
        new Date().toISOString()
      );
    })();
    latest = 3;
  }
  if (latest === 3) {
    db.transaction(() => {
      db.exec(MIGRATION_V4);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?)").run(
        new Date().toISOString()
      );
    })();
    latest = 4;
  }
  if (latest === 4) {
    db.transaction(() => {
      db.exec(MIGRATION_V5);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?)").run(
        new Date().toISOString()
      );
    })();
    latest = 5;
  }
  if (latest === 5) {
    db.transaction(() => {
      db.exec(MIGRATION_V6);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(6, ?)").run(
        new Date().toISOString()
      );
    })();
    latest = 6;
  }
  if (latest === 6 && migrationLimit >= 7) {
    applyMigrationV7(db);
    latest = 7;
  }
  if (latest === 7 && migrationLimit === 8) {
    applyMigrationV8(db);
    latest = 8;
  }
  if (latest !== migrationLimit) {
    throw new Error(`Unsupported Gateway schema version: ${latest}`);
  }
}

export interface GatewayDatabaseOpenOptions {
  migrationLimit?: 6 | 7 | 8;
}

export function openGatewayDatabase(
  databasePath: string,
  options: GatewayDatabaseOpenOptions = {}
): GatewayDatabase {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  applyMigrations(db, options.migrationLimit ?? 8);
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
