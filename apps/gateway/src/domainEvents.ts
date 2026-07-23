import { randomUUID } from "node:crypto";
import type { PublicError } from "@family-ai/contracts";
import type { GatewayDatabase } from "./database.js";

export const DOMAIN_EVENT_SCHEMA_VERSION = 1 as const;

export interface DomainEvent {
  eventRef: string;
  personRef: string;
  eventSequence: number;
  eventType: string;
  aggregateType: string;
  aggregateRef: string;
  threadRef: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface DomainEventPage {
  events: DomainEvent[];
  nextAfterSequence: number | null;
}

export interface OutboxDelivery {
  event: DomainEvent;
  attemptCount: number;
  claimedBy: string;
  claimedUntil: string;
}

const DOMAIN_EVENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS domain_event_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_event_sequences (
  person_ref TEXT PRIMARY KEY REFERENCES persons(person_ref) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_events (
  event_ref TEXT PRIMARY KEY,
  person_ref TEXT NOT NULL REFERENCES persons(person_ref) ON DELETE CASCADE,
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL CHECK (
    aggregate_type IN (
      'home_chat',
      'work',
      'thread_message',
      'chat_work_conversion',
      'work_progress',
      'provider_turn'
    )
  ),
  aggregate_ref TEXT NOT NULL,
  thread_ref TEXT REFERENCES interaction_threads(thread_ref) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (person_ref, event_sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS domain_events_person_sequence_idx
  ON domain_events(person_ref, event_sequence);

CREATE TABLE IF NOT EXISTS outbox_events (
  event_ref TEXT PRIMARY KEY REFERENCES domain_events(event_ref) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'published')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TEXT NOT NULL,
  claimed_by TEXT,
  claimed_until TEXT,
  published_at TEXT,
  last_error_json TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'pending' AND claimed_by IS NULL AND claimed_until IS NULL AND published_at IS NULL) OR
    (status = 'claimed' AND claimed_by IS NOT NULL AND claimed_until IS NOT NULL
      AND published_at IS NULL) OR
    (status = 'published' AND claimed_by IS NULL AND claimed_until IS NULL
      AND published_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS outbox_events_dispatch_idx
  ON outbox_events(status, available_at, claimed_until, event_ref);

CREATE TRIGGER IF NOT EXISTS domain_event_home_chat_created
AFTER INSERT ON daily_episodes
WHEN NEW.boundary_reason = 'initial'
BEGIN
  INSERT INTO person_event_sequences(person_ref, last_sequence, updated_at)
  VALUES(
    (SELECT person_ref FROM home_chat_streams
      WHERE home_chat_stream_ref = NEW.home_chat_stream_ref),
    1,
    NEW.started_at
  )
  ON CONFLICT(person_ref) DO UPDATE SET
    last_sequence = last_sequence + 1,
    updated_at = excluded.updated_at;

  INSERT INTO domain_events(
    event_ref, person_ref, event_sequence, event_type, aggregate_type,
    aggregate_ref, thread_ref, payload_json, occurred_at, created_at
  )
  VALUES(
    'event:' || lower(hex(randomblob(16))),
    (SELECT person_ref FROM home_chat_streams
      WHERE home_chat_stream_ref = NEW.home_chat_stream_ref),
    (SELECT last_sequence FROM person_event_sequences
      WHERE person_ref = (SELECT person_ref FROM home_chat_streams
        WHERE home_chat_stream_ref = NEW.home_chat_stream_ref)),
    'chat.home.created',
    'home_chat',
    NEW.home_chat_stream_ref,
    NEW.thread_ref,
    json_object(
      'homeChatStreamRef', NEW.home_chat_stream_ref,
      'dailyEpisodeRef', NEW.daily_episode_ref,
      'threadRef', NEW.thread_ref
    ),
    NEW.started_at,
    NEW.started_at
  );

  INSERT INTO outbox_events(
    event_ref, status, attempt_count, available_at, claimed_by, claimed_until,
    published_at, last_error_json, updated_at
  )
  SELECT event_ref, 'pending', 0, NEW.started_at, NULL, NULL, NULL, NULL, NEW.started_at
  FROM domain_events WHERE rowid = last_insert_rowid();
END;

CREATE TRIGGER IF NOT EXISTS domain_event_work_created
AFTER INSERT ON work_conversations
BEGIN
  INSERT INTO person_event_sequences(person_ref, last_sequence, updated_at)
  VALUES(
    NEW.person_ref,
    1,
    (SELECT created_at FROM interaction_threads WHERE thread_ref = NEW.thread_ref)
  )
  ON CONFLICT(person_ref) DO UPDATE SET
    last_sequence = last_sequence + 1,
    updated_at = excluded.updated_at;

  INSERT INTO domain_events(
    event_ref, person_ref, event_sequence, event_type, aggregate_type,
    aggregate_ref, thread_ref, payload_json, occurred_at, created_at
  )
  VALUES(
    'event:' || lower(hex(randomblob(16))),
    NEW.person_ref,
    (SELECT last_sequence FROM person_event_sequences WHERE person_ref = NEW.person_ref),
    'work.created',
    'work',
    NEW.work_conversation_ref,
    NEW.thread_ref,
    json_object(
      'workConversationRef', NEW.work_conversation_ref,
      'threadRef', NEW.thread_ref,
      'status', NEW.status
    ),
    (SELECT created_at FROM interaction_threads WHERE thread_ref = NEW.thread_ref),
    (SELECT created_at FROM interaction_threads WHERE thread_ref = NEW.thread_ref)
  );

  INSERT INTO outbox_events(
    event_ref, status, attempt_count, available_at, claimed_by, claimed_until,
    published_at, last_error_json, updated_at
  )
  SELECT event_ref, 'pending', 0, occurred_at, NULL, NULL, NULL, NULL, created_at
  FROM domain_events WHERE rowid = last_insert_rowid();
END;

CREATE TRIGGER IF NOT EXISTS domain_event_thread_message_created
AFTER INSERT ON thread_messages
BEGIN
  INSERT INTO person_event_sequences(person_ref, last_sequence, updated_at)
  VALUES(
    (SELECT person_ref FROM interaction_threads WHERE thread_ref = NEW.thread_ref),
    1,
    NEW.created_at
  )
  ON CONFLICT(person_ref) DO UPDATE SET
    last_sequence = last_sequence + 1,
    updated_at = excluded.updated_at;

  INSERT INTO domain_events(
    event_ref, person_ref, event_sequence, event_type, aggregate_type,
    aggregate_ref, thread_ref, payload_json, occurred_at, created_at
  )
  VALUES(
    'event:' || lower(hex(randomblob(16))),
    (SELECT person_ref FROM interaction_threads WHERE thread_ref = NEW.thread_ref),
    (SELECT last_sequence FROM person_event_sequences
      WHERE person_ref = (SELECT person_ref FROM interaction_threads
        WHERE thread_ref = NEW.thread_ref)),
    'thread.message.created',
    'thread_message',
    NEW.message_ref,
    NEW.thread_ref,
    json_object(
      'messageRef', NEW.message_ref,
      'threadRef', NEW.thread_ref,
      'threadSequence', NEW.thread_sequence,
      'actorType', NEW.actor_type,
      'clientMessageId', NEW.client_message_id
    ),
    NEW.occurred_at,
    NEW.created_at
  );

  INSERT INTO outbox_events(
    event_ref, status, attempt_count, available_at, claimed_by, claimed_until,
    published_at, last_error_json, updated_at
  )
  SELECT event_ref, 'pending', 0, NEW.created_at, NULL, NULL, NULL, NULL, NEW.created_at
  FROM domain_events WHERE rowid = last_insert_rowid();
END;

CREATE TRIGGER IF NOT EXISTS domain_event_chat_work_created
AFTER INSERT ON chat_work_conversions
BEGIN
  INSERT INTO person_event_sequences(person_ref, last_sequence, updated_at)
  VALUES(NEW.person_ref, 1, NEW.created_at)
  ON CONFLICT(person_ref) DO UPDATE SET
    last_sequence = last_sequence + 1,
    updated_at = excluded.updated_at;

  INSERT INTO domain_events(
    event_ref, person_ref, event_sequence, event_type, aggregate_type,
    aggregate_ref, thread_ref, payload_json, occurred_at, created_at
  )
  VALUES(
    'event:' || lower(hex(randomblob(16))),
    NEW.person_ref,
    (SELECT last_sequence FROM person_event_sequences WHERE person_ref = NEW.person_ref),
    'chat.work.created',
    'chat_work_conversion',
    NEW.conversion_ref,
    (SELECT thread_ref FROM work_conversations
      WHERE work_conversation_ref = NEW.work_conversation_ref),
    json_object(
      'conversionRef', NEW.conversion_ref,
      'homeChatStreamRef', NEW.home_chat_stream_ref,
      'workConversationRef', NEW.work_conversation_ref,
      'sourceMessageRefs', json_array()
    ),
    NEW.created_at,
    NEW.created_at
  );

  INSERT INTO outbox_events(
    event_ref, status, attempt_count, available_at, claimed_by, claimed_until,
    published_at, last_error_json, updated_at
  )
  SELECT event_ref, 'pending', 0, NEW.created_at, NULL, NULL, NULL, NULL, NEW.created_at
  FROM domain_events WHERE rowid = last_insert_rowid();
END;

CREATE TRIGGER IF NOT EXISTS domain_event_work_progress_inserted
AFTER INSERT ON work_progress_snapshots
BEGIN
  INSERT INTO person_event_sequences(person_ref, last_sequence, updated_at)
  VALUES(
    (SELECT person_ref FROM work_conversations
      WHERE work_conversation_ref = NEW.work_conversation_ref),
    1,
    NEW.updated_at
  )
  ON CONFLICT(person_ref) DO UPDATE SET
    last_sequence = last_sequence + 1,
    updated_at = excluded.updated_at;

  INSERT INTO domain_events(
    event_ref, person_ref, event_sequence, event_type, aggregate_type,
    aggregate_ref, thread_ref, payload_json, occurred_at, created_at
  )
  VALUES(
    'event:' || lower(hex(randomblob(16))),
    (SELECT person_ref FROM work_conversations
      WHERE work_conversation_ref = NEW.work_conversation_ref),
    (SELECT last_sequence FROM person_event_sequences
      WHERE person_ref = (SELECT person_ref FROM work_conversations
        WHERE work_conversation_ref = NEW.work_conversation_ref)),
    'work.progress.updated',
    'work_progress',
    NEW.work_conversation_ref,
    (SELECT thread_ref FROM work_conversations
      WHERE work_conversation_ref = NEW.work_conversation_ref),
    json_object(
      'workConversationRef', NEW.work_conversation_ref,
      'status', NEW.status,
      'updatedAt', NEW.updated_at
    ),
    NEW.updated_at,
    NEW.updated_at
  );

  INSERT INTO outbox_events(
    event_ref, status, attempt_count, available_at, claimed_by, claimed_until,
    published_at, last_error_json, updated_at
  )
  SELECT event_ref, 'pending', 0, NEW.updated_at, NULL, NULL, NULL, NULL, NEW.updated_at
  FROM domain_events WHERE rowid = last_insert_rowid();
END;

CREATE TRIGGER IF NOT EXISTS domain_event_work_progress_updated
AFTER UPDATE ON work_progress_snapshots
BEGIN
  INSERT INTO person_event_sequences(person_ref, last_sequence, updated_at)
  VALUES(
    (SELECT person_ref FROM work_conversations
      WHERE work_conversation_ref = NEW.work_conversation_ref),
    1,
    NEW.updated_at
  )
  ON CONFLICT(person_ref) DO UPDATE SET
    last_sequence = last_sequence + 1,
    updated_at = excluded.updated_at;

  INSERT INTO domain_events(
    event_ref, person_ref, event_sequence, event_type, aggregate_type,
    aggregate_ref, thread_ref, payload_json, occurred_at, created_at
  )
  VALUES(
    'event:' || lower(hex(randomblob(16))),
    (SELECT person_ref FROM work_conversations
      WHERE work_conversation_ref = NEW.work_conversation_ref),
    (SELECT last_sequence FROM person_event_sequences
      WHERE person_ref = (SELECT person_ref FROM work_conversations
        WHERE work_conversation_ref = NEW.work_conversation_ref)),
    'work.progress.updated',
    'work_progress',
    NEW.work_conversation_ref,
    (SELECT thread_ref FROM work_conversations
      WHERE work_conversation_ref = NEW.work_conversation_ref),
    json_object(
      'workConversationRef', NEW.work_conversation_ref,
      'status', NEW.status,
      'updatedAt', NEW.updated_at
    ),
    NEW.updated_at,
    NEW.updated_at
  );

  INSERT INTO outbox_events(
    event_ref, status, attempt_count, available_at, claimed_by, claimed_until,
    published_at, last_error_json, updated_at
  )
  SELECT event_ref, 'pending', 0, NEW.updated_at, NULL, NULL, NULL, NULL, NEW.updated_at
  FROM domain_events WHERE rowid = last_insert_rowid();
END;

CREATE TRIGGER IF NOT EXISTS domain_event_provider_turn_failed
AFTER UPDATE OF status ON thread_provider_turns
WHEN NEW.status = 'failed' AND OLD.status <> 'failed'
BEGIN
  INSERT INTO person_event_sequences(person_ref, last_sequence, updated_at)
  VALUES(
    (SELECT person_ref FROM interaction_threads WHERE thread_ref = NEW.thread_ref),
    1,
    NEW.completed_at
  )
  ON CONFLICT(person_ref) DO UPDATE SET
    last_sequence = last_sequence + 1,
    updated_at = excluded.updated_at;

  INSERT INTO domain_events(
    event_ref, person_ref, event_sequence, event_type, aggregate_type,
    aggregate_ref, thread_ref, payload_json, occurred_at, created_at
  )
  VALUES(
    'event:' || lower(hex(randomblob(16))),
    (SELECT person_ref FROM interaction_threads WHERE thread_ref = NEW.thread_ref),
    (SELECT last_sequence FROM person_event_sequences
      WHERE person_ref = (SELECT person_ref FROM interaction_threads
        WHERE thread_ref = NEW.thread_ref)),
    'thread.provider_turn.failed',
    'provider_turn',
    NEW.user_message_ref,
    NEW.thread_ref,
    json_object(
      'userMessageRef', NEW.user_message_ref,
      'threadRef', NEW.thread_ref,
      'attemptCount', NEW.attempt_count,
      'error', json_object(
        'code', json_extract(NEW.error_json, '$.code'),
        'category', json_extract(NEW.error_json, '$.category'),
        'retryable', json_extract(NEW.error_json, '$.retryable')
      )
    ),
    NEW.completed_at,
    NEW.completed_at
  );

  INSERT INTO outbox_events(
    event_ref, status, attempt_count, available_at, claimed_by, claimed_until,
    published_at, last_error_json, updated_at
  )
  SELECT event_ref, 'pending', 0, NEW.completed_at, NULL, NULL, NULL, NULL, NEW.completed_at
  FROM domain_events WHERE rowid = last_insert_rowid();
END;

CREATE TRIGGER IF NOT EXISTS domain_event_provider_turn_succeeded
AFTER UPDATE OF status ON thread_provider_turns
WHEN NEW.status = 'succeeded' AND OLD.status <> 'succeeded'
BEGIN
  INSERT INTO person_event_sequences(person_ref, last_sequence, updated_at)
  VALUES(
    (SELECT person_ref FROM interaction_threads WHERE thread_ref = NEW.thread_ref),
    1,
    NEW.completed_at
  )
  ON CONFLICT(person_ref) DO UPDATE SET
    last_sequence = last_sequence + 1,
    updated_at = excluded.updated_at;

  INSERT INTO domain_events(
    event_ref, person_ref, event_sequence, event_type, aggregate_type,
    aggregate_ref, thread_ref, payload_json, occurred_at, created_at
  )
  VALUES(
    'event:' || lower(hex(randomblob(16))),
    (SELECT person_ref FROM interaction_threads WHERE thread_ref = NEW.thread_ref),
    (SELECT last_sequence FROM person_event_sequences
      WHERE person_ref = (SELECT person_ref FROM interaction_threads
        WHERE thread_ref = NEW.thread_ref)),
    'thread.provider_turn.succeeded',
    'provider_turn',
    NEW.user_message_ref,
    NEW.thread_ref,
    json_object(
      'userMessageRef', NEW.user_message_ref,
      'assistantMessageRef', NEW.assistant_message_ref,
      'threadRef', NEW.thread_ref,
      'attemptCount', NEW.attempt_count
    ),
    NEW.completed_at,
    NEW.completed_at
  );

  INSERT INTO outbox_events(
    event_ref, status, attempt_count, available_at, claimed_by, claimed_until,
    published_at, last_error_json, updated_at
  )
  SELECT event_ref, 'pending', 0, NEW.completed_at, NULL, NULL, NULL, NULL, NEW.completed_at
  FROM domain_events WHERE rowid = last_insert_rowid();
END;
`;

function parseRecord(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(String(value)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored domain event payload is invalid");
  }
  return parsed as Record<string, unknown>;
}

function mapEvent(row: Record<string, unknown>): DomainEvent {
  return {
    eventRef: String(row.event_ref),
    personRef: String(row.person_ref),
    eventSequence: Number(row.event_sequence),
    eventType: String(row.event_type),
    aggregateType: String(row.aggregate_type),
    aggregateRef: String(row.aggregate_ref),
    threadRef: row.thread_ref === null ? null : String(row.thread_ref),
    payload: parseRecord(row.payload_json),
    occurredAt: String(row.occurred_at),
    createdAt: String(row.created_at)
  };
}

function claimInvalid(): Error {
  return new Error("OUTBOX_CLAIM_INVALID");
}

export class DomainEventStore {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly now: () => Date = () => new Date()
  ) {
    this.installSchema();
  }

  private installSchema(): void {
    const coreVersion = this.db.prepare(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"
    ).get() as { version: number } | undefined;
    if (coreVersion?.version !== 5) {
      throw new Error(`Domain Event schema requires Gateway schema version 5, got ${String(coreVersion?.version)}`);
    }
    this.db.transaction(() => {
      this.db.exec(DOMAIN_EVENT_SCHEMA);
      this.db.prepare(
        "INSERT OR IGNORE INTO domain_event_schema_migrations(version, applied_at) VALUES(?, ?)"
      ).run(DOMAIN_EVENT_SCHEMA_VERSION, this.now().toISOString());
    })();
  }

  append(input: {
    personRef: string;
    eventType: string;
    aggregateType: DomainEvent["aggregateType"];
    aggregateRef: string;
    threadRef?: string | null;
    payload: Record<string, unknown>;
    occurredAt: string;
  }): DomainEvent {
    const append = this.db.transaction(() => {
      const person = this.db.prepare(
        "SELECT 1 FROM persons WHERE person_ref = ? AND status = 'active'"
      ).get(input.personRef);
      if (!person) throw new Error("DOMAIN_EVENT_PERSON_NOT_FOUND");
      if (input.threadRef) {
        const thread = this.db.prepare(
          "SELECT 1 FROM interaction_threads WHERE thread_ref = ? AND person_ref = ?"
        ).get(input.threadRef, input.personRef);
        if (!thread) throw new Error("DOMAIN_EVENT_THREAD_NOT_FOUND");
      }

      const createdAt = this.now().toISOString();
      const sequence = this.db.prepare(
        `INSERT INTO person_event_sequences(person_ref, last_sequence, updated_at)
         VALUES(?, 1, ?)
         ON CONFLICT(person_ref) DO UPDATE SET
           last_sequence = last_sequence + 1,
           updated_at = excluded.updated_at
         RETURNING last_sequence`
      ).get(input.personRef, createdAt) as { last_sequence: number };
      const eventRef = `event:${randomUUID()}`;
      this.db.prepare(
        `INSERT INTO domain_events(
           event_ref, person_ref, event_sequence, event_type, aggregate_type,
           aggregate_ref, thread_ref, payload_json, occurred_at, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        eventRef,
        input.personRef,
        sequence.last_sequence,
        input.eventType,
        input.aggregateType,
        input.aggregateRef,
        input.threadRef ?? null,
        JSON.stringify(input.payload),
        input.occurredAt,
        createdAt
      );
      this.db.prepare(
        `INSERT INTO outbox_events(
           event_ref, status, attempt_count, available_at, claimed_by, claimed_until,
           published_at, last_error_json, updated_at
         ) VALUES(?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?)`
      ).run(eventRef, createdAt, createdAt);
      const row = this.db.prepare("SELECT * FROM domain_events WHERE event_ref = ?")
        .get(eventRef) as Record<string, unknown>;
      return mapEvent(row);
    });
    return append();
  }

