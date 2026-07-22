# iOS Mobile Entry Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an iOS 17 SwiftUI application that securely pairs a physical iPhone to one Family AI Person, restores and renews personal sessions, protects local UI access, and displays real Gateway portal context.

**Architecture:** Use a small feature-oriented SwiftUI application with an explicit top-level state machine. Isolate URLSession, Keychain, local authentication, QR parsing, and session renewal behind protocols so core behavior is testable without a live Gateway; decode canonical JSON fixtures from `packages/contracts` in Swift tests.

**Tech Stack:** iOS 17, Swift 5.9+, SwiftUI, Observation, Swift Concurrency, URLSession, Security, AVFoundation, LocalAuthentication, XCTest/XCUITest.

## Global Constraints

- Project path is `clients/ios/FamilyAI.xcodeproj`.
- Bundle identifiers and signing team are developer-local settings, not committed secrets.
- No real Gateway hostname, Tailnet name, token, pairing code, or Apple account identifier is committed.
- First version is personal entry only and contains no mock Chat, Work, push, or administrator UI.
- Credentials are stored only in Keychain.
- Device and session renewal logic must be actor-serialized.
- Minimum deployment target is iOS 17.0.

---

### Task 1: Create the Xcode project and deterministic build settings

**Files:**
- Create: `clients/ios/FamilyAI.xcodeproj/project.pbxproj`
- Create: `clients/ios/FamilyAI/FamilyAIApp.swift`
- Create: `clients/ios/FamilyAI/Info.plist`
- Create: `clients/ios/FamilyAITests/FamilyAITests.swift`
- Create: `clients/ios/FamilyAIUITests/FamilyAIUITests.swift`
- Create: `clients/ios/Config/Base.xcconfig`
- Create: `clients/ios/Config/Local.example.xcconfig`
- Modify: `.gitignore`

**Interfaces:**
- Produces an iOS 17 app target, unit-test target, and UI-test target.

- [ ] Create the project with SwiftUI App lifecycle and no third-party packages.
- [ ] Set `IPHONEOS_DEPLOYMENT_TARGET = 17.0`, strict concurrency warnings, and Swift 5 language mode compatible with the selected Xcode.
- [ ] Add camera and Face ID purpose strings using user-facing Chinese copy.
- [ ] Keep `DEVELOPMENT_TEAM` and real bundle suffix in ignored `Local.xcconfig`; commit only an example.
- [ ] Build with `xcodebuild -project clients/ios/FamilyAI.xcodeproj -scheme FamilyAI -destination 'platform=iOS Simulator,name=iPhone 15' build`.
- [ ] Commit `build(ios): add FamilyAI iOS 17 project`.

### Task 2: Add shared Swift models and fixture decoding tests

**Files:**
- Create: `clients/ios/FamilyAI/Core/Models/MobileEntryModels.swift`
- Create: `clients/ios/FamilyAITests/MobileEntryFixtureTests.swift`

**Interfaces:**
- Consumes canonical JSON files from `packages/contracts/fixtures/mobile-entry`.
- Produces Codable models matching mobile-entry protocol v1.

- [ ] Add failing tests that decode every success and error fixture.
- [ ] Define `MobileEntryProtocolVersion`, request/response models, `PersonalContext`, and `GatewayErrorEnvelope` with exact CodingKeys.
- [ ] Reject unsupported protocol versions after decoding.
- [ ] Run focused XCTest and commit `feat(ios): add mobile entry contract models`.

### Task 3: Implement safe QR parsing

**Files:**
- Create: `clients/ios/FamilyAI/Features/Pairing/PairingQRCodeParser.swift`
- Create: `clients/ios/FamilyAITests/PairingQRCodeParserTests.swift`

**Interfaces:**
- Produces `PairingQRCodePayload` from an approved `familyai://pair#...` string.

- [ ] Test correct parsing and rejection of wrong scheme, host, version, HTTP URL, URL credentials, query, fragment, missing fields, expired timestamps, and ambiguous codes.
- [ ] Implement parsing with `URLComponents`, percent-decoding, and normalized HTTPS base URL.
- [ ] Never write raw QR content to logs or errors.
- [ ] Commit `feat(ios): add secure mobile pairing QR parser`.

### Task 4: Implement Keychain credential stores

**Files:**
- Create: `clients/ios/FamilyAI/Core/Persistence/KeychainClient.swift`
- Create: `clients/ios/FamilyAI/Core/Authentication/CredentialStore.swift`
- Create: `clients/ios/FamilyAITests/CredentialStoreTests.swift`

**Interfaces:**
- Produces separate installation, device, and session credential lifecycles.

- [ ] Define a protocol-backed Keychain client with add, update, read, and delete operations.
- [ ] Test first-run UUID creation, logout session removal, unbind device/session removal, installationId retention, and atomic session replacement.
- [ ] Store credentials with an accessibility class appropriate for an unlocked personal device and no iCloud synchronization.
- [ ] Commit `security(ios): add Keychain credential lifecycle`.

### Task 5: Implement GatewayClient and stable error mapping

**Files:**
- Create: `clients/ios/FamilyAI/Core/Networking/GatewayClient.swift`
- Create: `clients/ios/FamilyAI/Core/Networking/GatewayError.swift`
- Create: `clients/ios/FamilyAITests/GatewayClientTests.swift`

