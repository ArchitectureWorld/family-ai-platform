export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface GatewayRequest {
  path: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: unknown;
}

export interface EntryAuthorization {
  entrySessionRef: string;
  token: string;
}

export interface DeviceAuthorization {
  deviceRef: string;
  deviceCredential: string;
}

function headersForBody(body: unknown): Record<string, string> {
  return body === undefined ? {} : { 'content-type': 'application/json' };
}

export function buildPublicRequest(
  path: string,
  method: HttpMethod,
  body?: unknown
): GatewayRequest {
  return {
    path,
    method,
    headers: headersForBody(body),
    ...(body === undefined ? {} : { body })
  };
}

export function buildEntryRequest(
  path: string,
  method: HttpMethod,
  authorization: EntryAuthorization,
  body?: unknown
): GatewayRequest {
  return {
    path,
    method,
    headers: {
      ...headersForBody(body),
      authorization: `Bearer ${authorization.token}`,
      'x-entry-session-ref': authorization.entrySessionRef
    },
    ...(body === undefined ? {} : { body })
  };
}

export function buildDeviceRequest(
  path: string,
  method: HttpMethod,
  authorization: DeviceAuthorization,
  body?: unknown
): GatewayRequest {
  return {
    path,
    method,
    headers: {
      ...headersForBody(body),
      authorization: `Device ${authorization.deviceCredential}`,
      'x-device-ref': authorization.deviceRef
    },
    ...(body === undefined ? {} : { body })
  };
}
