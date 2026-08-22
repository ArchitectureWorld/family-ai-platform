import Foundation

public enum PairingCompletion: Equatable, Sendable {
  case authenticated(PersonalPortalContext)
  case offline
  case failed(PairingFailure)
}

public actor PairingManager {
  private struct PendingClaim: Equatable, Sendable {
    let confirmation: PairingConfirmation
    let installationId: UUID
    let deviceCredential: String
    let device: MobileDeviceDescriptor
  }

  public private(set) var state: PairingState = .scanner

  public var canRetryClaim: Bool {
    pendingClaim != nil
  }

  private let gateway: GatewayClientProtocol
  private let credentials: CredentialStoreProtocol
  private let deviceDescriptor: @Sendable () -> MobileDeviceDescriptor
  private let credentialGenerator: @Sendable () throws -> String
  private let now: @Sendable () -> Date
  private var pendingClaim: PendingClaim?

  public init(
    gateway: GatewayClientProtocol,
    credentials: CredentialStoreProtocol,
    deviceDescriptor: @escaping @Sendable () -> MobileDeviceDescriptor,
    credentialGenerator: @escaping @Sendable () throws -> String = {
      try DeviceCredentialGenerator.generate()
    },
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.gateway = gateway
    self.credentials = credentials
    self.deviceDescriptor = deviceDescriptor
    self.credentialGenerator = credentialGenerator
    self.now = now
  }

  public func showScanner() {
    pendingClaim = nil
    state = .scanner
  }

  public func showManualEntry() {
    pendingClaim = nil
    state = .manualEntry
  }

  public func previewManual(
    gateway gatewayValue: String,
    code: String
  ) async throws {
    do {
      let input = try ManualPairingInput(
        gateway: gatewayValue,
        code: code
      )
      try await loadPreview(
        gateway: input.gateway,
        request: input.request,
        pairingRef: nil,
        code: input.code
      )
    } catch {
      if !(error is GatewayClientError) {
        state = .failed(mapInputError(error))
      }
      throw error
    }
  }

  public func previewScanned(_ rawValue: String) async throws {
    do {
      let payload = try PairingQRCodeParser.parse(rawValue, now: now())
      try await loadPreview(
        gateway: payload.gateway,
        request: PairingPreviewRequest(
          pairingRef: payload.pairingRef,
          code: payload.code
        ),
        pairingRef: payload.pairingRef,
        code: payload.code
      )
    } catch {
      if !(error is GatewayClientError) {
        state = .failed(mapInputError(error))
      }
      throw error
    }
  }

  public func confirm() async -> PairingCompletion {
    guard case .confirmation(let confirmation) = state else {
      return .failed(.invalidInput)
    }
    return await claim(confirmation: confirmation)
  }

  public func retryClaim() async -> PairingCompletion {
    guard let pendingClaim else {
      return .failed(.invalidInput)
    }
    return await claim(
      confirmation: pendingClaim.confirmation,
      reusing: pendingClaim
    )
  }

  public func resetAfterFailure() {
    pendingClaim = nil
    state = .scanner
  }

  private func loadPreview(
    gateway baseURL: URL,
    request: PairingPreviewRequest,
    pairingRef: String?,
    code: String
  ) async throws {
    pendingClaim = nil
    state = .loadingPreview

    do {
      let preview = try await gateway.preview(
        baseURL: baseURL,
        request: request
      )
      guard preview.expiresAt > now() else {
        state = .failed(.expired)
        throw PairingInputError.expired
      }
      state = .confirmation(
        PairingConfirmation(
          preview: preview,
          gateway: baseURL,
          code: code,
          pairingRef: pairingRef,
          deviceDisplayName: deviceDescriptor().displayName
        )
      )
    } catch let error as GatewayClientError {
      state = .failed(mapGatewayError(error))
      throw error
    }
  }

  private func claim(
    confirmation: PairingConfirmation,
    reusing existingPendingClaim: PendingClaim? = nil
  ) async -> PairingCompletion {
    guard confirmation.preview.expiresAt > now() else {
      pendingClaim = nil
      state = .failed(.expired)
      return .failed(.expired)
    }

    let claimMaterial: PendingClaim
    do {
      if let existingPendingClaim,
        existingPendingClaim.confirmation == confirmation
      {
        claimMaterial = existingPendingClaim
      } else {
        claimMaterial = PendingClaim(
          confirmation: confirmation,
          installationId: try await credentials.installationId(),
          deviceCredential: try credentialGenerator(),
          device: deviceDescriptor()
        )
      }
    } catch {
      pendingClaim = nil
      state = .failed(.invalidResponse)
      return .failed(.invalidResponse)
    }

    pendingClaim = claimMaterial
    state = .claiming(confirmation)

    let request = PairingClaimRequest(
      pairingRef: confirmation.pairingRef,
      code: confirmation.code,
      installationId: claimMaterial.installationId,
      deviceCredential: claimMaterial.deviceCredential,
      device: claimMaterial.device
    )

    do {
      let response = try await gateway.claim(
        baseURL: confirmation.gateway,
        request: request
      )
      let authorization = DeviceAuthorization(
        deviceRef: response.device.deviceRef,
        deviceCredential: claimMaterial.deviceCredential
      )
      try await credentials.saveClaim(
        profile: GatewayProfile(baseURL: confirmation.gateway),
        authorization: authorization,
        session: response.entry
      )

      do {
        let context = try await gateway.fetchPortalContext(
          baseURL: confirmation.gateway,
          session: response.entry
        )
        pendingClaim = nil
        state = .completed(context)
        return .authenticated(context)
      } catch GatewayClientError.unreachable,
        GatewayClientError.timeout
      {
        pendingClaim = nil
        state = .failed(.unavailable)
        return .offline
      }
    } catch let error as GatewayClientError {
      let failure = mapGatewayError(error)
      if error != .unreachable, error != .timeout {
        pendingClaim = nil
      }
      state = .failed(failure)
      return .failed(failure)
    } catch {
      pendingClaim = nil
      state = .failed(.invalidResponse)
      return .failed(.invalidResponse)
    }
  }

  private func mapInputError(_ error: Error) -> PairingFailure {
    guard let inputError = error as? PairingInputError else {
      return .invalidInput
    }
    switch inputError {
    case .expired, .invalidExpiry:
      return .expired
    default:
      return .invalidInput
    }
  }

  private func mapGatewayError(_ error: GatewayClientError) -> PairingFailure {
    switch error {
    case .unreachable, .timeout:
      return .unavailable
    case .invalidResponse, .insecureGateway:
      return .invalidResponse
    case .server(let code):
      if code == .pairingExpired {
        return .expired
      }
      return .rejected(code)
    }
  }
}
