import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGatewayDatabase } from "../src/database.js";
import { DeviceSyncHarness } from "./deviceSyncTestSupport.js";

const ownerMobileCredential = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const adultMobileCredential = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

describe("Device Sync Device and Person isolation", () => {
  let harness: DeviceSyncHarness;

  beforeEach(async () => {
    harness = new DeviceSyncHarness();
    await harness.start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("keeps two devices for the same Person on independent Cursors", async () => {
    await harness.openChat(harness.initialized.entries.personal);
    const event = (await harness.syncEvents(harness.initialized.entries.personal)).events[0]!;
    await harness.acknowledge(harness.initialized.entries.personal, event);

    const second = await harness.pairDevice({
      personRef: harness.initialized.owner.personRef,
      installationId: "de1f5ec4-c729-473b-9172-4dd3376540a1",
      credential: ownerMobileCredential,
      displayName: "第二台 iPhone"
    });
    const secondState = await harness.syncEvents(second.entry);
    expect(secondState.sync).toMatchObject({
      deviceRef: second.device.deviceRef,
      personRef: harness.initialized.owner.personRef,
      acknowledgedSequence: 0,
      latestSequence: 1
    });
    expect(secondState.events.map((item) => item.eventSequence)).toEqual([1]);
    await harness.acknowledge(second.entry, secondState.events[0]!);

    const db = openGatewayDatabase(harness.databasePath);
    try {
      const rows = db.prepare(
        `SELECT device_ref, person_ref, acknowledged_sequence
         FROM device_sync_cursors WHERE person_ref = ? ORDER BY device_ref`
      ).all(harness.initialized.owner.personRef) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => Number(row.acknowledged_sequence) === 1)).toBe(true);
      expect(new Set(rows.map((row) => String(row.device_ref)))).toEqual(new Set([
        harness.initialized.device.deviceRef,
        second.device.deviceRef
      ]));
    } finally {
      db.close();
    }
  });

  it("isolates two Persons, their events and their Device Cursors", async () => {
    const adultPersonRef = await harness.createMember();
    const adult = await harness.pairDevice({
      personRef: adultPersonRef,
      installationId: "32adca20-cc22-4b5d-818d-29e21306d018",
      credential: adultMobileCredential,
      displayName: "成人 iPhone"
    });

    await harness.openChat(harness.initialized.entries.personal);
    await harness.openChat(adult.entry);
    const ownerState = await harness.syncEvents(harness.initialized.entries.personal);
    const adultState = await harness.syncEvents(adult.entry);

    expect(ownerState.events).toHaveLength(1);
    expect(adultState.events).toHaveLength(1);
    expect(ownerState.events[0]?.personRef).toBe(harness.initialized.owner.personRef);
    expect(adultState.events[0]?.personRef).toBe(adultPersonRef);
    expect(JSON.stringify(ownerState)).not.toContain(adultPersonRef);
    expect(JSON.stringify(adultState)).not.toContain(harness.initialized.owner.personRef);

    await harness.acknowledge(harness.initialized.entries.personal, ownerState.events[0]!);
    await harness.acknowledge(adult.entry, adultState.events[0]!);

    const db = openGatewayDatabase(harness.databasePath);
    try {
      const rows = db.prepare(
        `SELECT device_ref, person_ref, acknowledged_sequence
         FROM device_sync_cursors ORDER BY person_ref, device_ref`
      ).all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          device_ref: harness.initialized.device.deviceRef,
          person_ref: harness.initialized.owner.personRef,
          acknowledged_sequence: 1
        }),
        expect.objectContaining({
          device_ref: adult.device.deviceRef,
          person_ref: adultPersonRef,
          acknowledged_sequence: 1
        })
      ]));
    } finally {
      db.close();
    }
  });
});
