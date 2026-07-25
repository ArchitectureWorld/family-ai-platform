import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GatewayClientError,
  GatewayTransportError,
  MobileGatewayClient,
  type GatewayTransport,
  type GatewayTransportResponse
} from '../src/gatewayClient.ts';
import type { GatewayRequest } from '../src/requests.ts';
import type { EntrySessionCredential } from '../src/types.ts';

const profile = { baseURL: 'https://gateway.example.test/' };
const session: EntrySessionCredential = {
  entryBindingRef: 'entry-binding:test-1',
  entrySessionRef: 'entry-session:test-1',
  token: 'T'.repeat(43),
  expiresAt: '2026-08-01T12:00:00.000Z'
};
const device = {
  deviceRef: 'device:test-1',
  deviceCredential: 'D'.repeat(43)
};

const contextBody = {
  protocolVersion: 1,
  audience: 'personal',
  entrySessionRef: session.entrySessionRef,
  entryBindingRef: session.entryBindingRef,
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

interface RecordedCall {
  baseURL: string;
  request: GatewayRequest;
}

class StubTransport implements GatewayTransport {
  readonly calls: RecordedCall[] = [];
  responses: GatewayTransportResponse[] = [];
  error: Error | null = null;

  async send(input: RecordedCall): Promise<GatewayTransportResponse> {
    this.calls.push(input);
    if (this.error) throw this.error;
    const response = this.responses.shift();
    if (!response) throw new Error('NO_STUB_RESPONSE');
    return response;
  }
}

function expectClientError(
  error: unknown,
  expected: { kind: GatewayClientError['kind']; serverCode?: string }
): boolean {
  assert.ok(error instanceof GatewayClientError);
  assert.equal(error.kind, expected.kind);
  assert.equal(error.serverCode, expected.serverCode);
  return true;
}

test('uses Entry Session authentication only for Portal Context', async () => {
  const transport = new StubTransport();
  transport.responses.push({ status: 200, body: contextBody });
  const client = new MobileGatewayClient(transport);

  const context = await client.fetchPortalContext(profile, session);

  assert.equal(context.person.displayName, '测试成员');
  assert.deepEqual(transport.calls, [{
    baseURL: 'https://gateway.example.test',
    request: {
      path: '/api/v1/portal/context',
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${session.token}`,
        'x-entry-session-ref': session.entrySessionRef
      }
    }
  }]);
  assert.equal('x-device-ref' in transport.calls[0]!.request.headers, false);
});

test('uses Device Credential authentication for renew, logout and unbind', async () => {
  const transport = new StubTransport();
  transport.responses.push(
    { status: 200, body: { protocolVersion: 1, entry: session } },
    { status: 200, body: { protocolVersion: 1, status: 'logged_out' } },
    { status: 200, body: { protocolVersion: 1, status: 'revoked' } }
  );
  const client = new MobileGatewayClient(transport);

  assert.equal((await client.renew(profile, device)).entry.entrySessionRef, session.entrySessionRef);
  assert.equal((await client.logout(profile, device)).status, 'logged_out');
  assert.equal((await client.unbind(profile, device)).status, 'revoked');

  assert.deepEqual(
    transport.calls.map(({ baseURL, request }) => ({
      baseURL,
      path: request.path,
      method: request.method,
      headers: request.headers
    })),
    [
      {
        baseURL: 'https://gateway.example.test',
        path: '/api/v1/mobile/session/renew',
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Device ${device.deviceCredential}`,
          'x-device-ref': device.deviceRef
        }
      },
      {
        baseURL: 'https://gateway.example.test',
        path: '/api/v1/mobile/session/logout',
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Device ${device.deviceCredential}`,
          'x-device-ref': device.deviceRef
        }
      },
      {
        baseURL: 'https://gateway.example.test',
        path: '/api/v1/mobile/device',
        method: 'DELETE',
        headers: {
          accept: 'application/json',
          authorization: `Device ${device.deviceCredential}`,
          'x-device-ref': device.deviceRef
        }
      }
    ]
  );
  for (const call of transport.calls) {
    assert.equal('x-entry-session-ref' in call.request.headers, false);
  }
});

test('maps stable server errors without inspecting localized messages', async () => {
  const transport = new StubTransport();
  transport.responses.push({
    status: 403,
    body: {
      protocolVersion: 1,
      error: {
        code: 'DEVICE_REVOKED',
        category: 'permission',
        message: '任意本地化文案',
        retryable: false,
        requestId: 'request:test-1'
      }
    }
  });
  const client = new MobileGatewayClient(transport);

  await assert.rejects(
    () => client.renew(profile, device),
    (error) => expectClientError(error, { kind: 'server', serverCode: 'DEVICE_REVOKED' })
  );
});

test('rejects malformed success and error responses', async () => {
  const transport = new StubTransport();
  const client = new MobileGatewayClient(transport);

  transport.responses.push({ status: 200, body: { protocolVersion: 1, entry: { token: 'bad' } } });
  await assert.rejects(
    () => client.renew(profile, device),
    (error) => expectClientError(error, { kind: 'invalid_response' })
  );

  transport.responses.push({ status: 500, body: { code: 'DEVICE_REVOKED' } });
  await assert.rejects(
    () => client.renew(profile, device),
    (error) => expectClientError(error, { kind: 'invalid_response' })
  );
});

test('keeps timeout and unreachable transport failures distinct', async () => {
  const transport = new StubTransport();
  const client = new MobileGatewayClient(transport);

  transport.error = new GatewayTransportError('timeout');
  await assert.rejects(
    () => client.renew(profile, device),
    (error) => expectClientError(error, { kind: 'timeout' })
  );

  transport.error = new GatewayTransportError('unreachable');
  await assert.rejects(
    () => client.renew(profile, device),
    (error) => expectClientError(error, { kind: 'unreachable' })
  );

  transport.error = new Error('raw transport detail');
  await assert.rejects(
    () => client.renew(profile, device),
    (error) => expectClientError(error, { kind: 'invalid_response' })
  );
});

test('rejects an insecure Gateway before invoking the Transport', async () => {
  const transport = new StubTransport();
  transport.responses.push({ status: 200, body: contextBody });
  const client = new MobileGatewayClient(transport);

  await assert.rejects(
    () => client.fetchPortalContext({ baseURL: 'http://gateway.example.test' }, session),
    (error) => expectClientError(error, { kind: 'insecure_gateway' })
  );
  assert.equal(transport.calls.length, 0);
});
