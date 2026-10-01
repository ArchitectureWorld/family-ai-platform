import Foundation

public protocol LocalAuthenticationClientProtocol: Sendable {
  func authenticate(reason: String) async -> Bool
}
