export const INSTALLATION_KEY = 'installationId' as const;
export const DEVICE_KEYS = [
  'gatewayBaseURL',
  'deviceRef',
  'deviceCredential'
] as const;
export const SESSION_KEYS = [
  'entryBindingRef',
  'entrySessionRef',
  'entrySessionToken',
  'entrySessionExpiresAt'
] as const;

export type CredentialKey =
  | typeof INSTALLATION_KEY
  | (typeof DEVICE_KEYS)[number]
  | (typeof SESSION_KEYS)[number];

export function keysRemovedByLogout(): CredentialKey[] {
  return [...SESSION_KEYS];
}

export function keysRemovedByUnbind(): CredentialKey[] {
  return [...DEVICE_KEYS, ...SESSION_KEYS];
}
