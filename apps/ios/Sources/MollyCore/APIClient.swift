import Foundation

/// Reject redirects on authenticated requests. Credentials never leave this origin.
private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
public final class APIClient {
    public let endpoint: Endpoint
    public var csrf = ""
    public var cookie = ""
    public var onUnauthorized: (() -> Void)?
    public var onCookie: ((String) -> Void)?
    public var onStorageChange: (() -> Void)?
    public var onLibraryChange: (() -> Void)?
    private let session: URLSession

    public init(endpoint: Endpoint, session: URLSession? = nil) {
        self.endpoint = endpoint
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 180
        self.session = session ?? URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }

    public func request<T: Decodable>(_ path: String, method: String = "GET",
                                     query: [URLQueryItem] = [], body: Data? = nil,
                                     headers: [String: String] = [:]) async throws -> T {
        let data = try await raw(path, method: method, query: query, body: body, headers: headers)
        do {
            let result = try JSONDecoder().decode(T.self, from: data)
            if let upload = result as? Upload,
               ["ready", "failed", "cancelled"].contains(upload.status) {
                onStorageChange?()
                if upload.status == "ready" { onLibraryChange?() }
            }
            return result
        }
        catch { throw APIError.invalidResponse }
    }

    public func raw(_ path: String, method: String = "GET", query: [URLQueryItem] = [],
                    body: Data? = nil, headers: [String: String] = [:]) async throws -> Data {
        let request = try authenticatedRequest(path, method: method, query: query, body: body, headers: headers)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 {
                // A failed login is not expiry of an existing session.
                if path != "/api/manage/auth/login" { onUnauthorized?(); throw APIError.unauthorized }
            }
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.http(http.statusCode, object?["detail"] as? String ?? "请求未完成（\(http.statusCode)），请稍后重试。")
        }
        let fields = http.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            if let key = entry.key as? String, let value = entry.value as? String { result[key] = value }
        }
        if let url = http.url, let received = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url)
            .first(where: { $0.name == "molly_parent" }) {
            cookie = received.value; onCookie?(cookie)
        }
        let queuedDeletion = http.statusCode == 202 && method == "DELETE" && path.hasPrefix("/api/manage/trash/")
        if !queuedDeletion && method != "GET" && method != "HEAD" && Self.changesStorage(path) {
            onStorageChange?()
        }
        if !queuedDeletion && method != "GET" && method != "HEAD" && (
            path == "/api/manage/resources" || path.hasPrefix("/api/manage/resources/")
            || path.hasPrefix("/api/manage/trash/") || path.hasPrefix("/api/manage/shares/")) {
            onLibraryChange?()
        }
        return data
    }

    public func authenticatedRequest(_ path: String, method: String, query: [URLQueryItem] = [],
                                     body: Data? = nil, headers: [String: String] = [:]) throws -> URLRequest {
        var request = URLRequest(url: try endpoint.api(path, query: query))
        request.httpMethod = method; request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("MollyTime-iOS/0.1", forHTTPHeaderField: "User-Agent")
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        if !cookie.isEmpty { request.setValue("molly_parent=\(cookie)", forHTTPHeaderField: "Cookie") }
        if method != "GET" && method != "HEAD" && !csrf.isEmpty {
            request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
        }
        return request
    }

    private static func changesStorage(_ path: String) -> Bool {
        if path == "/api/manage/uploads" { return true }
        if path.hasPrefix("/api/manage/uploads/") {
            return path.hasSuffix("/complete") || path.hasSuffix("/cancel")
        }
        return path == "/api/manage/settings"
            || path == "/api/manage/shares"
            || path.hasPrefix("/api/manage/resources/")
            || path.hasPrefix("/api/manage/trash/")
            || path.hasPrefix("/api/manage/shares/")
    }

    public func send<T: Decodable, Body: Encodable>(_ path: String, method: String = "POST", body: Body) async throws -> T {
        try await request(path, method: method, body: JSONEncoder().encode(body))
    }
    public func command(_ path: String, body: [String: String] = [:]) async throws {
        let _: OK = try await send(path, body: body)
    }
}