  listPersonEvents(input: {
    personRef: string;
    afterSequence?: number;
    limit?: number;
  }): DomainEventPage {
    const after = Math.max(input.afterSequence ?? 0, 0);
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
    const rows = this.db.prepare(
      `SELECT * FROM domain_events
       WHERE person_ref = ? AND event_sequence > ?
       ORDER BY event_sequence ASC
       LIMIT ?`
    ).all(input.personRef, after, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(mapEvent);
    return {
      events,
      nextAfterSequence: hasMore && events.length > 0
        ? events[events.length - 1]!.eventSequence
        : null
    };
  }

  claimOutboxBatch(input: {
    workerRef: string;
    now: string;
    claimedUntil: string;
    limit?: number;
  }): OutboxDelivery[] {
    if (Date.parse(input.claimedUntil) <= Date.parse(input.now)) {
      throw new Error("OUTBOX_LEASE_INVALID");
    }
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
    const claim = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE outbox_events
         SET status = 'pending', claimed_by = NULL, claimed_until = NULL, updated_at = ?
         WHERE status = 'claimed' AND claimed_until <= ?`
      ).run(input.now, input.now);

      const candidates = this.db.prepare(
        `SELECT o.event_ref
         FROM outbox_events o
         JOIN domain_events e ON e.event_ref = o.event_ref
         WHERE o.status = 'pending' AND o.available_at <= ?
         ORDER BY o.available_at, e.person_ref, e.event_sequence
         LIMIT ?`
      ).all(input.now, limit) as Array<{ event_ref: string }>;
      if (candidates.length === 0) return [];

      const update = this.db.prepare(
        `UPDATE outbox_events
         SET status = 'claimed', attempt_count = attempt_count + 1,
             claimed_by = ?, claimed_until = ?, updated_at = ?
         WHERE event_ref = ? AND status = 'pending'`
      );
      const claimedRefs: string[] = [];
      for (const candidate of candidates) {
        const result = update.run(
          input.workerRef,
          input.claimedUntil,
          input.now,
          candidate.event_ref
        );
        if (result.changes === 1) claimedRefs.push(candidate.event_ref);
      }
      if (claimedRefs.length === 0) return [];

      const placeholders = claimedRefs.map(() => "?").join(", ");
      const rows = this.db.prepare(
        `SELECT e.*, o.attempt_count, o.claimed_by, o.claimed_until
         FROM outbox_events o
         JOIN domain_events e ON e.event_ref = o.event_ref
         WHERE o.event_ref IN (${placeholders})
         ORDER BY e.person_ref, e.event_sequence`
      ).all(...claimedRefs) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        event: mapEvent(row),
        attemptCount: Number(row.attempt_count),
        claimedBy: String(row.claimed_by),
        claimedUntil: String(row.claimed_until)
      }));
    });
    return claim();
  }

  markPublished(input: {
    eventRef: string;
    workerRef: string;
    publishedAt: string;
  }): void {
    const result = this.db.prepare(
      `UPDATE outbox_events
       SET status = 'published', claimed_by = NULL, claimed_until = NULL,
           published_at = ?, last_error_json = NULL, updated_at = ?
       WHERE event_ref = ? AND status = 'claimed' AND claimed_by = ?
         AND claimed_until > ?`
    ).run(
      input.publishedAt,
      input.publishedAt,
      input.eventRef,
      input.workerRef,
      input.publishedAt
    );
    if (result.changes !== 1) throw claimInvalid();
  }

  markFailed(input: {
    eventRef: string;
    workerRef: string;
    error: PublicError;
    availableAt: string;
    updatedAt: string;
  }): void {
    const result = this.db.prepare(
      `UPDATE outbox_events
       SET status = 'pending', available_at = ?, claimed_by = NULL, claimed_until = NULL,
           published_at = NULL, last_error_json = ?, updated_at = ?
       WHERE event_ref = ? AND status = 'claimed' AND claimed_by = ?
         AND claimed_until > ?`
    ).run(
      input.availableAt,
      JSON.stringify(input.error),
      input.updatedAt,
      input.eventRef,
      input.workerRef,
      input.updatedAt
    );
    if (result.changes !== 1) throw claimInvalid();
  }
}
