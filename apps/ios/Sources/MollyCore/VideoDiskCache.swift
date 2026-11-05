import Foundation
import CryptoKit

/// Persistent, demand-filled video chunks. No preallocation, eviction, expiry,
/// signed URLs, or credentials. The OS must not treat watched video as purgeable.
public actor VideoDiskCache {
    public static let chunkSize = 256 * 1024
    private let directory: URL
    private var pending: [String: Task<Data, Error>] = [:]

    public init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MollyVideo-v1", isDirectory: true)
    }

    private func file(_ key: String, _ index: Int64) -> URL {
        let name = Self.digest(Data("\(key)|chunk:\(index)".utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(name)
    }
    private static func digest(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    /// Overlapping player requests share one transfer. A started chunk may finish
    /// after a seek/close so bytes already paid for can be reused next time.
    public func chunk(for key: String, index: Int64, count: Int,
                      fetch: @escaping @Sendable () async throws -> Data) async throws -> Data {
        let identity = file(key, index).lastPathComponent
        if let data = data(for: key, chunk: index, expectedCount: count) { return data }
        if let task = pending[identity] { return try await task.value }
        let task = Task {
            let data = try await fetch()
            guard data.count == count else { throw APIError.invalidResponse }
            self.store(data, for: key, chunk: index)
            return data
        }
        pending[identity] = task
        defer { pending[identity] = nil }
        return try await task.value
    }

    public func data(for key: String, chunk index: Int64, expectedCount: Int) -> Data? {
        guard index >= 0, expectedCount > 0, expectedCount <= Self.chunkSize,
              let stored = try? Data(contentsOf: file(key, index)), stored.count == expectedCount + 32 else { return nil }
        let data = Data(stored.dropFirst(32))
        guard stored.prefix(32) == Self.digest(data) else { return nil }
        return data
    }

    public func store(_ data: Data, for key: String, chunk index: Int64) {
        guard !Task.isCancelled, index >= 0, !data.isEmpty, data.count <= Self.chunkSize else { return }
        do {
            var root = directory
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            // Re-downloadable media must not inflate iCloud/device backups.
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try root.setResourceValues(values)
            try (Self.digest(data) + data).write(to: file(key, index), options: .atomic)
        } catch { /* Disk full/unavailable: keep existing cache and allow playback. */ }
    }
}
