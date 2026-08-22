import Foundation

public struct PersonalPortalContext: Codable, Equatable, Sendable {
  public enum Audience: String, Codable, Equatable, Sendable {
    case personal
  }

  public enum FamilyRole: String, Codable, Equatable, Sendable {
    case owner
    case adult
    case child
    case elder
  }

  public struct Family: Codable, Equatable, Sendable {
    private enum CodingKeys: String, CodingKey, CaseIterable {
      case familyRef
      case displayName
    }

    public let familyRef: String
    public let displayName: String

    public init(familyRef: String, displayName: String) {
      self.familyRef = familyRef
      self.displayName = displayName
    }

    public init(from decoder: Decoder) throws {
      try decoder.rejectUnknownKeys(CodingKeys.self)
      let container = try decoder.container(keyedBy: CodingKeys.self)
      familyRef = try MobileEntryValidation.reference(
        container.decode(String.self, forKey: .familyRef),
        prefix: "family",
        key: .familyRef,
        container: container
      )
      displayName = try MobileEntryValidation.displayName(
        container.decode(String.self, forKey: .displayName),
        key: .displayName,
        container: container
      )
    }
  }

  public struct Person: Codable, Equatable, Sendable {
    private enum CodingKeys: String, CodingKey, CaseIterable {
      case personRef
      case displayName
    }

    public let personRef: String
    public let displayName: String

    public init(personRef: String, displayName: String) {
      self.personRef = personRef
      self.displayName = displayName
    }

    public init(from decoder: Decoder) throws {
      try decoder.rejectUnknownKeys(CodingKeys.self)
      let container = try decoder.container(keyedBy: CodingKeys.self)
      personRef = try MobileEntryValidation.reference(
        container.decode(String.self, forKey: .personRef),
        prefix: "person",
        key: .personRef,
        container: container
      )
      displayName = try MobileEntryValidation.displayName(
        container.decode(String.self, forKey: .displayName),
        key: .displayName,
        container: container
      )
    }
  }

  public struct Membership: Codable, Equatable, Sendable {
    private enum CodingKeys: String, CodingKey, CaseIterable {
      case familyRole
    }

    public let familyRole: FamilyRole

    public init(familyRole: FamilyRole) {
      self.familyRole = familyRole
    }

    public init(from decoder: Decoder) throws {
      try decoder.rejectUnknownKeys(CodingKeys.self)
      let container = try decoder.container(keyedBy: CodingKeys.self)
      familyRole = try container.decode(FamilyRole.self, forKey: .familyRole)
    }
  }

  public struct Device: Codable, Equatable, Sendable {
    private enum CodingKeys: String, CodingKey, CaseIterable {
      case deviceRef
      case displayName
      case terminalType
      case platform
    }

    public let deviceRef: String
    public let displayName: String
    public let terminalType: String
    public let platform: String

    public init(
      deviceRef: String,
      displayName: String,
      terminalType: String,
      platform: String
    ) {
      self.deviceRef = deviceRef
      self.displayName = displayName
      self.terminalType = terminalType
      self.platform = platform
    }

    public init(from decoder: Decoder) throws {
      try decoder.rejectUnknownKeys(CodingKeys.self)
      let container = try decoder.container(keyedBy: CodingKeys.self)
      deviceRef = try MobileEntryValidation.reference(
        container.decode(String.self, forKey: .deviceRef),
        prefix: "device",
        key: .deviceRef,
        container: container
      )
      displayName = try MobileEntryValidation.displayName(
        container.decode(String.self, forKey: .displayName),
        key: .displayName,
        container: container
      )
      terminalType = try MobileEntryValidation.boundedText(
        container.decode(String.self, forKey: .terminalType),
        minimum: 1,
        maximum: 32,
        key: .terminalType,
        container: container
      )
      platform = try MobileEntryValidation.boundedText(
        container.decode(String.self, forKey: .platform),
        minimum: 1,
        maximum: 64,
        key: .platform,
        container: container
      )
    }
  }

