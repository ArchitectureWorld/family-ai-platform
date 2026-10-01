import LocalAuthentication

public struct SystemLocalAuthenticationClient: LocalAuthenticationClientProtocol {
  public init() {}

  public func authenticate(reason: String) async -> Bool {
    let context = LAContext()
    context.localizedCancelTitle = "取消"

    var error: NSError?
    guard
      context.canEvaluatePolicy(
        .deviceOwnerAuthentication,
        error: &error
      )
    else {
      return false
    }

    do {
      return try await context.evaluatePolicy(
        .deviceOwnerAuthentication,
        localizedReason: reason
      )
    } catch {
      return false
    }
  }
}
