import Foundation

#if canImport(Security)
  import Security
#endif
public enum KeychainClientError: Error, Equatable, Sendable {
  case unavailable
  case unexpectedStatus(Int32)
}
public protocol KeychainClientProtocol: Sendable {
  func read(key: String) async throws -> Data?
  func write(_ data: Data, key: String) async throws
  func delete(key: String) async throws
}
public actor InMemoryKeychainClient: KeychainClientProtocol {
  private var values: [String: Data] = [:]
  private var failingWrites: Set<String> = []
  public init() {}
  public func setFailingWrites(_ keys: Set<String>) { failingWrites = keys }
  public func read(key: String) -> Data? { values[key] }
  public func write(_ data: Data, key: String) throws {
    if failingWrites.contains(key) { throw KeychainClientError.unavailable }
    values[key] = data
  }
  public func delete(key: String) { values.removeValue(forKey: key) }
}
public actor SystemKeychainClient: KeychainClientProtocol {
  private let service: String
  public init(service: String = "FamilyAI.Keychain") { self.service = service }
  public func read(key: String) throws -> Data? {
    #if canImport(Security)
      var query = baseQuery(key: key)
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      if status == errSecItemNotFound { return nil }
      guard status == errSecSuccess else { throw KeychainClientError.unexpectedStatus(status) }
      return result as? Data
    #else
      throw KeychainClientError.unavailable
    #endif
  }
  public func write(_ data: Data, key: String) throws {
    #if canImport(Security)
      let query = baseQuery(key: key)
      let attributes = [kSecValueData as String: data]
      let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
      if updateStatus == errSecItemNotFound {
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        add[kSecAttrSynchronizable as String] = false
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainClientError.unexpectedStatus(status) }
      } else if updateStatus != errSecSuccess {
        throw KeychainClientError.unexpectedStatus(updateStatus)
      }
    #else
      throw KeychainClientError.unavailable
    #endif
  }
  public func delete(key: String) throws {
    #if canImport(Security)
      let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw KeychainClientError.unexpectedStatus(status)
      }
    #else
      throw KeychainClientError.unavailable
    #endif
  }
  #if canImport(Security)
    private func baseQuery(key: String) -> [String: Any] {
      [
        kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
        kSecAttrAccount as String: key,
      ]
    }
  #endif
}
