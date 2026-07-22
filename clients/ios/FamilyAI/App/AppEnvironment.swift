import Foundation
import UIKit

@MainActor
public enum AppEnvironment {
  public static func makeCoordinator() -> AppCoordinator {
    #if DEBUG
      let isUITesting = ProcessInfo.processInfo.arguments.contains("-uiTesting")
    #else
      let isUITesting = false
    #endif

    let keychain: any KeychainClientProtocol
    if isUITesting {
      keychain = InMemoryKeychainClient()
    } else {
      keychain = SystemKeychainClient(
        service: Bundle.main.bundleIdentifier ?? "FamilyAI"
      )
    }

    let credentials = CredentialStore(keychain: keychain)
    let gateway = URLSessionGatewayClient()
    let sessionManager = SessionManager(
      gateway: gateway,
      credentials: credentials
    )
    let descriptor = MobileDeviceDescriptor(
      displayName: bounded(
        UIDevice.current.name,
        maximum: 80,
        fallback: "iPhone"
      ),
      systemVersion: bounded(
        UIDevice.current.systemVersion,
        maximum: 32,
        fallback: "iOS 17"
      ),
      appVersion: bounded(
        Bundle.main.object(
          forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "1.0.0",
        maximum: 32,
        fallback: "1.0.0"
      ),
      model: bounded(
        UIDevice.current.model,
        maximum: 80,
        fallback: "iPhone"
      )
    )
    let pairingManager = PairingManager(
      gateway: gateway,
      credentials: credentials,
      deviceDescriptor: { descriptor }
    )

    return AppCoordinator(
      sessionManager: sessionManager,
      pairingManager: pairingManager,
      credentials: credentials,
      cache: CachedPersonalContextStore(),
      lockSettings: AppLockSettingsStore(),
      localAuthentication: SystemLocalAuthenticationClient()
    )
  }

  private static func bounded(
    _ value: String,
    maximum: Int,
    fallback: String
  ) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return fallback
    }
    return String(trimmed.prefix(maximum))
  }
}
