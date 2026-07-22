import XCTest

@testable import FamilyAICore

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

final class GatewayClientTests: XCTestCase {
  override func setUp() { URLProtocolStub.reset() }

  func testEntryAndDeviceHeadersNeverMix() async throws {
    URLProtocolStub.handler = { request in
      if request.url?.path == "/api/v1/portal/context" {
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer TOKEN")
        XCTAssertEqual(
          request.value(forHTTPHeaderField: "X-Entry-Session-Ref"), "entry-session:test")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-Device-Ref"))
        return Self.response(request, fixture: "portal-context-personal")
      }
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Device DEVICE")
      XCTAssertEqual(request.value(forHTTPHeaderField: "X-Device-Ref"), "device:test")
      XCTAssertNil(request.value(forHTTPHeaderField: "X-Entry-Session-Ref"))
      return Self.response(request, fixture: "session-renew-success")
    }
    let client = makeClient()
    _ = try await client.fetchPortalContext(
      baseURL: URL(string: "https://gateway.example.com")!,
      session: EntrySessionCredential(
        entryBindingRef: "entry-binding:test", entrySessionRef: "entry-session:test",
        token: "TOKEN", expiresAt: .distantFuture))
    _ = try await client.renew(
      baseURL: URL(string: "https://gateway.example.com")!,
      authorization: DeviceAuthorization(deviceRef: "device:test", deviceCredential: "DEVICE"))
  }

  func testMapsStableServerCodeAndTransportErrors() async {
    URLProtocolStub.handler = { request in
      Self.response(request, status: 403, fixture: "device-revoked-error")
    }
    do {
      _ = try await makeClient().renew(
        baseURL: URL(string: "https://gateway.example.com")!,
        authorization: DeviceAuthorization(deviceRef: "device:test", deviceCredential: "DEVICE"))
      XCTFail()
    } catch { XCTAssertEqual(error as? GatewayClientError, .server(.deviceRevoked)) }
    URLProtocolStub.error = URLError(.notConnectedToInternet)
    do {
      _ = try await makeClient().preview(
        baseURL: URL(string: "https://gateway.example.com")!,
        request: PairingPreviewRequest(code: "ABCD-EFGH"))
      XCTFail()
    } catch { XCTAssertEqual(error as? GatewayClientError, .unreachable) }
  }

  func testUsesExpectedMethodsPathsAndRequestBodies() async throws {
    URLProtocolStub.handler = { request in
      switch request.url?.path {
      case "/api/v1/mobile/pairing/preview":
        XCTAssertEqual(request.httpMethod, "POST")
        let object = try! XCTUnwrap(
          JSONSerialization.jsonObject(with: request.httpBody ?? Data())
            as? [String: Any]
        )
        XCTAssertEqual(object["protocolVersion"] as? Int, 1)
        XCTAssertEqual(object["code"] as? String, "ABCD-EFGH")
        XCTAssertNil(object["pairingRef"])
        return Self.response(
          request,
          fixture: "pairing-preview-success"
        )
      case "/api/v1/mobile/pairing/claim":
        XCTAssertEqual(request.httpMethod, "POST")
        let object = try! XCTUnwrap(
          JSONSerialization.jsonObject(with: request.httpBody ?? Data())
            as? [String: Any]
        )
        XCTAssertEqual(object["protocolVersion"] as? Int, 1)
        XCTAssertEqual(object["pairingRef"] as? String, "pairing:test-1")
        XCTAssertEqual(
          UUID(uuidString: object["installationId"] as? String ?? ""),
          UUID(uuidString: "018f47a2-1f10-7a3d-8c2d-61f369284f20")
        )
        return Self.response(
          request,
          fixture: "pairing-claim-success"
        )
      case "/api/v1/mobile/session/logout":
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertNil(request.httpBody)
        return Self.response(
          request,
          data: Data(
            #"{"protocolVersion":1,"status":"logged_out"}"#.utf8
          )
        )
      case "/api/v1/mobile/device":
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertNil(request.httpBody)
        return Self.response(
          request,
          data: Data(
            #"{"protocolVersion":1,"status":"revoked"}"#.utf8
          )
        )
      default:
        XCTFail("Unexpected path: \(request.url?.path ?? "nil")")
        return Self.response(request, status: 500, data: Data())
      }
    }

    let client = makeClient()
    let baseURL = try XCTUnwrap(URL(string: "https://gateway.example.com"))
    let session = EntrySessionCredential(
      entryBindingRef: "entry-binding:test",
      entrySessionRef: "entry-session:test",
      token: String(repeating: "T", count: 43),
      expiresAt: .distantFuture
    )
    let authorization = DeviceAuthorization(
      deviceRef: "device:test",
      deviceCredential: String(repeating: "D", count: 43)
    )

    _ = try await client.preview(
      baseURL: baseURL,
      request: PairingPreviewRequest(code: "ABCD-EFGH")
    )
    _ = try await client.claim(
      baseURL: baseURL,
      request: PairingClaimRequest(
        pairingRef: "pairing:test-1",
        code: "ABCD-EFGH",
        installationId: UUID(
          uuidString: "018f47a2-1f10-7a3d-8c2d-61f369284f20"
        )!,
        deviceCredential: String(repeating: "D", count: 43),
        device: MobileDeviceDescriptor(
          displayName: "测试 iPhone",
          systemVersion: "17.6",
          appVersion: "1.0.0",
          model: "iPhone"
        )
      )
    )
    _ = try await client.logout(baseURL: baseURL, session: session)
    _ = try await client.unbind(
      baseURL: baseURL,
      authorization: authorization
    )
  }

