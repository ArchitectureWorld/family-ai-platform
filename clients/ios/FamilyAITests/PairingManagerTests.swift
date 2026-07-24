import XCTest

@testable import FamilyAICore

final class PairingManagerTests: XCTestCase {
  func testManualPreviewOmitsPairingReferenceAndReachesConfirmation() async throws {
    let gateway = PairingGatewayStub()
    let manager = makeManager(gateway: gateway)

    await manager.showManualEntry()
    let manualState = await manager.state
    XCTAssertEqual(manualState, .manualEntry)

    try await manager.previewManual(
      gateway: "https://gateway.example.com",
      code: "abcd-efgh"
    )

    let recordedRequest = await gateway.lastPreviewRequest
    let request = try XCTUnwrap(recordedRequest)
    XCTAssertNil(request.pairingRef)
    XCTAssertEqual(request.code, "ABCD-EFGH")
    guard case .confirmation(let confirmation) = await manager.state else {
      return XCTFail("Expected confirmation")
    }
    XCTAssertEqual(confirmation.preview.family.displayName, "测试家庭")
    XCTAssertEqual(confirmation.deviceDisplayName, "测试 iPhone")
  }

  func testScannedPreviewIncludesPairingReference() async throws {
    let gateway = PairingGatewayStub()
    let manager = makeManager(gateway: gateway)
    let expiresAt = ISO8601DateFormatter().string(
      from: Date(timeIntervalSince1970: 1_800_000_000)
    )
    let raw =
      "familyai://pair#v=1&gateway=https%3A%2F%2Fgateway.example.com&pairingRef=pairing%3Atest-1&code=ABCD-EFGH&expiresAt=\(expiresAt.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)"

    try await manager.previewScanned(raw)

    let pairingRef = await gateway.lastPreviewRequest?.pairingRef
    XCTAssertEqual(pairingRef, "pairing:test-1")
  }

  func testUncertainClaimRetryReusesInstallationAndDeviceCredential() async throws {
    let gateway = PairingGatewayStub()
    await gateway.setClaimErrors([.unreachable, nil])
    let manager = makeManager(gateway: gateway)
    try await manager.previewManual(
      gateway: "https://gateway.example.com",
      code: "ABCD-EFGH"
    )

    let firstCompletion = await manager.confirm()
    XCTAssertEqual(firstCompletion, .failed(.unavailable))
    let secondCompletion = await manager.retryClaim()
    XCTAssertEqual(secondCompletion, .authenticated(PairingGatewayStub.context))

    let requests = await gateway.claimRequests
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(requests[0].installationId, requests[1].installationId)
    XCTAssertEqual(requests[0].deviceCredential, requests[1].deviceCredential)
    XCTAssertEqual(requests[0].deviceCredential, String(repeating: "D", count: 43))
  }

  func testSuccessfulClaimAtomicallyPersistsDeviceAndSession() async throws {
    let keychain = InMemoryKeychainClient()
    let store = CredentialStore(keychain: keychain)
    let gateway = PairingGatewayStub()
    let manager = makeManager(gateway: gateway, credentials: store)
    try await manager.previewManual(
      gateway: "https://gateway.example.com",
      code: "ABCD-EFGH"
    )

    let completion = await manager.confirm()

    XCTAssertEqual(completion, .authenticated(PairingGatewayStub.context))
    let storedDeviceRef = try await store.deviceAuthorization()?.deviceRef
    let storedSessionRef = try await store.session()?.entrySessionRef
    let completedState = await manager.state
    XCTAssertEqual(storedDeviceRef, "device:test-mobile-1")
    XCTAssertEqual(storedSessionRef, "entry-session:test-mobile-1")
    XCTAssertEqual(completedState, .completed(PairingGatewayStub.context))
  }

