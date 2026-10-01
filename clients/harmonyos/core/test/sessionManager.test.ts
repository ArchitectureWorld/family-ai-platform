import test from 'node:test';
import assert from 'node:assert/strict';
import type { MobileCredentialStore } from '../src/credentialStore.ts';
import {
  GatewayClientError,
  type GatewayProfile
} from '../src/gatewayClient.ts';
import type { DeviceAuthorization } from '../src/requests.ts';
import {
  SessionManager,
  type SessionGateway
} from '../src/sessionManager.ts';
import type {
  EntrySessionCredential,
  MobileOperationResponse,
  PersonalPortalContext,
  SessionRenewResponse
} from '../src/types.ts';

const now = Date.parse('2026-07-25T03:00:00.000Z');
const profile: GatewayProfile = { baseURL: 'https://gateway.example.test' };
const device: DeviceAuthorization = {
  deviceRef: 'device:test-1',
  deviceCredential: 'D'.repeat(43)
};

function session(
  suffix: string,
  expiresAt = '2026-08-01T03:00:00.000Z'
): EntrySessionCredential {
  return {
    entryBindingRef: 'entry-binding:test-1',
    entrySessionRef: `entry-session:${suffix}`,
    token: suffix.padEnd(43, 'T').slice(0, 43),
    expiresAt
  };
}

const context: PersonalPortalContext = {
  protocolVersion: 1,
  audience: 'personal',
  entrySessionRef: 'entry-session:new',
  entryBindingRef: 'entry-binding:test-1',
  family: { familyRef: 'family:test-1', displayName: '测试家庭' },
  person: { personRef: 'person:test-1', displayName: '测试成员' },
  membership: { familyRole: 'adult' },
  device: {
    deviceRef: device.deviceRef,
    displayName: '测试鸿蒙手机',
    terminalType: 'mobile',
    platform: 'harmonyos'
  },
  agent: {
    assignmentRef: 'assignment:test-1',
    assignmentType: 'personal_assistant',
    agentRef: 'agent:test-1',
    displayName: '个人助理',
    providerProfileRef: 'provider-profile:test-1'
  }
};

class MemoryCredentialStore implements MobileCredentialStore {
  profile: GatewayProfile | null = profile;
  authorization: DeviceAuthorization | null = device;
  currentSession: EntrySessionCredential | null = null;
  readonly replacements: EntrySessionCredential[] = [];
  clearSessionCalls = 0;
  clearDeviceAndSessionCalls = 0;

  async gatewayProfile(): Promise<GatewayProfile | null> {
    return this.profile;
  }

  async deviceAuthorization(): Promise<DeviceAuthorization | null> {
    return this.authorization;
  }

  async session(): Promise<EntrySessionCredential | null> {
    return this.currentSession;
  }

  async replaceSessionAtomically(value: EntrySessionCredential): Promise<void> {
    this.replacements.push(value);
    this.currentSession = value;
  }

  async clearSession(): Promise<void> {
    this.clearSessionCalls += 1;
    this.currentSession = null;
  }

  async clearDeviceAndSession(): Promise<void> {
    this.clearDeviceAndSessionCalls += 1;
    this.profile = null;
    this.authorization = null;
    this.currentSession = null;
  }
}

class StubSessionGateway implements SessionGateway {
  readonly fetchCalls: Array<{
    profile: GatewayProfile;
    session: EntrySessionCredential;
  }> = [];
  readonly renewCalls: Array<{
    profile: GatewayProfile;
    authorization: DeviceAuthorization;
  }> = [];
  readonly logoutCalls: Array<{
    profile: GatewayProfile;
    authorization: DeviceAuthorization;
  }> = [];
  readonly unbindCalls: Array<{
    profile: GatewayProfile;
    authorization: DeviceAuthorization;
  }> = [];

  fetchHandler: (
    profile: GatewayProfile,
    session: EntrySessionCredential
  ) => Promise<PersonalPortalContext> = async () => context;
  renewHandler: (
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ) => Promise<SessionRenewResponse> = async () => ({
    protocolVersion: 1,
    entry: session('new')
  });
  logoutHandler: (
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ) => Promise<MobileOperationResponse> = async () => ({
    protocolVersion: 1,
    status: 'logged_out'
  });
  unbindHandler: (
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ) => Promise<MobileOperationResponse> = async () => ({
    protocolVersion: 1,
    status: 'revoked'
  });

