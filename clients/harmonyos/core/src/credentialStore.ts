import type { GatewayProfile } from './gatewayClient.ts';
import type { DeviceAuthorization } from './requests.ts';
import type { EntrySessionCredential } from './types.ts';

export interface MobileCredentialStore {
  gatewayProfile(): Promise<GatewayProfile | null>;
  deviceAuthorization(): Promise<DeviceAuthorization | null>;
  session(): Promise<EntrySessionCredential | null>;
  replaceSessionAtomically(session: EntrySessionCredential): Promise<void>;
  clearSession(): Promise<void>;
  clearDeviceAndSession(): Promise<void>;
}
