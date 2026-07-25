import test from 'node:test';
import assert from 'node:assert/strict';
import { MOBILE_ENDPOINTS } from '../src/endpoints.ts';

test('defines one explicit authentication mode for every current mobile endpoint', () => {
  assert.deepEqual(MOBILE_ENDPOINTS, {
    pairingPreview: { method: 'POST', path: '/api/v1/mobile/pairing/preview', authentication: 'public' },
    pairingClaim: { method: 'POST', path: '/api/v1/mobile/pairing/claim', authentication: 'public' },
    portalContext: { method: 'GET', path: '/api/v1/portal/context', authentication: 'entry' },
    sessionRenew: { method: 'POST', path: '/api/v1/mobile/session/renew', authentication: 'device' },
    sessionLogout: { method: 'POST', path: '/api/v1/mobile/session/logout', authentication: 'device' },
    deviceUnbind: { method: 'DELETE', path: '/api/v1/mobile/device', authentication: 'device' },
    homeChat: { method: 'GET', path: '/api/v1/chat', authentication: 'entry' },
    workConversations: { method: 'GET', path: '/api/v1/work-conversations', authentication: 'entry' },
    syncCatchUp: { method: 'GET', path: '/api/v1/sync/events', authentication: 'entry' },
    syncAck: { method: 'POST', path: '/api/v1/sync/ack', authentication: 'entry' },
    eventStream: { method: 'GET', path: '/api/v1/events/stream', authentication: 'entry' }
  });
});
