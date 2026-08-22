import Foundation

public struct PairingQRPayload: Codable, Equatable, Sendable {
  private enum CodingKeys: String, CodingKey, CaseIterable {
    case version
    case gateway
    case pairingRef
    case code
    case expiresAt
  }

  public let version: MobileEntryProtocolVersion
  public let gateway: URL
  public let pairingRef: String
  public let code: String
  public let expiresAt: Date

  public init(
    version: MobileEntryProtocolVersion = .current,
    gateway: URL,
    pairingRef: String,
    code: String,
    expiresAt: Date
  ) {
    self.version = version
    self.gateway = gateway
    self.pairingRef = pairingRef
    self.code = code
    self.expiresAt = expiresAt
  }

  public init(from decoder: Decoder) throws {
    try decoder.rejectUnknownKeys(CodingKeys.self)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    version = try container.decode(
      MobileEntryProtocolVersion.self,
      forKey: .version
    )
    let rawGateway = try container.decode(URL.self, forKey: .gateway)
    do {
      gateway = try GatewayURLValidator.validate(rawGateway.absoluteString)
    } catch {
      throw DecodingError.dataCorruptedError(
        forKey: .gateway,
        in: container,
        debugDescription: "Invalid secure Gateway URL"
      )
    }
    pairingRef = try MobileEntryValidation.reference(
      container.decode(String.self, forKey: .pairingRef),
      prefix: "pairing",
      key: .pairingRef,
      container: container
    )
    code = try MobileEntryValidation.pairingCode(
      container.decode(String.self, forKey: .code),
      key: .code,
      container: container
    )
    expiresAt = try container.decode(Date.self, forKey: .expiresAt)
  }
}

public struct PairingPreviewRequest: Codable, Equatable, Sendable {
  private enum CodingKeys: String, CodingKey, CaseIterable {
    case protocolVersion
    case pairingRef
    case code
  }

  public let protocolVersion: MobileEntryProtocolVersion
  public let pairingRef: String?
  public let code: String

  public init(pairingRef: String? = nil, code: String) {
    protocolVersion = .current
    self.pairingRef = pairingRef
    self.code = code
  }

  public init(from decoder: Decoder) throws {
    try decoder.rejectUnknownKeys(CodingKeys.self)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try container.decode(
      MobileEntryProtocolVersion.self,
      forKey: .protocolVersion
    )
    pairingRef = try MobileEntryValidation.optionalReference(
      container.decodeIfPresent(String.self, forKey: .pairingRef),
      prefix: "pairing",
      key: .pairingRef,
      container: container
    )
    code = try MobileEntryValidation.pairingCode(
      container.decode(String.self, forKey: .code),
      key: .code,
      container: container
    )
  }
}

public struct PairingPreviewResponse: Codable, Equatable, Sendable {
  public struct NamedEntity: Codable, Equatable, Sendable {
    private enum CodingKeys: String, CodingKey, CaseIterable {
      case displayName
    }

    public let displayName: String

    public init(displayName: String) {
      self.displayName = displayName
    }

    public init(from decoder: Decoder) throws {
      try decoder.rejectUnknownKeys(CodingKeys.self)
      let container = try decoder.container(keyedBy: CodingKeys.self)
      displayName = try MobileEntryValidation.displayName(
        container.decode(String.self, forKey: .displayName),
        key: .displayName,
        container: container
      )
    }
  }

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case protocolVersion
    case family
    case person
    case gatewayHost
    case expiresAt
  }

  public let protocolVersion: MobileEntryProtocolVersion
  public let family: NamedEntity
  public let person: NamedEntity
  public let gatewayHost: String
  public let expiresAt: Date

  public init(
    protocolVersion: MobileEntryProtocolVersion = .current,
    family: NamedEntity,
    person: NamedEntity,
    gatewayHost: String,
    expiresAt: Date
  ) {
    self.protocolVersion = protocolVersion
    self.family = family
    self.person = person
    self.gatewayHost = gatewayHost
    self.expiresAt = expiresAt
  }

  public init(from decoder: Decoder) throws {
    try decoder.rejectUnknownKeys(CodingKeys.self)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try container.decode(
      MobileEntryProtocolVersion.self,
      forKey: .protocolVersion
    )
    family = try container.decode(NamedEntity.self, forKey: .family)
    person = try container.decode(NamedEntity.self, forKey: .person)
    gatewayHost = try MobileEntryValidation.hostName(
      container.decode(String.self, forKey: .gatewayHost),
      key: .gatewayHost,
      container: container
    )
    expiresAt = try container.decode(Date.self, forKey: .expiresAt)
  }
}