  public struct Agent: Codable, Equatable, Sendable {
    public enum AssignmentType: String, Codable, Equatable, Sendable {
      case personalAssistant = "personal_assistant"
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
      case assignmentRef
      case assignmentType
      case agentRef
      case displayName
      case providerProfileRef
    }

    public let assignmentRef: String
    public let assignmentType: AssignmentType
    public let agentRef: String
    public let displayName: String
    public let providerProfileRef: String

    public init(
      assignmentRef: String,
      assignmentType: AssignmentType = .personalAssistant,
      agentRef: String,
      displayName: String,
      providerProfileRef: String
    ) {
      self.assignmentRef = assignmentRef
      self.assignmentType = assignmentType
      self.agentRef = agentRef
      self.displayName = displayName
      self.providerProfileRef = providerProfileRef
    }

    public init(from decoder: Decoder) throws {
      try decoder.rejectUnknownKeys(CodingKeys.self)
      let container = try decoder.container(keyedBy: CodingKeys.self)
      assignmentRef = try MobileEntryValidation.reference(
        container.decode(String.self, forKey: .assignmentRef),
        prefix: "assignment",
        key: .assignmentRef,
        container: container
      )
      assignmentType = try container.decode(
        AssignmentType.self,
        forKey: .assignmentType
      )
      agentRef = try MobileEntryValidation.reference(
        container.decode(String.self, forKey: .agentRef),
        prefix: "agent",
        key: .agentRef,
        container: container
      )
      displayName = try MobileEntryValidation.displayName(
        container.decode(String.self, forKey: .displayName),
        key: .displayName,
        container: container
      )
      providerProfileRef = try MobileEntryValidation.reference(
        container.decode(String.self, forKey: .providerProfileRef),
        prefix: "provider-profile",
        key: .providerProfileRef,
        container: container
      )
    }
  }

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case protocolVersion
    case audience
    case entrySessionRef
    case entryBindingRef
    case family
    case person
    case membership
    case device
    case agent
  }

  public let protocolVersion: MobileEntryProtocolVersion
  public let audience: Audience
  public let entrySessionRef: String
  public let entryBindingRef: String
  public let family: Family
  public let person: Person
  public let membership: Membership
  public let device: Device
  public let agent: Agent

  public init(
    protocolVersion: MobileEntryProtocolVersion = .current,
    audience: Audience = .personal,
    entrySessionRef: String,
    entryBindingRef: String,
    family: Family,
    person: Person,
    membership: Membership,
    device: Device,
    agent: Agent
  ) {
    self.protocolVersion = protocolVersion
    self.audience = audience
    self.entrySessionRef = entrySessionRef
    self.entryBindingRef = entryBindingRef
    self.family = family
    self.person = person
    self.membership = membership
    self.device = device
    self.agent = agent
  }

  public init(from decoder: Decoder) throws {
    try decoder.rejectUnknownKeys(CodingKeys.self)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try container.decode(
      MobileEntryProtocolVersion.self,
      forKey: .protocolVersion
    )
    audience = try container.decode(Audience.self, forKey: .audience)
    entrySessionRef = try MobileEntryValidation.reference(
      container.decode(String.self, forKey: .entrySessionRef),
      prefix: "entry-session",
      key: .entrySessionRef,
      container: container
    )
    entryBindingRef = try MobileEntryValidation.reference(
      container.decode(String.self, forKey: .entryBindingRef),
      prefix: "entry-binding",
      key: .entryBindingRef,
      container: container
    )
    family = try container.decode(Family.self, forKey: .family)
    person = try container.decode(Person.self, forKey: .person)
    membership = try container.decode(Membership.self, forKey: .membership)
    device = try container.decode(Device.self, forKey: .device)
    agent = try container.decode(Agent.self, forKey: .agent)
  }
}
