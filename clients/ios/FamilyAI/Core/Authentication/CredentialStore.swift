import Foundation

public enum CredentialStoreError: Error, Equatable, Sendable {
  case corruptedState
  case atomicReplacementFailed
}

public protocol CredentialStoreProtocol: Sendable {
  func installationId() async throws -> UUID
  func gatewayProfile() async throws -> GatewayProfile?
  func deviceAuthorization() async throws -> DeviceAuthorization?
  func session() async throws -> EntrySessionCredential?

  func saveGatewayAndDevice(
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ) async throws

  func saveClaim(
    profile: GatewayProfile,
    authorization: DeviceAuthorization,
    session: EntrySessionCredential
  ) async throws

  func replaceSessionAtomically(
    _ session: EntrySessionCredential
  ) async throws

  func clearSession() async throws
  func clearDeviceAndSession() async throws
}

public actor CredentialStore: CredentialStoreProtocol {
  private enum Key: String, CaseIterable {
    case installationId
    case gatewayBaseURL
    case deviceRef
    case deviceCredential
    case entryBindingRef
    case entrySessionRef
    case entrySessionToken
    case entrySessionExpiresAt

    var staged: String {
      "\(rawValue).staged"
    }
  }

  private struct Snapshot: Sendable {
    let key: Key
    let data: Data?
  }

  private let keychain: KeychainClientProtocol
  private let dateEncoder = MobileEntryCoding.encoder()
  private let dateDecoder = MobileEntryCoding.decoder()

  public init(keychain: KeychainClientProtocol) {
    self.keychain = keychain
  }

  public func installationId() async throws -> UUID {
    if let data = try await keychain.read(key: Key.installationId.rawValue),
      let string = String(data: data, encoding: .utf8),
      let value = UUID(uuidString: string)
    {
      return value
    }

    let value = UUID()
    try await keychain.write(
      Data(value.uuidString.lowercased().utf8),
      key: Key.installationId.rawValue
    )
    return value
  }

  public func gatewayProfile() async throws -> GatewayProfile? {
    guard let value = try await readString(.gatewayBaseURL) else {
      return nil
    }
    do {
      return GatewayProfile(
        baseURL: try GatewayURLValidator.validate(value)
      )
    } catch {
      throw CredentialStoreError.corruptedState
    }
  }

  public func deviceAuthorization() async throws -> DeviceAuthorization? {
    let deviceRef = try await readString(.deviceRef)
    let credential = try await readString(.deviceCredential)

    switch (deviceRef, credential) {
    case (nil, nil):
      return nil
    case (.some(let deviceRef), .some(let credential)):
      return DeviceAuthorization(
        deviceRef: deviceRef,
        deviceCredential: credential
      )
    default:
      throw CredentialStoreError.corruptedState
    }
  }

  public func session() async throws -> EntrySessionCredential? {
    let entryBindingRef = try await readString(.entryBindingRef)
    let entrySessionRef = try await readString(.entrySessionRef)
    let token = try await readString(.entrySessionToken)
    let expiresAtData = try await keychain.read(
      key: Key.entrySessionExpiresAt.rawValue
    )

    let valuesPresent = [
      entryBindingRef != nil,
      entrySessionRef != nil,
      token != nil,
      expiresAtData != nil,
    ]

    if valuesPresent.allSatisfy({ !$0 }) {
      return nil
    }
    guard valuesPresent.allSatisfy({ $0 }),
      let entryBindingRef,
      let entrySessionRef,
      let token,
      let expiresAtData,
      let expiresAt = try? dateDecoder.decode(
        Date.self,
        from: expiresAtData
      )
    else {
      throw CredentialStoreError.corruptedState
    }

    return EntrySessionCredential(
      entryBindingRef: entryBindingRef,
      entrySessionRef: entrySessionRef,
      token: token,
      expiresAt: expiresAt
    )
  }

  public func saveGatewayAndDevice(
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ) async throws {
    try await replaceAtomically(
      values: gatewayAndDeviceValues(
        profile: profile,
        authorization: authorization
      )
    )
  }

  public func saveClaim(
    profile: GatewayProfile,
    authorization: DeviceAuthorization,
    session: EntrySessionCredential
  ) async throws {
    var values = gatewayAndDeviceValues(
      profile: profile,
      authorization: authorization
    )
    values.merge(
      try sessionValues(session),
      uniquingKeysWith: { _, new in new }
    )
    try await replaceAtomically(values: values)
  }

  public func replaceSessionAtomically(
    _ session: EntrySessionCredential
  ) async throws {
    try await replaceAtomically(values: try sessionValues(session))
  }

  public func clearSession() async throws {
    for key in sessionKeys {
      try await keychain.delete(key: key.rawValue)
      try await keychain.delete(key: key.staged)
    }
  }

  public func clearDeviceAndSession() async throws {
    try await clearSession()
    for key in [Key.gatewayBaseURL, .deviceRef, .deviceCredential] {
      try await keychain.delete(key: key.rawValue)
      try await keychain.delete(key: key.staged)
    }
  }

  private var sessionKeys: [Key] {
    [
      .entryBindingRef,
      .entrySessionRef,
      .entrySessionToken,
      .entrySessionExpiresAt,
    ]
  }

  private func gatewayAndDeviceValues(
    profile: GatewayProfile,
    authorization: DeviceAuthorization
  ) -> [Key: Data] {
    [
      .gatewayBaseURL: Data(profile.baseURL.absoluteString.utf8),
      .deviceRef: Data(authorization.deviceRef.utf8),
      .deviceCredential: Data(authorization.deviceCredential.utf8),
    ]
  }

  private func sessionValues(
    _ session: EntrySessionCredential
  ) throws -> [Key: Data] {
    [
      .entryBindingRef: Data(session.entryBindingRef.utf8),
      .entrySessionRef: Data(session.entrySessionRef.utf8),
      .entrySessionToken: Data(session.token.utf8),
      .entrySessionExpiresAt: try dateEncoder.encode(session.expiresAt),
    ]
  }

  private func replaceAtomically(values: [Key: Data]) async throws {
    let orderedKeys = values.keys.sorted { $0.rawValue < $1.rawValue }

    do {
      for key in orderedKeys {
        guard let data = values[key] else {
          continue
        }
        try await keychain.write(data, key: key.staged)
      }
      try await verifyStagedValues(values, orderedKeys: orderedKeys)
    } catch {
      await clearStagedValues(orderedKeys)
      throw error
    }

    var snapshots: [Snapshot] = []
    for key in orderedKeys {
      snapshots.append(
        Snapshot(
          key: key,
          data: try await keychain.read(key: key.rawValue)
        )
      )
    }

    do {
      for key in orderedKeys {
        guard let data = values[key] else {
          continue
        }
        try await keychain.write(data, key: key.rawValue)
      }
    } catch {
      let rollbackSucceeded = await rollback(snapshots)
      await clearStagedValues(orderedKeys)
      if rollbackSucceeded {
        throw error
      }
      throw CredentialStoreError.atomicReplacementFailed
    }

    await clearStagedValues(orderedKeys)
  }

  private func verifyStagedValues(
    _ values: [Key: Data],
    orderedKeys: [Key]
  ) async throws {
    for key in orderedKeys {
      guard let expected = values[key],
        try await keychain.read(key: key.staged) == expected
      else {
        throw CredentialStoreError.atomicReplacementFailed
      }
    }
  }

  private func rollback(_ snapshots: [Snapshot]) async -> Bool {
    var succeeded = true
    for snapshot in snapshots {
      do {
        if let data = snapshot.data {
          try await keychain.write(data, key: snapshot.key.rawValue)
        } else {
          try await keychain.delete(key: snapshot.key.rawValue)
        }
      } catch {
        succeeded = false
      }
    }
    return succeeded
  }

  private func clearStagedValues(_ keys: [Key]) async {
    for key in keys {
      try? await keychain.delete(key: key.staged)
    }
  }

  private func readString(_ key: Key) async throws -> String? {
    guard let data = try await keychain.read(key: key.rawValue),
      let value = String(data: data, encoding: .utf8)
    else {
      return nil
    }
    return value
  }
}
