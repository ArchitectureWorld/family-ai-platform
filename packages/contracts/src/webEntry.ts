import { z } from "zod";
import {
  pairingCodeSchema,
  pairingRefSchema,
  personalPortalContextSchema
} from "./mobileEntry.js";

export const WEB_ENTRY_PROTOCOL_VERSION = 1 as const;

const protocolVersionSchema = z.literal(WEB_ENTRY_PROTOCOL_VERSION);
const displayNameSchema = z.string().trim().min(1).max(80);
const browserLabelSchema = z.string().trim().min(1).max(120);
const operatingSystemSchema = z.string().trim().min(1).max(80);
const appVersionSchema = z.string().trim().min(1).max(32);

export const webDeviceDescriptorSchema = z
  .object({
    displayName: displayNameSchema,
    browser: browserLabelSchema,
    operatingSystem: operatingSystemSchema,
    appVersion: appVersionSchema
  })
  .strict();

export const webPairingClaimRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    pairingRef: pairingRefSchema.optional(),
    code: pairingCodeSchema,
    installationId: z.string().uuid(),
    device: webDeviceDescriptorSchema
  })
  .strict();

export const webEntryContextResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    context: personalPortalContextSchema
  })
  .strict();

export const webEntryOperationResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    status: z.enum(["logged_out", "revoked"])
  })
  .strict();

export type WebDeviceDescriptor = z.infer<typeof webDeviceDescriptorSchema>;
export type WebPairingClaimRequest = z.infer<typeof webPairingClaimRequestSchema>;
export type WebEntryContextResponse = z.infer<typeof webEntryContextResponseSchema>;
export type WebEntryOperationResponse = z.infer<typeof webEntryOperationResponseSchema>;
