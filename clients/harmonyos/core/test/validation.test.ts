import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMobileGatewayError,
  parseMobileOperationResponse,
  parsePairingClaimResponse,
  parsePairingPreviewResponse,
  parsePersonalPortalContext,
  parseSessionRenewResponse
} from '../src/validation.ts';

const entry = {
  entryBindingRef: 'entry-binding:test-1',
  entrySessionRef: 'entry-session:test-1',
  token: 'A'.repeat(43),
  expiresAt: '2026-08-01T12:00:00.000Z'
};

test('accepts canonical Mobile Entry responses', () => {
  assert.equal(parsePairingPreviewResponse({
    protocolVersion: 1,
    family: { displayName: '测试家庭' },
    person: { displayName: '测试成员' },
    gatewayHost: 'gateway.example.test',
    expiresAt: '2026-07-25T12:05:00.000Z'
  }).person.displayName, '测试成员');

  assert.equal(parsePairingClaimResponse({
    protocolVersion: 1,
    device: { deviceRef: 'device:test-1', displayName: '测试鸿蒙手机', status: 'active' },
    entry
  }).device.status, 'active');

  assert.equal(parseSessionRenewResponse({ protocolVersion: 1, entry }).entry.token.length, 43);

  assert.equal(parsePersonalPortalContext({
    protocolVersion: 1,
    audience: 'personal',
    entrySessionRef: entry.entrySessionRef,
    entryBindingRef: entry.entryBindingRef,
    family: { familyRef: 'family:test-1', displayName: '测试家庭' },
    person: { personRef: 'person:test-1', displayName: '测试成员' },
    membership: { familyRole: 'adult' },
    device: {
      deviceRef: 'device:test-1',
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
  }).device.platform, 'harmonyos');
});

test('rejects unknown fields, wrong protocol versions and malformed references', () => {
  assert.throws(() => parsePairingPreviewResponse({
    protocolVersion: 1,
    family: { displayName: '测试家庭', leaked: true },
    person: { displayName: '测试成员' },
    gatewayHost: 'gateway.example.test',
    expiresAt: '2026-07-25T12:05:00.000Z'
  }), /MOBILE_ENTRY_RESPONSE_INVALID/);

  assert.throws(() => parsePairingClaimResponse({
    protocolVersion: 2,
    device: { deviceRef: 'device:test-1', displayName: '测试鸿蒙手机', status: 'active' },
    entry
  }), /MOBILE_ENTRY_RESPONSE_INVALID/);

  assert.throws(() => parseSessionRenewResponse({
    protocolVersion: 1,
    entry: { ...entry, entrySessionRef: 'bad-ref' }
  }), /MOBILE_ENTRY_RESPONSE_INVALID/);
});

test('maps stable server error codes without inspecting localized messages', () => {
  const parsed = parseMobileGatewayError({
    protocolVersion: 1,
    error: {
      code: 'DEVICE_REVOKED',
      category: 'permission',
      message: '任意本地化文案',
      retryable: false,
      requestId: 'request:test-1'
    }
  });
  assert.equal(parsed.error.code, 'DEVICE_REVOKED');
  assert.equal(parsed.error.retryable, false);
});

test('rejects a portal context that misclassifies the HarmonyOS device as another platform', () => {
  assert.throws(() => parsePersonalPortalContext({
    protocolVersion: 1,
    audience: 'personal',
    entrySessionRef: entry.entrySessionRef,
    entryBindingRef: entry.entryBindingRef,
    family: { familyRef: 'family:test-1', displayName: '测试家庭' },
    person: { personRef: 'person:test-1', displayName: '测试成员' },
    membership: { familyRole: 'adult' },
    device: {
      deviceRef: 'device:test-1',
      displayName: '测试鸿蒙手机',
      terminalType: 'mobile',
      platform: 'ios'
    },
    agent: {
      assignmentRef: 'assignment:test-1',
      assignmentType: 'personal_assistant',
      agentRef: 'agent:test-1',
      displayName: '个人助理',
      providerProfileRef: 'provider-profile:test-1'
    }
  }), /MOBILE_ENTRY_RESPONSE_INVALID/);
});

test('accepts only the two versioned mobile operation terminal states', () => {
  assert.equal(parseMobileOperationResponse({ protocolVersion: 1, status: 'logged_out' }).status, 'logged_out');
  assert.equal(parseMobileOperationResponse({ protocolVersion: 1, status: 'revoked' }).status, 'revoked');
  assert.throws(() => parseMobileOperationResponse({ protocolVersion: 1, status: 'ok' }), /MOBILE_ENTRY_RESPONSE_INVALID/);
});
