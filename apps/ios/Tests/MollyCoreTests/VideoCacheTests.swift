import Foundation
import Testing
import AVFoundation
@testable import MollyCore

private func playback(version: String = "v1", size: Int64 = 600_000, url: String = "https://media.example/video?signature=one") throws -> Playback {
    let json: [String: Any] = ["mediaId": "media-1", "version": version, "size": size, "mime": "video/mp4", "url": url, "subtitles": []]
    return try JSONDecoder().decode(Playback.self, from: JSONSerialization.data(withJSONObject: json))
}

private actor FetchCounter {
    var count = 0
    func fetch() async throws -> Data {
        count += 1
        try await Task.sleep(for: .milliseconds(30))
        return Data([1, 2, 3])
    }
}

struct VideoCacheTests {
    @Test func signedURLRenewalReusesIdentityButAccountServerAndVersionDoNot() throws {
        let original = try #require(VideoCacheDescriptor(playback: playback(), scope: "https://one|alice"))
        let renewed = try #require(VideoCacheDescriptor(playback: playback(url: "https://media.example/video?signature=new"), scope: "https://one|alice"))
        #expect(original.key == renewed.key)
        #expect(!original.key.contains("signature"))
        #expect(original.key != VideoCacheDescriptor(playback: try playback(version: "v2"), scope: "https://one|alice")?.key)
        #expect(original.key != VideoCacheDescriptor(playback: try playback(), scope: "https://one|bob")?.key)
        #expect(original.key != VideoCacheDescriptor(playback: try playback(), scope: "https://two|alice")?.key)
        #expect(original.key != VideoCacheDescriptor(playback: try playback(size: 42), scope: "https://one|alice")?.key)
    }

    @Test func legacyPlaybackStillDecodesAndRangesStayWithinFile() throws {
        let legacy = try JSONDecoder().decode(Playback.self, from: Data(#"{"mediaId":"m","url":"/play","subtitles":[]}"#.utf8))
        #expect(VideoCacheDescriptor(playback: legacy, scope: "a") == nil)
        let descriptor = try #require(VideoCacheDescriptor(playback: playback(), scope: "a"))
        #expect(try descriptor.range(containing: 1) == 0..<262_144)
        #expect(try descriptor.range(containing: 262_144) == 262_144..<524_288)
        #expect(try descriptor.range(containing: 599_999) == 524_288..<600_000)
        #expect(throws: APIError.self) { try descriptor.range(containing: -1) }
        #expect(throws: APIError.self) { try descriptor.range(containing: 600_000) }
        let huge = try #require(VideoCacheDescriptor(playback: playback(size: Int64.max), scope: "a"))
        #expect(try huge.range(containing: Int64.max - 1).upperBound == Int64.max)
    }

    @Test func persistentCacheDoesNotPreallocateExpireOrEvict() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = VideoDiskCache(directory: root)
        #expect(!FileManager.default.fileExists(atPath: root.path))
        let bytes = Data(repeating: 7, count: VideoDiskCache.chunkSize)
        await cache.store(bytes, for: "account|version", chunk: 0)
        let first = try #require(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 0)], ofItemAtPath: first.path)
        for index in 1...8 { await cache.store(bytes, for: "account|version", chunk: Int64(index)) }
        let reopened = VideoDiskCache(directory: root)
        #expect(await reopened.data(for: "account|version", chunk: 0, expectedCount: bytes.count) == bytes)
        #expect(await reopened.data(for: "other-account|version", chunk: 0, expectedCount: bytes.count) == nil)
        #expect(try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).count == 9)
        #expect(try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    }

    @Test func corruptionAndTruncationAreMissesAndDiskFailureDoesNotFailPlayback() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = VideoDiskCache(directory: root)
        let bytes = Data([1, 2, 3])
        await cache.store(bytes, for: "video", chunk: 0)
        let file = try #require(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        var corrupt = try Data(contentsOf: file); corrupt[corrupt.count - 1] = 9
        try corrupt.write(to: file)
        #expect(await cache.data(for: "video", chunk: 0, expectedCount: 3) == nil)
        try Data([1]).write(to: file)
        #expect(await cache.data(for: "video", chunk: 0, expectedCount: 3) == nil)
        let unwritable = VideoDiskCache(directory: file)
        let result = try await unwritable.chunk(for: "video", index: 0, count: 3) { bytes }
        #expect(result == bytes)
        #expect(await unwritable.data(for: "video", chunk: 0, expectedCount: 3) == nil)
    }

    @Test func concurrentAndCancelledReadersPayForOnlyOneTransfer() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = VideoDiskCache(directory: root), counter = FetchCounter()
        let first = Task { try await cache.chunk(for: "video", index: 0, count: 3) { try await counter.fetch() } }
        let second = Task { try await cache.chunk(for: "video", index: 0, count: 3) { try await counter.fetch() } }
        first.cancel()
        #expect(try await second.value == Data([1, 2, 3]))
        _ = try await first.value
        #expect(await counter.count == 1)
        let reopened = VideoDiskCache(directory: root)
        let cached = try await reopened.chunk(for: "video", index: 0, count: 3) { throw APIError.invalidResponse }
        #expect(cached == Data([1, 2, 3]))
    }

