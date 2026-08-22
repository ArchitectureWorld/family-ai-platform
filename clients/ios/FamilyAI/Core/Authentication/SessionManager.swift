import Foundation

public enum SessionRestoreResult: Equatable, Sendable {
  case needsPairing
  case authenticated(PersonalPortalContext)
  case offline, revoked
}
public actor SessionManager {
  private let gateway: GatewayClientProtocol
  private let credentials: CredentialStoreProtocol
  private let now: @Sendable () -> Date
  private var renewalTask: Task<EntrySessionCredential, Error>?
  public init(
    gateway: GatewayClientProtocol, credentials: CredentialStoreProtocol,
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.gateway = gateway
    self.credentials = credentials
    self.now = now
  }
  public func restore() async throws -> SessionRestoreResult {
    guard let profile = try await credentials.gatewayProfile(),
      let device = try await credentials.deviceAuthorization()
    else { return .needsPairing }
    guard let storedSession = try await credentials.session() else {
      return try await restoreByRenewing(profile: profile, device: device)
    }
    let session: EntrySessionCredential
    if storedSession.expiresAt <= now() {
      do { session = try await renew(profile: profile, device: device) } catch {
        return try await mapRenewalFailure(error)
      }
    } else {
      session = storedSession
    }
    do {
      return .authenticated(
        try await gateway.fetchPortalContext(baseURL: profile.baseURL, session: session))
    } catch GatewayClientError.server(let code)
      where code == .entrySessionExpired || code == .entrySessionInvalid
    {
      do {
        let renewed = try await renew(profile: profile, device: device)
        return .authenticated(
          try await gateway.fetchPortalContext(baseURL: profile.baseURL, session: renewed))
      } catch { return try await mapRenewalFailure(error) }
    } catch GatewayClientError.server(.deviceRevoked) {
      try await credentials.clearDeviceAndSession()
      return .revoked
    } catch GatewayClientError.unreachable, GatewayClientError.timeout { return .offline }
  }
  public func validSession() async throws -> EntrySessionCredential {
    guard let profile = try await credentials.gatewayProfile(),
      let device = try await credentials.deviceAuthorization()
    else { throw GatewayClientError.server(.deviceAuthInvalid) }
    if let existing = try await credentials.session(), existing.expiresAt > now() {
      return existing
    }
    return try await renew(profile: profile, device: device)
  }
  public func logout() async throws {
    guard let profile = try await credentials.gatewayProfile(),
      let session = try await credentials.session()
    else {
      try await credentials.clearSession()
      return
    }

    do {
      _ = try await gateway.logout(
        baseURL: profile.baseURL,
        session: session
      )
      try await credentials.clearSession()
    } catch GatewayClientError.server(.entrySessionExpired),
      GatewayClientError.server(.entrySessionInvalid)
    {
      try await credentials.clearSession()
    } catch GatewayClientError.server(.deviceRevoked) {
      try await credentials.clearDeviceAndSession()
    } catch {
      throw error
    }
  }
  public func unbind() async throws {
    guard let profile = try await credentials.gatewayProfile(),
      let device = try await credentials.deviceAuthorization()
    else {
      try await credentials.clearDeviceAndSession()
      return
    }

    do {
      _ = try await gateway.unbind(
        baseURL: profile.baseURL,
        authorization: device
      )
    } catch GatewayClientError.server(.deviceRevoked) {
      // The server already reached the desired terminal state.
    } catch {
      throw error
    }

    try await credentials.clearDeviceAndSession()
  }
  private func restoreByRenewing(profile: GatewayProfile, device: DeviceAuthorization) async throws
    -> SessionRestoreResult
  {
    do {
      let session = try await renew(profile: profile, device: device)
      return .authenticated(
        try await gateway.fetchPortalContext(baseURL: profile.baseURL, session: session))
    } catch { return try await mapRenewalFailure(error) }
  }
  private func renew(profile: GatewayProfile, device: DeviceAuthorization) async throws
    -> EntrySessionCredential
  {
    if let renewalTask { return try await renewalTask.value }
    let task = Task { [gateway, credentials] in
      let response = try await gateway.renew(baseURL: profile.baseURL, authorization: device)
      try await credentials.replaceSessionAtomically(response.entry)
      return response.entry
    }
    renewalTask = task
    defer { renewalTask = nil }
    return try await task.value
  }
  private func mapRenewalFailure(_ error: Error) async throws -> SessionRestoreResult {
    if case GatewayClientError.server(.deviceRevoked) = error {
      try await credentials.clearDeviceAndSession()
      return .revoked
    }
    if case GatewayClientError.unreachable = error { return .offline }
    if case GatewayClientError.timeout = error { return .offline }
    throw error
  }
}
