import XCTest

@testable import FamilyAICore

final class CredentialStoreLayeringTests: XCTestCase {
  func testStoresEveryCredentialInItsDedicatedKeychainEntry() async throws {
    let keychain = InMemoryKeychainClient()
    let store = CredentialStore(keychain: keychain)
    let profile = GatewayProfile(
      baseURL: URL(string: "https://gateway.example.com")!
    )
    let device = DeviceAuthorization(
      deviceRef: "device:test-1",
      deviceCredential: String(repeating: "A", count: 43)
    )
    let session = makeSession(suffix: "one")

    try await store.saveClaim(
      profile: profile,
      authorization: device,
      session: session
    )

    for key in [
      "gatewayBaseURL",
      "deviceRef",
      "deviceCredential",
      "entryBindingRef",
      "entrySessionRef",
      "entrySessionToken",
      "entrySessionExpiresAt",
    ] {
      let data = await keychain.read(key: key)
      XCTAssertNotNil(data, "Missing dedicated Keychain value: \(key)")
    }

    let aggregateDevice = await keychain.read(key: "deviceAuthorization")
    let aggregateSession = await keychain.read(key: "entrySession")
    XCTAssertNil(aggregateDevice)
    XCTAssertNil(aggregateSession)
  }

  func testAtomicSessionReplacementRollsBackEveryLiveField() async throws {
    let keychain = InMemoryKeychainClient()
    let store = CredentialStore(keychain: keychain)
    let old = makeSession(suffix: "old")
    let new = makeSession(suffix: "new")
    try await store.replaceSessionAtomically(old)

    await keychain.setFailingWrites(["entrySessionToken"])
    do {
      try await store.replaceSessionAtomically(new)
      XCTFail("Expected replacement failure")
    } catch {
      // The original complete session must remain readable.
    }

    let retainedSession = try await store.session()
    XCTAssertEqual(retainedSession, old)
  }

  func testPartialDeviceOrSessionStateIsRejectedAsCorrupt() async throws {
    let keychain = InMemoryKeychainClient()
    let store = CredentialStore(keychain: keychain)
    try await keychain.write(Data("device:test-1".utf8), key: "deviceRef")

    do {
      _ = try await store.deviceAuthorization()
      XCTFail("Expected corrupt-state error")
    } catch {
      XCTAssertEqual(error as? CredentialStoreError, .corruptedState)
    }
  }

  private func makeSession(suffix: String) -> EntrySessionCredential {
    EntrySessionCredential(
      entryBindingRef: "entry-binding:test",
      entrySessionRef: "entry-session:\(suffix)",
      token: String(repeating: "B", count: 43),
      expiresAt: Date(timeIntervalSince1970: 2_000_000_000)
    )
  }
}
