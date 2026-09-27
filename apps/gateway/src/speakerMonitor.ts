import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { speakerSnapshotSchema, type SpeakerMonitorResponse, type Speaker } from "@family-ai/contracts";

export interface SpeakerMonitorConfig {
  filePath: string;
  familyRef: string;
}
const MAX_BYTES = 64 * 1024;
const TTL_MS = 30_000;
const FUTURE_TOLERANCE_MS = 5_000;

function empty(sourceState: "unavailable" | "not_configured"): SpeakerMonitorResponse {
  return { protocolVersion: 1, sourceState, sampledAt: null, speakers: [] };
}

function expired(speaker: Speaker, problemCode: "telemetry_stale" | "telemetry_unavailable"): Speaker {
  return { ...speaker, serviceState: "unknown", linkState: "unknown", phase: "unknown", problemCode };
}

/** Reads only an operator-configured local regular file, after route authorization. */
export async function readSpeakerMonitor(
  config: SpeakerMonitorConfig | undefined,
  now: Date
): Promise<SpeakerMonitorResponse> {
  if (!config) return empty("not_configured");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(config.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return empty("unavailable");
    // Read one byte beyond the bound, even if a writer grows the file after stat.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    if (bytes > MAX_BYTES) return empty("unavailable");
    const value = speakerSnapshotSchema.safeParse(JSON.parse(buffer.subarray(0, bytes).toString("utf8")));
    if (!value.success) return empty("unavailable");
    const snapshot = value.data;
    const current = now.getTime();
    if (Date.parse(snapshot.sampledAt) > current + FUTURE_TOLERANCE_MS || snapshot.speakers.some(speaker =>
      speaker.runtimeUpdatedAt !== null && Date.parse(speaker.runtimeUpdatedAt) > current + FUTURE_TOLERANCE_MS
    )) return empty("unavailable");
    const stale = current - Date.parse(snapshot.sampledAt) > TTL_MS;
    const speakers = snapshot.speakers.map(speaker => {
      if (stale) return expired(speaker, "telemetry_stale");
      if (speaker.runtimeUpdatedAt === null) {
        return speaker.serviceState === "running" || speaker.linkState === "connected" ||
          ["waiting_for_wake", "listening", "processing", "speaking"].includes(speaker.phase)
          ? expired(speaker, "telemetry_unavailable") : speaker;
      }
      if (current - Date.parse(speaker.runtimeUpdatedAt) > TTL_MS) return expired(speaker, "telemetry_stale");
      return speaker;
    });
    return { ...snapshot, sourceState: stale ? "stale" : "ready", speakers };
  } catch {
    return empty("unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}
