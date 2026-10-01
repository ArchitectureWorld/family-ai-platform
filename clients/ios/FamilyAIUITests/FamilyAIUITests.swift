import XCTest

final class FamilyAIUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func testFreshInstallShowsRealPairingEntryAndManualCodeOnlyForm() {
    let app = XCUIApplication()
    app.launchArguments.append("-uiTesting")
    app.launch()

    let scannerButton = app.buttons["start-scanner-pairing"]
    let manualButton = app.buttons["start-manual-pairing"]
    XCTAssertTrue(scannerButton.waitForExistence(timeout: 5))
    XCTAssertTrue(manualButton.exists)

    manualButton.tap()

    XCTAssertTrue(app.textFields["manual-gateway"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.textFields["manual-code"].exists)
    XCTAssertFalse(app.textFields["pairing-ref"].exists)
    XCTAssertTrue(app.buttons["manual-preview"].exists)
  }
}
