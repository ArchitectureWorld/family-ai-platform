import XCTest

@testable import FamilyAICore

final class SessionManagerTests: XCTestCase {
  func testValidSessionRestoresContextWithoutRenewal() async throws {
    let gateway = GatewayStub()
    let store = try await configuredStore(session: session("valid", expires: 2_000_000_000))
    let manager = SessionManager(
      gateway: gateway, credentials: store, now: { Date(timeIntervalSince1970: 1_700_000_000) })
    let restoration = try await manager.restore()
    let renewCount = await gateway.renewCount
    XCTAssertEqual(restoration, .authenticated(GatewayStub.context))
    XCTAssertEqual(renewCount, 0)
  }

  func testExpiredConcurrentRequestsCoalesceRenewal() async throws {
    let gateway = GatewayStub()
    await gateway.setRenewDelay(100_000_000)
    let store = try await configuredStore(session: session("expired", expires: 1_600_000_000))
    let manager = SessionManager(
      gateway: gateway, credentials: store, now: { Date(timeIntervalSince1970: 1_700_000_000) })
    async let a = manager.validSession()
    async let b = manager.validSession()
    async let c = manager.validSession()
    _ = try await [a, b, c]
    let renewCount = await gateway.renewCount
    let storedSession = try await store.session()
    XCTAssertEqual(renewCount, 1)
    XCTAssertEqual(storedSession?.entrySessionRef, "entry-session:renewed")
  }

  func testLogoutUnreachablePreservesSession() async throws {
    let gateway = GatewayStub()
    await gateway.setLogoutError(.unreachable)
    let store = try await configuredStore(
      session: session("valid", expires: 2_000_000_000)
    )
    let manager = SessionManager(
      gateway: gateway,
      credentials: store
    )

    do {
      try await manager.logout()
      XCTFail("Expected unreachable logout to fail")
    } catch {
      XCTAssertEqual(error as? GatewayClientError, .unreachable)
    }

    let retainedSession = try await store.session()
    XCTAssertNotNil(retainedSession)
  }

  func testUnbindTreatsAlreadyRevokedDeviceAsCleared() async throws {
    let gateway = GatewayStub()
    await gateway.setUnbindError(.server(.deviceRevoked))
    let store = try await configuredStore(
      session: session("valid", expires: 2_000_000_000)
    )
    let manager = SessionManager(
      gateway: gateway,
      credentials: store
    )

    try await manager.unbind()

    let authorization = try await store.deviceAuthorization()
    let storedSession = try await store.session()
    XCTAssertNil(authorization)
    XCTAssertNil(storedSession)
  }

  func testRevokedClearsAuthorizationAndUnreachablePreservesIt() async throws {
    let revokedGateway = GatewayStub()
    await revokedGateway.setRenewError(.server(.deviceRevoked))
    let revokedStore = try await configuredStore(session: nil)
    let revokedResult = try await SessionManager(gateway: revokedGateway, credentials: revokedStore)
      .restore()
    let revokedAuthorization = try await revokedStore.deviceAuthorization()
    XCTAssertEqual(revokedResult, .revoked)
    XCTAssertNil(revokedAuthorization)

    let offlineGateway = GatewayStub()
    await offlineGateway.setRenewError(.unreachable)
    let offlineStore = try await configuredStore(session: nil)
    let offlineResult = try await SessionManager(gateway: offlineGateway, credentials: offlineStore)
      .restore()
    let retainedAuthorization = try await offlineStore.deviceAuthorization()
    XCTAssertEqual(offlineResult, .offline)
    XCTAssertNotNil(retainedAuthorization)
  }

  private func configuredStore(session: EntrySessionCredential?) async throws -> CredentialStore {
    let store = CredentialStore(keychain: InMemoryKeychainClient())
    try await store.saveGatewayAndDevice(
      profile: GatewayProfile(baseURL: URL(string: "https://gateway.example.com")!),
      authorization: DeviceAuthorization(deviceRef: "device:test", deviceCredential: "DEVICE"))
    if let session { try await store.replaceSessionAtomically(session) }
    return store
  }
  private func session(_ suffix: String, expires: TimeInterval) -> EntrySessionCredential {
    EntrySessionCredential(
      entryBindingRef: "entry-binding:test", entrySessionRef: "entry-session:\(suffix)",
      token: "TOKEN", expiresAt: Date(timeIntervalSince1970: expires))
  }
}

actor GatewayStub: GatewayClientProtocol {
  static let context = PersonalPortalContext(
    protocolVersion: .current, audience: .personal, entrySessionRef: "entry-session:renewed",
    entryBindingRef: "entry-binding:test",
    family: .init(familyRef: "family:test", displayName: "家庭"),
    person: .init(personRef: "person:test", displayName: "成员"),
    membership: .init(familyRole: .adult),
    device: .init(
      deviceRef: "device:test", displayName: "iPhone", terminalType: "mobile", platform: "ios"),
    agent: .init(
      assignmentRef: "assignment:test", agentRef: "agent:test", displayName: "助理",
      providerProfileRef: "provider-profile:test"))
  var renewCount = 0
  var renewError: GatewayClientError?
  var logoutError: GatewayClientError?
  var unbindError: GatewayClientError?
  var renewDelay: UInt64 = 0
  func setRenewError(_ error: GatewayClientError) { renewError = error }
  func setLogoutError(_ error: GatewayClientError) { logoutError = error }
  func setUnbindError(_ error: GatewayClientError) { unbindError = error }
  func setRenewDelay(_ delay: UInt64) { renewDelay = delay }
  func preview(baseURL: URL, request: PairingPreviewRequest) async throws -> PairingPreviewResponse
  { fatalError() }
  func claim(baseURL: URL, request: PairingClaimRequest) async throws -> PairingClaimResponse {
    fatalError()
  }
  func fetchPortalContext(baseURL: URL, session: EntrySessionCredential) async throws
    -> PersonalPortalContext
  { Self.context }
  func renew(baseURL: URL, authorization: DeviceAuthorization) async throws -> SessionRenewResponse
  {
    renewCount += 1
    if renewDelay > 0 { try await Task.sleep(nanoseconds: renewDelay) }
    if let renewError { throw renewError }
    return SessionRenewResponse(
      protocolVersion: .current,
      entry: EntrySessionCredential(
        entryBindingRef: "entry-binding:test", entrySessionRef: "entry-session:renewed",
        token: "NEW", expiresAt: .distantFuture))
  }
  func logout(baseURL: URL, session: EntrySessionCredential) async throws -> MobileOperationResponse
  {
    if let logoutError { throw logoutError }
    return .init(protocolVersion: .current, status: .loggedOut)
  }
  func unbind(baseURL: URL, authorization: DeviceAuthorization) async throws
    -> MobileOperationResponse
  {
    if let unbindError { throw unbindError }
    return .init(protocolVersion: .current, status: .revoked)
  }
}
