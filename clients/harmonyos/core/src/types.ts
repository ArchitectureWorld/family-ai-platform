export const MOBILE_ENTRY_PROTOCOL_VERSION = 1 as const;

export type FamilyRole = 'owner' | 'adult' | 'child' | 'elder';
export type MobileOperationStatus = 'revoked' | 'logged_out';
export type MobileGatewayErrorCategory =
  | 'validation'
  | 'permission'
  | 'availability'
  | 'timeout'
  | 'conflict'
  | 'internal';

export type MobileGatewayErrorCode =
  | 'PAIRING_INVALID'
  | 'PAIRING_EXPIRED'
  | 'PAIRING_CONSUMED'
  | 'PAIRING_ATTEMPTS_EXCEEDED'
  | 'PAIRING_TARGET_INACTIVE'
  | 'DEVICE_AUTH_INVALID'
  | 'DEVICE_REVOKED'
  | 'ENTRY_SESSION_EXPIRED'
  | 'ENTRY_SESSION_INVALID'
  | 'ENTRY_AUDIENCE_FORBIDDEN'
  | 'PROTOCOL_VERSION_UNSUPPORTED';

export interface PairingQrPayload {
  version: 1;
  gateway: string;
  pairingRef: string;
  code: string;
  expiresAt: string;
}

export interface PairingPreviewResponse {
  protocolVersion: 1;
  family: { displayName: string };
  person: { displayName: string };
  gatewayHost: string;
  expiresAt: string;
}

export interface EntrySessionCredential {
  entryBindingRef: string;
  entrySessionRef: string;
  token: string;
  expiresAt: string;
}

export interface PairingClaimResponse {
  protocolVersion: 1;
  device: {
    deviceRef: string;
    displayName: string;
    status: 'active';
  };
  entry: EntrySessionCredential;
}

export interface SessionRenewResponse {
  protocolVersion: 1;
  entry: EntrySessionCredential;
}

export interface MobileOperationResponse {
  protocolVersion: 1;
  status: MobileOperationStatus;
}

export interface PersonalPortalContext {
  protocolVersion: 1;
  audience: 'personal';
  entrySessionRef: string;
  entryBindingRef: string;
  family: {
    familyRef: string;
    displayName: string;
  };
  person: {
    personRef: string;
    displayName: string;
  };
  membership: {
    familyRole: FamilyRole;
  };
  device: {
    deviceRef: string;
    displayName: string;
    terminalType: string;
    platform: string;
  };
  agent: {
    assignmentRef: string;
    assignmentType: 'personal_assistant';
    agentRef: string;
    displayName: string;
    providerProfileRef: string;
  };
}

export interface MobileGatewayError {
  protocolVersion: 1;
  error: {
    code: MobileGatewayErrorCode;
    category: MobileGatewayErrorCategory;
    message: string;
    retryable: boolean;
    requestId?: string;
  };
}

export interface HarmonyDeviceDescriptor {
  displayName: string;
  terminalType: 'mobile';
  platform: 'harmonyos';
  systemVersion: string;
  appVersion: string;
  model: string;
}
