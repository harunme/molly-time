import Foundation
import Testing
@testable import MollyCore

struct ArtworkDiskCacheTests {
    @Test func survivesCacheRecreationAndSeparatesAccountsServersAndVersions() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let key = "https://one.example|alice|/api/items/1/image?v=one&w=320"
        let bytes = Data([1, 2, 3])
        await ArtworkDiskCache(directory: root).store(bytes, for: key)
        let reopened = ArtworkDiskCache(directory: root)
        #expect(await reopened.data(for: key) == bytes)
        #expect(await reopened.data(for: key.replacingOccurrences(of: "alice", with: "bob")) == nil)
        #expect(await reopened.data(for: key.replacingOccurrences(of: "one.example", with: "two.example")) == nil)
        #expect(await reopened.data(for: key.replacingOccurrences(of: "v=one", with: "v=two")) == nil)
    }
    @Test func boundsDiskUsageAndExpiresOldEntries() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = ArtworkDiskCache(directory: root, byteLimit: 10)
        await cache.store(Data(repeating: 1, count: 6), for: "first")
        let firstFile = try #require(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -100)], ofItemAtPath: firstFile.path)
        await cache.store(Data(repeating: 2, count: 6), for: "second")
        #expect(await cache.data(for: "first") == nil)
        #expect(await cache.data(for: "second")?.count == 6)
        await cache.store(Data(repeating: 3, count: 11), for: "too-large")
        #expect(await cache.data(for: "too-large") == nil)
        let expired = ArtworkDiskCache(directory: root, byteLimit: 10, lifetime: -1)
        #expect(await expired.data(for: "second") == nil)
    }
    @Test func unwritableCacheFallsBackWithoutFailingImageLoad() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data([1]).write(to: root)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = ArtworkDiskCache(directory: root)
        await cache.store(Data([2]), for: "image")
        #expect(await cache.data(for: "image") == nil)
    }
}
