import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGatewayBaseUrl } from '../src/gatewayUrl.ts';

test('accepts a bare HTTPS Gateway origin and normalizes the trailing slash', () => {
  assert.equal(
    validateGatewayBaseUrl('https://family-ai-gateway.example.test/'),
    'https://family-ai-gateway.example.test'
  );
});

test('rejects insecure, credential-bearing, routed and decorated Gateway URLs', () => {
  for (const value of [
    'http://family-ai-gateway.example.test',
    'https://user:pass@family-ai-gateway.example.test',
    'https://family-ai-gateway.example.test/member',
    'https://family-ai-gateway.example.test?token=x',
    'https://family-ai-gateway.example.test/#secret',
    'not-a-url'
  ]) {
    assert.throws(() => validateGatewayBaseUrl(value), /GATEWAY_URL_INVALID/);
  }
});
