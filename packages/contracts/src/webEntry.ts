import { z } from "zod";
import {
  pairingCodeSchema,
  pairingRefSchema,
  personalPortalContextSchema
} from "./mobileEntry.js";

export const WEB_ENTRY_PROTOCOL_VERSION = 2 as const;

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

export const webDeviceCredentialSchema = z.string().regex(
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
);

export const webPairingClaimRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    pairingRef: pairingRefSchema.optional(),
    code: pairingCodeSchema,
    installationId: z.string().uuid(),
    deviceCredential: webDeviceCredentialSchema,
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

export const WEB_ENTRY_REVOKED_SSE_EVENT_NAME = "entry-revoked" as const;

export const webEntryRevokedSseDataSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("device_revoked")
  })
  .strict();

export const webGatewayErrorSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    error: z.object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
      category: z.enum(["validation", "permission", "availability", "timeout", "conflict", "internal"]),
      message: z.string().min(1).max(500),
      retryable: z.boolean(),
      requestId: z.string().min(1)
    }).strict()
  })
  .strict();

export type WebDeviceDescriptor = z.infer<typeof webDeviceDescriptorSchema>;
export type WebPairingClaimRequest = z.infer<typeof webPairingClaimRequestSchema>;
export type WebEntryContextResponse = z.infer<typeof webEntryContextResponseSchema>;
export type WebEntryOperationResponse = z.infer<typeof webEntryOperationResponseSchema>;
