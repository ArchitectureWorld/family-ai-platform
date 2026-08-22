import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public struct GatewayProfile: Codable, Equatable, Sendable {
  public let baseURL: URL
  public init(baseURL: URL) { self.baseURL = baseURL }
}
public struct DeviceAuthorization: Codable, Equatable, Sendable {
  public let deviceRef: String
  public let deviceCredential: String
  public init(deviceRef: String, deviceCredential: String) {
    self.deviceRef = deviceRef
    self.deviceCredential = deviceCredential
  }
}
public protocol GatewayClientProtocol: Sendable {
  func preview(baseURL: URL, request: PairingPreviewRequest) async throws -> PairingPreviewResponse
  func claim(baseURL: URL, request: PairingClaimRequest) async throws -> PairingClaimResponse
  func fetchPortalContext(baseURL: URL, session: EntrySessionCredential) async throws
    -> PersonalPortalContext
  func renew(baseURL: URL, authorization: DeviceAuthorization) async throws -> SessionRenewResponse
  func logout(baseURL: URL, session: EntrySessionCredential) async throws -> MobileOperationResponse
  func unbind(baseURL: URL, authorization: DeviceAuthorization) async throws
    -> MobileOperationResponse
}
public final class URLSessionGatewayClient: GatewayClientProtocol, @unchecked Sendable {
  private enum Authentication {
    case none
    case entry(EntrySessionCredential)
    case device(DeviceAuthorization)
  }
  private let session: URLSession
  private let decoder = MobileEntryCoding.decoder()
  private let encoder = MobileEntryCoding.encoder()
  public init(session: URLSession? = nil) {
    if let session {
      self.session = session
    } else {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.timeoutIntervalForRequest = 15
      configuration.timeoutIntervalForResource = 15
      self.session = URLSession(configuration: configuration)
    }
  }
  public func preview(baseURL: URL, request: PairingPreviewRequest) async throws
    -> PairingPreviewResponse
  {
    try await send(
      baseURL: baseURL, path: "/api/v1/mobile/pairing/preview", method: "POST", body: request,
      authentication: .none)
  }
  public func claim(baseURL: URL, request: PairingClaimRequest) async throws -> PairingClaimResponse
  {
    try await send(
      baseURL: baseURL, path: "/api/v1/mobile/pairing/claim", method: "POST", body: request,
      authentication: .none)
  }
  public func fetchPortalContext(baseURL: URL, session: EntrySessionCredential) async throws
    -> PersonalPortalContext
  {
    try await send(
      baseURL: baseURL, path: "/api/v1/portal/context", method: "GET", body: Optional<String>.none,
      authentication: .entry(session))
  }
  public func renew(baseURL: URL, authorization: DeviceAuthorization) async throws
    -> SessionRenewResponse
  {
    try await send(
      baseURL: baseURL, path: "/api/v1/mobile/session/renew", method: "POST",
      body: Optional<String>.none, authentication: .device(authorization))
  }
  public func logout(baseURL: URL, session: EntrySessionCredential) async throws
    -> MobileOperationResponse
  {
    try await send(
      baseURL: baseURL, path: "/api/v1/mobile/session/logout", method: "POST",
      body: Optional<String>.none, authentication: .entry(session))
  }
  public func unbind(baseURL: URL, authorization: DeviceAuthorization) async throws
    -> MobileOperationResponse
  {
    try await send(
      baseURL: baseURL, path: "/api/v1/mobile/device", method: "DELETE",
      body: Optional<String>.none, authentication: .device(authorization))
  }
  private func send<Response: Decodable, Body: Encodable>(
    baseURL: URL, path: String, method: String, body: Body?, authentication: Authentication
  ) async throws -> Response {
    guard let secureBaseURL = try? GatewayURLValidator.validate(baseURL.absoluteString),
      let url = URL(string: path, relativeTo: secureBaseURL)?.absoluteURL
    else { throw GatewayClientError.insecureGateway }
    var request = URLRequest(url: url, timeoutInterval: 15)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("ios-\(UUID().uuidString.lowercased())", forHTTPHeaderField: "X-Request-ID")
    if let body {
      request.httpBody = try encoder.encode(body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    switch authentication {
    case .none: break
    case .entry(let credential):
      request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
      request.setValue(credential.entrySessionRef, forHTTPHeaderField: "X-Entry-Session-Ref")
    case .device(let authorization):
      request.setValue(
        "Device \(authorization.deviceCredential)", forHTTPHeaderField: "Authorization")
      request.setValue(authorization.deviceRef, forHTTPHeaderField: "X-Device-Ref")
    }
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else {
        throw GatewayClientError.invalidResponse
      }
      guard (200..<300).contains(http.statusCode) else {
        if let envelope = try? decoder.decode(MobileGatewayErrorEnvelope.self, from: data) {
          throw GatewayClientError.server(envelope.error.code)
        }
        throw GatewayClientError.invalidResponse
      }
      do { return try decoder.decode(Response.self, from: data) } catch {
        throw GatewayClientError.invalidResponse
      }
    } catch let error as GatewayClientError { throw error } catch let error as URLError {
      if error.code == .timedOut { throw GatewayClientError.timeout }
      if [
        .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .networkConnectionLost,
        .notConnectedToInternet,
      ].contains(error.code) {
        throw GatewayClientError.unreachable
      }
      throw GatewayClientError.invalidResponse
    } catch { throw GatewayClientError.invalidResponse }
  }
}