public struct MobileDeviceDescriptor: Codable, Equatable, Sendable {
  public enum TerminalType: String, Codable, Equatable, Sendable {
    case mobile
  }

  public enum Platform: String, Codable, Equatable, Sendable {
    case ios
  }

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case displayName
    case terminalType
    case platform
    case systemVersion
    case appVersion
    case model
  }

  public let displayName: String
  public let terminalType: TerminalType
  public let platform: Platform
  public let systemVersion: String
  public let appVersion: String
  public let model: String

  public init(
    displayName: String,
    systemVersion: String,
    appVersion: String,
    model: String
  ) {
    self.displayName = displayName
    terminalType = .mobile
    platform = .ios
    self.systemVersion = systemVersion
    self.appVersion = appVersion
    self.model = model
  }

  public init(from decoder: Decoder) throws {
    try decoder.rejectUnknownKeys(CodingKeys.self)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    displayName = try MobileEntryValidation.displayName(
      container.decode(String.self, forKey: .displayName),
      key: .displayName,
      container: container
    )
    terminalType = try container.decode(TerminalType.self, forKey: .terminalType)
    platform = try container.decode(Platform.self, forKey: .platform)
    systemVersion = try MobileEntryValidation.boundedText(
      container.decode(String.self, forKey: .systemVersion),
      minimum: 1,
      maximum: 32,
      key: .systemVersion,
      container: container
    )
    appVersion = try MobileEntryValidation.boundedText(
      container.decode(String.self, forKey: .appVersion),
      minimum: 1,
      maximum: 32,
      key: .appVersion,
      container: container
    )
    model = try MobileEntryValidation.boundedText(
      container.decode(String.self, forKey: .model),
      minimum: 1,
      maximum: 80,
      key: .model,
      container: container
    )
  }
}

public struct PairingClaimRequest: Codable, Equatable, Sendable {
  private enum CodingKeys: String, CodingKey, CaseIterable {
    case protocolVersion
    case pairingRef
    case code
    case installationId
    case deviceCredential
    case device
  }

  public let protocolVersion: MobileEntryProtocolVersion
  public let pairingRef: String?
  public let code: String
  public let installationId: UUID
  public let deviceCredential: String
  public let device: MobileDeviceDescriptor

  public init(
    pairingRef: String? = nil,
    code: String,
    installationId: UUID,
    deviceCredential: String,
    device: MobileDeviceDescriptor
  ) {
    protocolVersion = .current
    self.pairingRef = pairingRef
    self.code = code
    self.installationId = installationId
    self.deviceCredential = deviceCredential
    self.device = device
  }

  public init(from decoder: Decoder) throws {
    try decoder.rejectUnknownKeys(CodingKeys.self)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try container.decode(
      MobileEntryProtocolVersion.self,
      forKey: .protocolVersion
    )
    pairingRef = try MobileEntryValidation.optionalReference(
      container.decodeIfPresent(String.self, forKey: .pairingRef),
      prefix: "pairing",
      key: .pairingRef,
      container: container
    )
    code = try MobileEntryValidation.pairingCode(
      container.decode(String.self, forKey: .code),
      key: .code,
      container: container
    )
    installationId = try container.decode(UUID.self, forKey: .installationId)
    deviceCredential = try MobileEntryValidation.credential(
      container.decode(String.self, forKey: .deviceCredential),
      key: .deviceCredential,
      container: container
    )
    device = try container.decode(MobileDeviceDescriptor.self, forKey: .device)
  }
}

public struct EntrySessionCredential: Codable, Equatable, Sendable {
  private enum CodingKeys: String, CodingKey, CaseIterable {
    case entryBindingRef
    case entrySessionRef
    case token
    case expiresAt
  }

  public let entryBindingRef: String
  public let entrySessionRef: String
  public let token: String
  public let expiresAt: Date

