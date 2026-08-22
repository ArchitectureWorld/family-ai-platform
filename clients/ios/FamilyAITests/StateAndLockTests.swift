import XCTest

@testable import FamilyAICore

final class StateAndLockTests: XCTestCase {
  func testPairingAndAppStateCasesAreDistinct() {
    XCTAssertNotEqual(PairingState.scanner, .manualEntry)
    XCTAssertNotEqual(AppState.launching, .needsPairing)
    XCTAssertEqual(PairingState.failed(.expired), .failed(.expired))
  }

  func testFiveMinuteLockPolicyUsesStrictThreshold() {
    let background = Date(timeIntervalSince1970: 1_000)
    XCTAssertFalse(
      AppLockPolicy.fiveMinutes.requiresAuthentication(
        backgroundedAt: background, now: Date(timeIntervalSince1970: 1_300)))
    XCTAssertTrue(
      AppLockPolicy.fiveMinutes.requiresAuthentication(
        backgroundedAt: background, now: Date(timeIntervalSince1970: 1_300.001)))
    XCTAssertTrue(
      AppLockPolicy.immediate.requiresAuthentication(backgroundedAt: background, now: background))
    XCTAssertFalse(
      AppLockPolicy.disabled.requiresAuthentication(backgroundedAt: background, now: .distantFuture)
    )
  }

  func testDeviceCredentialIsBase64URLWithoutPadding() throws {
    let value = try DeviceCredentialGenerator.generate()
    XCTAssertEqual(value.count, 43)
    XCTAssertNil(value.range(of: "[^A-Za-z0-9_-]", options: .regularExpression))
  }
}
