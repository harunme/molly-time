import Foundation

public struct VideoCacheDescriptor: Sendable {
    public let key: String
    public let size: Int64
    public let mime: String

    public init?(playback: Playback, scope: String) {
        guard let size = playback.size, size > 0, let version = playback.version, !version.isEmpty,
              let mime = playback.mime?.lowercased(),
              ["video/mp4", "video/quicktime", "video/x-m4v"].contains(mime) else { return nil }
        self.size = size; self.mime = mime
        // Stable across renewed signed URLs, distinct across accounts and versions.
        let identity = [scope, playback.mediaId, version, String(size), mime]
        guard let encoded = try? JSONEncoder().encode(identity), let key = String(data: encoded, encoding: .utf8) else { return nil }
        self.key = key
    }

    public func range(containing offset: Int64) throws -> Range<Int64> {
        guard offset >= 0, offset < size else { throw APIError.invalidResponse }
        let start = offset / Int64(VideoDiskCache.chunkSize) * Int64(VideoDiskCache.chunkSize)
        return start..<(start + min(Int64(VideoDiskCache.chunkSize), size - start))
    }
}

public enum VideoRangeError: Error { case rangeUnsupported, invalidResponse }

/// Credentials are scoped to the original API origin, never a redirected OSS host.
final class VideoRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static func redirected(_ request: URLRequest, from origin: URL) -> URLRequest? {
        guard let url = request.url, url.scheme == "https", url.user == nil, url.password == nil else { return nil }
        var result = request
        if url.host != origin.host || (url.port ?? 443) != (origin.port ?? 443) || url.scheme != origin.scheme {
            result.setValue(nil, forHTTPHeaderField: "Cookie")
            result.setValue(nil, forHTTPHeaderField: "Authorization")
        }
        return result
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let origin = task.originalRequest?.url else { completionHandler(nil); return }
        completionHandler(Self.redirected(request, from: origin))
    }
}

public final class VideoRangeSource: @unchecked Sendable {
    public let descriptor: VideoCacheDescriptor
    private let cache: VideoDiskCache
    private let request: URLRequest
    private let session: URLSession

    public init(descriptor: VideoCacheDescriptor, url: URL, cookie: String?, cache: VideoDiskCache, session: URLSession? = nil) {
        self.descriptor = descriptor; self.cache = cache
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let cookie, !cookie.isEmpty { request.setValue("molly_parent=\(cookie)", forHTTPHeaderField: "Cookie") }
        self.request = request
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 120
        self.session = session ?? URLSession(configuration: configuration, delegate: VideoRedirectPolicy(), delegateQueue: nil)
    }
    deinit { session.finishTasksAndInvalidate() }

    public func chunk(containing offset: Int64) async throws -> (range: Range<Int64>, data: Data) {
        try Task.checkCancellation()
        let range = try descriptor.range(containing: offset)
        let data = try await cache.chunk(for: descriptor.key, index: range.lowerBound / Int64(VideoDiskCache.chunkSize), count: Int(range.count)) { [self] in
            try await fetch(range)
        }
        try Task.checkCancellation()
        return (range, data)
    }

    static func validate(_ response: HTTPURLResponse, range: Range<Int64>, total: Int64) throws {
        if response.statusCode == 200 {
            // A small complete file is safe; never consume an ignored large Range.
            guard range.lowerBound == 0, range.upperBound == total else { throw VideoRangeError.rangeUnsupported }
        } else {
            guard response.statusCode == 206 else { throw VideoRangeError.invalidResponse }
            let expected = "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(total)"
            guard response.value(forHTTPHeaderField: "Content-Range") == expected else { throw VideoRangeError.invalidResponse }
        }
        if let length = response.value(forHTTPHeaderField: "Content-Length") {
            guard Int64(length) == Int64(range.count) else { throw VideoRangeError.invalidResponse }
        }
        if let encoding = response.value(forHTTPHeaderField: "Content-Encoding"), encoding.lowercased() != "identity" {
            throw VideoRangeError.invalidResponse
        }
    }

    private func fetch(_ range: Range<Int64>) async throws -> Data {
        var request = request
        request.setValue("bytes=\(range.lowerBound)-\(range.upperBound - 1)", forHTTPHeaderField: "Range")
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let response = response as? HTTPURLResponse else { throw VideoRangeError.invalidResponse }
        try Self.validate(response, range: range, total: descriptor.size)
        var data = Data(); data.reserveCapacity(Int(range.count))
        for try await byte in bytes {
            guard data.count < range.count else { throw VideoRangeError.invalidResponse }
            data.append(byte)
        }
        guard data.count == range.count else { throw VideoRangeError.invalidResponse }
        return data
    }
}
