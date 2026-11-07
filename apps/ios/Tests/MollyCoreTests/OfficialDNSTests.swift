import Foundation
import Testing
@testable import MollyCore

private actor DNSProbes {
    var calls: [Int] = []
    let available: Set<Int>
    init(_ available: Set<Int>) { self.available = available }
    func check(_ index: Int) -> Bool { calls.append(index); return available.contains(index) }
}

private final class DNSRequestProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@Suite(.serialized) @MainActor
struct OfficialDNSTests {
    private let origin = URL(string: "https://mollytime.app")!

    @Test func scopeDoesNotCaptureCustomServersOrLookalikeDomains() {
        #expect(OfficialDNS.manages(origin))
        #expect(OfficialDNS.manages(URL(string: "https://api.mollytime.app")!))
        for value in ["https://mollytime.app.evil.example", "https://notmollytime.app", "https://family.local", "https://192.168.1.2", "http://mollytime.app"] {
            #expect(!OfficialDNS.manages(URL(string: value)!))
        }
    }

    @Test func unreachablePrimaryUsesBackupAndCustomServerRestoresSystemDNS() async {
        let probes = DNSProbes([1])
        var applied: [Int?] = []
        let dns = OfficialDNS(probe: { await probes.check($0) }, apply: { applied.append($0) })
        dns.configure(for: origin)
        await dns.ready()
        #expect(dns.resolverIndex == 1)
        #expect(await probes.calls == [0, 1])
        dns.configure(for: URL(string: "https://family.local")!)
        #expect(applied.last! == nil)
    }

    @Test func networkChangeTriesEncryptedDNSAgainAfterBothProvidersWereBlocked() async {
        let dns = OfficialDNS(probe: { _ in false }, apply: { _ in })
        dns.configure(for: origin); await dns.ready()
        #expect(dns.resolverIndex == nil)
        dns.networkChanged()
        #expect(dns.resolverIndex == 0)
        await dns.ready()
        #expect(dns.resolverIndex == nil)
    }

    @Test func obsoleteProbeCannotOverrideACustomServer() async {
        let dns = OfficialDNS(probe: { _ in await Task.yield(); return true }, apply: { _ in })
        dns.configure(for: origin)
        dns.configure(for: URL(string: "https://family.local")!)
        await dns.ready(); await Task.yield()
        #expect(dns.resolverIndex == nil)
    }

    private func client(dns: OfficialDNS) throws -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DNSRequestProtocol.self]
        let api = APIClient(endpoint: try Endpoint(origin.absoluteString), session: URLSession(configuration: config), dns: dns)
        api.cookie = "saved-session"; api.csrf = "csrf"
        return api
    }

    @Test func certificateFailureRotatesResolverAndRetriesOneReadWithTheSameOriginAndCookie() async throws {
        let dns = OfficialDNS(probe: { _ in true }, apply: { _ in })
        let api = try client(dns: dns)
        var calls = 0, unauthorized = 0
        api.onUnauthorized = { unauthorized += 1 }
        DNSRequestProtocol.handler = { request in
            calls += 1
            #expect(request.url?.host == "mollytime.app")
            #expect(request.value(forHTTPHeaderField: "Cookie") == "molly_parent=saved-session")
            if calls == 1 { throw URLError(.serverCertificateUntrusted) }
            return (200, Data("{\"ok\":true}".utf8))
        }
        let _: OK = try await api.request("/api/manage/settings")
        #expect(calls == 2 && unauthorized == 0 && api.cookie == "saved-session")
        #expect(dns.resolverIndex == 1)
    }

    @Test func invalidCertificateIsStillRejectedAfterRotation() async throws {
        let dns = OfficialDNS(probe: { _ in true }, apply: { _ in })
        let api = try client(dns: dns)
        var calls = 0
        DNSRequestProtocol.handler = { _ in calls += 1; throw URLError(.serverCertificateUntrusted) }
        do { let _: OK = try await api.request("/api/manage/settings"); Issue.record("Invalid TLS must fail") }
        catch { #expect((error as? URLError)?.code == .serverCertificateUntrusted) }
        #expect(calls == 2)
    }

    @Test func ambiguousMutationFailuresAreNeverReplayed() async throws {
        for method in ["POST", "PUT", "PATCH", "DELETE"] {
            let dns = OfficialDNS(probe: { _ in true }, apply: { _ in })
            let api = try client(dns: dns)
            var calls = 0
            DNSRequestProtocol.handler = { _ in calls += 1; throw URLError(.timedOut) }
            do { let _: OK = try await api.request("/api/manage/uploads", method: method); Issue.record("Expected failure") }
            catch { #expect((error as? URLError)?.code == .timedOut) }
            #expect(calls == 1 && dns.resolverIndex == 0)
            #expect(api.cookie == "saved-session")
        }
    }

    @Test func cancellationAndHTTPResponsesDoNotTriggerDNSRetries() async throws {
        var request = URLRequest(url: origin)
        for code: URLError.Code in [.cancelled, .notConnectedToInternet, .badServerResponse] {
            #expect(!OfficialDNS.mayRetry(request, after: URLError(code)))
        }
        request.httpMethod = "POST"
        #expect(!OfficialDNS.mayRetry(request, after: URLError(.serverCertificateUntrusted)))
        let dns = OfficialDNS(probe: { _ in true }, apply: { _ in })
        let api = try client(dns: dns)
        var calls = 0
        DNSRequestProtocol.handler = { _ in calls += 1; return (401, Data()) }
        do { let _: OK = try await api.request("/api/manage/auth/session"); Issue.record("Expected 401") }
        catch { #expect(error as? APIError == .unauthorized) }
        #expect(calls == 1 && dns.resolverIndex == 0)
    }
}
