import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAppState, reduceAppState } from '../src/state.ts';

const context = {
  personDisplayName: '测试成员',
  familyDisplayName: '测试家庭',
  deviceDisplayName: '测试鸿蒙手机'
};

test('moves from launch to pairing when no device authorization exists', () => {
  assert.deepEqual(
    reduceAppState(initialAppState(), { type: 'BOOTSTRAP_NO_DEVICE' }),
    { kind: 'needsPairing' }
  );
});

test('preserves cached identity when transport is offline', () => {
  const authenticated = reduceAppState(initialAppState(), {
    type: 'AUTHENTICATED',
    context,
    sessionExpiresAt: '2026-08-01T12:00:00.000Z'
  });
  assert.deepEqual(reduceAppState(authenticated, {
    type: 'TRANSPORT_OFFLINE',
    cachedContext: context,
    lastSyncedAt: '2026-07-25T12:00:00.000Z'
  }), {
    kind: 'offline',
    cachedContext: context,
    lastSyncedAt: '2026-07-25T12:00:00.000Z'
  });
});

test('device revocation removes protected context and returns to explicit acknowledgement', () => {
  const authenticated = reduceAppState(initialAppState(), {
    type: 'AUTHENTICATED',
    context,
    sessionExpiresAt: '2026-08-01T12:00:00.000Z'
  });
  const revoked = reduceAppState(authenticated, { type: 'DEVICE_REVOKED' });
  assert.deepEqual(revoked, { kind: 'authorizationRevoked' });
  assert.deepEqual(reduceAppState(revoked, { type: 'ACKNOWLEDGE_REVOCATION' }), {
    kind: 'needsPairing'
  });
});

test('local lock never invents an authenticated state', () => {
  const locked = reduceAppState({ kind: 'needsPairing' }, { type: 'LOCK_REQUIRED' });
  assert.deepEqual(locked, { kind: 'needsPairing' });

  const authenticated = reduceAppState(initialAppState(), {
    type: 'AUTHENTICATED',
    context,
    sessionExpiresAt: '2026-08-01T12:00:00.000Z'
  });
  assert.deepEqual(reduceAppState(authenticated, { type: 'LOCK_REQUIRED' }), {
    kind: 'locked',
    protectedState: authenticated
  });
});
