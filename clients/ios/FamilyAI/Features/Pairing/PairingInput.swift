import Foundation

public enum PairingInputError: Error, Equatable, Sendable {
  case invalidScheme, invalidHost, unsupportedVersion, invalidGateway, invalidPairingRef,
    invalidCode, invalidExpiry, expired, missingField, duplicateField, unexpectedField
}
public enum GatewayURLValidator {
  public static func validate(_ rawValue: String) throws -> URL {
    guard let components = URLComponents(string: rawValue),
      components.scheme?.lowercased() == "https", let host = components.host, !host.isEmpty,
      components.user == nil, components.password == nil, components.query == nil,
      components.fragment == nil, components.path.isEmpty || components.path == "/"
    else { throw PairingInputError.invalidGateway }
    var normalized = components
    normalized.path = ""
    guard let url = normalized.url else { throw PairingInputError.invalidGateway }
    return url
  }
}
public enum PairingCodeValidator {
  private static let regex = try! NSRegularExpression(
    pattern: "^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$")
  public static func validate(_ value: String) throws -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    guard
      regex.firstMatch(in: normalized, range: NSRange(normalized.startIndex..., in: normalized))
        != nil
    else { throw PairingInputError.invalidCode }
    return normalized
  }
}
public struct ManualPairingInput: Equatable, Sendable {
  public let gateway: URL
  public let code: String
  public init(gateway: String, code: String) throws {
    self.gateway = try GatewayURLValidator.validate(gateway)
    self.code = try PairingCodeValidator.validate(code)
  }
  public var request: PairingPreviewRequest { PairingPreviewRequest(code: code) }
}
public enum PairingQRCodeParser {
  public static func parse(_ rawValue: String, now: Date = Date()) throws -> PairingQRPayload {
    guard let url = URLComponents(string: rawValue) else { throw PairingInputError.missingField }
    guard url.scheme?.lowercased() == "familyai" else { throw PairingInputError.invalidScheme }
    guard url.host?.lowercased() == "pair" else { throw PairingInputError.invalidHost }
    guard url.user == nil,
      url.password == nil,
      url.port == nil,
      url.path.isEmpty,
      url.query == nil,
      let fragment = url.fragment
    else {
      throw PairingInputError.unexpectedField
    }
    let allowed = Set(["v", "gateway", "pairingRef", "code", "expiresAt"])
    var values: [String: String] = [:]
    for pair in fragment.split(separator: "&", omittingEmptySubsequences: false) {
      let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard parts.count == 2, let key = String(parts[0]).removingPercentEncoding,
        let value = String(parts[1]).removingPercentEncoding, !key.isEmpty, !value.isEmpty
      else { throw PairingInputError.missingField }
      guard allowed.contains(key) else { throw PairingInputError.unexpectedField }
      guard values[key] == nil else { throw PairingInputError.duplicateField }
      values[key] = value
    }
    guard values.count == allowed.count else { throw PairingInputError.missingField }
    guard values["v"] == "1" else { throw PairingInputError.unsupportedVersion }
    guard let gatewayValue = values["gateway"], let pairingRef = values["pairingRef"],
      let codeValue = values["code"], let expiresValue = values["expiresAt"]
    else { throw PairingInputError.missingField }
    guard
      pairingRef.range(of: #"^pairing:[a-z0-9][a-z0-9._:-]{1,126}$"#, options: .regularExpression)
        != nil
    else { throw PairingInputError.invalidPairingRef }
    let gateway = try GatewayURLValidator.validate(gatewayValue)
    let code = try PairingCodeValidator.validate(codeValue)
    guard
      let expiresAt = try? MobileEntryCoding.decoder().decode(
        Date.self, from: Data("\"\(expiresValue)\"".utf8))
    else { throw PairingInputError.invalidExpiry }
    guard expiresAt > now else { throw PairingInputError.expired }
    return PairingQRPayload(
      version: .current, gateway: gateway, pairingRef: pairingRef, code: code, expiresAt: expiresAt)
  }
}
