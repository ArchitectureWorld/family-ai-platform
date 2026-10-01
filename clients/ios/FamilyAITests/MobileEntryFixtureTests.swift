import XCTest

@testable import FamilyAICore

final class MobileEntryFixtureTests: XCTestCase {
  func testDecodesAllSuccessFixtures() throws {
    _ = try decode(PairingPreviewRequest.self, "pairing-preview-request")
    _ = try decode(PairingPreviewResponse.self, "pairing-preview-success")
    _ = try decode(PairingClaimRequest.self, "pairing-claim-request")
    _ = try decode(PairingClaimResponse.self, "pairing-claim-success")
    _ = try decode(SessionRenewResponse.self, "session-renew-success")
    let context = try decode(PersonalPortalContext.self, "portal-context-personal")
    XCTAssertEqual(context.audience, .personal)
  }

  func testDecodesErrorFixturesByStableCode() throws {
    XCTAssertEqual(
      try decode(MobileGatewayErrorEnvelope.self, "pairing-expired-error").error.code,
      .pairingExpired)
    XCTAssertEqual(
      try decode(MobileGatewayErrorEnvelope.self, "device-revoked-error").error.code, .deviceRevoked
    )
    XCTAssertEqual(
      try decode(MobileGatewayErrorEnvelope.self, "session-expired-error").error.code,
      .entrySessionExpired)
  }

  func testMissingPortalProtocolVersionFails() throws {
    var object = try jsonObject("portal-context-personal")
    object.removeValue(forKey: "protocolVersion")
    XCTAssertThrowsError(
      try MobileEntryCoding.decoder().decode(
        PersonalPortalContext.self, from: JSONSerialization.data(withJSONObject: object)))
  }

  func testUnsupportedPortalProtocolVersionFails() throws {
    var object = try jsonObject("portal-context-personal")
    object["protocolVersion"] = 2
    XCTAssertThrowsError(
      try MobileEntryCoding.decoder().decode(
        PersonalPortalContext.self, from: JSONSerialization.data(withJSONObject: object)))
  }

  func testNonPersonalAudienceFails() throws {
    var object = try jsonObject("portal-context-personal")
    object["audience"] = "admin"
    XCTAssertThrowsError(
      try MobileEntryCoding.decoder().decode(
        PersonalPortalContext.self, from: JSONSerialization.data(withJSONObject: object)))
  }

  private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
    try MobileEntryCoding.decoder().decode(type, from: fixtureData(name))
  }

  private func jsonObject(_ name: String) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: fixtureData(name)) as? [String: Any])
  }

  private func fixtureData(_ name: String) throws -> Data {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try Data(
      contentsOf: root.appendingPathComponent(
        "packages/contracts/fixtures/mobile-entry/\(name).json"))
  }
}
