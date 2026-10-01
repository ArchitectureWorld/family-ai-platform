import Foundation

public enum AppLockPolicy: String, Codable, CaseIterable, Equatable, Sendable {
  case immediate
  case fiveMinutes
  case disabled

  public func requiresAuthentication(
    backgroundedAt: Date?,
    now: Date
  ) -> Bool {
    switch self {
    case .disabled:
      return false
    case .immediate:
      return backgroundedAt != nil
    case .fiveMinutes:
      return backgroundedAt.map {
        now.timeIntervalSince($0) > 300
      } ?? false
    }
  }
}

public protocol AppLockSettingsStoreProtocol: Sendable {
  func load() async -> AppLockPolicy
  func save(_ policy: AppLockPolicy) async
}

public actor AppLockSettingsStore: AppLockSettingsStoreProtocol {
  private enum Key {
    static let policy = "appLockPolicy"
  }

  private let userDefaults: UserDefaults

  public init(suiteName: String? = nil) {
    if let suiteName, let defaults = UserDefaults(suiteName: suiteName) {
      userDefaults = defaults
    } else {
      userDefaults = .standard
    }
  }

  public func load() -> AppLockPolicy {
    guard let rawValue = userDefaults.string(forKey: Key.policy),
      let policy = AppLockPolicy(rawValue: rawValue)
    else {
      return .fiveMinutes
    }
    return policy
  }

  public func save(_ policy: AppLockPolicy) {
    userDefaults.set(policy.rawValue, forKey: Key.policy)
  }
}
