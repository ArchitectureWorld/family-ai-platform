import { z } from "zod";

export const MOBILE_ENTRY_PROTOCOL_VERSION = 1 as const;

const protocolVersionSchema = z.literal(MOBILE_ENTRY_PROTOCOL_VERSION);
const timestampSchema = z.string().datetime({ offset: true });
const displayNameSchema = z.string().trim().min(1).max(80);
const hostDisplayNameSchema = z.string().trim().min(1).max(253);

function refSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}:[a-z0-9][a-z0-9._:-]{1,126}$`));
}

export const familyRefSchema = refSchema("family");
export const personRefSchema = refSchema("person");
export const mobileDeviceRefSchema = refSchema("device");
export const deviceBindingRefSchema = refSchema("device-binding");
export const entryBindingRefSchema = refSchema("entry-binding");
export const entrySessionRefSchema = refSchema("entry-session");
export const pairingRefSchema = refSchema("pairing");
export const assignmentRefSchema = refSchema("assignment");
export const mobileAgentRefSchema = refSchema("agent");
export const mobileProviderProfileRefSchema = refSchema("provider-profile");

export const pairingCodeSchema = z
  .string()
  .regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

export const deviceCredentialSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/);

export const entrySessionTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/);

export const secureGatewayBaseUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Gateway URL is invalid" });
      return;
    }

    if (parsed.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Gateway URL must use HTTPS" });
    }
    if (parsed.username || parsed.password) {
      context.addIssue({ code: "custom", message: "Gateway URL must not contain credentials" });
    }
    if (parsed.search || parsed.hash) {
      context.addIssue({ code: "custom", message: "Gateway URL must not contain query or fragment" });
    }
    if (parsed.pathname !== "/" && parsed.pathname !== "") {
      context.addIssue({ code: "custom", message: "Gateway URL must not contain a path" });
    }
  });

export const pairingQrPayloadSchema = z
  .object({
    version: protocolVersionSchema,
    gateway: secureGatewayBaseUrlSchema,
    pairingRef: pairingRefSchema,
    code: pairingCodeSchema,
    expiresAt: timestampSchema
  })
  .strict();

export const pairingPreviewRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    pairingRef: pairingRefSchema,
    code: pairingCodeSchema
  })
  .strict();

export const pairingPreviewResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    family: z.object({ displayName: displayNameSchema }).strict(),
    person: z.object({ displayName: displayNameSchema }).strict(),
    gatewayHost: hostDisplayNameSchema,
    expiresAt: timestampSchema
  })
  .strict();

export const mobileDeviceDescriptorSchema = z
  .object({
    displayName: displayNameSchema,
    terminalType: z.literal("mobile"),
    platform: z.literal("ios"),
    systemVersion: z.string().trim().min(1).max(32),
    appVersion: z.string().trim().min(1).max(32),
    model: z.string().trim().min(1).max(80)
  })
  .strict();

export const pairingClaimRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    pairingRef: pairingRefSchema,
    code: pairingCodeSchema,
    installationId: z.string().uuid(),
    deviceCredential: deviceCredentialSchema,
    device: mobileDeviceDescriptorSchema
  })
  .strict();

export const entrySessionCredentialSchema = z
  .object({
    entryBindingRef: entryBindingRefSchema,
    entrySessionRef: entrySessionRefSchema,
    token: entrySessionTokenSchema,
    expiresAt: timestampSchema
  })
  .strict();

export const pairingClaimResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    device: z
      .object({
        deviceRef: mobileDeviceRefSchema,
        displayName: displayNameSchema,
        status: z.literal("active")
      })
      .strict(),
    entry: entrySessionCredentialSchema
  })
  .strict();

export const sessionRenewResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    entry: entrySessionCredentialSchema
  })
  .strict();

export const mobileOperationResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    status: z.enum(["revoked", "logged_out"])
  })
  .strict();

export const personalPortalContextSchema = z
  .object({
    protocolVersion: protocolVersionSchema.optional(),
    audience: z.literal("personal"),
    entrySessionRef: entrySessionRefSchema,
    entryBindingRef: entryBindingRefSchema,
    family: z
      .object({
        familyRef: familyRefSchema,
        displayName: displayNameSchema
      })
      .strict(),
    person: z
      .object({
        personRef: personRefSchema,
        displayName: displayNameSchema
      })
      .strict(),
    membership: z
      .object({
        familyRole: z.enum(["owner", "adult", "child", "elder"])
      })
      .strict(),
    device: z
      .object({
        deviceRef: mobileDeviceRefSchema,
        displayName: displayNameSchema,
        terminalType: z.string().trim().min(1).max(32),
        platform: z.string().trim().min(1).max(64)
      })
      .strict(),
    agent: z
      .object({
        assignmentRef: assignmentRefSchema,
        assignmentType: z.literal("personal_assistant"),
        agentRef: mobileAgentRefSchema,
        displayName: displayNameSchema,
        providerProfileRef: mobileProviderProfileRefSchema
      })
      .strict()
  })
  .strict();

export const mobileGatewayErrorCodeSchema = z.enum([
  "PAIRING_INVALID",
  "PAIRING_EXPIRED",
  "PAIRING_CONSUMED",
  "PAIRING_ATTEMPTS_EXCEEDED",
  "PAIRING_TARGET_INACTIVE",
  "DEVICE_AUTH_INVALID",
  "DEVICE_REVOKED",
  "ENTRY_SESSION_EXPIRED",
  "ENTRY_SESSION_INVALID",
  "ENTRY_AUDIENCE_FORBIDDEN",
  "PROTOCOL_VERSION_UNSUPPORTED"
]);

export const mobileGatewayErrorSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    error: z
      .object({
        code: mobileGatewayErrorCodeSchema,
        category: z.enum([
          "validation",
          "permission",
          "availability",
          "timeout",
          "conflict",
          "internal"
        ]),
        message: z.string().trim().min(1).max(500),
        retryable: z.boolean(),
        requestId: z.string().trim().min(8).max(128).optional()
      })
      .strict()
  })
  .strict();

export type PairingQrPayload = z.infer<typeof pairingQrPayloadSchema>;
export type PairingPreviewRequest = z.infer<typeof pairingPreviewRequestSchema>;
export type PairingPreviewResponse = z.infer<typeof pairingPreviewResponseSchema>;
export type MobileDeviceDescriptor = z.infer<typeof mobileDeviceDescriptorSchema>;
export type PairingClaimRequest = z.infer<typeof pairingClaimRequestSchema>;
export type EntrySessionCredential = z.infer<typeof entrySessionCredentialSchema>;
export type PairingClaimResponse = z.infer<typeof pairingClaimResponseSchema>;
export type SessionRenewResponse = z.infer<typeof sessionRenewResponseSchema>;
export type MobileOperationResponse = z.infer<typeof mobileOperationResponseSchema>;
export type PersonalPortalContext = z.infer<typeof personalPortalContextSchema>;
export type MobileGatewayErrorCode = z.infer<typeof mobileGatewayErrorCodeSchema>;
export type MobileGatewayError = z.infer<typeof mobileGatewayErrorSchema>;
