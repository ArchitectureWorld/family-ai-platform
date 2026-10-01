import XCTest

@testable import FamilyAICore

final class CachedPersonalContextStoreTests: XCTestCase {
  func testCacheContainsOnlyApprovedNonSensitiveFields() async throws {
    let suiteName = "CachedPersonalContextStoreTests.\(UUID().uuidString)"
    let store = CachedPersonalContextStore(suiteName: suiteName)
    defer { UserDefaults.standard.removePersistentDomain(forName: suiteName) }
    let cached = CachedPersonalContext(
      context: PairingGatewayStub.context,
      lastSyncedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )

    try await store.save(cached)

    let loaded = try await store.load()
    XCTAssertEqual(loaded, cached)
    let inspectionDefaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    let raw = try XCTUnwrap(
      inspectionDefaults.data(forKey: "cachedPersonalContext")
    )
    let text = try XCTUnwrap(String(data: raw, encoding: .utf8))
    XCTAssertFalse(text.contains("entry-session"))
    XCTAssertFalse(text.contains(String(repeating: "B", count: 43)))
    XCTAssertFalse(text.contains("family:test"))
    XCTAssertTrue(text.contains("测试家庭"))
  }

  func testClearRemovesCachedContext() async throws {
    let suiteName = UUID().uuidString
    let store = CachedPersonalContextStore(suiteName: suiteName)
    try await store.save(
      CachedPersonalContext(
        context: PairingGatewayStub.context,
        lastSyncedAt: .now
      )
    )

    await store.clear()

    let loaded = try await store.load()
    XCTAssertNil(loaded)
  }
}
