import Foundation

#if canImport(Observation) && !os(Linux)
  import Observation
#endif

public enum AppCoordinatorFailure: Equatable, Sendable {
  case connectionUnavailable
  case operationFailed
  case configurationInvalid
}

@MainActor
#if canImport(Observation) && !os(Linux)
  @Observable
#endif
public final class AppCoordinator {
  public private(set) var state: AppState = .launching
  public private(set) var isPrivacyCoverVisible = true
  public private(set) var lockPolicy: AppLockPolicy = .fiveMinutes
  public private(set) var sessionExpiresAt: Date?
  public private(set) var lastSyncedAt: Date?
  public private(set) var canRetryPairingClaim = false
  public private(set) var lastFailure: AppCoordinatorFailure?

  private let sessionManager: SessionManager
  private let pairingManager: PairingManager
  private let credentials: CredentialStoreProtocol
  private let cache: CachedPersonalContextStoreProtocol
  private let lockSettings: AppLockSettingsStoreProtocol
  private let localAuthentication: LocalAuthenticationClientProtocol
  private let now: @Sendable () -> Date

  private var backgroundedAt: Date?
  private var protectedState: AppState?

  public init(
    sessionManager: SessionManager,
    pairingManager: PairingManager,
    credentials: CredentialStoreProtocol,
    cache: CachedPersonalContextStoreProtocol,
    lockSettings: AppLockSettingsStoreProtocol,
    localAuthentication: LocalAuthenticationClientProtocol,
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.sessionManager = sessionManager
    self.pairingManager = pairingManager
    self.credentials = credentials
    self.cache = cache
    self.lockSettings = lockSettings
    self.localAuthentication = localAuthentication
    self.now = now
  }

  public func start() async {
    state = .launching
    lastFailure = nil
    lockPolicy = await lockSettings.load()

    do {
      guard try await credentials.deviceAuthorization() != nil else {
        sessionExpiresAt = nil
        state = .needsPairing
        isPrivacyCoverVisible = false
        return
      }
      state = .restoringSession
      try await apply(restoreResult: sessionManager.restore())
    } catch CredentialStoreError.corruptedState,
      CredentialStoreError.atomicReplacementFailed
    {
      lastFailure = .configurationInvalid
      state = .fatalConfigurationError
    } catch {
      lastFailure = .operationFailed
      state = .fatalConfigurationError
    }
    isPrivacyCoverVisible = false
  }

  public func beginScannerPairing() async {
    await pairingManager.showScanner()
    await synchronizePairingState()
  }

  public func beginManualPairing() async {
    await pairingManager.showManualEntry()
    await synchronizePairingState()
  }

  public func previewManualPairing(
    gateway: String,
    code: String
  ) async {
    lastFailure = nil
    do {
      try await pairingManager.previewManual(
        gateway: gateway,
        code: code
      )
    } catch {
      // PairingManager owns the stable, code-based failure mapping.
    }
    await synchronizePairingState()
  }

  public func previewScannedPairing(_ rawValue: String) async {
    lastFailure = nil
    do {
      try await pairingManager.previewScanned(rawValue)
    } catch {
      // Never log or retain the full QR payload.
    }
    await synchronizePairingState()
  }

  public func confirmPairing() async {
    await apply(pairingCompletion: pairingManager.confirm())
  }

  public func retryPairingClaim() async {
    await apply(pairingCompletion: pairingManager.retryClaim())
  }

  public func resetPairing() async {
    await pairingManager.resetAfterFailure()
    await synchronizePairingState()
  }

  public func acknowledgeAuthorizationRevoked() {
    state = .needsPairing
  }

  public func retryOfflineConnection() async {
    await restoreAuthorizedSession()
  }

  public func setLockPolicy(_ policy: AppLockPolicy) async {
    lockPolicy = policy
    await lockSettings.save(policy)
  }

  public func didEnterBackground(at date: Date = Date()) {
    if state == .locked {
      isPrivacyCoverVisible = true
      return
    }
    backgroundedAt = date
    if case .authenticated = state {
      protectedState = state
    } else if case .offline = state {
      protectedState = state
    }
    isPrivacyCoverVisible = true
  }

