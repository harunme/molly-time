import Foundation

/// Persist only in Keychain: the session cookie and CSRF token are credentials.
public struct SavedAccount: Codable, Identifiable, Sendable {
    public let server: String
    public var session: ParentSession
    public var cookie: String
    public var id: String { Self.key(server: server, userID: session.user.id) }
    public var name: String { session.user.displayName ?? session.user.name }
    public var needsLogin: Bool { cookie.isEmpty }

    public init(server: String, session: ParentSession, cookie: String) {
        self.server = server; self.session = session; self.cookie = cookie
    }
    public static func key(server: String, userID: String) -> String {
        var parts = URLComponents(string: server)
        let host = parts?.host?.lowercased()
        parts?.host = host
        if parts?.port == 443 { parts?.port = nil }
        parts?.path = ""
        return "\(parts?.string ?? server)|\(userID)"
    }
    public static func replacing(_ record: SavedAccount, in records: [SavedAccount]) -> [SavedAccount] {
        [record] + records.filter { $0.id != record.id }
    }
}

/// Candidate clients never carry the current account's cookie or callbacks.
/// Callers activate a candidate only after validation has completed successfully.
@MainActor
public enum AccountAuthentication {
    public static func login(username: String, password: String, client: APIClient) async throws -> ParentSession {
        client.cookie = ""; client.csrf = ""
        let session: ParentSession = try await client.send("/api/manage/auth/login", body: ["username": username, "password": password])
        guard !client.cookie.isEmpty else { throw APIError.invalidResponse }
        client.csrf = session.csrfToken
        return session
    }
    public static func restore(_ account: SavedAccount, client: APIClient) async throws -> ParentSession {
        guard !account.cookie.isEmpty else { throw APIError.unauthorized }
        client.cookie = account.cookie; client.csrf = ""
        let session: ParentSession = try await client.request("/api/manage/auth/session")
        guard session.user.id == account.session.user.id else { throw APIError.unauthorized }
        client.csrf = session.csrfToken
        return session
    }
}
