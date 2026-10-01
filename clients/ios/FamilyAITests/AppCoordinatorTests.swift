import XCTest

@testable import FamilyAICore

@MainActor
final class AppCoordinatorTests: XCTestCase {
  func testStartupWithoutDeviceAuthorizationNeedsPairing() async {
    let harness = makeHarness()

    await harness.coordinator.start()

    XCTAssertEqual(harness.coordinator.state, .needsPairing)
  }

  func testStartupRestoresRealContextAndCachesOnlyDisplayData() async throws {
    let harness = makeHarness()
    try await configureAuthorizedStore(harness.credentials, withSession: true)

    await harness.coordinator.start()

    XCTAssertEqual(
      harness.coordinator.state,
      .authenticated(PairingGatewayStub.context)
    )
    let cachedFamilyName = try await harness.cache.load()?.familyDisplayName
    XCTAssertEqual(cachedFamilyName, "测试家庭")
    XCTAssertNotNil(harness.coordinator.sessionExpiresAt)
  }

  func testOfflineStartupPreservesCredentialsAndUsesCachedContext() async throws {
    let harness = makeHarness()
    try await configureAuthorizedStore(harness.credentials, withSession: true)
    try await harness.cache.save(
      CachedPersonalContext(
        context: PairingGatewayStub.context,
        lastSyncedAt: Date(timeIntervalSince1970: 1_600_000_000)
      )
    )
    await harness.gateway.setContextError(.unreachable)

    await harness.coordinator.start()

    guard case .offline(let cached) = harness.coordinator.state else {
      return XCTFail("Expected offline state")
    }
    XCTAssertEqual(cached?.personDisplayName, "测试成员")
    let retainedAuthorization = try await harness.credentials.deviceAuthorization()
    XCTAssertNotNil(retainedAuthorization)
  }

  func testRevocationTransitionsThroughAuthorizationRevokedThenPairing() async throws {
    let harness = makeHarness()
    try await configureAuthorizedStore(harness.credentials, withSession: false)
    await harness.gateway.setRenewError(.server(.deviceRevoked))

    await harness.coordinator.start()

    XCTAssertEqual(harness.coordinator.state, .authorizationRevoked)
    let revokedAuthorization = try await harness.credentials.deviceAuthorization()
    XCTAssertNil(revokedAuthorization)
    harness.coordinator.acknowledgeAuthorizationRevoked()
    XCTAssertEqual(harness.coordinator.state, .needsPairing)
  }

  func testPrivacyCoverAndFiveMinuteLockPolicy() async throws {
    let harness = makeHarness()
    try await configureAuthorizedStore(harness.credentials, withSession: true)
    await harness.coordinator.start()
    let backgroundedAt = Date(timeIntervalSince1970: 1_000)

    harness.coordinator.didEnterBackground(at: backgroundedAt)
    XCTAssertTrue(harness.coordinator.isPrivacyCoverVisible)
    await harness.coordinator.didBecomeActive(
      at: Date(timeIntervalSince1970: 1_300)
    )
    XCTAssertEqual(
      harness.coordinator.state,
      .authenticated(PairingGatewayStub.context)
    )
    XCTAssertFalse(harness.coordinator.isPrivacyCoverVisible)

    harness.coordinator.didEnterBackground(at: backgroundedAt)
    await harness.coordinator.didBecomeActive(
      at: Date(timeIntervalSince1970: 1_301)
    )
    XCTAssertEqual(harness.coordinator.state, .locked)
    XCTAssertFalse(harness.coordinator.isPrivacyCoverVisible)
  }

  func testLockedStateCannotBeBypassedByBriefBackgroundRoundTrip() async throws {
    let harness = makeHarness(authenticationResults: [false])
    try await configureAuthorizedStore(
      harness.credentials,
      withSession: true
    )
    await harness.coordinator.start()

    harness.coordinator.didEnterBackground(
      at: Date(timeIntervalSince1970: 1_000)
    )
    await harness.coordinator.didBecomeActive(
      at: Date(timeIntervalSince1970: 1_301)
    )
    XCTAssertEqual(harness.coordinator.state, .locked)

    harness.coordinator.didEnterBackground(
      at: Date(timeIntervalSince1970: 1_400)
    )
    await harness.coordinator.didBecomeActive(
      at: Date(timeIntervalSince1970: 1_450)
    )

    XCTAssertEqual(harness.coordinator.state, .locked)
  }

  func testCancelledUnlockRemainsLockedAndSuccessfulUnlockRestoresSession() async throws {
    let harness = makeHarness(authenticationResults: [false, true])
    try await configureAuthorizedStore(harness.credentials, withSession: true)
    await harness.coordinator.start()
    harness.coordinator.didEnterBackground(at: Date(timeIntervalSince1970: 1_000))
    await harness.coordinator.didBecomeActive(
      at: Date(timeIntervalSince1970: 1_301)
    )

    await harness.coordinator.unlock()
    XCTAssertEqual(harness.coordinator.state, .locked)
    await harness.coordinator.unlock()
    XCTAssertEqual(
      harness.coordinator.state,
      .authenticated(PairingGatewayStub.context)
    )
  }

