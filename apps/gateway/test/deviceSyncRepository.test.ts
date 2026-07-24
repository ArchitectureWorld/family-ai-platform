import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { DeviceSyncRepository } from "../src/deviceSync.js";
import { DomainEventStore } from "../src/domainEvents.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

describe("DeviceSyncRepository", () => {
  let directory = "";
  let databasePath = "";
  let db: GatewayDatabase;
  let events: DomainEventStore;
  let sync: DeviceSyncRepository;
  let ownerPersonRef = "";
  let adultPersonRef = "";
  let ownerDeviceRef = "";
  let currentNow = new Date("2026-07-24T16:30:00.000Z");

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-device-sync-repository-"));
    databasePath = join(directory, "gateway.sqlite");
    db = openGatewayDatabase(databasePath);
    const family = new FamilyDomainRepository(db);
    const onboarding = family.initializeFamily({
      familyName: "测试家庭",
      ownerName: "家庭创建者",
      deviceName: "测试电脑",
      deviceCredential: "device-sync-repository-credential-with-enough-length"
    });
    ownerPersonRef = onboarding.owner.personRef;
    ownerDeviceRef = onboarding.device.deviceRef;
    adultPersonRef = family.createMember({
      familyRef: onboarding.family.familyRef,
      displayName: "另一位成人",
      familyRole: "adult"
    }).personRef;
    currentNow = new Date("2026-07-24T16:30:00.000Z");
    events = new DomainEventStore(db, () => currentNow);
    sync = new DeviceSyncRepository(db, events, () => currentNow);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function append(personRef: string, suffix: string) {
    return events.append({
      personRef,
      eventType: `test.sync.${suffix}`,
      aggregateType: "work",
      aggregateRef: `work:sync-${suffix}`,
      payload: { suffix },
      occurredAt: currentNow.toISOString()
    });
  }

  it("treats a missing Cursor as zero without creating a row", () => {
    expect(sync.readCursor({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef
    })).toEqual({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef,
      acknowledgedSequence: 0,
      latestSequence: 0,
      createdAt: null,
      updatedAt: null
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM device_sync_cursors").get())
      .toEqual({ count: 0 });
  });

  it("creates, replays and advances one Device + Person Cursor monotonically", () => {
    const first = append(ownerPersonRef, "ack-first");
    const second = append(ownerPersonRef, "ack-second");

    const created = sync.acknowledge({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef,
      eventSequence: first.eventSequence,
      eventRef: first.eventRef
    });
    expect(created).toEqual({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef,
      previousSequence: 0,
      acknowledgedSequence: 1,
      advanced: true,
      updatedAt: "2026-07-24T16:30:00.000Z"
    });

    currentNow = new Date("2026-07-24T16:31:00.000Z");
    expect(sync.acknowledge({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef,
      eventSequence: first.eventSequence,
      eventRef: first.eventRef
    })).toEqual({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef,
      previousSequence: 1,
      acknowledgedSequence: 1,
      advanced: false,
      updatedAt: "2026-07-24T16:30:00.000Z"
    });

    expect(sync.acknowledge({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef,
      eventSequence: second.eventSequence,
      eventRef: second.eventRef
    })).toEqual({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef,
      previousSequence: 1,
      acknowledgedSequence: 2,
      advanced: true,
      updatedAt: "2026-07-24T16:31:00.000Z"
    });

    currentNow = new Date("2026-07-24T16:32:00.000Z");
    expect(sync.acknowledge({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef,
      eventSequence: first.eventSequence,
      eventRef: first.eventRef
    })).toMatchObject({
      previousSequence: 2,
      acknowledgedSequence: 2,
      advanced: false,
      updatedAt: "2026-07-24T16:31:00.000Z"
    });
  });

  it("rejects mismatched or cross-Person events without mutating the Cursor", () => {
    const ownerEvent = append(ownerPersonRef, "owner");
    const adultEvent = append(adultPersonRef, "adult");

    expect(sync.acknowledge({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef,
      eventSequence: adultEvent.eventSequence,
      eventRef: adultEvent.eventRef
    })).toBeNull();
    expect(sync.acknowledge({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef,
      eventSequence: ownerEvent.eventSequence,
      eventRef: adultEvent.eventRef
    })).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM device_sync_cursors").get())
      .toEqual({ count: 0 });
  });

  it("recovers the Cursor after restart and rejects impossible stored state", () => {
    const first = append(ownerPersonRef, "restart");
    sync.acknowledge({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef,
      eventSequence: first.eventSequence,
      eventRef: first.eventRef
    });
    db.close();

    db = openGatewayDatabase(databasePath);
    events = new DomainEventStore(db, () => new Date("2026-07-24T16:35:00.000Z"));
    sync = new DeviceSyncRepository(db, events, () => new Date("2026-07-24T16:35:00.000Z"));
    expect(sync.readCursor({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef
    })).toMatchObject({
      acknowledgedSequence: 1,
      latestSequence: 1,
      createdAt: "2026-07-24T16:30:00.000Z",
      updatedAt: "2026-07-24T16:30:00.000Z"
    });

    db.prepare(
      `UPDATE device_sync_cursors SET acknowledged_sequence = 2
       WHERE device_ref = ? AND person_ref = ?`
    ).run(ownerDeviceRef, ownerPersonRef);
    expect(() => sync.readCursor({
      deviceRef: ownerDeviceRef,
      personRef: ownerPersonRef
    })).toThrow("DEVICE_SYNC_CURSOR_AHEAD_OF_EVENT_LOG");
  });
});