    @Test func partialResponsesNeverPoisonCacheAndFailedFetchCanRetry() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = VideoDiskCache(directory: root)
        await #expect(throws: APIError.self) { try await cache.chunk(for: "video", index: 0, count: 3) { Data([1]) } }
        #expect(await cache.data(for: "video", chunk: 0, expectedCount: 3) == nil)
        #expect(try await cache.chunk(for: "video", index: 0, count: 3) { Data([1, 2, 3]) } == Data([1, 2, 3]))
    }

    @Test func rangeValidationRejectsIgnoredRangesAndIncorrectBytes() throws {
        func response(_ status: Int = 206, _ headers: [String: String]) -> HTTPURLResponse {
            HTTPURLResponse(url: URL(string: "https://media.example/video")!, statusCode: status, httpVersion: nil, headerFields: headers)!
        }
        try VideoRangeSource.validate(response(206, ["Content-Range": "bytes 0-2/10", "Content-Length": "3"]), range: 0..<3, total: 10)
        #expect(throws: VideoRangeError.self) { try VideoRangeSource.validate(response(200, [:]), range: 0..<3, total: 10) }
        #expect(throws: VideoRangeError.self) { try VideoRangeSource.validate(response(206, ["Content-Range": "bytes 1-3/10"]), range: 0..<3, total: 10) }
        #expect(throws: VideoRangeError.self) { try VideoRangeSource.validate(response(206, ["Content-Range": "bytes 0-2/11"]), range: 0..<3, total: 10) }
        #expect(throws: VideoRangeError.self) { try VideoRangeSource.validate(response(206, ["Content-Range": "bytes 0-2/10", "Content-Length": "4"]), range: 0..<3, total: 10) }
        #expect(throws: VideoRangeError.self) { try VideoRangeSource.validate(response(403, [:]), range: 0..<3, total: 10) }
        try VideoRangeSource.validate(response(200, ["Content-Length": "3"]), range: 0..<3, total: 3)
    }

    @Test func redirectNeverLeaksAPICredentialsToOSSOrHTTP() throws {
        let origin = URL(string: "https://api.example/play")!
        var request = URLRequest(url: URL(string: "https://oss.example/video")!)
        request.setValue("secret", forHTTPHeaderField: "Cookie")
        request.setValue("secret", forHTTPHeaderField: "Authorization")
        request.setValue("bytes=0-2", forHTTPHeaderField: "Range")
        let redirected = try #require(VideoRedirectPolicy.redirected(request, from: origin))
        #expect(redirected.value(forHTTPHeaderField: "Cookie") == nil)
        #expect(redirected.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(redirected.value(forHTTPHeaderField: "Range") == "bytes=0-2")
        request.url = URL(string: "http://api.example/play")!
        #expect(VideoRedirectPolicy.redirected(request, from: origin) == nil)
        request.url = URL(string: "https://api.example:444/play")!
        #expect(VideoRedirectPolicy.redirected(request, from: origin)?.value(forHTTPHeaderField: "Cookie") == nil)
        request.url = origin
        #expect(VideoRedirectPolicy.redirected(request, from: origin)?.value(forHTTPHeaderField: "Cookie") == "secret")
    }
}

