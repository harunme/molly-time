import Foundation
import Testing
@testable import MollyCore

private final class DiagnosticsProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        let status = path == "/api/client/error-logs" ? 401 : path.hasSuffix("decode") ? 200 : 503
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"detail\":\"private server response\"}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
struct APIDiagnosticsTests {
    private func api() throws -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DiagnosticsProtocol.self]
        return APIClient(endpoint: try Endpoint("https://diagnostics.example"), session: URLSession(configuration: config))
    }

    @Test func serverAndDecodingFailuresEmitDiagnostics() async throws {
        let client = try api()
        var codes: [String] = []
        client.onDiagnostic = { _, code in codes.append(code) }
        do { let _ = try await client.raw("/api/manage/resources") } catch { }
        #expect(codes == ["API_HTTP_503"])
        struct Result: Decodable { let required: Int }
        do { let _: Result = try await client.request("/api/manage/decode") } catch { }
        #expect(codes == ["API_HTTP_503", "API_DECODE_ERROR"])
    }

    @Test func reporterFailureDoesNotReportItselfOrInvalidateTheSession() async throws {
        let client = try api()
        var reports = 0, unauthorized = 0
        client.onDiagnostic = { _, _ in reports += 1 }
        client.onUnauthorized = { unauthorized += 1 }
        do { let _ = try await client.raw("/api/client/error-logs", method: "POST", body: Data("{}".utf8)) } catch { }
        #expect(reports == 0)
        #expect(unauthorized == 0)
    }
}
