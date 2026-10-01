import Foundation

public struct MobileEntryProtocolVersion: Codable, Equatable, Sendable {
  public static let current = Self(rawValue: 1)

  public let rawValue: Int

  private init(rawValue: Int) {
    self.rawValue = rawValue
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    let value = try container.decode(Int.self)
    guard value == Self.current.rawValue else {
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Unsupported Mobile Entry protocol version"
      )
    }
    rawValue = value
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

public enum MobileEntryCoding {
  public static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let value = try container.decode(String.self)
      guard let date = parseRFC3339(value) else {
        throw DecodingError.dataCorruptedError(
          in: container,
          debugDescription: "Invalid RFC3339 timestamp"
        )
      }
      return date
    }
    return decoder
  }

  public static func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      try container.encode(formatRFC3339(date))
    }
    return encoder
  }

  private static func parseRFC3339(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [
      .withInternetDateTime,
      .withFractionalSeconds,
    ]
    if let date = fractional.date(from: value) {
      return date
    }

    let standard = ISO8601DateFormatter()
    standard.formatOptions = [.withInternetDateTime]
    return standard.date(from: value)
  }

  private static func formatRFC3339(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [
      .withInternetDateTime,
      .withFractionalSeconds,
    ]
    return formatter.string(from: date)
  }
}

struct AnyCodingKey: CodingKey, Hashable {
  let stringValue: String
  let intValue: Int?

  init?(stringValue: String) {
    self.stringValue = stringValue
    intValue = nil
  }

  init?(intValue: Int) {
    stringValue = String(intValue)
    self.intValue = intValue
  }
}

extension Decoder {
  func rejectUnknownKeys<Key>(_: Key.Type) throws
  where Key: CodingKey & CaseIterable, Key.AllCases: Collection {
    let container = try container(keyedBy: AnyCodingKey.self)
    let allowed = Set(Key.allCases.map(\.stringValue))
    let unknown = container.allKeys
      .map(\.stringValue)
      .filter { !allowed.contains($0) }
      .sorted()

    guard unknown.isEmpty else {
      throw DecodingError.dataCorrupted(
        .init(
          codingPath: codingPath,
          debugDescription: "Unexpected fields: \(unknown.joined(separator: ", "))"
        )
      )
    }
  }
}

enum MobileEntryValidation {
  static func displayName<Key: CodingKey>(
    _ value: String,
    key: Key,
    container: KeyedDecodingContainer<Key>
  ) throws -> String {
    try boundedTrimmed(
      value,
      minimum: 1,
      maximum: 80,
      key: key,
      container: container,
      description: "Invalid display name"
    )
  }

  static func hostName<Key: CodingKey>(
    _ value: String,
    key: Key,
    container: KeyedDecodingContainer<Key>
  ) throws -> String {
    try boundedTrimmed(
      value,
      minimum: 1,
      maximum: 253,
      key: key,
      container: container,
      description: "Invalid host display name"
    )
  }

  static func boundedText<Key: CodingKey>(
    _ value: String,
    minimum: Int,
    maximum: Int,
    key: Key,
    container: KeyedDecodingContainer<Key>
  ) throws -> String {
    try boundedTrimmed(
      value,
      minimum: minimum,
      maximum: maximum,
      key: key,
      container: container,
      description: "Invalid protocol text"
    )
  }

  static func reference<Key: CodingKey>(
    _ value: String,
    prefix: String,
    key: Key,
    container: KeyedDecodingContainer<Key>
  ) throws -> String {
    let pattern = "^\(NSRegularExpression.escapedPattern(for: prefix)):[a-z0-9][a-z0-9._:-]{1,126}$"
    guard value.range(of: pattern, options: .regularExpression) != nil else {
      throw DecodingError.dataCorruptedError(
        forKey: key,
        in: container,
        debugDescription: "Invalid \(prefix) reference"
      )
    }
    return value
  }

  static func optionalReference<Key: CodingKey>(
    _ value: String?,
    prefix: String,
    key: Key,
    container: KeyedDecodingContainer<Key>
  ) throws -> String? {
    guard let value else {
      return nil
    }
    return try reference(
      value,
      prefix: prefix,
      key: key,
      container: container
    )
  }

  static func pairingCode<Key: CodingKey>(
    _ value: String,
    key: Key,
    container: KeyedDecodingContainer<Key>
  ) throws -> String {
    guard
      value.range(
        of: "^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$",
        options: .regularExpression
      ) != nil
    else {
      throw DecodingError.dataCorruptedError(
        forKey: key,
        in: container,
        debugDescription: "Invalid pairing code"
      )
    }
    return value
  }

  static func credential<Key: CodingKey>(
    _ value: String,
    key: Key,
    container: KeyedDecodingContainer<Key>
  ) throws -> String {
    guard
      value.range(
        of: "^[A-Za-z0-9_-]{43}$",
        options: .regularExpression
      ) != nil
    else {
      throw DecodingError.dataCorruptedError(
        forKey: key,
        in: container,
        debugDescription: "Invalid credential"
      )
    }
    return value
  }

  private static func boundedTrimmed<Key: CodingKey>(
    _ value: String,
    minimum: Int,
    maximum: Int,
    key: Key,
    container: KeyedDecodingContainer<Key>,
    description: String
  ) throws -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count >= minimum, trimmed.count <= maximum else {
      throw DecodingError.dataCorruptedError(
        forKey: key,
        in: container,
        debugDescription: description
      )
    }
    return trimmed
  }
}