private final class VideoStubProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, [String: String], Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (code, headers, body) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@Suite(.serialized)
struct VideoRangeTransportTests {
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [VideoStubProtocol.self]
        return URLSession(configuration: config)
    }

    @Test func seekAndReplayDownloadOnlyMissingChunksEvenAfterSignedURLChanges() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let descriptor = try #require(VideoCacheDescriptor(playback: playback(), scope: "a"))
        var ranges: [String] = []
        VideoStubProtocol.handler = { request in
            let value = try #require(request.value(forHTTPHeaderField: "Range"))
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
            #expect(request.value(forHTTPHeaderField: "Accept-Encoding") == "identity")
            ranges.append(value)
            let parts = value.dropFirst(6).split(separator: "-").compactMap { Int($0) }
            return (206, ["Content-Range": "bytes \(parts[0])-\(parts[1])/600000"], Data(repeating: 42, count: parts[1] - parts[0] + 1))
        }
        let source = VideoRangeSource(descriptor: descriptor, url: URL(string: "https://oss.example/a?signature=one")!, cookie: nil,
                                      cache: VideoDiskCache(directory: root), session: session())
        #expect(try await source.chunk(containing: 0).data.count == 262_144)
        #expect(try await source.chunk(containing: 100).data.count == 262_144)
        #expect(try await source.chunk(containing: 599_999).data.count == 75_712)
        #expect(ranges == ["bytes=0-262143", "bytes=524288-599999"])
        let reopened = VideoRangeSource(descriptor: descriptor, url: URL(string: "https://oss.example/a?signature=two")!, cookie: nil,
                                        cache: VideoDiskCache(directory: root), session: session())
        _ = try await reopened.chunk(containing: 0)
        _ = try await reopened.chunk(containing: 599_999)
        #expect(ranges.count == 2)
        _ = try await reopened.chunk(containing: 300_000)
        #expect(ranges == ["bytes=0-262143", "bytes=524288-599999", "bytes=262144-524287"])
    }

    @Test func truncatedNetworkBodyIsNotStored() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let descriptor = try #require(VideoCacheDescriptor(playback: playback(size: 3), scope: "a"))
        VideoStubProtocol.handler = { _ in (206, ["Content-Range": "bytes 0-2/3"], Data([1])) }
        let cache = VideoDiskCache(directory: root)
        let source = VideoRangeSource(descriptor: descriptor, url: URL(string: "https://oss.example/video")!, cookie: nil, cache: cache, session: session())
        await #expect(throws: VideoRangeError.self) { try await source.chunk(containing: 0) }
        #expect(await cache.data(for: descriptor.key, chunk: 0, expectedCount: 3) == nil)
    }

    @Test(.timeLimit(.minutes(1))) @MainActor
    func avFoundationDecodesRealVideoAndReopensWithoutNetworkBytes() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let apps = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let movie = try Data(contentsOf: apps.appendingPathComponent("server/mollytime_server/assets/reminders/warning.mp4"))
        let descriptor = try #require(VideoCacheDescriptor(playback: playback(size: Int64(movie.count)), scope: "a"))
        var transferred = 0
        VideoStubProtocol.handler = { request in
            let value = try #require(request.value(forHTTPHeaderField: "Range"))
            let parts = value.dropFirst(6).split(separator: "-").compactMap { Int($0) }
            let data = movie.subdata(in: parts[0]..<(parts[1] + 1))
            transferred += data.count
            return (206, ["Content-Range": "bytes \(parts[0])-\(parts[1])/\(movie.count)"], data)
        }
        for _ in 0..<2 {
            let source = VideoRangeSource(descriptor: descriptor, url: URL(string: "https://oss.example/video")!, cookie: nil,
                                          cache: VideoDiskCache(directory: root), session: session())
            let cached = CachedVideoAsset(source: source, onUnsupportedRange: { Issue.record("Range unexpectedly unsupported") })
            defer { cached.stop() }
            let duration = try await cached.asset.load(.duration)
            #expect(duration.seconds > 0)
            let frame = try await AVAssetImageGenerator(asset: cached.asset).image(at: .zero)
            #expect(frame.image.width > 0)
            #expect(transferred == movie.count)
        }
    }
}