  func testMapsEveryStableServerErrorCodeWithoutInspectingMessage() async {
    let baseURL = URL(string: "https://gateway.example.com")!
    for code in MobileGatewayErrorCode.allCases {
      URLProtocolStub.reset()
      URLProtocolStub.handler = { request in
        let data = try! JSONSerialization.data(
          withJSONObject: [
            "protocolVersion": 1,
            "error": [
              "code": code.rawValue,
              "category": "validation",
              "message": "server text must not drive UI state",
              "retryable": false,
            ],
          ]
        )
        return Self.response(request, status: 400, data: data)
      }

      do {
        _ = try await makeClient().preview(
          baseURL: baseURL,
          request: PairingPreviewRequest(code: "ABCD-EFGH")
        )
        XCTFail("Expected server error for \(code.rawValue)")
      } catch {
        XCTAssertEqual(error as? GatewayClientError, .server(code))
      }
    }
  }

  func testMapsTimeoutAndMalformedHTTPResponse() async {
    let baseURL = URL(string: "https://gateway.example.com")!
    URLProtocolStub.error = URLError(.timedOut)
    do {
      _ = try await makeClient().preview(
        baseURL: baseURL,
        request: PairingPreviewRequest(code: "ABCD-EFGH")
      )
      XCTFail("Expected timeout")
    } catch {
      XCTAssertEqual(error as? GatewayClientError, .timeout)
    }

    URLProtocolStub.reset()
    URLProtocolStub.handler = { request in
      Self.response(request, data: Data("not-json".utf8))
    }
    do {
      _ = try await makeClient().preview(
        baseURL: baseURL,
        request: PairingPreviewRequest(code: "ABCD-EFGH")
      )
      XCTFail("Expected invalid response")
    } catch {
      XCTAssertEqual(error as? GatewayClientError, .invalidResponse)
    }
  }

  func testUsesFifteenSecondTimeoutAndSyntheticRequestId() async throws {
    URLProtocolStub.handler = { request in
      XCTAssertEqual(request.timeoutInterval, 15, accuracy: 0.01)
      XCTAssertTrue(request.value(forHTTPHeaderField: "X-Request-ID")?.hasPrefix("ios-") == true)
      return Self.response(request, fixture: "pairing-preview-success")
    }
    _ = try await makeClient().preview(
      baseURL: URL(string: "https://gateway.example.com")!,
      request: PairingPreviewRequest(code: "ABCD-EFGH"))
  }

  private func makeClient() -> URLSessionGatewayClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [URLProtocolStub.self]
    return URLSessionGatewayClient(session: URLSession(configuration: config))
  }
  private static func response(
    _ request: URLRequest,
    status: Int = 200,
    fixture: String
  ) -> (HTTPURLResponse, Data) {
    let root = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let data = try! Data(
      contentsOf: root.appendingPathComponent(
        "packages/contracts/fixtures/mobile-entry/\(fixture).json"
      )
    )
    return response(request, status: status, data: data)
  }

  private static func response(
    _ request: URLRequest,
    status: Int = 200,
    data: Data
  ) -> (HTTPURLResponse, Data) {
    (
      HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: nil,
        headerFields: nil
      )!,
      data
    )
  }
}

final class URLProtocolStub: URLProtocol {
  nonisolated(unsafe) static var handler: ((URLRequest) -> (HTTPURLResponse, Data))?
  nonisolated(unsafe) static var error: Error?
  static func reset() {
    handler = nil
    error = nil
  }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    if let error = Self.error {
      client?.urlProtocol(self, didFailWithError: error)
      return
    }
    let (response, data) = Self.handler!(request)
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