  async fetchPortalContext(
    gatewayProfile: GatewayProfile,
    entry: EntrySessionCredential
  ): Promise<PersonalPortalContext> {
    this.fetchCalls.push({ profile: gatewayProfile, session: entry });
    return this.fetchHandler(gatewayProfile, entry);
  }

  async renew(
    gatewayProfile: GatewayProfile,
    authorization: DeviceAuthorization
  ): Promise<SessionRenewResponse> {
    this.renewCalls.push({ profile: gatewayProfile, authorization });
    return this.renewHandler(gatewayProfile, authorization);
  }

  async logout(
    gatewayProfile: GatewayProfile,
    authorization: DeviceAuthorization
  ): Promise<MobileOperationResponse> {
    this.logoutCalls.push({ profile: gatewayProfile, authorization });
    return this.logoutHandler(gatewayProfile, authorization);
  }

  async unbind(
    gatewayProfile: GatewayProfile,
    authorization: DeviceAuthorization
  ): Promise<MobileOperationResponse> {
    this.unbindCalls.push({ profile: gatewayProfile, authorization });
    return this.unbindHandler(gatewayProfile, authorization);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('returns needsPairing when no Device authorization exists', async () => {
  const credentials = new MemoryCredentialStore();
  credentials.authorization = null;
  const gateway = new StubSessionGateway();
  const manager = new SessionManager(gateway, credentials, () => now);

  assert.deepEqual(await manager.restore(), { kind: 'needsPairing' });
  assert.equal(gateway.fetchCalls.length, 0);
  assert.equal(gateway.renewCalls.length, 0);
});

test('restores a valid Session without renewing it', async () => {
  const credentials = new MemoryCredentialStore();
  const stored = session('valid');
  credentials.currentSession = stored;
  const gateway = new StubSessionGateway();
  const manager = new SessionManager(gateway, credentials, () => now);

  assert.deepEqual(await manager.restore(), { kind: 'authenticated', context });
  assert.deepEqual(gateway.fetchCalls, [{ profile, session: stored }]);
  assert.equal(gateway.renewCalls.length, 0);
  assert.equal(credentials.replacements.length, 0);
});

test('renews a missing or expired Session and stores it before loading Portal Context', async () => {
  for (const stored of [null, session('expired', '2026-07-25T02:59:59.000Z')]) {
    const credentials = new MemoryCredentialStore();
    credentials.currentSession = stored;
    const renewed = session(stored === null ? 'missing-renewed' : 'expired-renewed');
    const gateway = new StubSessionGateway();
    gateway.renewHandler = async () => ({ protocolVersion: 1, entry: renewed });
    const manager = new SessionManager(gateway, credentials, () => now);

    assert.deepEqual(await manager.restore(), { kind: 'authenticated', context });
    assert.equal(gateway.renewCalls.length, 1);
    assert.deepEqual(credentials.replacements, [renewed]);
    assert.equal(gateway.fetchCalls[0]?.session, renewed);
  }
});

test('renews once and retries Portal Context after an invalid Entry Session', async () => {
  const credentials = new MemoryCredentialStore();
  const oldSession = session('old');
  const renewed = session('renewed');
  credentials.currentSession = oldSession;
  const gateway = new StubSessionGateway();
  gateway.renewHandler = async () => ({ protocolVersion: 1, entry: renewed });
  gateway.fetchHandler = async (_profile, entry) => {
    if (entry.entrySessionRef === oldSession.entrySessionRef) {
      throw new GatewayClientError('server', 'ENTRY_SESSION_INVALID');
    }
    return context;
  };
  const manager = new SessionManager(gateway, credentials, () => now);

  assert.deepEqual(await manager.restore(), { kind: 'authenticated', context });
  assert.equal(gateway.renewCalls.length, 1);
  assert.deepEqual(
    gateway.fetchCalls.map((call) => call.session.entrySessionRef),
    [oldSession.entrySessionRef, renewed.entrySessionRef]
  );
  assert.deepEqual(credentials.replacements, [renewed]);
});

test('coalesces concurrent renewal requests into one Gateway call', async () => {
  const credentials = new MemoryCredentialStore();
  credentials.currentSession = session('expired', '2026-07-25T02:59:59.000Z');
  const renewed = session('coalesced');
  const pending = deferred<SessionRenewResponse>();
  const gateway = new StubSessionGateway();
  gateway.renewHandler = async () => pending.promise;
  const manager = new SessionManager(gateway, credentials, () => now);

  const first = manager.validSession();
  const second = manager.validSession();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(gateway.renewCalls.length, 1);

  pending.resolve({ protocolVersion: 1, entry: renewed });
  assert.deepEqual(await Promise.all([first, second]), [renewed, renewed]);
  assert.deepEqual(credentials.replacements, [renewed]);
});

test('returns offline without clearing credentials on transport failure', async () => {
  const credentials = new MemoryCredentialStore();
  credentials.currentSession = session('valid');
  const gateway = new StubSessionGateway();
  gateway.fetchHandler = async () => {
    throw new GatewayClientError('unreachable');
  };
  const manager = new SessionManager(gateway, credentials, () => now);

  assert.deepEqual(await manager.restore(), { kind: 'offline' });
  assert.equal(credentials.clearSessionCalls, 0);
  assert.equal(credentials.clearDeviceAndSessionCalls, 0);
  assert.notEqual(credentials.currentSession, null);
});

test('clears Device and Session authorization when the server revokes the Device', async () => {
  const credentials = new MemoryCredentialStore();
  credentials.currentSession = session('valid');
  const gateway = new StubSessionGateway();
  gateway.fetchHandler = async () => {
    throw new GatewayClientError('server', 'DEVICE_REVOKED');
  };
  const manager = new SessionManager(gateway, credentials, () => now);

  assert.deepEqual(await manager.restore(), { kind: 'revoked' });
  assert.equal(credentials.clearDeviceAndSessionCalls, 1);
  assert.equal(credentials.authorization, null);
});

test('logout uses Device authorization and clears only the Session', async () => {
  const credentials = new MemoryCredentialStore();
  credentials.currentSession = null;
  const gateway = new StubSessionGateway();
  const manager = new SessionManager(gateway, credentials, () => now);

  await manager.logout();

  assert.deepEqual(gateway.logoutCalls, [{ profile, authorization: device }]);
  assert.equal(credentials.clearSessionCalls, 1);
  assert.equal(credentials.clearDeviceAndSessionCalls, 0);
  assert.deepEqual(credentials.authorization, device);
});

test('unbind clears all authorization after success or an already-revoked response', async () => {
  for (const alreadyRevoked of [false, true]) {
    const credentials = new MemoryCredentialStore();
    credentials.currentSession = session('valid');
    const gateway = new StubSessionGateway();
    if (alreadyRevoked) {
      gateway.unbindHandler = async () => {
        throw new GatewayClientError('server', 'DEVICE_REVOKED');
      };
    }
    const manager = new SessionManager(gateway, credentials, () => now);

    await manager.unbind();

    assert.deepEqual(gateway.unbindCalls, [{ profile, authorization: device }]);
    assert.equal(credentials.clearDeviceAndSessionCalls, 1);
    assert.equal(credentials.authorization, null);
  }
});

test('unbind preserves local authorization when the Gateway is unreachable', async () => {
  const credentials = new MemoryCredentialStore();
  credentials.currentSession = session('valid');
  const gateway = new StubSessionGateway();
  gateway.unbindHandler = async () => {
    throw new GatewayClientError('unreachable');
  };
  const manager = new SessionManager(gateway, credentials, () => now);

  await assert.rejects(
    () => manager.unbind(),
    (error) => error instanceof GatewayClientError && error.kind === 'unreachable'
  );
  assert.equal(credentials.clearDeviceAndSessionCalls, 0);
  assert.deepEqual(credentials.authorization, device);
});
