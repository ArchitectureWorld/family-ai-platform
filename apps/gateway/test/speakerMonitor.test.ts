import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";
import { loadGatewayConfig } from "../src/config.js";

const now = new Date("2026-09-27T08:00:00.000Z");
const deviceToken = "speaker-test-bootstrap-with-enough-length";
const sample = () => ({
  protocolVersion: 1, sampledAt: now.toISOString(), speakers: [{
    speakerId: "112233aabbcc", displayName: "DIY 音箱", room: "客厅",
    board: "diy-n16r8", usbConnected: true, transport: "wifi",
    serviceState: "running", linkState: "connected", phase: "listening",
    runtimeUpdatedAt: now.toISOString(), firmware: "V4", volumePercent: 45,
    capabilities: { wifi: true, aec: false, duplex: false }, problemCode: null
  }]
});
type Entry = { entrySessionRef: string; token: string };
const headers = (entry: Entry) => ({ authorization: `Bearer ${entry.token}`, "x-entry-session-ref": entry.entrySessionRef });

describe("speaker monitoring authority and bounded projection", () => {
  let directory: string;
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let admin: Entry;
  let personal: Entry;
  let config: { filePath: string; familyRef: string };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-speaker-monitor-"));
    config = { filePath: join(directory, "snapshot.json"), familyRef: "family:unbound" };
    app = await buildGatewayApp({ databasePath: join(directory, "gateway.sqlite"),
      databaseOpenRequest: { intent: "test-create-or-existing", simulate: "migrate-create-or-existing" },
      deviceToken, mode: "test", now: () => now, speakerMonitor: config });
    const initialized = await app.inject({ method: "POST", url: "/api/v1/onboarding/family",
      headers: { authorization: `Bearer ${deviceToken}`, "x-device-ref": "device:test" },
      payload: { familyName: "监测测试家庭", ownerName: "管理员", deviceName: "浏览器" } });
    expect(initialized.statusCode).toBe(201);
    admin = initialized.json().entries.admin;
    personal = initialized.json().entries.personal;
    config.familyRef = initialized.json().family.familyRef;
    writeFileSync(config.filePath, JSON.stringify(sample()));
  });
  afterEach(async () => { await app?.close(); rmSync(directory, { recursive: true, force: true }); });
  const read = () => app.inject({ method: "GET", url: "/api/v1/admin/speakers", headers: headers(admin) });

  it("returns safe status to the bound administrator without creating authenticated speaker devices", async () => {
    const db = openGatewayDatabase(join(directory, "gateway.sqlite"), { intent: "test-create-or-existing", simulate: "migrate-create-or-existing" });
    const counts = () => ["managed_devices", "entry_bindings", "entry_sessions"].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
    const before = counts();
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...sample(), sourceState: "ready" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(counts()).toEqual(before);
    db.close();
  });

  it("denies unauthenticated and personal entries before accessing the file", async () => {
    Object.defineProperty(config, "filePath", { get() { throw new Error("private file accessed"); } });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/speakers" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/speakers", headers: headers(personal) })).statusCode).toBe(403);
  });

  it("denies a paired ordinary adult member", async () => {
    const member = await app.inject({ method: "POST", url: "/api/v1/admin/members", headers: headers(admin),
      payload: { displayName: "普通成员", familyRole: "adult" } });
    expect(member.statusCode).toBe(201);
    const pairing = await app.inject({ method: "POST", url: `/api/v1/admin/members/${encodeURIComponent(member.json().member.personRef)}/pairing-codes`, headers: { ...headers(admin), host: "gateway.example.test", "x-forwarded-proto": "https" } });
    expect(pairing.statusCode).toBe(201);
    const claim = await app.inject({ method: "POST", url: "/api/v1/mobile/pairing/claim", payload: {
      protocolVersion: 1, code: pairing.json().pairing.code,
      installationId: "e6eb6a53-26b9-4b91-ae0d-ff5e8d9d58a8", deviceCredential: "A".repeat(43),
      device: { displayName: "测试手机", terminalType: "mobile", platform: "ios", systemVersion: "26.0", appVersion: "1.0.0", model: "iPhone" }
    } });
    expect(claim.statusCode).toBe(201);
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/speakers", headers: headers(claim.json().entry) });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("112233aabbcc");
  });

  it("denies a valid administrator outside the server-bound family before reading", async () => {
    config.familyRef = "family:another";
    Object.defineProperty(config, "filePath", { get() { throw new Error("private file accessed"); } });
    const response = await read();
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("private");
  });

  it("drops transcripts, paths, credentials and nested unknown keys", async () => {
    const value = sample();
    Object.assign(value, { path: "/private/voice", token: "private-credential" });
    Object.assign(value.speakers[0]!, { transcript: "PRIVATE_TRANSCRIPT", voiceIdentity: "PRIVATE_PERSON", rawError: "/private/raw", url: "https://secret@example.invalid" });
    Object.assign(value.speakers[0]!.capabilities, { token: "private-credential" });
    writeFileSync(config.filePath, JSON.stringify(value));
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...sample(), sourceState: "ready" });
  });

  it.each(["missing", "broken", "oversize", "duplicate", "future", "runtime-future", "too-many", "bad-board", "symlink", "private-label"])("fails closed with generic unavailable state: %s", async kind => {
    const value = sample();
    if (kind === "missing") rmSync(config.filePath);
    if (kind === "broken") writeFileSync(config.filePath, "{broken");
    if (kind === "oversize") writeFileSync(config.filePath, " ".repeat(65537));
    if (kind === "duplicate") value.speakers.push(value.speakers[0]!);
    if (kind === "future") value.sampledAt = "2026-09-27T08:01:00.000Z";
    if (kind === "runtime-future") value.speakers[0]!.runtimeUpdatedAt = "2026-09-27T08:01:00.000Z";
    if (kind === "too-many") value.speakers = Array.from({ length: 33 }, (_, i) => ({ ...value.speakers[0]!, speakerId: i.toString(16).padStart(12, "0") }));
    if (kind === "bad-board") value.speakers[0]!.board = "unknown-board";
    if (kind === "private-label") value.speakers[0]!.firmware = "/home/private/firmware";
    if (kind === "symlink") { rmSync(config.filePath); writeFileSync(join(directory, "private.json"), JSON.stringify(value)); symlinkSync(join(directory, "private.json"), config.filePath); }
    if (!["missing", "broken", "oversize", "symlink"].includes(kind)) writeFileSync(config.filePath, JSON.stringify(value));
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ protocolVersion: 1, sourceState: "unavailable", sampledAt: null, speakers: [] });
  });

  it("expires a stale snapshot without presenting a green link or an active voice phase", async () => {
    const value = sample(); value.sampledAt = "2026-09-27T07:59:29.999Z";
    writeFileSync(config.filePath, JSON.stringify(value));
    expect((await read()).json()).toMatchObject({ sourceState: "stale", sampledAt: value.sampledAt,
      speakers: [{ serviceState: "unknown", linkState: "unknown", phase: "unknown", problemCode: "telemetry_stale" }] });
  });

  it.each(["identity_mismatch", "telemetry_stale"])("preserves collector fault %s when its verified heartbeat is absent", async problemCode => {
    const value = sample();
    Object.assign(value.speakers[0]!, { runtimeUpdatedAt: null, problemCode, linkState: "unknown", phase: "unknown" });
    writeFileSync(config.filePath, JSON.stringify(value));
    expect((await read()).json()).toMatchObject({ sourceState: "ready", speakers: [{
      serviceState: "unknown", linkState: "unknown", phase: "unknown", runtimeUpdatedAt: null, problemCode
    }] });
  });

  it("reports missing telemetry when no collector fault or heartbeat is available", async () => {
    const value = sample(); Object.assign(value.speakers[0]!, { runtimeUpdatedAt: null });
    writeFileSync(config.filePath, JSON.stringify(value));
    expect((await read()).json()).toMatchObject({ speakers: [{ linkState: "unknown", phase: "unknown", problemCode: "telemetry_unavailable" }] });
  });

  it("expires an old runtime heartbeat even when the collector snapshot is fresh", async () => {
    const value = sample(); value.speakers[0]!.runtimeUpdatedAt = "2026-09-27T07:59:20.000Z";
    writeFileSync(config.filePath, JSON.stringify(value));
    expect((await read()).json()).toMatchObject({ sourceState: "ready", speakers: [{ linkState: "unknown", phase: "unknown", problemCode: "telemetry_stale" }] });
  });

  it("does not retain active voice or a connected link from an old heartbeat when service has stopped", async () => {
    const value = sample(); value.speakers[0]!.serviceState = "stopped";
    value.speakers[0]!.runtimeUpdatedAt = "2026-09-27T07:59:20.000Z";
    writeFileSync(config.filePath, JSON.stringify(value));
    expect((await read()).json()).toMatchObject({ speakers: [{ linkState: "unknown", phase: "unknown", problemCode: "telemetry_stale" }] });
  });

  it("returns not_configured when no source is configured", async () => {
    await app.close();
    app = await buildGatewayApp({ databasePath: join(directory, "gateway.sqlite"),
      databaseOpenRequest: { intent: "test-create-or-existing", simulate: "migrate-create-or-existing" }, deviceToken, mode: "test", now: () => now });
    expect((await read()).json()).toEqual({ protocolVersion: 1, sourceState: "not_configured", sampledAt: null, speakers: [] });
  });
});