**Interfaces:**
- Produces async preview, claim, portal-context, renew, logout, and unbind methods.

- [ ] Test HTTP method, path, headers, body encoding, timeout, response decoding, and redacted diagnostics with `URLProtocol` stubs.
- [ ] Keep Bearer entry and Device authentication headers separate.
- [ ] Map server codes to typed client errors; map transport failures to `unreachable` or `timeout`.
- [ ] Include a synthetic request ID without logging credentials.
- [ ] Commit `feat(ios): add mobile Gateway client`.

### Task 6: Implement actor-serialized SessionManager

**Files:**
- Create: `clients/ios/FamilyAI/Core/Authentication/SessionManager.swift`
- Create: `clients/ios/FamilyAITests/SessionManagerTests.swift`

**Interfaces:**
- Consumes GatewayClient and CredentialStore.
- Produces validated personal context and one shared renewal task.

- [ ] Test valid-session restore, expired-session renewal, concurrent renewal coalescing, device revocation cleanup, and unreachable-Gateway preservation.
- [ ] Implement `actor SessionManager` with a single optional renewal `Task`.
- [ ] Replace stored sessions atomically after successful renewal.
- [ ] Commit `feat(ios): add serialized personal session restoration`.

### Task 7: Implement the pairing feature

**Files:**
- Create files under `clients/ios/FamilyAI/Features/Pairing/` for scanner, manual entry, confirmation, model, and view.
- Create pairing unit and UI tests.

**Interfaces:**
- Consumes QR parser, GatewayClient, DeviceIdentityStore, CredentialStore.
- Produces an authenticated personal context after claim.

- [ ] Implement `PairingState` cases: scanner, manualEntry, loadingPreview, confirmation, claiming, completed, failed.
- [ ] Use AVFoundation camera scanning and provide a manual input fallback.
- [ ] Confirmation must display family name, person name, Gateway host, and current iPhone name.
- [ ] Generate a 32-byte device credential with `SecRandomCopyBytes` only after user confirmation.
- [ ] Safely retry an interrupted claim using the same installation and device credential.
- [ ] Commit `feat(ios): add physical iPhone pairing flow`.

### Task 8: Implement AppCoordinator and real personal home

**Files:**
- Create: `clients/ios/FamilyAI/App/AppCoordinator.swift`
- Create: `clients/ios/FamilyAI/App/AppEnvironment.swift`
- Create files under `clients/ios/FamilyAI/Features/PersonalHome/`.
- Create state-machine and view tests.

**Interfaces:**
- Produces deterministic root navigation across launch, pairing, restore, lock, authenticated, offline, revoked, and configuration-error states.

- [ ] Implement the approved `AppState` enum.
- [ ] Load only real portal context and the last non-sensitive cached context.
- [ ] Display identity, assistant, device, connection, session, and unavailable-Chat cards.
- [ ] Never display full internal refs or credentials in production builds.
- [ ] Commit `feat(ios): add personal entry state machine and home`.

### Task 9: Implement local authentication and privacy cover

**Files:**
- Create files under `clients/ios/FamilyAI/Features/AppLock/`.
- Create local-authentication policy tests.

**Interfaces:**
- Produces a five-minute background lock and sensitive-action reauthentication.

- [ ] Test immediate, five-minute, and disabled policies, defaulting to five minutes.
- [ ] Use `LocalAuthentication` with device-passcode fallback.
- [ ] Present an opaque privacy cover before background snapshots occur.
- [ ] Require fresh authentication before unbinding.
- [ ] Commit `security(ios): add local app lock and privacy cover`.

### Task 10: Implement settings, logout, unbind, and diagnostics

**Files:**
- Create files under `clients/ios/FamilyAI/Features/Settings/`.
- Add settings and credential-lifecycle UI tests.

**Interfaces:**
- Produces user-visible connection state, local-lock policy, logout, and permanent unbind.

- [ ] Clearly distinguish `退出当前会话` from `解绑此设备`.
- [ ] Logout revokes and clears only the session; local device authorization can renew later.
- [ ] Unbind requires authentication, revokes server authorization, clears device and session credentials, and returns to pairing.
- [ ] Diagnostics may show app version, protocol version, connection status, and redacted reference suffixes only.
- [ ] Commit `feat(ios): add mobile entry settings and device controls`.

### Task 11: Add iOS CI and physical-device acceptance guide

**Files:**
- Create: `.github/workflows/ios-ci.yml`
- Create: `docs/development/ios-physical-device-acceptance.md`

**Interfaces:**
- Produces path-filtered simulator verification and repeatable manual iPhone evidence.

- [ ] Trigger CI only for `clients/ios/**`, mobile contracts, and the workflow itself.
- [ ] Build and run unit tests on a pinned macOS/Xcode-compatible runner configuration.
- [ ] Do not upload DerivedData, Keychain exports, provisioning profiles, or verbose network logs.
- [ ] Document Xcode direct installation, developer mode, Tailscale login, Serve HTTPS, Safari health check, camera, Face ID, restart, offline, renewal, and revocation acceptance.
- [ ] Commit `ci(ios): verify mobile entry foundation`.

## Final verification

```bash
xcodebuild \
  -project clients/ios/FamilyAI.xcodeproj \
  -scheme FamilyAI \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  test
```

Then complete every physical-device acceptance item against a synthetic family and member. No real credential value may be pasted into an issue, PR description, CI log, screenshot, or committed file.