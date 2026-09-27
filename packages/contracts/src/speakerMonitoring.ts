import { z } from "zod";

// Human labels only; runtime paths, URLs and multiline diagnostics never cross this boundary.
const label = z.string().trim().min(1).max(80)
  .regex(/^[\p{L}\p{N} _().+\-]+$/u);
const timestamp = z.string().datetime({ offset: true });
export const speakerSchema = z.object({
  speakerId: z.string().regex(/^[a-f0-9]{12}$/),
  displayName: label,
  room: label.nullable(),
  board: z.enum(["diy-n16r8", "esp32-s3-box3", "waveshare-audio"]),
  usbConnected: z.boolean(),
  transport: z.enum(["wifi", "usb", "unknown"]),
  serviceState: z.enum(["running", "stopped", "not_configured", "unknown"]),
  linkState: z.enum(["connected", "disconnected", "unknown"]),
  phase: z.enum(["waiting_for_wake", "listening", "processing", "speaking", "muted", "starting", "reconnecting", "stopped", "not_configured", "unknown"]),
  runtimeUpdatedAt: timestamp.nullable(),
  firmware: label.nullable(),
  volumePercent: z.number().int().min(0).max(100).nullable(),
  capabilities: z.object({ wifi: z.boolean(), aec: z.boolean(), duplex: z.boolean() }),
  problemCode: z.enum(["service_stopped", "telemetry_stale", "telemetry_unavailable", "identity_mismatch", "disconnected", "upstream_unavailable"]).nullable()
});
export const speakerSnapshotSchema = z.object({
  protocolVersion: z.literal(1), sampledAt: timestamp, speakers: z.array(speakerSchema).max(32)
}).refine(value => new Set(value.speakers.map(speaker => speaker.speakerId)).size === value.speakers.length);
export const speakerMonitorResponseSchema = z.object({
  protocolVersion: z.literal(1),
  sourceState: z.enum(["ready", "stale", "unavailable", "not_configured"]),
  sampledAt: timestamp.nullable(), speakers: z.array(speakerSchema).max(32)
});
export type Speaker = z.infer<typeof speakerSchema>;
export type SpeakerMonitorResponse = z.infer<typeof speakerMonitorResponseSchema>;