describe("speaker source configuration", () => {
  const base = { GATEWAY_DEVICE_TOKEN: deviceToken, GATEWAY_MODE: "test" };
  it("requires a complete pair with an absolute source and valid family ref", () => {
    for (const extra of [
      { FAMILY_AI_SPEAKER_MONITOR_FILE: "/run/speakers.json" },
      { FAMILY_AI_SPEAKER_MONITOR_FAMILY_REF: "family:test" },
      { FAMILY_AI_SPEAKER_MONITOR_FILE: "relative.json", FAMILY_AI_SPEAKER_MONITOR_FAMILY_REF: "family:test" },
      { FAMILY_AI_SPEAKER_MONITOR_FILE: "/run/speakers.json", FAMILY_AI_SPEAKER_MONITOR_FAMILY_REF: "person:test" }
    ]) expect(() => loadGatewayConfig({ ...base, ...extra })).toThrow("Speaker monitor configuration is invalid");
    expect(loadGatewayConfig({ ...base, FAMILY_AI_SPEAKER_MONITOR_FILE: "/run/speakers.json", FAMILY_AI_SPEAKER_MONITOR_FAMILY_REF: "family:test" }).speakerMonitor)
      .toEqual({ filePath: "/run/speakers.json", familyRef: "family:test" });
    expect(loadGatewayConfig(base).speakerMonitor).toBeUndefined();
  });
});
