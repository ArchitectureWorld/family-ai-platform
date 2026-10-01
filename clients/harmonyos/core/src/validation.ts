import type {
  EntrySessionCredential,
  MobileGatewayError,
  MobileGatewayErrorCategory,
  MobileGatewayErrorCode,
  MobileOperationResponse,
  PairingClaimResponse,
  PairingPreviewResponse,
  PersonalPortalContext,
  SessionRenewResponse
} from './types.ts';

const REF_PATTERNS: Record<string, RegExp> = {
  family: /^family:[a-z0-9][a-z0-9._:-]{1,126}$/,
  person: /^person:[a-z0-9][a-z0-9._:-]{1,126}$/,
  device: /^device:[a-z0-9][a-z0-9._:-]{1,126}$/,
  'entry-binding': /^entry-binding:[a-z0-9][a-z0-9._:-]{1,126}$/,
  'entry-session': /^entry-session:[a-z0-9][a-z0-9._:-]{1,126}$/,
  assignment: /^assignment:[a-z0-9][a-z0-9._:-]{1,126}$/,
  agent: /^agent:[a-z0-9][a-z0-9._:-]{1,126}$/,
  'provider-profile': /^provider-profile:[a-z0-9][a-z0-9._:-]{1,126}$/
};

const ERROR_CODES = new Set<MobileGatewayErrorCode>([
  'PAIRING_INVALID',
  'PAIRING_EXPIRED',
  'PAIRING_CONSUMED',
  'PAIRING_ATTEMPTS_EXCEEDED',
  'PAIRING_TARGET_INACTIVE',
  'DEVICE_AUTH_INVALID',
  'DEVICE_REVOKED',
  'ENTRY_SESSION_EXPIRED',
  'ENTRY_SESSION_INVALID',
  'ENTRY_AUDIENCE_FORBIDDEN',
  'PROTOCOL_VERSION_UNSUPPORTED'
]);

const ERROR_CATEGORIES = new Set<MobileGatewayErrorCategory>([
  'validation',
  'permission',
  'availability',
  'timeout',
  'conflict',
  'internal'
]);

function invalid(): never {
  throw new Error('MOBILE_ENTRY_RESPONSE_INVALID');
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid();
  }
}

function stringValue(value: unknown, minimum = 1, maximum = 500): string {
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > maximum) {
    invalid();
  }
  return value;
}

function literal<T extends string | number>(value: unknown, expected: T): T {
  if (value !== expected) invalid();
  return expected;
}

function reference(value: unknown, kind: keyof typeof REF_PATTERNS): string {
  const parsed = stringValue(value, 3, 140);
  if (!REF_PATTERNS[kind].test(parsed)) invalid();
  return parsed;
}

function timestamp(value: unknown): string {
  const parsed = stringValue(value, 1, 80);
  if (!Number.isFinite(Date.parse(parsed)) || !parsed.includes('T')) invalid();
  return parsed;
}

function displayName(value: unknown): string {
  return stringValue(value, 1, 80);
}

function entryCredential(value: unknown): EntrySessionCredential {
  const item = record(value);
  exact(item, ['entryBindingRef', 'entrySessionRef', 'token', 'expiresAt']);
  const token = stringValue(item.token, 43, 43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) invalid();
  return {
    entryBindingRef: reference(item.entryBindingRef, 'entry-binding'),
    entrySessionRef: reference(item.entrySessionRef, 'entry-session'),
    token,
    expiresAt: timestamp(item.expiresAt)
  };
}

export function parsePairingPreviewResponse(value: unknown): PairingPreviewResponse {
  const item = record(value);
  exact(item, ['protocolVersion', 'family', 'person', 'gatewayHost', 'expiresAt']);
  literal(item.protocolVersion, 1);
  const family = record(item.family);
  const person = record(item.person);
  exact(family, ['displayName']);
  exact(person, ['displayName']);
  return {
    protocolVersion: 1,
    family: { displayName: displayName(family.displayName) },
    person: { displayName: displayName(person.displayName) },
    gatewayHost: stringValue(item.gatewayHost, 1, 253),
    expiresAt: timestamp(item.expiresAt)
  };
}

