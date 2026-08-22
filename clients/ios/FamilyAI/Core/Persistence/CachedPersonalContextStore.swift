import Foundation

public protocol CachedPersonalContextStoreProtocol: Sendable {
  func load() async throws -> CachedPersonalContext?
  func save(_ context: CachedPersonalContext) async throws
  func clear() async
}

public actor CachedPersonalContextStore: CachedPersonalContextStoreProtocol {
  private enum Key {
    static let context = "cachedPersonalContext"
  }

  private let userDefaults: UserDefaults
  private let encoder = MobileEntryCoding.encoder()
  private let decoder = MobileEntryCoding.decoder()

  public init(suiteName: String? = nil) {
    if let suiteName, let defaults = UserDefaults(suiteName: suiteName) {
      userDefaults = defaults
    } else {
      userDefaults = .standard
    }
  }

  public func load() throws -> CachedPersonalContext? {
    guard let data = userDefaults.data(forKey: Key.context) else {
      return nil
    }
    return try decoder.decode(CachedPersonalContext.self, from: data)
  }

  public func save(_ context: CachedPersonalContext) throws {
    userDefaults.set(try encoder.encode(context), forKey: Key.context)
  }

  public func clear() {
    userDefaults.removeObject(forKey: Key.context)
  }
}
