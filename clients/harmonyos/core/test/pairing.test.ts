import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePairingCode, parsePairingQr } from '../src/pairing.ts';

test('normalizes manual pairing input without admitting ambiguous characters', () => {
  assert.equal(normalizePairingCode('abcd efgh'), 'ABCD-EFGH');
  assert.equal(normalizePairingCode('ABCD-EF'), 'ABCD-EF');
  assert.equal(normalizePairingCode('A1OI-L0ZZ'), 'ALZZ');
});

test('parses the versioned Family AI QR fragment', () => {
  const payload = parsePairingQr(
    'familyai://pair#v=1&gateway=https%3A%2F%2Fgateway.example.test&pairingRef=pairing%3Atest-1&code=ABCD-EFGH&expiresAt=2026-07-25T12%3A05%3A00.000Z'
  );
  assert.deepEqual(payload, {
    version: 1,
    gateway: 'https://gateway.example.test',
    pairingRef: 'pairing:test-1',
    code: 'ABCD-EFGH',
    expiresAt: '2026-07-25T12:05:00.000Z'
  });
});

test('rejects malformed, unsupported or unsafe QR payloads', () => {
  for (const value of [
    'https://pair.example.test/#v=1',
    'familyai://other#v=1&gateway=https%3A%2F%2Fgateway.example.test&pairingRef=pairing%3Atest-1&code=ABCD-EFGH&expiresAt=2026-07-25T12%3A05%3A00.000Z',
    'familyai://pair#v=2&gateway=https%3A%2F%2Fgateway.example.test&pairingRef=pairing%3Atest-1&code=ABCD-EFGH&expiresAt=2026-07-25T12%3A05%3A00.000Z',
    'familyai://pair#v=1&gateway=http%3A%2F%2Fgateway.example.test&pairingRef=pairing%3Atest-1&code=ABCD-EFGH&expiresAt=2026-07-25T12%3A05%3A00.000Z',
    'familyai://pair#v=1&gateway=https%3A%2F%2Fgateway.example.test&pairingRef=pairing%3Atest-1&code=ABCD-EFGH'
  ]) {
    assert.throws(() => parsePairingQr(value), /PAIRING_QR_INVALID/);
  }
});
