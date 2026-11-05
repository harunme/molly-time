import Foundation
import Testing
@testable import MollyCore

struct EndpointTests {
    @Test func testOnlyHTTPSOriginsAreAccepted() throws {
        for bad in ["http://mollytime.app", "https://user:pass@mollytime.app", "https://mollytime.app/api", "https://mollytime.app?token=1", "https://mollytime.app#x", "not a url"] {
            checkThrows(try Endpoint(bad), bad)
        }
        checkEqual(try Endpoint(" https://mollytime.app/ ").origin.host, "mollytime.app")
    }
    @Test func testCredentialsStayOnExactOrigin() throws {
        let endpoint = try Endpoint("https://mollytime.app")
        checkThrows(try endpoint.resolve("https://evil.example/api/manage/resources"))
        checkThrows(try endpoint.resolve("//evil.example/api/manage/resources"))
        checkThrows(try endpoint.resolve("https://mollytime.app:444/api/manage/resources"))
        checkThrows(try endpoint.resolve("http://mollytime.app/api/manage/resources", authenticated: false))
        checkEqual(try endpoint.resolve("/api/episodes/e1/play").host, "mollytime.app")
        checkEqual(try endpoint.resolve("https://media.oss-cn-beijing.aliyuncs.com/a?Signature=example", authenticated: false).host, "media.oss-cn-beijing.aliyuncs.com")
    }
    @Test func testQueryEncodingAndExistingImageQuery() throws {
        let endpoint = try Endpoint("https://mollytime.app")
        let url = try endpoint.api("/api/manage/resources", query: [URLQueryItem(name: "q", value: "花 & 树")])
        checkEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "花 & 树")
        checkEqual(try endpoint.api("/api/items/1/image?w=320").query, "w=320")
    }
    @Test func testPairingRequiresFourASCIIDigitsAndSameServer() throws {
        let endpoint = try Endpoint("https://mollytime.app")
        checkEqual(PairingCode.normalize("0042", endpoint: endpoint), "0042")
        checkEqual(PairingCode.normalize("https://mollytime.app/manage/?pair=0042", endpoint: endpoint), "0042")
        for bad in ["１２３４", "123", "12345", "https://evil.example/manage/?pair=0042", "https://mollytime.app/other?pair=0042"] {
            checkNil(PairingCode.normalize(bad, endpoint: endpoint), bad)
        }
    }
}

struct ModelTests {
    @Test func testPagedResourcesWithoutFilesDecode() throws {
        // Paginated API responses intentionally omit media detail and overview text.
        let json = #"{"items":[{"id":"x","name":"自然","type":"Series","parentId":null,"overview":"","status":"draft","ready":false,"runtimeMs":0,"imageUrl":"/api/items/x/image?w=320"}],"page":1,"pageSize":1,"total":2}"#
        let page = try JSONDecoder().decode(Page<Resource>.self, from: Data(json.utf8))
        checkTrue(page.hasNext); checkTrue(page.items[0].isFolder)
        checkEqual(page.items[0].statusLabel, "处理中")
    }
    @Test func testSessionRoleIsNotInferredFromName() throws {
        let json = #"{"user":{"id":"u","name":"管理员","role":"member","accountId":"100001","email":null},"family":{"id":"f","name":"家"},"csrfToken":"csrf"}"#
        let session = try JSONDecoder().decode(ParentSession.self, from: Data(json.utf8))
        checkFalse(session.canManage)
    }
    @Test func testVTTHandlesCueIDsSettingsAndAlreadyOffsetTimestamps() {
        let cues = WebVTT.parse("WEBVTT\r\n\r\n1\r\n00:00:01.500 --> 00:00:03.000 align:center\r\n<b>你好</b> &amp; 世界\r\n\r\n00:04.000 --> 00:05.000\r\n第二行\r\n\r\ninvalid --> line\r\nbad")
        checkEqual(cues.count, 2)
        checkEqual(WebVTT.caption(at: 1.5, offsetMs: 0, cues: cues), "你好 & 世界")
        checkEqual(WebVTT.caption(at: 3, offsetMs: 0, cues: cues), "")
        checkEqual(WebVTT.caption(at: 5, offsetMs: 1000, cues: cues), "第二行")
    }
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, [String: String], Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw APIError.invalidResponse }
            let (status, headers, data) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@Suite(.serialized) @MainActor
