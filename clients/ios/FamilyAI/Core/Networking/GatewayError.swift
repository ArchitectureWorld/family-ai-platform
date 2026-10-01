import Foundation

public enum GatewayClientError: Error, Equatable, Sendable {
  case server(MobileGatewayErrorCode)
  case unreachable, timeout, invalidResponse, insecureGateway
}
