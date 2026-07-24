import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DeviceSyncHarness,
  deviceHeaders,
  entryHeaders,
  type EntryCredential
} from "./deviceSyncTestSupport.js";

const mobileCredential = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("Device Sync Session continuity", () => {
  let harness: DeviceSyncHarness;

  beforeEach(async () => {
    harness = new DeviceSyncHarness();
    await harness.start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("keeps the Cursor across logout, Session renewal and Gateway restart", async () => {
    const mobile = await harness.pairDevice({
      personRef: harness.initialized.owner.personRef,
      installationId: "8d3a6168-fef5-4b04-aeef-3bb853f60ea0",
      credential: mobileCredential,
      displayName: "同步 iPhone"
    });
    await harness.openChat(mobile.entry);
    const first = (await harness.syncEvents(mobile.entry)).events[0]!;
    await harness.acknowledge(mobile.entry, first);

    const logout = await harness.app.inject({
      method: "POST",
      url: "/api/v1/mobile/session/logout",
      headers: deviceHeaders(mobile.device.deviceRef, mobileCredential)
    });
    expect(logout.statusCode).toBe(200);

    const oldEntry = await harness.app.inject({
      method: "GET",
      url: "/api/v1/sync/events",
      headers: entryHeaders(mobile.entry)
    });
    expect(oldEntry.statusCode).toBe(401);
    expect(oldEntry.json()).toMatchObject({ code: "ENTRY_SESSION_INVALID" });

    const renew = await harness.app.inject({
      method: "POST",
      url: "/api/v1/mobile/session/renew",
      headers: deviceHeaders(mobile.device.deviceRef, mobileCredential)
    });
    expect(renew.statusCode).toBe(200);
    const renewed = (renew.json() as { entry: EntryCredential }).entry;
    expect(renewed.entrySessionRef).not.toBe(mobile.entry.entrySessionRef);

    await harness.restart();
    const state = await harness.syncEvents(renewed);
    expect(state.sync).toMatchObject({
      deviceRef: mobile.device.deviceRef,
      personRef: harness.initialized.owner.personRef,
      acknowledgedSequence: 1,
      latestSequence: 1
    });
    expect(state.events).toEqual([]);
  });
});
