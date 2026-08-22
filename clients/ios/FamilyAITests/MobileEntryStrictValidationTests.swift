import XCTest

@testable import FamilyAICore

final class MobileEntryStrictValidationTests: XCTestCase {
  func testRejectsUnknownTopLevelField() throws {
    var object = try jsonObject("portal-context-personal")
    object["unexpected"] = true

    XCTAssertThrowsError(
      try decode(PersonalPortalContext.self, object: object)
    )
  }

  func testRejectsInvalidClaimDeviceLiterals() throws {
    var object = try jsonObject("pairing-claim-request")
    var device = try XCTUnwrap(object["device"] as? [String: Any])
    device["terminalType"] = "desktop"
    object["device"] = device

    XCTAssertThrowsError(
      try decode(PairingClaimRequest.self, object: object)
    )
  }

  func testRejectsInvalidClaimResponseStatus() throws {
    var object = try jsonObject("pairing-claim-success")
    var device = try XCTUnwrap(object["device"] as? [String: Any])
    device["status"] = "revoked"
    object["device"] = device

    XCTAssertThrowsError(
      try decode(PairingClaimResponse.self, object: object)
    )
  }

  func testRejectsMalformedSessionTokenAndReference() throws {
    var object = try jsonObject("session-renew-success")
    var entry = try XCTUnwrap(object["entry"] as? [String: Any])
    entry["token"] = "not-a-token"
    entry["entrySessionRef"] = "wrong:test"
    object["entry"] = entry

    XCTAssertThrowsError(
      try decode(SessionRenewResponse.self, object: object)
    )
  }

  private func decode<T: Decodable>(_ type: T.Type, object: [String: Any]) throws -> T {
    let data = try JSONSerialization.data(withJSONObject: object)
    return try MobileEntryCoding.decoder().decode(type, from: data)
  }

  private func jsonObject(_ name: String) throws -> [String: Any] {
    let root = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let url = root.appendingPathComponent(
      "packages/contracts/fixtures/mobile-entry/\(name).json"
    )
    let data = try Data(contentsOf: url)
    return try XCTUnwrap(
      JSONSerialization.jsonObject(with: data) as? [String: Any]
    )
  }
}
