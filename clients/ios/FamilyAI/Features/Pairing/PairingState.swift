import Foundation

public struct PairingConfirmation: Equatable, Sendable {
  public let preview: PairingPreviewResponse
  public let gateway: URL
  public let code: String
  public let pairingRef: String?
  public let deviceDisplayName: String
  public init(
    preview: PairingPreviewResponse, gateway: URL, code: String, pairingRef: String?,
    deviceDisplayName: String
  ) {
    self.preview = preview
    self.gateway = gateway
    self.code = code
    self.pairingRef = pairingRef
    self.deviceDisplayName = deviceDisplayName
  }
}
public enum PairingFailure: Equatable, Sendable {
  case invalidInput, expired, unavailable
  case rejected(MobileGatewayErrorCode)
  case invalidResponse
}
public enum PairingState: Equatable, Sendable {
  case scanner, manualEntry, loadingPreview
  case confirmation(PairingConfirmation)
  case claiming(PairingConfirmation)
  case completed(PersonalPortalContext)
  case failed(PairingFailure)
}
