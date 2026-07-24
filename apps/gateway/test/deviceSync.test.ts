import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

describe("Device Sync event schema foundation", () => {
  let directory = "";
  let databasePath = "";
  let db: GatewayDatabase;
  let events: DomainEventStore;
  let ownerPersonRef = "";
  let adultPersonRef = "";
  let currentNow = new Date("2026-07-24T16:00:00.000Z");

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-device-sync-"));
    databasePath = join(directory, "gateway.sqlite");
    db = openGatewayDatabase(databasePath);
    const family = new FamilyDomainRepository(db);
    const onboarding = family.initializeFamily({
      familyName: "测试家庭",
      ownerName: "家庭创建者",
      deviceName: "测试电脑",
      deviceCredential: "device-sync-test-credential-with-enough-length"
    });
    ownerPersonRef = onboarding.owner.personRef;
    adultPersonRef = family.createMember({
      familyRef: onboarding.family.familyRef,
      displayName: "另一位成人",
      familyRole: "adult"
    }).personRef;
    currentNow = new Date("2026-07-24T16:00:00.000Z");
    events = new DomainEventStore(db, () => currentNow);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it.skip("installs Domain Event migrations V1 and V2 and creates the Device Cursor table", () => {
    expect(db.prepare(
      "SELECT version FROM domain_event_schema_migrations ORDER BY version"
    ).all()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device_sync_cursors'"
    ).get()).toEqual({ name: "device_sync_cursors" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it.skip("returns latest Person sequence and resolves only an exact Person event identity", () => {
    const first = events.append({
      personRef: ownerPersonRef,
      eventType: "test.sync.first",
      aggregateType: "work",
      aggregateRef: "work:sync-first",
      payload: {},
      occurredAt: currentNow.toISOString()
    });
    const second = events.append({
      personRef: ownerPersonRef,
      eventType: "test.sync.second",
      aggregateType: "work",
      aggregateRef: "work:sync-second",
      payload: {},
      occurredAt: currentNow.toISOString()
    });
    const hidden = events.append({
      personRef: adultPersonRef,
      eventType: "test.sync.hidden",
      aggregateType: "work",
      aggregateRef: "work:sync-hidden",
      payload: {},
      occurredAt: currentNow.toISOString()
    });

    expect(events.getLatestPersonSequence(ownerPersonRef)).toBe(2);
    expect(events.getLatestPersonSequence("person:no-events")).toBe(0);
    expect(events.findPersonEvent({
      personRef: ownerPersonRef,
      eventSequence: second.eventSequence,
      eventRef: second.eventRef
    })).toEqual(second);
    expect(events.findPersonEvent({
      personRef: ownerPersonRef,
      eventSequence: hidden.eventSequence,
      eventRef: hidden.eventRef
    })).toBeNull();
    expect(first.eventSequence).toBe(1);
  });

  it.skip("upgrades an existing Event Schema V1 database without rewriting events", () => {
    const existing = events.append({
      personRef: ownerPersonRef,
      eventType: "test.sync.upgrade",
      aggregateType: "work",
      aggregateRef: "work:sync-upgrade",
      payload: { preserved: true },
      occurredAt: currentNow.toISOString()
    });

    db.exec("DROP TABLE device_sync_cursors");
    db.prepare("DELETE FROM domain_event_schema_migrations WHERE version = 2").run();
    db.close();

    db = openGatewayDatabase(databasePath);
    events = new DomainEventStore(
      db,
      () => new Date("2026-07-24T16:05:00.000Z")
    );

    expect(db.prepare(
      "SELECT version FROM domain_event_schema_migrations ORDER BY version"
    ).all()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(events.findPersonEvent({
      personRef: ownerPersonRef,
      eventSequence: existing.eventSequence,
      eventRef: existing.eventRef
    })).toEqual(existing);
  });
});
