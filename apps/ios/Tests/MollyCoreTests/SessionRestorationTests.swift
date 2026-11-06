import Foundation
import Testing
@testable import MollyCore

private final class RestoreURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@Suite(.serialized) @MainActor
struct SessionRestorationTests {
    private func client() throws -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RestoreURLProtocol.self]
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        let api = APIClient(endpoint: try Endpoint("https://mollytime.app"), session: URLSession(configuration: config))
        api.cookie = "saved-session"
        return api
    }
    private let sessionJSON = Data(#"{"user":{"id":"u","name":"家长","role":"member","accountId":"100001"},"family":{"id":"f","name":"家"},"csrfToken":"csrf"}"#.utf8)

    @Test func timeoutAndDeployment502RecoverWithTheSameCredentials() async throws {
        let api = try client()
        var requests = 0, unauthorized = 0
        var delays: [Duration] = []
        let recovery = SessionRestoration(sleep: { delays.append($0) })
        api.onUnauthorized = { unauthorized += 1 }
        let reply = sessionJSON
        RestoreURLProtocol.handler = { request in
            requests += 1
            #expect(request.url?.path == "/api/manage/auth/session")
            #expect(request.value(forHTTPHeaderField: "Cookie") == ["molly_parent", "saved-session"].joined(separator: "="))
            #expect(request.timeoutInterval == 10)
            if requests == 1 { throw URLError(.timedOut) }
            if requests == 2 { return (502, Data()) }
            return (200, reply)
        }
        var restored: ParentSession?
        await recovery.restoreIfNeeded {
            restored = try await api.request("/api/manage/auth/session", timeout: 10)
        }
        #expect(requests == 3 && delays == [.seconds(1), .seconds(2)])
        #expect(restored?.user.id == "u" && unauthorized == 0)
        #expect(api.cookie == "saved-session" && !recovery.restoring && recovery.failure == nil)
        await recovery.restoreIfNeeded { Issue.record("A restored session must not be fetched again") }
    }

    @Test func exhaustedRetriesKeepCredentialsAndAllowAnotherAttempt() async throws {
        let api = try client()
        let recovery = SessionRestoration(sleep: { _ in })
        var requests = 0
        RestoreURLProtocol.handler = { _ in
            requests += 1
            return (503, Data())
        }
        let restore: @MainActor () async throws -> Void = {
            let _: ParentSession = try await api.request("/api/manage/auth/session", timeout: 10)
        }
        await recovery.restoreIfNeeded(load: restore)
        #expect(requests == 3 && !recovery.restoring && recovery.failure != nil)
        #expect(api.cookie == "saved-session")
        let reply = sessionJSON
        RestoreURLProtocol.handler = { _ in requests += 1; return (200, reply) }
        await recovery.restoreIfNeeded(load: restore) // Retry button and foreground use the same entry point.
        #expect(requests == 4 && !recovery.restoring && recovery.failure == nil)
    }

    @Test func onlyUnauthorizedEndsRecoveryWithoutAnErrorScreen() async throws {
        let api = try client()
        let recovery = SessionRestoration(sleep: { _ in Issue.record("401 must not retry") })
        var expired = false
        api.onUnauthorized = { expired = true; api.cookie = ""; recovery.finish() }
        RestoreURLProtocol.handler = { _ in (401, Data()) }
        await recovery.restoreIfNeeded {
            let _: ParentSession = try await api.request("/api/manage/auth/session")
        }
        #expect(expired && api.cookie.isEmpty && !recovery.restoring && recovery.failure == nil)
        await recovery.restoreIfNeeded { Issue.record("Expired credentials must not retry") }
    }

    @Test func otherFailuresDoNotSignOutOrAutomaticallyRepeat() async {
        let recovery = SessionRestoration(sleep: { _ in Issue.record("A non-transient error must not retry") })
        var attempts = 0
        await recovery.restoreIfNeeded { attempts += 1; throw APIError.invalidResponse }
        #expect(attempts == 1 && recovery.failure != nil && !recovery.restoring)
        await recovery.restoreIfNeeded { attempts += 1 }
        #expect(attempts == 2 && recovery.failure == nil)
    }

    @Test func simultaneousStartupAndForegroundShareOneRecovery() async {
        let recovery = SessionRestoration(sleep: { _ in })
        let gate = RestorationGate()
        var attempts = 0
        let first = Task { await recovery.restoreIfNeeded { attempts += 1; await gate.wait() } }
        await gate.started()
        let second = Task { await recovery.restoreIfNeeded { attempts += 1 } }
        await Task.yield()
        gate.release()
        await first.value; await second.value
        #expect(attempts == 1 && !recovery.restoring && recovery.failure == nil)
    }

    @Test func accountChangeRejectsALateFailureAndItsRetries() async {
        let recovery = SessionRestoration(sleep: { _ in Issue.record("A retired account must not retry") })
        let gate = RestorationGate()
        let old = Task {
            await recovery.restoreIfNeeded {
                await gate.wait() // Deliberately ignore cancellation as a late transport might.
                throw URLError(.timedOut)
            }
        }
        await gate.started()
        recovery.finish()
        gate.release()
        await old.value
        #expect(!recovery.restoring && recovery.failure == nil)
        await recovery.restoreIfNeeded { Issue.record("The new login supersedes startup recovery") }
    }

    @Test func cancelledTransportStillOffersRecoveryInsteadOfLogin() async {
        let recovery = SessionRestoration(sleep: { _ in })
        await recovery.restoreIfNeeded { throw URLError(.cancelled) }
        #expect(!recovery.restoring && recovery.failure != nil)
        await recovery.restoreIfNeeded {}
        #expect(recovery.failure == nil)
    }
}

@MainActor
private final class RestorationGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var startWaiter: CheckedContinuation<Void, Never>?
    func wait() async {
        await withCheckedContinuation {
            continuation = $0
            startWaiter?.resume(); startWaiter = nil
        }
    }
    func started() async {
        if continuation != nil { return }
        await withCheckedContinuation { startWaiter = $0 }
    }
    func release() { continuation?.resume(); continuation = nil }
}
