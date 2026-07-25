import { MOBILE_ENDPOINTS } from './endpoints.ts';
import { validateGatewayBaseUrl } from './gatewayUrl.ts';
import {
  buildDeviceRequest,
  buildEntryRequest,
  type DeviceAuthorization,
  type GatewayRequest
} from './requests.ts';
import type {
  EntrySessionCredential,
  MobileGatewayErrorCode,
  MobileOperationResponse,
  PersonalPortalContext,
  SessionRenewResponse
} from './types.ts';
import {
  parseMobileGatewayError,
  parseMobileOperationResponse,
  parsePersonalPortalContext,
  parseSessionRenewResponse
} from './validation.ts';

export interface GatewayProfile {
  baseURL: string;
}

export interface GatewayTransportResponse {
  status: number;
  body: unknown;
}

export interface GatewayTransport {
  send(input: {
    baseURL: string;
    request: GatewayRequest;
  }): Promise<GatewayTransportResponse>;
}

export type GatewayTransportErrorKind = 'timeout' | 'unreachable';

export class GatewayTransportError extends Error {
  readonly kind: GatewayTransportErrorKind;

  constructor(kind: GatewayTransportErrorKind) {
    super(kind);
    this.name = 'GatewayTransportError';
    this.kind = kind;
  }
}

export type GatewayClientErrorKind =
  | 'timeout'
  | 'unreachable'
  | 'invalid_response'
  | 'insecure_gateway'
  | 'server';

export class GatewayClientError extends Error {
  readonly kind: GatewayClientErrorKind;
  readonly serverCode: MobileGatewayErrorCode | undefined;

  constructor(
    kind: GatewayClientErrorKind,
    serverCode?: MobileGatewayErrorCode
  ) {
    super(kind === 'server' && serverCode ? `${kind}:${serverCode}` : kind);
    this.name = 'GatewayClientError';
    this.kind = kind;
    this.serverCode = serverCode;
  }
}

type ResponseParser<T> = (value: unknown) => T;

export class MobileGatewayClient {
  private readonly transport: GatewayTransport;

  constructor(transport: GatewayTransport) {
    this.transport = transport;
  }

  fetchPortalContext(
    profile: GatewayProfile,
    session: EntrySessionCredential
  ): Promise<PersonalPortalContext> {
    const endpoint = MOBILE_ENDPOINTS.portalContext;
    return this.send(
      profile,
      buildEntryRequest(endpoint.path, endpoint.method, {
        entrySessionRef: session.entrySessionRef,
        token: session.token
      }),
      parsePersonalPortalContext
    );
  }

  renew(
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ): Promise<SessionRenewResponse> {
    const endpoint = MOBILE_ENDPOINTS.sessionRenew;
    return this.send(
      profile,
      buildDeviceRequest(endpoint.path, endpoint.method, authorization),
      parseSessionRenewResponse
    );
  }

  logout(
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ): Promise<MobileOperationResponse> {
    const endpoint = MOBILE_ENDPOINTS.sessionLogout;
    return this.send(
      profile,
      buildDeviceRequest(endpoint.path, endpoint.method, authorization),
      parseMobileOperationResponse
    );
  }

  unbind(
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ): Promise<MobileOperationResponse> {
    const endpoint = MOBILE_ENDPOINTS.deviceUnbind;
    return this.send(
      profile,
      buildDeviceRequest(endpoint.path, endpoint.method, authorization),
      parseMobileOperationResponse
    );
  }

  private async send<T>(
    profile: GatewayProfile,
    request: GatewayRequest,
    parse: ResponseParser<T>
  ): Promise<T> {
    let baseURL: string;
    try {
      baseURL = validateGatewayBaseUrl(profile.baseURL);
    } catch {
      throw new GatewayClientError('insecure_gateway');
    }

    const requestWithAccept: GatewayRequest = {
      ...request,
      headers: {
        accept: 'application/json',
        ...request.headers
      }
    };

    let response: GatewayTransportResponse;
    try {
      response = await this.transport.send({
        baseURL,
        request: requestWithAccept
      });
    } catch (error) {
      if (error instanceof GatewayTransportError) {
        throw new GatewayClientError(error.kind);
      }
      if (error instanceof GatewayClientError) throw error;
      throw new GatewayClientError('invalid_response');
    }

    if (response.status >= 200 && response.status < 300) {
      try {
        return parse(response.body);
      } catch {
        throw new GatewayClientError('invalid_response');
      }
    }

    try {
      const envelope = parseMobileGatewayError(response.body);
      throw new GatewayClientError('server', envelope.error.code);
    } catch (error) {
      if (error instanceof GatewayClientError) throw error;
      throw new GatewayClientError('invalid_response');
    }
  }
}