  func testExpiredPreviewAndStableGatewayErrorsMapWithoutMessageInspection() async throws {
    let gateway = PairingGatewayStub()
    await gateway.setPreviewError(.server(.pairingExpired))
    let manager = makeManager(gateway: gateway)

    do {
      try await manager.previewManual(
        gateway: "https://gateway.example.com",
        code: "ABCD-EFGH"
      )
      XCTFail("Expected preview failure")
    } catch {
      let failedState = await manager.state
      XCTAssertEqual(failedState, .failed(.expired))
    }
  }

  private func makeManager(
    gateway: PairingGatewayStub,
    credentials: CredentialStore? = nil
  ) -> PairingManager {
    PairingManager(
      gateway: gateway,
      credentials: credentials
        ?? CredentialStore(
          keychain: InMemoryKeychainClient()
        ),
      deviceDescriptor: {
        MobileDeviceDescriptor(
          displayName: "测试 iPhone",
          systemVersion: "17.6",
          appVersion: "1.0.0",
          model: "iPhone"
        )
      },
      credentialGenerator: {
        String(repeating: "D", count: 43)
      },
      now: {
        Date(timeIntervalSince1970: 1_700_000_000)
      }
    )
  }
}

actor PairingGatewayStub: GatewayClientProtocol {
  static let preview = PairingPreviewResponse(
    family: .init(displayName: "测试家庭"),
    person: .init(displayName: "测试成员"),
    gatewayHost: "gateway.example.com",
    expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
  )
  static let entry = EntrySessionCredential(
    entryBindingRef: "entry-binding:test-mobile-1",
    entrySessionRef: "entry-session:test-mobile-1",
    token: String(repeating: "B", count: 43),
    expiresAt: Date(timeIntervalSince1970: 2_000_000_000)
  )
  static let claim = PairingClaimResponse(
    device: .init(
      deviceRef: "device:test-mobile-1",
      displayName: "测试 iPhone"
    ),
    entry: entry
  )
  static let context = PersonalPortalContext(
    entrySessionRef: "entry-session:test-mobile-1",
    entryBindingRef: "entry-binding:test-mobile-1",
    family: .init(
      familyRef: "family:test-family-1",
      displayName: "测试家庭"
    ),
    person: .init(
      personRef: "person:test-person-1",
      displayName: "测试成员"
    ),
    membership: .init(familyRole: .adult),
    device: .init(
      deviceRef: "device:test-mobile-1",
      displayName: "测试 iPhone",
      terminalType: "mobile",
      platform: "ios"
    ),
    agent: .init(
      assignmentRef: "assignment:test-personal-1",
      agentRef: "agent:personal-assistant",
      displayName: "个人助理",
      providerProfileRef: "provider-profile:fake-local"
    )
  )

  var lastPreviewRequest: PairingPreviewRequest?
  var claimRequests: [PairingClaimRequest] = []
  private var previewError: GatewayClientError?
  private var claimErrors: [GatewayClientError?] = []

  func setPreviewError(_ error: GatewayClientError?) {
    previewError = error
  }

  func setClaimErrors(_ errors: [GatewayClientError?]) {
    claimErrors = errors
  }

  func preview(
    baseURL: URL,
    request: PairingPreviewRequest
  ) async throws -> PairingPreviewResponse {
    lastPreviewRequest = request
    if let previewError {
      throw previewError
    }
    return Self.preview
  }

  func claim(
    baseURL: URL,
    request: PairingClaimRequest
  ) async throws -> PairingClaimResponse {
    claimRequests.append(request)
    if !claimErrors.isEmpty {
      let error = claimErrors.removeFirst()
      if let error {
        throw error
      }
    }
    return Self.claim
  }

  func fetchPortalContext(
    baseURL: URL,
    session: EntrySessionCredential
  ) async throws -> PersonalPortalContext {
    Self.context
  }

  func renew(
    baseURL: URL,
    authorization: DeviceAuthorization
  ) async throws -> SessionRenewResponse {
    .init(entry: Self.entry)
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