  public init(
    entryBindingRef: String,
    entrySessionRef: String,
    token: String,
    expiresAt: Date
  ) {
    self.entryBindingRef = entryBindingRef
    self.entrySessionRef = entrySessionRef
    self.token = token
    self.expiresAt = expiresAt
  }

  public init(from decoder: Decoder) throws {
    try decoder.rejectUnknownKeys(CodingKeys.self)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    entryBindingRef = try MobileEntryValidation.reference(
      container.decode(String.self, forKey: .entryBindingRef),
      prefix: "entry-binding",
      key: .entryBindingRef,
      container: container
    )
    entrySessionRef = try MobileEntryValidation.reference(
      container.decode(String.self, forKey: .entrySessionRef),
      prefix: "entry-session",
      key: .entrySessionRef,
      container: container
    )
    token = try MobileEntryValidation.credential(
      container.decode(String.self, forKey: .token),
      key: .token,
      container: container
    )
    expiresAt = try container.decode(Date.self, forKey: .expiresAt)
  }
}

public struct PairingClaimResponse: Codable, Equatable, Sendable {
  public struct Device: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Equatable, Sendable {
      case active
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
      case deviceRef
      case displayName
      case status
    }

    public let deviceRef: String
    public let displayName: String
    public let status: Status

    public init(
      deviceRef: String,
      displayName: String,
      status: Status = .active
    ) {
      self.deviceRef = deviceRef
      self.displayName = displayName
      self.status = status
    }

    public init(from decoder: Decoder) throws {
      try decoder.rejectUnknownKeys(CodingKeys.self)
      let container = try decoder.container(keyedBy: CodingKeys.self)
      deviceRef = try MobileEntryValidation.reference(
        container.decode(String.self, forKey: .deviceRef),
        prefix: "device",
        key: .deviceRef,
        container: container
      )
      displayName = try MobileEntryValidation.displayName(
        container.decode(String.self, forKey: .displayName),
        key: .displayName,
        container: container
      )
      status = try container.decode(Status.self, forKey: .status)
    }
  }

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case protocolVersion
    case device
    case entry
  }

  public let protocolVersion: MobileEntryProtocolVersion
  public let device: Device
  public let entry: EntrySessionCredential

  public init(
    protocolVersion: MobileEntryProtocolVersion = .current,
    device: Device,
    entry: EntrySessionCredential
  ) {
    self.protocolVersion = protocolVersion
    self.device = device
    self.entry = entry
  }

  public init(from decoder: Decoder) throws {
    try decoder.rejectUnknownKeys(CodingKeys.self)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try container.decode(
      MobileEntryProtocolVersion.self,
      forKey: .protocolVersion
    )
    device = try container.decode(Device.self, forKey: .device)
    entry = try container.decode(EntrySessionCredential.self, forKey: .entry)
  }
}

public struct SessionRenewResponse: Codable, Equatable, Sendable {
  private enum CodingKeys: String, CodingKey, CaseIterable {
    case protocolVersion
    case entry
  }

  public let protocolVersion: MobileEntryProtocolVersion
  public let entry: EntrySessionCredential

  public init(
    protocolVersion: MobileEntryProtocolVersion = .current,
    entry: EntrySessionCredential
  ) {
    self.protocolVersion = protocolVersion
    self.entry = entry
  }

  public init(from decoder: Decoder) throws {
    try decoder.rejectUnknownKeys(CodingKeys.self)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try container.decode(
      MobileEntryProtocolVersion.self,
      forKey: .protocolVersion
    )
    entry = try container.decode(EntrySessionCredential.self, forKey: .entry)
  }
}

public struct MobileOperationResponse: Codable, Equatable, Sendable {
  public enum Status: String, Codable, Equatable, Sendable {
    case revoked
    case loggedOut = "logged_out"
  }

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case protocolVersion
    case status
  }

  public let protocolVersion: MobileEntryProtocolVersion
  public let status: Status

  public init(
    protocolVersion: MobileEntryProtocolVersion = .current,
    status: Status
  ) {
    self.protocolVersion = protocolVersion
    self.status = status
  }

  public init(from decoder: Decoder) throws {
    try decoder.rejectUnknownKeys(CodingKeys.self)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try container.decode(
      MobileEntryProtocolVersion.self,
      forKey: .protocolVersion
    )
    status = try container.decode(Status.self, forKey: .status)
  }
}
