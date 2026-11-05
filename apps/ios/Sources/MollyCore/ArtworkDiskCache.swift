import Foundation
import CryptoKit

/// Only versioned artwork belongs here. The caller includes server and account
/// in the key; authenticated JSON and unversioned images are never persisted.
public actor ArtworkDiskCache {
    private let directory: URL
    private let byteLimit: Int
    private let lifetime: TimeInterval
    private var prepared = false
    private var usedBytes = 0

    public init(directory: URL? = nil, byteLimit: Int = 64 * 1024 * 1024, lifetime: TimeInterval = 7 * 86400) {
        self.directory = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MollyArtwork-v1", isDirectory: true)
        self.byteLimit = max(0, byteLimit)
        self.lifetime = lifetime
    }
    private func file(_ key: String) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(digest)
    }
    public func data(for key: String) -> Data? {
        prepare()
        let url = file(key)
        guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]),
              let date = values.contentModificationDate,
              Date().timeIntervalSince(date) < lifetime,
              let size = values.fileSize, size > 0, size <= byteLimit else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        return try? Data(contentsOf: url)
    }
    public func store(_ data: Data, for key: String) {
        guard !data.isEmpty, data.count <= min(byteLimit, 4 * 1024 * 1024) else { return }
        prepare()
        do {
            let previousSize = (try? file(key).resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            try data.write(to: file(key), options: .atomic)
            usedBytes = max(0, usedBytes + data.count - previousSize)
            // Avoid scanning the entire directory for every cover in a grid.
            if usedBytes > byteLimit { trim() }
        } catch { /* Disk pressure must not turn a loaded cover into a failure. */ }
    }
    private func prepare() {
        guard !prepared else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            prepared = true
            trim()
        } catch { }
    }
    private func trim() {
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
        guard let urls = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: Array(keys)) else { return }
        var files: [(url: URL, date: Date, size: Int)] = []
        let now = Date()
        for url in urls {
            guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else { continue }
            let date = values.contentModificationDate ?? .distantPast
            if now.timeIntervalSince(date) >= lifetime { try? FileManager.default.removeItem(at: url) }
            else { files.append((url, date, values.fileSize ?? 0)) }
        }
        var total = files.reduce(0) { $0 + $1.size }
        for entry in files.sorted(by: { $0.date < $1.date }) where total > byteLimit {
            do { try FileManager.default.removeItem(at: entry.url); total -= entry.size } catch { }
        }
        usedBytes = total
    }
}