  public func didBecomeInactive() {
    isPrivacyCoverVisible = true
  }

  public func didBecomeActive(at date: Date = Date()) async {
    if state == .locked {
      isPrivacyCoverVisible = false
      return
    }
    guard let protectedState else {
      isPrivacyCoverVisible = false
      return
    }

    if lockPolicy.requiresAuthentication(
      backgroundedAt: backgroundedAt,
      now: date
    ) {
      state = .locked
    } else {
      state = protectedState
      self.protectedState = nil
      backgroundedAt = nil
    }
    isPrivacyCoverVisible = false
  }

  public func unlock() async {
    guard state == .locked else {
      return
    }
    let authenticated = await localAuthentication.authenticate(
      reason: "解锁 Family AI 个人入口"
    )
    guard authenticated else {
      return
    }
    protectedState = nil
    backgroundedAt = nil
    await restoreAuthorizedSession()
  }

  public func logout() async {
    lastFailure = nil
    do {
      try await sessionManager.logout()
      sessionExpiresAt = nil
      protectedState = nil
      state = .locked
    } catch {
      lastFailure = .operationFailed
    }
  }

  public func unbindDevice() async {
    lastFailure = nil
    let authenticated = await localAuthentication.authenticate(
      reason: "确认解绑此 iPhone"
    )
    guard authenticated else {
      return
    }

    do {
      try await sessionManager.unbind()
      await cache.clear()
      sessionExpiresAt = nil
      protectedState = nil
      state = .needsPairing
    } catch GatewayClientError.unreachable,
      GatewayClientError.timeout
    {
      lastFailure = .connectionUnavailable
    } catch {
      lastFailure = .operationFailed
    }
  }

  private func restoreAuthorizedSession() async {
    state = .restoringSession
    do {
      try await apply(restoreResult: sessionManager.restore())
    } catch CredentialStoreError.corruptedState,
      CredentialStoreError.atomicReplacementFailed
    {
      lastFailure = .configurationInvalid
      state = .fatalConfigurationError
    } catch {
      lastFailure = .operationFailed
      state = .fatalConfigurationError
    }
  }

  private func apply(restoreResult: SessionRestoreResult) async throws {
    switch restoreResult {
    case .needsPairing:
      sessionExpiresAt = nil
      state = .needsPairing
    case .authenticated(let context):
      let synchronizedAt = now()
      lastSyncedAt = synchronizedAt
      try await cache.save(
        CachedPersonalContext(
          context: context,
          lastSyncedAt: synchronizedAt
        )
      )
      sessionExpiresAt = try await credentials.session()?.expiresAt
      state = .authenticated(context)
    case .offline:
      sessionExpiresAt = try await credentials.session()?.expiresAt
      let cachedContext = try await cache.load()
      lastSyncedAt = cachedContext?.lastSyncedAt
      state = .offline(cachedContext)
    case .revoked:
      await cache.clear()
      sessionExpiresAt = nil
      state = .authorizationRevoked
    }
  }

  private func apply(pairingCompletion: PairingCompletion) async {
    switch pairingCompletion {
    case .authenticated(let context):
      do {
        let synchronizedAt = now()
        lastSyncedAt = synchronizedAt
        try await cache.save(
          CachedPersonalContext(
            context: context,
            lastSyncedAt: synchronizedAt
          )
        )
        sessionExpiresAt = try await credentials.session()?.expiresAt
        state = .authenticated(context)
      } catch {
        lastFailure = .configurationInvalid
        state = .fatalConfigurationError
      }
    case .offline:
      sessionExpiresAt = try? await credentials.session()?.expiresAt
      let cachedContext = try? await cache.load()
      lastSyncedAt = cachedContext?.lastSyncedAt
      state = .offline(cachedContext)
    case .failed:
      await synchronizePairingState()
    }
  }

  private func synchronizePairingState() async {
    state = .pairing(await pairingManager.state)
    canRetryPairingClaim = await pairingManager.canRetryClaim
  }
}