  func testLogoutKeepsDeviceAuthorizationAndUnbindClearsIt() async throws {
    let harness = makeHarness(authenticationResults: [true])
    try await configureAuthorizedStore(harness.credentials, withSession: true)
    await harness.coordinator.start()

    await harness.coordinator.logout()
    let loggedOutSession = try await harness.credentials.session()
    let retainedDevice = try await harness.credentials.deviceAuthorization()
    XCTAssertNil(loggedOutSession)
    XCTAssertNotNil(retainedDevice)
    XCTAssertEqual(harness.coordinator.state, .locked)

    await harness.coordinator.unbindDevice()
    let unboundSession = try await harness.credentials.session()
    let unboundDevice = try await harness.credentials.deviceAuthorization()
    XCTAssertNil(unboundSession)
    XCTAssertNil(unboundDevice)
    XCTAssertEqual(harness.coordinator.state, .needsPairing)
  }

  private func makeHarness(
    authenticationResults: [Bool] = []
  ) -> CoordinatorHarness {
    let keychain = InMemoryKeychainClient()
    let credentials = CredentialStore(keychain: keychain)
    let gateway = CoordinatorGatewayStub()
    let sessions = SessionManager(
      gateway: gateway,
      credentials: credentials,
      now: { Date(timeIntervalSince1970: 1_700_000_000) }
    )
    let pairing = PairingManager(
      gateway: gateway,
      credentials: credentials,
      deviceDescriptor: {
        MobileDeviceDescriptor(
          displayName: "测试 iPhone",
          systemVersion: "17.6",
          appVersion: "1.0.0",
          model: "iPhone"
        )
      }
    )
    let suiteName = UUID().uuidString
    let cache = CachedPersonalContextStore(suiteName: suiteName)
    let lockSettings = AppLockSettingsStore(suiteName: suiteName)
    let localAuthentication = LocalAuthenticationStub(
      results: authenticationResults
    )
    let coordinator = AppCoordinator(
      sessionManager: sessions,
      pairingManager: pairing,
      credentials: credentials,
      cache: cache,
      lockSettings: lockSettings,
      localAuthentication: localAuthentication,
      now: { Date(timeIntervalSince1970: 1_700_000_000) }
    )
    return CoordinatorHarness(
      coordinator: coordinator,
      credentials: credentials,
      cache: cache,
      gateway: gateway
    )
  }

  private func configureAuthorizedStore(
    _ store: CredentialStore,
    withSession: Bool
  ) async throws {
    try await store.saveGatewayAndDevice(
      profile: GatewayProfile(
        baseURL: URL(string: "https://gateway.example.com")!
      ),
      authorization: DeviceAuthorization(
        deviceRef: "device:test-mobile-1",
        deviceCredential: String(repeating: "D", count: 43)
      )
    )
    if withSession {
      try await store.replaceSessionAtomically(PairingGatewayStub.entry)
    }
  }
}

private struct CoordinatorHarness {
  let coordinator: AppCoordinator
  let credentials: CredentialStore
  let cache: CachedPersonalContextStore
  let gateway: CoordinatorGatewayStub
}

private actor LocalAuthenticationStub: LocalAuthenticationClientProtocol {
  private var results: [Bool]

  init(results: [Bool]) {
    self.results = results
  }

  func authenticate(reason: String) async -> Bool {
    guard !results.isEmpty else {
      return false
    }
    return results.removeFirst()
  }
}

private actor CoordinatorGatewayStub: GatewayClientProtocol {
  private var contextError: GatewayClientError?
  private var renewError: GatewayClientError?

  func setContextError(_ error: GatewayClientError?) {
    contextError = error
  }

  func setRenewError(_ error: GatewayClientError?) {
    renewError = error
  }

  func preview(
    baseURL: URL,
    request: PairingPreviewRequest
  ) async throws -> PairingPreviewResponse {
    PairingGatewayStub.preview
  }

  func claim(
    baseURL: URL,
    request: PairingClaimRequest
  ) async throws -> PairingClaimResponse {
    PairingGatewayStub.claim
  }

  func fetchPortalContext(
    baseURL: URL,
    session: EntrySessionCredential
  ) async throws -> PersonalPortalContext {
    if let contextError {
      throw contextError
    }
    return PairingGatewayStub.context
  }

  func renew(
    baseURL: URL,
    authorization: DeviceAuthorization
  ) async throws -> SessionRenewResponse {
    if let renewError {
      throw renewError
    }
    return .init(entry: PairingGatewayStub.entry)
  }

  func logout(
    baseURL: URL,
    session: EntrySessionCredential
  ) async throws -> MobileOperationResponse {
    .init(status: .loggedOut)
  }

  func unbind(
    baseURL: URL,
    authorization: DeviceAuthorization
  ) async throws -> MobileOperationResponse {
    .init(status: .revoked)
  }
}