struct APIClientTests {
    private func makeClient() throws -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        return APIClient(endpoint: try Endpoint("https://mollytime.app"), session: URLSession(configuration: config))
    }
    @Test func libraryInvalidationOnlyFollowsSuccessfulChanges() async throws {
        let api = try makeClient()
        var changes = 0; api.onLibraryChange = { changes += 1 }
        StubURLProtocol.handler = { _ in (200, [:], Data(#"{"ok":true}"#.utf8)) }
        let _: OK = try await api.request("/api/manage/resources/e")
        checkEqual(changes, 0)
        try await api.command("/api/manage/resources/e/archive")
        checkEqual(changes, 1)
        try await api.command("/api/manage/trash/e/restore")
        checkEqual(changes, 2)
        StubURLProtocol.handler = { _ in (409, [:], Data(#"{"detail":"busy"}"#.utf8)) }
        do { try await api.command("/api/manage/resources/e/archive"); fail() } catch {}
        checkEqual(changes, 2)
    }
    @Test func acceptedDeletionDoesNotPretendStorageHasBeenFreed() async throws {
        let api = try makeClient()
        var storageChanges = 0, libraryChanges = 0
        api.onStorageChange = { storageChanges += 1 }
        api.onLibraryChange = { libraryChanges += 1 }
        StubURLProtocol.handler = { _ in (202, [:], Data(#"{"ok":true,"deleting":true}"#.utf8)) }
        let receipt: TrashDeletionReceipt = try await api.request("/api/manage/trash/e", method: "DELETE")
        #expect(receipt.deleting == true)
        #expect(storageChanges == 0 && libraryChanges == 0)
        // Old servers complete synchronously and still trigger immediate refresh.
        StubURLProtocol.handler = { _ in (200, [:], Data(#"{"ok":true}"#.utf8)) }
        let previous: TrashDeletionReceipt = try await api.request("/api/manage/trash/e", method: "DELETE")
        #expect(previous.deleting == nil)
        #expect(storageChanges == 1 && libraryChanges == 1)
    }
    @Test func artworkUsesBoundedChunksAndCompletesBeforeInvalidating() async throws {
        let api = try makeClient()
        let size = 4 * 1024 * 1024 + 8
        var offsets: [Int] = []; var changes = 0
        api.onLibraryChange = { changes += 1 }
        func reply(_ offset: Int, _ status: String) -> Data {
            Data("{\"id\":\"u\",\"itemId\":\"e\",\"offset\":\(offset),\"size\":\(size),\"status\":\"\(status)\",\"transport\":\"local\",\"partSize\":4194304,\"error\":\"\"}".utf8)
        }
        StubURLProtocol.handler = { request in
            let path = request.url!.path
            if path.hasSuffix("/chunks") {
                let offset = Int(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!)!
                offsets.append(offset)
                checkTrue(request.value(forHTTPHeaderField: "X-Chunk-SHA256")?.count == 64)
                return (200, [:], reply(min(offset + 4 * 1024 * 1024, size), "uploading"))
            }
            if path.hasSuffix("/complete") { return (200, [:], reply(size, "ready")) }
            checkEqual(path, "/api/manage/uploads")
            return (200, [:], reply(0, "uploading"))
        }
        try await ResourceArtworkUpload.send(Data(repeating: 1, count: size), itemID: "e", api: api)
        checkEqual(offsets, [0, 4 * 1024 * 1024])
        checkEqual(changes, 1)
    }
    @Test func testMutationIncludesScopedCookieAndCSRF() async throws {
        let api = try makeClient(); api.cookie = "session-value"; api.csrf = "csrf-value"
        StubURLProtocol.handler = { request in
            checkEqual(request.url?.host, "mollytime.app")
            checkEqual(request.httpMethod, "POST")
            checkEqual(request.value(forHTTPHeaderField: "Cookie"), "molly_parent=session-value")
            checkEqual(request.value(forHTTPHeaderField: "X-CSRF-Token"), "csrf-value")
            return (200, [:], Data(#"{"ok":true}"#.utf8))
        }
        try await api.command("/api/manage/pairing/confirm", body: ["code":"0042", "name":"客厅"])
    }
    @Test func testRejectsExternalRequestsBeforeTransport() async throws {
        let api = try makeClient(); api.cookie = "secret"
        StubURLProtocol.handler = { _ in fail("External request reached transport"); return (200, [:], Data()) }
        do { let _: OK = try await api.request("https://evil.example/api/manage/session"); fail() }
        catch { checkEqual(error as? APIError, .unsafeURL) }
    }
    @Test func testLoginCapturesCookieWithoutLoggingCredentials() async throws {
        let api = try makeClient()
        var saved = ""
        api.onCookie = { saved = $0 }
        StubURLProtocol.handler = { _ in (200, ["Set-Cookie":"molly_parent=new-session; Path=/; Secure; HttpOnly; SameSite=Strict"], Data(#"{"ok":true}"#.utf8)) }
        let _: OK = try await api.send("/api/manage/auth/login", body: ["username":"test", "password":"example"])
        checkEqual(saved, "new-session"); checkEqual(api.cookie, "new-session")
    }
    @Test func testUnauthorizedInvalidatesSession() async throws {
        let api = try makeClient()
        var expired = false; api.onUnauthorized = { expired = true }
        StubURLProtocol.handler = { _ in (401, [:], Data(#"{"detail":"expired"}"#.utf8)) }
        do { let _: OK = try await api.request("/api/manage/auth/session"); fail() }
        catch { checkEqual(error as? APIError, .unauthorized) }
        checkTrue(expired)
    }
    @Test func testFailedLoginKeepsActionableError() async throws {
        let api = try makeClient()
        var expired = false; api.onUnauthorized = { expired = true }
        StubURLProtocol.handler = { _ in (401, [:], Data(#"{"detail":"账号密码错误"}"#.utf8)) }
        do { let _: OK = try await api.send("/api/manage/auth/login", body: ["username":"test"]); fail() }
        catch { checkEqual(error as? APIError, .http(401, "账号密码错误")) }
        checkFalse(expired)
    }
    @Test func testMalformedResponseGivesReadableFailure() async throws {
        let api = try makeClient()
        StubURLProtocol.handler = { _ in (200, [:], Data("<html>proxy</html>".utf8)) }
        do { let _: ParentSession = try await api.request("/api/manage/auth/session"); fail() }
        catch { checkEqual(error as? APIError, .invalidResponse) }
    }
    @Test func storageChangesNotifyAfterSuccessfulMutationsWithoutChunkOrReadNoise() async throws {
        let api = try makeClient()
        var changes = 0
        api.onStorageChange = { changes += 1 }
        StubURLProtocol.handler = { _ in (200, [:], Data(#"{"ok":true}"#.utf8)) }
        for path in ["/api/manage/uploads", "/api/manage/uploads/u/complete",
                     "/api/manage/uploads/u/cancel", "/api/manage/resources/r",
                     "/api/manage/trash/r/purge", "/api/manage/shares", "/api/manage/settings"] {
            try await api.command(path, body: [String: String]())
        }
        #expect(changes == 7)
        let _: OK = try await api.request("/api/manage/settings")
        try await api.command("/api/manage/uploads/u/part-url", body: [String: String]())
        _ = try await api.raw("/api/manage/uploads/u", method: "PATCH", body: Data())
        #expect(changes == 7)
        StubURLProtocol.handler = { _ in (500, [:], Data()) }
        do {
            try await api.command("/api/manage/uploads/u/cancel", body: [String: String]())
            Issue.record("Failed operation must throw")
        } catch {}
        #expect(changes == 7)
    }
    @Test func uploadProcessingCompletionTriggersSilentStorageRefresh() async throws {
        let api = try makeClient()
        var changes = 0
        api.onStorageChange = { changes += 1 }
        for status in ["processing", "ready", "failed", "cancelled"] {
            StubURLProtocol.handler = { _ in
                (200, [:], Data("""
                {"id":"u","itemId":"r","offset":100,"size":100,"status":"\(status)","transport":"oss","partSize":100,"error":""}
                """.utf8))
            }
            let _: Upload = try await api.request("/api/manage/uploads/u")
            #expect(changes == ["processing": 0, "ready": 1, "failed": 2, "cancelled": 3][status])
        }
    }
}

private func checkEqual<T: Equatable>(_ actual: T, _ expected: T) { #expect(actual == expected) }
private func checkTrue(_ value: Bool) { #expect(value) }
private func checkFalse(_ value: Bool) { #expect(!value) }
private func checkNil<T>(_ value: T?, _ message: String = "") { #expect(value == nil, "\(message)") }
private func checkThrows<T>(_ expression: @autoclosure () throws -> T, _ message: String = "") {
    do { _ = try expression(); Issue.record("Expected error: \(message)") } catch {}
}
private func fail(_ message: String = "Unexpected success") { Issue.record("\(message)") }

struct SettingsTests {
    @Test func passwordsRespectServerUTF8LimitAndConfirmation() {
        #expect(SettingsValidation.passwordError("abcdefgh", confirmation: "abcdefgh") == nil)
        #expect(SettingsValidation.passwordError("abcdefg", confirmation: "abcdefg") != nil)
        #expect(SettingsValidation.passwordError("abcdefgh", confirmation: "abcdEfgh") != nil)
        let boundary = String(repeating: "花", count: 24)
        #expect(SettingsValidation.passwordError(boundary, confirmation: boundary) == nil)
        let oversized = boundary + "花"
        #expect(SettingsValidation.passwordError(oversized, confirmation: oversized) != nil)
        #expect(SettingsValidation.validPIN("0042"))
        for value in ["123", "12345", "１２３４", "12a4", "12 4"] {
            #expect(!SettingsValidation.validPIN(value))
        }
    }
    @Test func reminderCanContainOnlyFarewellWithoutWarning() throws {
        let data = Data(#"{"farewell":{"itemId":"private-clip","ready":true}}"#.utf8)
        let settings = try JSONDecoder().decode(ReminderSettings.self, from: data)
        #expect(settings.farewell.ready)
        #expect(settings.farewell.itemId == "private-clip")
    }
}

private func accountSessionData(_ id: String = "account-b") -> Data {
    Data("""
    {"user":{"id":"\(id)","name":"Parent","role":"admin","accountId":"100002","email":null},"family":{"id":"family-\(id)","name":"Family"},"csrfToken":"csrf-\(id)"}
    """.utf8)
}

extension APIClientTests {
    @Test func addingAccountNeverSendsCurrentCookieAndFailureKeepsCurrentSession() async throws {
        let active = try makeClient(); active.cookie = "account-a-cookie"; active.csrf = "csrf-a"
        let candidate = try makeClient()
        candidate.cookie = "must-be-cleared"
        var expiredCurrent = false
        active.onUnauthorized = { expiredCurrent = true }
        StubURLProtocol.handler = { request in
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
            #expect(request.value(forHTTPHeaderField: "X-CSRF-Token") == nil)
            return (401, [:], Data(#"{"detail":"账号密码错误"}"#.utf8))
        }
        do {
            _ = try await AccountAuthentication.login(username: "b", password: "invalid-example", client: candidate)
            Issue.record("Login should fail")
        } catch { #expect(error as? APIError == .http(401, "账号密码错误")) }
        #expect(active.cookie == "account-a-cookie")
        #expect(active.csrf == "csrf-a")
        #expect(!expiredCurrent)
    }
    @Test func newLoginKeepsSessionsIndependent() async throws {
        let active = try makeClient(); active.cookie = "account-a-cookie"
        let candidate = try makeClient()
        StubURLProtocol.handler = { _ in
            (200, ["Set-Cookie": "molly_parent=account-b-cookie; Path=/; Secure; HttpOnly"], accountSessionData())
        }
        let session = try await AccountAuthentication.login(username: "b", password: "example-only", client: candidate)
        #expect(session.user.id == "account-b")
        #expect(candidate.cookie == "account-b-cookie")
        #expect(candidate.csrf == "csrf-account-b")
        #expect(active.cookie == "account-a-cookie")
    }
    @Test func savedAccountValidationRejectsExpiryAndIdentityMismatch() async throws {
        let active = try makeClient(); active.cookie = "account-a-cookie"
        let session = try JSONDecoder().decode(ParentSession.self, from: accountSessionData())
        let record = SavedAccount(server: "https://mollytime.app", session: session, cookie: "account-b-cookie")
        for (status, data) in [(401, Data()), (200, accountSessionData("unexpected-account"))] {
            let candidate = try makeClient()
            StubURLProtocol.handler = { request in
                #expect(request.value(forHTTPHeaderField: "Cookie") == "molly_parent=account-b-cookie")
                return (status, [:], data)
            }
            do {
                _ = try await AccountAuthentication.restore(record, client: candidate)
                Issue.record("Invalid saved session should not activate")
            } catch { #expect(error as? APIError == .unauthorized) }
            #expect(active.cookie == "account-a-cookie")
        }
    }
    @Test func savedAccountRefreshUsesOnlyItsOwnCredentials() async throws {
        let session = try JSONDecoder().decode(ParentSession.self, from: accountSessionData())
        let record = SavedAccount(server: "https://mollytime.app", session: session, cookie: "b-cookie")
        let candidate = try makeClient()
        StubURLProtocol.handler = { request in
            #expect(request.httpMethod == "GET")
            #expect(request.value(forHTTPHeaderField: "Cookie") == "molly_parent=b-cookie")
            return (200, [:], accountSessionData())
        }
        let refreshed = try await AccountAuthentication.restore(record, client: candidate)
        #expect(refreshed.user.id == record.session.user.id)
        #expect(candidate.csrf == refreshed.csrfToken)
    }
}

struct SavedAccountTests {
    @Test func keysAndReplacementRespectServerAndUserIdentity() throws {
        let session = try JSONDecoder().decode(ParentSession.self, from: accountSessionData())
        let original = SavedAccount(server: "https://MOLLYTIME.app:443/", session: session, cookie: "old")
        let renewed = SavedAccount(server: "https://mollytime.app", session: session, cookie: "new")
        let otherServer = SavedAccount(server: "https://other.example", session: session, cookie: "other")
        #expect(original.id == renewed.id)
        #expect(original.id != otherServer.id)
        #expect(SavedAccount.key(server: renewed.server, userID: "a") != renewed.id)
        let records = SavedAccount.replacing(renewed, in: [original, otherServer])
        #expect(records.count == 2)
        #expect(records[0].cookie == "new")
        #expect(records[1].cookie == "other")
        let restored = try JSONDecoder().decode([SavedAccount].self, from: JSONEncoder().encode(records))
        #expect(restored.map(\.id) == records.map(\.id))
        var expired = renewed; expired.cookie = ""
        #expect(expired.needsLogin)
    }
}

struct RegistrationCodeTests {
    @Test func acceptsPastedCodesButNotDeviceCodesOrConfusableCharacters() {
        #expect(RegistrationCode.normalize(" abcd-efgh-jk23 \n") == "ABCDEFGHJK23")
        for invalid in ["1234", "ABCD-EFGH-I023", "ABCD-EFGH-１２３４", "ABCD-EFGH-JK234"] {
            #expect(RegistrationCode.normalize(invalid) == nil)
        }
    }
}

extension APIClientTests {
    @Test func registrationRetriesLoginWithoutActivatingAgain() async throws {
        let api = try makeClient()
        let flow = InvitationRegistration(api: api)
        flow.code = "abcd-efgh-jk23"
        var activations = 0
        StubURLProtocol.handler = { request in
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
            #expect(request.value(forHTTPHeaderField: "X-CSRF-Token") == nil)
            if request.url?.path.hasSuffix("preview") == true {
                return (200, [:], Data(#"{"email":null,"familyName":null,"expiresAt":"2026-12-01T00:00:00Z"}"#.utf8))
            }
            activations += 1
            return (200, [:], Data(#"{"email":"guest@example.com","accountId":"1234567890","familyName":"我的片库"}"#.utf8))
        }
        await flow.verify()
        #expect(flow.preview != nil)
        flow.email = " GUEST@example.com "; flow.password = "example-password"
        let first = await flow.submit { _, _ in throw APIError.http(503, "网络暂不可用") }
        #expect(!first && flow.created != nil && flow.loginOnly)
        #expect(activations == 1)
        let second = await flow.submit { email, password in
            #expect(email == "guest@example.com")
            #expect(password == "example-password")
        }
        #expect(second && activations == 1)
        #expect(flow.password.isEmpty && flow.code.isEmpty)
    }
    @Test func lostRegistrationResponseRequiresLoginOrCodeRecheck() async throws {
        let api = try makeClient()
        let flow = InvitationRegistration(api: api)
        flow.code = "ABCDEFGHJK23"
        var activationCalls = 0
        StubURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("preview") == true {
                return (200, [:], Data(#"{"email":null,"familyName":null,"expiresAt":"2026-12-01T00:00:00Z"}"#.utf8))
            }
            activationCalls += 1
            throw URLError(.networkConnectionLost)
        }
        await flow.verify()
        flow.email = "guest@example.com"; flow.password = "example-password"
        #expect(!(await flow.submit { _, _ in Issue.record("Cannot log in before activation response") }))
        #expect(flow.activationUncertain)
        #expect(!(await flow.submit { _, _ in throw APIError.http(401, "账号密码错误") }))
        #expect(activationCalls == 1)
        await flow.verify()
        #expect(!flow.activationUncertain && flow.preview != nil)
    }
    @Test func expiredAndDuplicateInvitationsHaveDifferentRecoveryPaths() async throws {
        for status in [404, 409] {
            let flow = InvitationRegistration(api: try makeClient())
            flow.code = "ABCDEFGHJK23"
            StubURLProtocol.handler = { request in
                if request.url?.path.hasSuffix("preview") == true {
                    return (200, [:], Data(#"{"email":"bound@example.com","familyName":"已有名称","expiresAt":"2026-12-01T00:00:00Z"}"#.utf8))
                }
                return (status, [:], Data(#"{"detail":"无法注册"}"#.utf8))
            }
            await flow.verify()
            #expect(flow.email == "bound@example.com")
            flow.password = "example-password"
            #expect(!(await flow.submit { _, _ in Issue.record("Should not activate a session") }))
            #expect(flow.existingEmail == (status == 409))
            #expect((flow.preview == nil) == (status == 404))
            #expect(!flow.loginOnly)
        }
    }
}

extension RegistrationCodeTests {
    @Test func emailValidationMatchesServerRules() {
        #expect(RegistrationEmail.normalize(" Guest+ios@Example.COM ") == "guest+ios@example.com")
        for invalid in [".guest@example.com", "a..b@example.com", "a@example..com", "a@-example.com", "a@example.com-", "a@example", "a@@example.com"] {
            #expect(RegistrationEmail.normalize(invalid) == nil)
        }
    }
}
