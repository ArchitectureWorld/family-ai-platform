import type { GatewayDatabase } from "./database.js";
import {
  DomainEventStore as CoreDomainEventStore,
  type DomainEvent,
  type DomainEventPage,
  type OutboxDelivery
} from "./domainEventCore.js";

export type { DomainEvent, DomainEventPage, OutboxDelivery };

export const DOMAIN_EVENT_SCHEMA_VERSION = 2 as const;

const DOMAIN_EVENT_MIGRATION_V2 = `
CREATE TABLE IF NOT EXISTS device_sync_cursors (
  device_ref TEXT NOT NULL
    REFERENCES managed_devices(device_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL
    REFERENCES persons(person_ref) ON DELETE CASCADE,
  acknowledged_sequence INTEGER NOT NULL
    CHECK (acknowledged_sequence >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_ref, person_ref)
);
CREATE INDEX IF NOT EXISTS device_sync_cursors_person_sequence_idx
  ON device_sync_cursors(person_ref, acknowledged_sequence, device_ref);
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

export class DomainEventStore extends CoreDomainEventStore {
  private readonly eventDb: GatewayDatabase;
  private readonly eventNow: () => Date;

  constructor(
    db: GatewayDatabase,
    now: () => Date = () => new Date()
  ) {
    super(db, now);
    this.eventDb = db;
    this.eventNow = now;
  }

  getLatestPersonSequence(personRef: string): number {
    const row = this.eventDb.prepare(
      `SELECT COALESCE(MAX(event_sequence), 0) AS latest_sequence
       FROM domain_events WHERE person_ref = ?`
    ).get(personRef) as { latest_sequence: number };
    return Number(row.latest_sequence);
  }

  findPersonEvent(input: {
    personRef: string;
    eventSequence: number;
    eventRef: string;
  }): DomainEvent | null {
    const row = this.eventDb.prepare(
      `SELECT * FROM domain_events
       WHERE person_ref = ? AND event_sequence = ? AND event_ref = ?`
    ).get(input.personRef, input.eventSequence, input.eventRef) as
      | Record<string, unknown>
      | undefined;
    return row ? mapEvent(row) : null;
  }

  installDeviceSyncSchemaForTesting(): void {
    this.eventDb.transaction(() => {
      let latest = (this.eventDb.prepare(
        "SELECT version FROM domain_event_schema_migrations ORDER BY version DESC LIMIT 1"
      ).get() as { version: number } | undefined)?.version ?? 0;

      if (latest > DOMAIN_EVENT_SCHEMA_VERSION || latest < 1) {
        throw new Error(`Unsupported Domain Event schema version: ${latest}`);
      }
      if (latest === 1) {
        this.eventDb.exec(DOMAIN_EVENT_MIGRATION_V2);
        this.eventDb.prepare(
          "INSERT INTO domain_event_schema_migrations(version, applied_at) VALUES(2, ?)"
        ).run(this.eventNow().toISOString());
        latest = 2;
      }
      if (latest !== DOMAIN_EVENT_SCHEMA_VERSION) {
        throw new Error(`Unsupported Domain Event schema version: ${latest}`);
      }
    })();
  }
}