export function parsePairingClaimResponse(value: unknown): PairingClaimResponse {
  const item = record(value);
  exact(item, ['protocolVersion', 'device', 'entry']);
  literal(item.protocolVersion, 1);
  const device = record(item.device);
  exact(device, ['deviceRef', 'displayName', 'status']);
  return {
    protocolVersion: 1,
    device: {
      deviceRef: reference(device.deviceRef, 'device'),
      displayName: displayName(device.displayName),
      status: literal(device.status, 'active')
    },
    entry: entryCredential(item.entry)
  };
}

export function parseSessionRenewResponse(value: unknown): SessionRenewResponse {
  const item = record(value);
  exact(item, ['protocolVersion', 'entry']);
  literal(item.protocolVersion, 1);
  return { protocolVersion: 1, entry: entryCredential(item.entry) };
}

export function parsePersonalPortalContext(value: unknown): PersonalPortalContext {
  const item = record(value);
  exact(item, [
    'protocolVersion',
    'audience',
    'entrySessionRef',
    'entryBindingRef',
    'family',
    'person',
    'membership',
    'device',
    'agent'
  ]);
  literal(item.protocolVersion, 1);
  literal(item.audience, 'personal');

  const family = record(item.family);
  const person = record(item.person);
  const membership = record(item.membership);
  const device = record(item.device);
  const agent = record(item.agent);
  exact(family, ['familyRef', 'displayName']);
  exact(person, ['personRef', 'displayName']);
  exact(membership, ['familyRole']);
  exact(device, ['deviceRef', 'displayName', 'terminalType', 'platform']);
  exact(agent, [
    'assignmentRef',
    'assignmentType',
    'agentRef',
    'displayName',
    'providerProfileRef'
  ]);

  const role = membership.familyRole;
  if (role !== 'owner' && role !== 'adult' && role !== 'child' && role !== 'elder') invalid();
  const terminalType = stringValue(device.terminalType, 1, 32);
  const platform = stringValue(device.platform, 1, 64);
  if (terminalType !== 'mobile' || platform !== 'harmonyos') invalid();

  return {
    protocolVersion: 1,
    audience: 'personal',
    entrySessionRef: reference(item.entrySessionRef, 'entry-session'),
    entryBindingRef: reference(item.entryBindingRef, 'entry-binding'),
    family: {
      familyRef: reference(family.familyRef, 'family'),
      displayName: displayName(family.displayName)
    },
    person: {
      personRef: reference(person.personRef, 'person'),
      displayName: displayName(person.displayName)
    },
    membership: { familyRole: role },
    device: {
      deviceRef: reference(device.deviceRef, 'device'),
      displayName: displayName(device.displayName),
      terminalType,
      platform
    },
    agent: {
      assignmentRef: reference(agent.assignmentRef, 'assignment'),
      assignmentType: literal(agent.assignmentType, 'personal_assistant'),
      agentRef: reference(agent.agentRef, 'agent'),
      displayName: displayName(agent.displayName),
      providerProfileRef: reference(agent.providerProfileRef, 'provider-profile')
    }
  };
}

export function parseMobileOperationResponse(value: unknown): MobileOperationResponse {
  const item = record(value);
  exact(item, ['protocolVersion', 'status']);
  literal(item.protocolVersion, 1);
  if (item.status !== 'revoked' && item.status !== 'logged_out') invalid();
  return { protocolVersion: 1, status: item.status };
}

export function parseMobileGatewayError(value: unknown): MobileGatewayError {
  const item = record(value);
  exact(item, ['protocolVersion', 'error']);
  literal(item.protocolVersion, 1);
  const error = record(item.error);
  const allowed = ['code', 'category', 'message', 'retryable'];
  if ('requestId' in error) allowed.push('requestId');
  exact(error, allowed);

  if (typeof error.code !== 'string' || !ERROR_CODES.has(error.code as MobileGatewayErrorCode)) invalid();
  if (
    typeof error.category !== 'string' ||
    !ERROR_CATEGORIES.has(error.category as MobileGatewayErrorCategory)
  ) invalid();
  if (typeof error.retryable !== 'boolean') invalid();

  const parsed: MobileGatewayError = {
    protocolVersion: 1,
    error: {
      code: error.code as MobileGatewayErrorCode,
      category: error.category as MobileGatewayErrorCategory,
      message: stringValue(error.message, 1, 500),
      retryable: error.retryable
    }
  };
  if (error.requestId !== undefined) {
    parsed.error.requestId = stringValue(error.requestId, 8, 128);
  }
  return parsed;
}
