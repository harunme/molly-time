import Foundation

public enum APIError: LocalizedError, Equatable {
    case invalidAddress, unsafeURL, invalidResponse, unauthorized, http(Int, String)
    public var errorDescription: String? {
        switch self {
        case .invalidAddress: return "请输入完整的 HTTPS 服务地址。"
        case .unsafeURL: return "服务返回了不安全或不受信任的地址。"
        case .invalidResponse: return "服务返回的数据暂时无法读取，请稍后重试。"
        case .unauthorized: return "登录已过期，请重新登录。"
        case .http(_, let message): return message
        }
    }
}

public struct Endpoint: Sendable, Equatable {
    public let origin: URL
    public init(_ value: String) throws {
        guard let parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", let url = parts.url else { throw APIError.invalidAddress }
        origin = url
    }
    public func isSameOrigin(_ url: URL) -> Bool {
        url.scheme == origin.scheme && url.host == origin.host && (url.port ?? 443) == (origin.port ?? 443)
    }
    public func resolve(_ path: String, authenticated: Bool = true) throws -> URL {
        guard let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.scheme == "https", url.user == nil, url.password == nil, url.fragment == nil,
              !authenticated || isSameOrigin(url) else { throw APIError.unsafeURL }
        return url
    }
    public func api(_ path: String, query: [URLQueryItem] = []) throws -> URL {
        let url = try resolve(path)
        guard url.path.hasPrefix("/api/") else { throw APIError.unsafeURL }
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: true)!
        if !query.isEmpty { parts.queryItems = query }
        guard let result = parts.url else { throw APIError.invalidAddress }
        return result
    }
}

public enum PairingCode {
    public static func normalize(_ input: String, endpoint: Endpoint) -> String? {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.count == 4 && value.utf8.allSatisfy({ (48...57).contains($0) }) { return value }
        guard let url = URL(string: value), endpoint.isSameOrigin(url),
              url.path == "/manage/" || url.path == "/manage",
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let code = parts.queryItems?.first(where: { $0.name == "pair" })?.value,
              code.count == 4, code.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
        return code
    }
}
