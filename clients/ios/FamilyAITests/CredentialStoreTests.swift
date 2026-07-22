import XCTest

@testable import FamilyAICore

final class CredentialStoreTests: XCTestCase {
  func testInstallationIdIsStableAndRetainedAcrossUnbind() async throws {
    let keychain = InMemoryKeychainClient()
    let store = CredentialStore(keychain: keychain)
    let first = try await store.installationId()
    try await store.saveGatewayAndDevice(
      profile: GatewayProfile(baseURL: URL(string: "https://gateway.example.com")!),
      authorization: DeviceAuthorization(
        deviceRef: "device:test-1", deviceCredential: String(repeating: "A", count: 43)))
    try await store.clearDeviceAndSession()
    let retainedInstallationId = try await store.installationId()
    let deviceAuthorization = try await store.deviceAuthorization()
    XCTAssertEqual(first, retainedInstallationId)
    XCTAssertNil(deviceAuthorization)
  }

  func testLogoutClearsOnlySession() async throws {
    let store = CredentialStore(keychain: InMemoryKeychainClient())
    let auth = DeviceAuthorization(
      deviceRef: "device:test-1", deviceCredential: String(repeating: "A", count: 43))
    try await store.saveGatewayAndDevice(
      profile: GatewayProfile(baseURL: URL(string: "https://gateway.example.com")!),
      authorization: auth)
    try await store.replaceSessionAtomically(session("old"))
    try await store.clearSession()
    let retainedAuthorization = try await store.deviceAuthorization()
    let clearedSession = try await store.session()
    XCTAssertEqual(retainedAuthorization, auth)
    XCTAssertNil(clearedSession)
  }

  func testFailedAtomicReplacementKeepsOldSession() async throws {
    let keychain = InMemoryKeychainClient()
    let store = CredentialStore(keychain: keychain)
    let old = session("old")
    try await store.replaceSessionAtomically(old)
    await keychain.setFailingWrites(["entrySessionToken"])
    do {
      try await store.replaceSessionAtomically(session("new"))
      XCTFail("Expected failure")
    } catch {}
    let retainedSession = try await store.session()
    XCTAssertEqual(retainedSession, old)
  }

  private func session(_ suffix: String) -> EntrySessionCredential {
    EntrySessionCredential(
      entryBindingRef: "entry-binding:test", entrySessionRef: "entry-session:\(suffix)",
      token: String(repeating: "B", count: 43),
      expiresAt: Date(timeIntervalSince1970: 2_000_000_000))
  }
}
