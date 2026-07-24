import type { GatewayDatabase } from "./database.js";
import type { DomainEventStore } from "./domainEvents.js";

export interface DeviceSyncCursorState {
  deviceRef: string;
  personRef: string;
  acknowledgedSequence: number;
  latestSequence: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DeviceSyncAcknowledgement {
  deviceRef: string;
  personRef: string;
  previousSequence: number;
  acknowledgedSequence: number;
  advanced: boolean;
  updatedAt: string;
}

interface StoredCursor {
  acknowledged_sequence: number;
  created_at: string;
  updated_at: string;
}

export class DeviceSyncRepository {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly events: DomainEventStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  readCursor(input: {
    deviceRef: string;
    personRef: string;
  }): DeviceSyncCursorState {
    const row = this.readStoredCursor(input);
    const acknowledgedSequence = row ? Number(row.acknowledged_sequence) : 0;
    const latestSequence = this.events.getLatestPersonSequence(input.personRef);
    if (acknowledgedSequence > latestSequence) {
      throw new Error("DEVICE_SYNC_CURSOR_AHEAD_OF_EVENT_LOG");
    }
    return {
      deviceRef: input.deviceRef,
      personRef: input.personRef,
      acknowledgedSequence,
      latestSequence,
      createdAt: row?.created_at ?? null,
      updatedAt: row?.updated_at ?? null
    };
  }

  acknowledge(input: {
    deviceRef: string;
    personRef: string;
    eventSequence: number;
    eventRef: string;
  }): DeviceSyncAcknowledgement | null {
    const acknowledge = this.db.transaction(() => {
      const current = this.readCursor({
        deviceRef: input.deviceRef,
        personRef: input.personRef
      });
      const event = this.events.findPersonEvent({
        personRef: input.personRef,
        eventSequence: input.eventSequence,
        eventRef: input.eventRef
      });
      if (!event) return null;

      if (input.eventSequence <= current.acknowledgedSequence) {
        if (!current.updatedAt) {
          throw new Error("DEVICE_SYNC_CURSOR_STATE_INVALID");
        }
        return {
          deviceRef: input.deviceRef,
          personRef: input.personRef,
          previousSequence: current.acknowledgedSequence,
          acknowledgedSequence: current.acknowledgedSequence,
          advanced: false,
          updatedAt: current.updatedAt
        };
      }

      const updatedAt = this.now().toISOString();
      this.db.prepare(
        `INSERT INTO device_sync_cursors(
           device_ref, person_ref, acknowledged_sequence, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(device_ref, person_ref) DO UPDATE SET
           acknowledged_sequence = excluded.acknowledged_sequence,
           updated_at = excluded.updated_at
         WHERE device_sync_cursors.acknowledged_sequence < excluded.acknowledged_sequence`
      ).run(
        input.deviceRef,
        input.personRef,
        input.eventSequence,
        updatedAt,
        updatedAt
      );

      const stored = this.readStoredCursor({
        deviceRef: input.deviceRef,
        personRef: input.personRef
      });
      if (!stored) throw new Error("DEVICE_SYNC_CURSOR_WRITE_FAILED");
      const acknowledgedSequence = Number(stored.acknowledged_sequence);
      return {
        deviceRef: input.deviceRef,
        personRef: input.personRef,
        previousSequence: current.acknowledgedSequence,
        acknowledgedSequence,
        advanced: acknowledgedSequence > current.acknowledgedSequence,
        updatedAt: stored.updated_at
      };
    });
    return acknowledge();
  }

  private readStoredCursor(input: {
    deviceRef: string;
    personRef: string;
  }): StoredCursor | null {
    const row = this.db.prepare(
      `SELECT acknowledged_sequence, created_at, updated_at
       FROM device_sync_cursors
       WHERE device_ref = ? AND person_ref = ?`
    ).get(input.deviceRef, input.personRef) as StoredCursor | undefined;
    return row ?? null;
  }
}
