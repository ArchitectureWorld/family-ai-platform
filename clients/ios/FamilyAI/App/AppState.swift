import Foundation

public struct CachedPersonalContext: Codable, Equatable, Sendable {
  public let familyDisplayName: String
  public let personDisplayName: String
  public let familyRole: PersonalPortalContext.FamilyRole
  public let assistantDisplayName: String
  public let deviceDisplayName: String
  public let lastSyncedAt: Date

  public init(
    familyDisplayName: String,
    personDisplayName: String,
    familyRole: PersonalPortalContext.FamilyRole,
    assistantDisplayName: String,
    deviceDisplayName: String,
    lastSyncedAt: Date
  ) {
    self.familyDisplayName = familyDisplayName
    self.personDisplayName = personDisplayName
    self.familyRole = familyRole
    self.assistantDisplayName = assistantDisplayName
    self.deviceDisplayName = deviceDisplayName
    self.lastSyncedAt = lastSyncedAt
  }

  public init(
    context: PersonalPortalContext,
    lastSyncedAt: Date
  ) {
    familyDisplayName = context.family.displayName
    personDisplayName = context.person.displayName
    familyRole = context.membership.familyRole
    assistantDisplayName = context.agent.displayName
    deviceDisplayName = context.device.displayName
    self.lastSyncedAt = lastSyncedAt
  }
}

public enum AppState: Equatable, Sendable {
  case launching
  case needsPairing
  case pairing(PairingState)
  case restoringSession
  case locked
  case authenticated(PersonalPortalContext)
  case offline(CachedPersonalContext?)
  case authorizationRevoked
  case fatalConfigurationError
}
