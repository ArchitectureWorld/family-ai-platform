import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEntryRequest,
  buildDeviceRequest,
  buildPublicRequest
} from '../src/requests.ts';

const entry = { entrySessionRef: 'entry-session:test-1', token: 'T'.repeat(43) };
const device = { deviceRef: 'device:test-1', deviceCredential: 'D'.repeat(43) };

test('never mixes Entry Session and Device authentication headers', () => {
  const portal = buildEntryRequest('/api/v1/portal/context', 'GET', entry);
  assert.equal(portal.headers.authorization, `Bearer ${entry.token}`);
  assert.equal(portal.headers['x-entry-session-ref'], entry.entrySessionRef);
  assert.equal('x-device-ref' in portal.headers, false);

  const renew = buildDeviceRequest('/api/v1/mobile/session/renew', 'POST', device);
  assert.equal(renew.headers.authorization, `Device ${device.deviceCredential}`);
  assert.equal(renew.headers['x-device-ref'], device.deviceRef);
  assert.equal('x-entry-session-ref' in renew.headers, false);
});

test('builds mobile logout with Device authentication to match Gateway semantics', () => {
  const logout = buildDeviceRequest('/api/v1/mobile/session/logout', 'POST', device);
  assert.equal(logout.headers.authorization, `Device ${device.deviceCredential}`);
  assert.equal(logout.path, '/api/v1/mobile/session/logout');
});

test('public pairing requests contain no authorization headers', () => {
  const request = buildPublicRequest('/api/v1/mobile/pairing/preview', 'POST', {
    protocolVersion: 1,
    code: 'ABCD-EFGH'
  });
  assert.equal('authorization' in request.headers, false);
  assert.equal(request.headers['content-type'], 'application/json');
});
