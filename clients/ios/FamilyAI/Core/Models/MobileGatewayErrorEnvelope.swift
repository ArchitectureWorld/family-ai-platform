import Foundation

public enum MobileGatewayErrorCode: String, Codable, CaseIterable, Equatable, Sendable {
  case pairingInvalid = "PAIRING_INVALID"
  case pairingExpired = "PAIRING_EXPIRED"
  case pairingConsumed = "PAIRING_CONSUMED"
  case pairingAttemptsExceeded = "PAIRING_ATTEMPTS_EXCEEDED"
  case pairingTargetInactive = "PAIRING_TARGET_INACTIVE"
  case deviceAuthInvalid = "DEVICE_AUTH_INVALID"
  case deviceRevoked = "DEVICE_REVOKED"
  case entrySessionExpired = "ENTRY_SESSION_EXPIRED"
  case entrySessionInvalid = "ENTRY_SESSION_INVALID"
  case entryAudienceForbidden = "ENTRY_AUDIENCE_FORBIDDEN"
  case protocolVersionUnsupported = "PROTOCOL_VERSION_UNSUPPORTED"
}

public struct MobileGatewayErrorEnvelope: Codable, Equatable, Sendable {
  public struct Detail: Codable, Equatable, Sendable {
    public enum Category: String, Codable, Equatable, Sendable {
      case validation
      case permission
      case availability
      case timeout
      case conflict
      case internalError = "internal"
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
      case code
      case category
      case message
      case retryable
      case requestId
    }

    public let code: MobileGatewayErrorCode
    public let category: Category
    public let message: String
    public let retryable: Bool
    public let requestId: String?

    public init(
      code: MobileGatewayErrorCode,
      category: Category,
      message: String,
      retryable: Bool,
      requestId: String? = nil
    ) {
      self.code = code
      self.category = category
      self.message = message
      self.retryable = retryable
      self.requestId = requestId
    }

    public init(from decoder: Decoder) throws {
      try decoder.rejectUnknownKeys(CodingKeys.self)
      let container = try decoder.container(keyedBy: CodingKeys.self)
      code = try container.decode(MobileGatewayErrorCode.self, forKey: .code)
      category = try container.decode(Category.self, forKey: .category)
      message = try MobileEntryValidation.boundedText(
        container.decode(String.self, forKey: .message),
        minimum: 1,
        maximum: 500,
        key: .message,
        container: container
      )
      retryable = try container.decode(Bool.self, forKey: .retryable)
      requestId = try container.decodeIfPresent(String.self, forKey: .requestId)
        .map {
          try MobileEntryValidation.boundedText(
            $0,
            minimum: 8,
            maximum: 128,
            key: .requestId,
            container: container
          )
        }
    }
  }

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case protocolVersion
    case error
  }

  public let protocolVersion: MobileEntryProtocolVersion
  public let error: Detail

  public init(
    protocolVersion: MobileEntryProtocolVersion = .current,
    error: Detail
  ) {
    self.protocolVersion = protocolVersion
    self.error = error
  }

  public init(from decoder: Decoder) throws {
    try decoder.rejectUnknownKeys(CodingKeys.self)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try container.decode(
      MobileEntryProtocolVersion.self,
      forKey: .protocolVersion
    )
    error = try container.decode(Detail.self, forKey: .error)
  }
}
