import XCTest

@testable import FamilyAICore

final class PairingInputTests: XCTestCase {
  private let future = Date(timeIntervalSince1970: 1_800_000_000)
  private let now = Date(timeIntervalSince1970: 1_700_000_000)

  func testManualPairingUsesCodeOnlyRequest() throws {
    let input = try ManualPairingInput(gateway: "https://gateway.example.com", code: "abcd-efgh")
    XCTAssertNil(input.request.pairingRef)
    XCTAssertEqual(input.request.code, "ABCD-EFGH")
  }

  func testParsesValidQRCode() throws {
    let timestamp = ISO8601DateFormatter().string(from: future)
    let raw =
      "familyai://pair#v=1&gateway=https%3A%2F%2Fgateway.example.com&pairingRef=pairing%3Atest-1&code=ABCD-EFGH&expiresAt=\(timestamp.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)"
    let payload = try PairingQRCodeParser.parse(raw, now: now)
    XCTAssertEqual(payload.pairingRef, "pairing:test-1")
    XCTAssertEqual(payload.gateway.absoluteString, "https://gateway.example.com")
  }

  func testRejectsInsecureAndDecoratedGatewayURLs() {
    let invalidURLs = [
      "http://gateway.example.com", "https://user@gateway.example.com",
      "https://user:pass@gateway.example.com", "https://gateway.example.com/path",
      "https://gateway.example.com?x=1", "https://gateway.example.com#x",
    ]
    for invalidURL in invalidURLs {
      XCTAssertThrowsError(try GatewayURLValidator.validate(invalidURL), invalidURL)
    }
  }

  func testRejectsDecoratedPairingAuthorityAndUnexpectedFields() {
    let timestamp = ISO8601DateFormatter().string(from: future)
    let fields =
      "v=1&gateway=https%3A%2F%2Fgateway.example.com&pairingRef=pairing%3Atest-1&code=ABCD-EFGH&expiresAt=\(timestamp.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)"

    let invalidPayloads = [
      "familyai://user@pair#\(fields)",
      "familyai://user:pass@pair#\(fields)",
      "familyai://pair:123#\(fields)",
      "familyai://pair/path#\(fields)",
      "familyai://pair?query=1#\(fields)",
      "familyai://pair#\(fields)&code=JKLM-NPQR",
      "familyai://pair#\(fields)&extra=value",
    ]

    for payload in invalidPayloads {
      XCTAssertThrowsError(
        try PairingQRCodeParser.parse(payload, now: now),
        payload
      )
    }
  }

  func testRejectsWrongQRMetadataAndExpiredPayload() {
    let expired = "2020-01-01T00%3A00%3A00Z"
    let base =
      "gateway=https%3A%2F%2Fgateway.example.com&pairingRef=pairing%3Atest-1&code=ABCD-EFGH&expiresAt=\(expired)"
    XCTAssertThrowsError(try PairingQRCodeParser.parse("http://pair#v=1&\(base)", now: now))
    XCTAssertThrowsError(try PairingQRCodeParser.parse("familyai://wrong#v=1&\(base)", now: now))
    XCTAssertThrowsError(try PairingQRCodeParser.parse("familyai://pair#v=2&\(base)", now: now))
    XCTAssertThrowsError(try PairingQRCodeParser.parse("familyai://pair#v=1&\(base)", now: now))
  }
}
