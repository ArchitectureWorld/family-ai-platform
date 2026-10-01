import { validateGatewayBaseUrl } from './gatewayUrl.ts';
import type { PairingQrPayload } from './types.ts';

const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const PAIRING_REF = /^pairing:[a-z0-9][a-z0-9._:-]{1,126}$/;

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /T/.test(value);
}

export function normalizePairingCode(value: string): string {
  const compact = value
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, '')
    .slice(0, 8);
  return compact.length > 4
    ? `${compact.slice(0, 4)}-${compact.slice(4)}`
    : compact;
}

export function parsePairingQr(rawValue: string): PairingQrPayload {
  try {
    const url = new URL(rawValue);
    if (url.protocol !== 'familyai:' || url.hostname !== 'pair') {
      throw new Error('scheme');
    }
    const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
    const version = fragment.get('v');
    const gateway = fragment.get('gateway');
    const pairingRef = fragment.get('pairingRef');
    const code = fragment.get('code');
    const expiresAt = fragment.get('expiresAt');
    const knownKeys = new Set(['v', 'gateway', 'pairingRef', 'code', 'expiresAt']);
    for (const key of fragment.keys()) {
      if (!knownKeys.has(key)) throw new Error('field');
    }
    if (
      version !== '1' ||
      gateway === null ||
      pairingRef === null ||
      code === null ||
      expiresAt === null ||
      !PAIRING_REF.test(pairingRef) ||
      !PAIRING_CODE.test(code) ||
      !validTimestamp(expiresAt)
    ) {
      throw new Error('shape');
    }
    return {
      version: 1,
      gateway: validateGatewayBaseUrl(gateway),
      pairingRef,
      code,
      expiresAt
    };
  } catch {
    throw new Error('PAIRING_QR_INVALID');
  }
}
