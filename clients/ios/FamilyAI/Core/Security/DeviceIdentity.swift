import Foundation

#if canImport(Security)
  import Security
#endif
public enum DeviceIdentityError: Error, Equatable, Sendable { case randomGenerationFailed }
public enum DeviceCredentialGenerator {
  public static func generate() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    #if canImport(Security)
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw DeviceIdentityError.randomGenerationFailed
      }
    #else
      var generator = SystemRandomNumberGenerator()
      for index in bytes.indices {
        bytes[index] = UInt8.random(in: .min ... .max, using: &generator)
      }
    #endif
    return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}
