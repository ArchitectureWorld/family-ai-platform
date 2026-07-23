import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

describe("DomainEventStore", () => {
  let directory = "";
  let databasePath = "";
  let db: GatewayDatabase;
  let store: DomainEventStore;
  let currentNow: Date;
  let ownerPersonRef = "";
  let adultPersonRef = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-domain-events-"));
    databasePath = join(directory, "gateway.sqlite");
    db = openGatewayDatabase(databasePath);
    const family = new FamilyDomainRepository(db);
    const onboarding = family.initializeFamily({
      familyName: "测试家庭",
      ownerName: "家庭创建者",
      deviceName: "测试电脑",
      deviceCredential: "domain-event-device-credential-with-enough-length"
    });
    ownerPersonRef = onboarding.owner.personRef;
    adultPersonRef = family.createMember({
      familyRef: onboarding.family.familyRef,
      displayName: "另一位成人",
      familyRole: "adult"
    }).personRef;
    currentNow = new Date("2026-07-23T18:00:00.000Z");
    store = new DomainEventStore(db, () => currentNow);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("allocates independent Person sequences and writes a pending Outbox row atomically", () => {
    const first = store.append({
      personRef: ownerPersonRef,
      eventType: "test.owner.first",
      aggregateType: "home_chat",
      aggregateRef: "home-chat:test-owner",
      payload: { value: 1 },
      occurredAt: currentNow.toISOString()
    });
    currentNow = new Date("2026-07-23T18:00:01.000Z");
    const second = store.append({
      personRef: ownerPersonRef,
      eventType: "test.owner.second",
      aggregateType: "work",
      aggregateRef: "work:test-owner",
      payload: { value: 2 },
      occurredAt: currentNow.toISOString()
    });
    const adult = store.append({
      personRef: adultPersonRef,
      eventType: "test.adult.first",
      aggregateType: "work",
      aggregateRef: "work:test-adult",
      payload: { value: 3 },
      occurredAt: currentNow.toISOString()
    });

    expect([first.eventSequence, second.eventSequence]).toEqual([1, 2]);
    expect(adult.eventSequence).toBe(1);
    expect(db.prepare(
      "SELECT event_ref, status, attempt_count FROM outbox_events ORDER BY event_ref"
    ).all()).toHaveLength(3);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'pending' AND attempt_count = 0"
    ).get()).toEqual({ count: 3 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("pages events in ascending order and never crosses Person ownership", () => {
    for (let index = 1; index <= 4; index += 1) {
      currentNow = new Date(`2026-07-23T18:00:0${index}.000Z`);
      store.append({
        personRef: ownerPersonRef,
        eventType: `test.owner.${index}`,
        aggregateType: "work",
        aggregateRef: `work:test-${index}`,
        payload: { index },
        occurredAt: currentNow.toISOString()
      });
    }
    store.append({
      personRef: adultPersonRef,
      eventType: "test.adult.hidden",
      aggregateType: "work",
      aggregateRef: "work:test-hidden",
      payload: { hidden: true },
      occurredAt: currentNow.toISOString()
    });

    const firstPage = store.listPersonEvents({ personRef: ownerPersonRef, limit: 2 });
    expect(firstPage.events.map((event) => event.eventSequence)).toEqual([1, 2]);
    expect(firstPage.nextAfterSequence).toBe(2);
    const secondPage = store.listPersonEvents({
      personRef: ownerPersonRef,
      afterSequence: firstPage.nextAfterSequence ?? 0,
      limit: 2
    });
    expect(secondPage.events.map((event) => event.eventSequence)).toEqual([3, 4]);
    expect(secondPage.nextAfterSequence).toBeNull();
    expect(secondPage.events.every((event) => event.personRef === ownerPersonRef)).toBe(true);
  });

  it("claims, publishes, fails and reclaims expired Outbox leases", () => {
    const first = store.append({
      personRef: ownerPersonRef,
      eventType: "test.delivery.first",
      aggregateType: "work",
      aggregateRef: "work:delivery-first",
      payload: {},
      occurredAt: currentNow.toISOString()
    });
    const second = store.append({
      personRef: ownerPersonRef,
      eventType: "test.delivery.second",
      aggregateType: "work",
      aggregateRef: "work:delivery-second",
      payload: {},
      occurredAt: currentNow.toISOString()
    });

    const claimed = store.claimOutboxBatch({
      workerRef: "worker:first",
      now: "2026-07-23T18:00:01.000Z",
      claimedUntil: "2026-07-23T18:01:01.000Z",
      limit: 2
    });
    expect(claimed).toHaveLength(2);
    expect(claimed.map((item) => item.attemptCount)).toEqual([1, 1]);

    expect(() => store.markPublished({
      eventRef: first.eventRef,
      workerRef: "worker:wrong",
      publishedAt: "2026-07-23T18:00:02.000Z"
    })).toThrow("OUTBOX_CLAIM_INVALID");

    store.markPublished({
      eventRef: first.eventRef,
      workerRef: "worker:first",
      publishedAt: "2026-07-23T18:00:02.000Z"
    });
    store.markFailed({
      eventRef: second.eventRef,
      workerRef: "worker:first",
      error: {
        code: "DELIVERY_FAILED",
        category: "availability",
        message: "暂时无法投递。",
        retryable: true
      },
      availableAt: "2026-07-23T18:02:00.000Z",
      updatedAt: "2026-07-23T18:00:03.000Z"
    });

    expect(store.claimOutboxBatch({
      workerRef: "worker:second",
      now: "2026-07-23T18:01:59.000Z",
      claimedUntil: "2026-07-23T18:02:59.000Z"
    })).toEqual([]);
    const retried = store.claimOutboxBatch({
      workerRef: "worker:second",
      now: "2026-07-23T18:02:00.000Z",
      claimedUntil: "2026-07-23T18:03:00.000Z"
    });
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({
      attemptCount: 2,
      claimedBy: "worker:second"
    });

    const third = store.append({
      personRef: ownerPersonRef,
      eventType: "test.delivery.expired",
      aggregateType: "work",
      aggregateRef: "work:delivery-expired",
      payload: {},
      occurredAt: "2026-07-23T18:02:01.000Z"
    });
    store.claimOutboxBatch({
      workerRef: "worker:expired",
      now: "2026-07-23T18:02:01.000Z",
      claimedUntil: "2026-07-23T18:02:02.000Z"
    });
    const reclaimed = store.claimOutboxBatch({
      workerRef: "worker:reclaimer",
      now: "2026-07-23T18:02:03.000Z",
      claimedUntil: "2026-07-23T18:03:03.000Z",
      limit: 10
    });
    expect(reclaimed.some((item) => item.event.eventRef === third.eventRef)).toBe(true);
  });

  it("rejects publish and failure finalization after a claim lease expires", () => {
    const publishEvent = store.append({
      personRef: ownerPersonRef,
      eventType: "test.expired.publish",
      aggregateType: "work",
      aggregateRef: "work:expired-publish",
      payload: {},
      occurredAt: currentNow.toISOString()
    });
    const failEvent = store.append({
      personRef: ownerPersonRef,
      eventType: "test.expired.fail",
      aggregateType: "work",
      aggregateRef: "work:expired-fail",
      payload: {},
      occurredAt: currentNow.toISOString()
    });
    store.claimOutboxBatch({
      workerRef: "worker:expired-finalizer",
      now: "2026-07-23T18:00:01.000Z",
      claimedUntil: "2026-07-23T18:00:02.000Z",
      limit: 2
    });

    expect(() => store.markPublished({
      eventRef: publishEvent.eventRef,
      workerRef: "worker:expired-finalizer",
      publishedAt: "2026-07-23T18:00:03.000Z"
    })).toThrow("OUTBOX_CLAIM_INVALID");
    expect(() => store.markFailed({
      eventRef: failEvent.eventRef,
      workerRef: "worker:expired-finalizer",
      error: {
        code: "DELIVERY_FAILED",
        category: "availability",
        message: "租约已过期。",
        retryable: true
      },
      availableAt: "2026-07-23T18:01:00.000Z",
      updatedAt: "2026-07-23T18:00:03.000Z"
    })).toThrow("OUTBOX_CLAIM_INVALID");

    expect(db.prepare(
      "SELECT status, claimed_by FROM outbox_events WHERE event_ref = ?"
    ).get(publishEvent.eventRef)).toEqual({
      status: "claimed",
      claimed_by: "worker:expired-finalizer"
    });
  });

  it("recovers events and Outbox state after database restart", () => {
    const event = store.append({
      personRef: ownerPersonRef,
      eventType: "test.restart",
      aggregateType: "work",
      aggregateRef: "work:restart",
      payload: { stable: true },
      occurredAt: currentNow.toISOString()
    });
    db.close();

    db = openGatewayDatabase(databasePath);
    store = new DomainEventStore(db, () => new Date("2026-07-23T18:05:00.000Z"));
    expect(store.listPersonEvents({ personRef: ownerPersonRef }).events).toEqual([event]);
    const claimed = store.claimOutboxBatch({
      workerRef: "worker:restart",
      now: "2026-07-23T18:05:00.000Z",
      claimedUntil: "2026-07-23T18:06:00.000Z"
    });
    expect(claimed.map((item) => item.event.eventRef)).toContain(event.eventRef);
  });
});
