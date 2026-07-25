import type { MobileCredentialStore } from './credentialStore.ts';
import {
  GatewayClientError,
  type GatewayProfile
} from './gatewayClient.ts';
import type { DeviceAuthorization } from './requests.ts';
import type {
  EntrySessionCredential,
  MobileOperationResponse,
  PersonalPortalContext,
  SessionRenewResponse
} from './types.ts';

export interface SessionGateway {
  fetchPortalContext(
    profile: GatewayProfile,
    session: EntrySessionCredential
  ): Promise<PersonalPortalContext>;
  renew(
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ): Promise<SessionRenewResponse>;
  logout(
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ): Promise<MobileOperationResponse>;
  unbind(
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ): Promise<MobileOperationResponse>;
}

export type SessionRestoreResult =
  | { kind: 'needsPairing' }
  | { kind: 'authenticated'; context: PersonalPortalContext }
  | { kind: 'offline' }
  | { kind: 'revoked' };

export class SessionManager {
  private renewalTask: Promise<EntrySessionCredential> | null = null;

  constructor(
    private readonly gateway: SessionGateway,
    private readonly credentials: MobileCredentialStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  async restore(): Promise<SessionRestoreResult> {
    const profile = await this.credentials.gatewayProfile();
    const authorization = await this.credentials.deviceAuthorization();
    if (!profile || !authorization) return { kind: 'needsPairing' };

    const storedSession = await this.credentials.session();
    let activeSession: EntrySessionCredential;
    if (!storedSession || Date.parse(storedSession.expiresAt) <= this.now()) {
      try {
        activeSession = await this.renew(profile, authorization);
      } catch (error) {
        return this.mapRestoreFailure(error);
      }
    } else {
      activeSession = storedSession;
    }

    try {
      const context = await this.gateway.fetchPortalContext(profile, activeSession);
      return { kind: 'authenticated', context };
    } catch (error) {
      if (this.isEntrySessionInvalid(error)) {
        try {
          const renewed = await this.renew(profile, authorization);
          const context = await this.gateway.fetchPortalContext(profile, renewed);
          return { kind: 'authenticated', context };
        } catch (renewalError) {
          return this.mapRestoreFailure(renewalError);
        }
      }
      return this.mapRestoreFailure(error);
    }
  }

  async validSession(): Promise<EntrySessionCredential> {
    const profile = await this.credentials.gatewayProfile();
    const authorization = await this.credentials.deviceAuthorization();
    if (!profile || !authorization) {
      throw new GatewayClientError('server', 'DEVICE_AUTH_INVALID');
    }

    const existing = await this.credentials.session();
    if (existing && Date.parse(existing.expiresAt) > this.now()) return existing;
    return this.renew(profile, authorization);
  }

  async logout(): Promise<void> {
    const profile = await this.credentials.gatewayProfile();
    const authorization = await this.credentials.deviceAuthorization();
    if (!profile || !authorization) {
      await this.credentials.clearSession();
      return;
    }

    try {
      await this.gateway.logout(profile, authorization);
      await this.credentials.clearSession();
    } catch (error) {
      if (this.isServerCode(error, 'DEVICE_REVOKED')) {
        await this.credentials.clearDeviceAndSession();
        return;
      }
      throw error;
    }
  }

  async unbind(): Promise<void> {
    const profile = await this.credentials.gatewayProfile();
    const authorization = await this.credentials.deviceAuthorization();
    if (!profile || !authorization) {
      await this.credentials.clearDeviceAndSession();
      return;
    }

    try {
      await this.gateway.unbind(profile, authorization);
    } catch (error) {
      if (!this.isServerCode(error, 'DEVICE_REVOKED')) throw error;
    }
    await this.credentials.clearDeviceAndSession();
  }

  private async renew(
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ): Promise<EntrySessionCredential> {
    if (this.renewalTask) return this.renewalTask;

    const task = (async () => {
      const response = await this.gateway.renew(profile, authorization);
      await this.credentials.replaceSessionAtomically(response.entry);
      return response.entry;
    })();
    this.renewalTask = task;

    try {
      return await task;
    } finally {
      if (this.renewalTask === task) this.renewalTask = null;
    }
  }

  private async mapRestoreFailure(error: unknown): Promise<SessionRestoreResult> {
    if (this.isServerCode(error, 'DEVICE_REVOKED')) {
      await this.credentials.clearDeviceAndSession();
      return { kind: 'revoked' };
    }
    if (
      error instanceof GatewayClientError &&
      (error.kind === 'unreachable' || error.kind === 'timeout')
    ) {
      return { kind: 'offline' };
    }
    throw error;
  }

  private isEntrySessionInvalid(error: unknown): boolean {
    return this.isServerCode(error, 'ENTRY_SESSION_EXPIRED') ||
      this.isServerCode(error, 'ENTRY_SESSION_INVALID');
  }

  private isServerCode(error: unknown, code: GatewayClientError['serverCode']): boolean {
    return error instanceof GatewayClientError &&
      error.kind === 'server' &&
      error.serverCode === code;
  }
}
